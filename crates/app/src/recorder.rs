//! Recording the mix: the stereo pair of the mixer's record channels that carries
//! its master output (as the Xone:4D sends it back over USB, after the faders, EQ,
//! filters and crossfader), written to 24-bit 48 kHz WAV files in
//! `~/Music/recordings`. The USB thread only copies frames into a lock-free ring
//! while recording; this writer drains it to disk and keeps the WAV header current
//! every 2 s, so a crash still leaves a playable file.

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use engine::{SAMPLE_RATE, Shared};
use ploytec::Frame;
use serde_json::{Value, json};

/// The mixer's record pair that carries its mix: soundcard input 7/8, with channel 4's
/// soundcard input switch on "Mix" (the only pair that can carry the main mix).
pub const DEFAULT_PAIR: usize = 3;
const BYTES_PER_FRAME: u32 = 6;
const HEADER_EVERY: Duration = Duration::from_secs(2);

pub struct Recorder {
    shared: Arc<Shared>,
    dir: PathBuf,
    /// Which stereo pair of the 8 record channels to save (0 = 1/2 … 3 = 7/8).
    pair: AtomicUsize,
    take: Mutex<Option<Take>>,
    /// The last finished recording, for the app to announce once.
    saved: Mutex<Option<(PathBuf, f64)>>,
}

struct Take {
    out: BufWriter<File>,
    path: PathBuf,
    frames: u64,
    peak: f32,
    started: Instant,
    header_at: Instant,
    stopping: bool,
}

impl Recorder {
    pub fn new(shared: Arc<Shared>, dir: PathBuf) -> Arc<Self> {
        Arc::new(Self { shared, dir, pair: AtomicUsize::new(DEFAULT_PAIR), take: Mutex::new(None), saved: Mutex::new(None) })
    }

    pub fn set_pair(&self, pair: usize) {
        self.pair.store(pair.min(3), Ordering::Relaxed);
    }

    pub fn active(&self) -> bool {
        self.take.lock().unwrap().as_ref().is_some_and(|t| !t.stopping)
    }

    /// Start a new recording; the file is named after the local date and time.
    pub fn start(&self) -> Result<PathBuf, String> {
        let mut take = self.take.lock().unwrap();
        if take.as_ref().is_some_and(|t| !t.stopping) {
            return Err("already recording".into());
        }
        if take.is_some() {
            return Err("still saving the last recording".into());
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("can't create {}: {e}", self.dir.display()))?;
        let path = self.dir.join(format!("X1 D Four mix {}.wav", local_stamp()));
        let file = File::create(&path).map_err(|e| format!("can't create {}: {e}", path.display()))?;
        let mut out = BufWriter::with_capacity(1 << 20, file);
        write_header(&mut out, 0).map_err(|e| e.to_string())?;
        let now = Instant::now();
        *take = Some(Take { out, path: path.clone(), frames: 0, peak: 0.0, started: now, header_at: now, stopping: false });
        self.shared.capture_dropped.store(0, Ordering::Relaxed);
        self.shared.capture_on.store(true, Ordering::Relaxed);
        tracing::info!(path = %path.display(), pair = self.pair.load(Ordering::Relaxed), "recording");
        Ok(path)
    }

    /// Stop recording; the writer saves what's left in the feed and closes the file.
    pub fn stop(&self) {
        self.shared.capture_on.store(false, Ordering::Relaxed);
        if let Some(t) = self.take.lock().unwrap().as_mut() {
            t.stopping = true;
        }
    }

    /// The recording just finished, once.
    pub fn take_saved(&self) -> Option<(PathBuf, f64)> {
        self.saved.lock().unwrap().take()
    }

    pub fn status(&self) -> Value {
        let take = self.take.lock().unwrap();
        let pair = self.pair.load(Ordering::Relaxed);
        match take.as_ref() {
            Some(t) => json!({
                "active": !t.stopping,
                "seconds": t.frames as f64 / SAMPLE_RATE as f64,
                "file": t.path.file_name().map(|n| n.to_string_lossy().into_owned()),
                "peak_db": if t.peak > 1e-5 { ((20.0 * t.peak.log10()) * 10.0).round() / 10.0 } else { -99.0 },
                "pair": pair,
                "dropped": self.shared.capture_dropped.load(Ordering::Relaxed),
            }),
            None => json!({ "active": false, "pair": pair }),
        }
    }

    /// The writer: drains the capture feed to the open file, forever.
    pub fn run(self: Arc<Self>, mut feed: rtrb::Consumer<Frame>) {
        let mut bytes = Vec::with_capacity(SAMPLE_RATE as usize * BYTES_PER_FRAME as usize);
        loop {
            let pair = self.pair.load(Ordering::Relaxed);
            bytes.clear();
            let mut peak = 0f32;
            let mut frames = 0u64;
            while let Ok(f) = feed.pop() {
                for &s in &f[pair * 2..pair * 2 + 2] {
                    bytes.extend_from_slice(&s.to_le_bytes()[..3]);
                    peak = peak.max((s as f32 / 8_388_608.0).abs());
                }
                frames += 1;
            }
            let mut take = self.take.lock().unwrap();
            if let Some(t) = take.as_mut() {
                let mut result = t.out.write_all(&bytes);
                t.frames += frames;
                t.peak = t.peak.max(peak);
                if result.is_ok() && t.header_at.elapsed() >= HEADER_EVERY {
                    t.header_at = Instant::now();
                    result = update_header(&mut t.out, t.frames);
                }
                let done = t.stopping && feed.is_empty();
                if let Err(e) = &result {
                    tracing::error!(error = %e, path = %t.path.display(), "recording failed, stopping");
                    self.shared.capture_on.store(false, Ordering::Relaxed);
                }
                if done || result.is_err() {
                    let mut t = take.take().unwrap();
                    let seconds = t.frames as f64 / SAMPLE_RATE as f64;
                    match update_header(&mut t.out, t.frames).and_then(|_| t.out.flush()) {
                        Ok(()) => tracing::info!(path = %t.path.display(), seconds, elapsed = ?t.started.elapsed(), "recording saved"),
                        Err(e) => tracing::error!(error = %e, path = %t.path.display(), "recording not finalised"),
                    }
                    *self.saved.lock().unwrap() = Some((t.path, seconds));
                }
            }
            drop(take);
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// A 44-byte PCM WAV header: stereo, 48 kHz, 24-bit, for `frames` frames.
fn write_header(out: &mut impl Write, frames: u64) -> std::io::Result<()> {
    let data = (frames * BYTES_PER_FRAME as u64).min(u32::MAX as u64 - 36) as u32;
    out.write_all(b"RIFF")?;
    out.write_all(&(36 + data).to_le_bytes())?;
    out.write_all(b"WAVEfmt ")?;
    out.write_all(&16u32.to_le_bytes())?;
    out.write_all(&1u16.to_le_bytes())?; // PCM
    out.write_all(&2u16.to_le_bytes())?;
    out.write_all(&SAMPLE_RATE.to_le_bytes())?;
    out.write_all(&(SAMPLE_RATE * BYTES_PER_FRAME).to_le_bytes())?;
    out.write_all(&(BYTES_PER_FRAME as u16).to_le_bytes())?;
    out.write_all(&24u16.to_le_bytes())?;
    out.write_all(b"data")?;
    out.write_all(&data.to_le_bytes())
}

/// Rewrite the header for the frames written so far, and carry on at the end.
fn update_header(out: &mut BufWriter<File>, frames: u64) -> std::io::Result<()> {
    out.flush()?;
    let file = out.get_mut();
    file.seek(SeekFrom::Start(0))?;
    write_header(file, frames)?;
    file.seek(SeekFrom::End(0))?;
    Ok(())
}

/// "2026-10-06 21-04-33" in local time.
fn local_stamp() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()) as libc::time_t;
    // SAFETY: localtime_r only writes the tm we hand it.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&now, &mut tm) };
    format!("{:04}-{:02}-{:02} {:02}-{:02}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_the_chosen_pair_to_a_valid_wav() {
        let dir = std::env::temp_dir().join(format!("x1d4-rec-{}", std::process::id()));
        use ploytec::Renderer;
        let (mut control, mut rt) = engine::new();
        let feed = control.take_capture().unwrap();
        let rec = Recorder::new(control.shared.clone(), dir.clone());
        rec.set_pair(1);
        let path = rec.start().unwrap();
        assert!(rec.active());
        assert!(rec.start().is_err(), "one at a time");
        let writer = rec.clone();
        std::thread::spawn(move || writer.run(feed));
        // One packet from the mixer: pair 1 (channels 3/4) carries the mix.
        let mut frames = [[0i32; 8]; ploytec::FRAMES_PER_PACKET];
        for (i, f) in frames.iter_mut().enumerate() {
            f[2] = i as i32 * 1000;
            f[3] = -(i as i32) * 1000;
            f[0] = 7;
        }
        rt.captured(&frames);
        std::thread::sleep(Duration::from_millis(60));
        rec.stop();
        let mut saved = None;
        for _ in 0..100 {
            saved = rec.take_saved();
            if saved.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let (p, seconds) = saved.expect("saved");
        assert_eq!(p, path);
        assert_eq!(seconds, 80.0 / 48_000.0);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes([bytes[34], bytes[35]]), 24);
        assert_eq!(u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]), 48_000);
        assert_eq!(bytes.len(), 44 + 80 * 6);
        assert_eq!(u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]), 80 * 6);
        // Frame 5: left 5000, right -5000, as 24-bit little-endian.
        let at = 44 + 5 * 6;
        let s24 = |b: &[u8]| (i32::from_le_bytes([b[0], b[1], b[2], 0]) << 8) >> 8;
        assert_eq!((s24(&bytes[at..at + 3]), s24(&bytes[at + 3..at + 6])), (5000, -5000));
        assert!(path.file_name().unwrap().to_string_lossy().starts_with("X1 D Four mix "));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_header_counts_the_frames() {
        let mut v = Vec::new();
        write_header(&mut v, 48_000).unwrap();
        assert_eq!(u32::from_le_bytes([v[40], v[41], v[42], v[43]]), 48_000 * 6);
        assert_eq!(u32::from_le_bytes([v[4], v[5], v[6], v[7]]), 36 + 48_000 * 6);
    }
}
