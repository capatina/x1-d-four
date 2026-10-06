//! Track loading: decode with symphonia, convert to 48 kHz stereo f32 in RAM,
//! compute an overview waveform. Runs off the real-time thread.

use std::fs::File;
use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::SAMPLE_RATE;

/// Buckets in the overview waveform.
pub const PEAK_BUCKETS: usize = 1024;
/// Frames per block of the detailed three-band waveform (10 ms at 48 kHz).
pub const WAVE_BLOCK: usize = 480;

/// A decoded track: interleaved stereo f32 at 48 kHz.
pub struct Track {
    pub path: PathBuf,
    pub samples: Vec<f32>,
    /// Max |sample| per bucket, 0..=255, for the overview waveform.
    pub peaks: Vec<u8>,
    /// Low/mid/high level per `WAVE_BLOCK` frames, 0..=255, for the detailed waveforms.
    pub bands: Vec<[u8; 3]>,
    /// Beat grid, if known: needed for sync.
    pub grid: Option<Grid>,
    /// Volume normalization: the gain that brings the track to `TARGET_LUFS` (1 = none).
    pub gain: f32,
}

/// Loudness every loaded track is brought to (EBU R128 integrated loudness).
pub const TARGET_LUFS: f64 = -11.0;
/// Normalization never cuts more than this or boosts more than this (dB).
const MIN_GAIN_DB: f64 = -12.0;
const MAX_GAIN_DB: f64 = 9.0;
/// A boost stops where the loudest sample would reach this.
const PEAK_CEILING: f32 = 0.98;

/// Tempo and first beat of a track, in its own 48 kHz frames.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Grid {
    pub bpm: f64,
    pub first_beat: f64,
}

impl Grid {
    pub fn beat_frames(&self) -> f64 {
        60.0 * SAMPLE_RATE as f64 / self.bpm
    }

    /// Phase within the beat (0..1) at a frame position.
    pub fn phase_at(&self, frame: f64) -> f64 {
        ((frame - self.first_beat) / self.beat_frames()).rem_euclid(1.0)
    }
}

impl Track {
    pub fn frames(&self) -> usize {
        self.samples.len() / 2
    }

    pub fn seconds(&self) -> f64 {
        self.frames() as f64 / SAMPLE_RATE as f64
    }

    /// Build a track from 48 kHz interleaved stereo samples.
    pub fn from_samples(path: PathBuf, samples: Vec<f32>) -> Self {
        let peaks = peaks(&samples);
        let bands = band_levels(&samples);
        Self { path, samples, peaks, bands, grid: None, gain: 1.0 }
    }

    /// Set `gain` so the track plays at `TARGET_LUFS`, without boosting it into clipping.
    pub fn normalize(&mut self) {
        self.gain = normalization_gain(&self.samples);
    }
}

/// Gain toward `TARGET_LUFS`: clamped to −12…+9 dB, and a boost only as far as the peak allows.
pub fn normalization_gain(samples: &[f32]) -> f32 {
    let Some(lufs) = integrated_loudness(samples) else { return 1.0 };
    let db = (TARGET_LUFS - lufs).clamp(MIN_GAIN_DB, MAX_GAIN_DB);
    let mut gain = 10f64.powf(db / 20.0) as f32;
    if gain > 1.0 {
        let peak = samples.iter().fold(0f32, |m, v| m.max(v.abs()));
        if peak > 0.0 {
            gain = gain.min((PEAK_CEILING / peak).max(1.0));
        }
    }
    gain
}

/// EBU R128 / ITU-R BS.1770 integrated loudness of 48 kHz interleaved stereo, in LUFS:
/// K-weighting, 400 ms blocks every 100 ms, absolute gate at −70 LUFS, relative gate
/// 10 LU below. None for silence.
pub fn integrated_loudness(samples: &[f32]) -> Option<f64> {
    // K-weighting at 48 kHz: high shelf, then the RLB high-pass.
    const SHELF: ([f64; 3], [f64; 2]) = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [-1.69065929318241, 0.73248077421585]);
    const HIGHPASS: ([f64; 3], [f64; 2]) = ([1.0, -2.0, 1.0], [-1.99004745483398, 0.99007225036621]);
    const HOP: usize = SAMPLE_RATE as usize / 10;
    let frames = samples.len() / 2;
    if frames < HOP * 4 {
        return None;
    }
    // Per 100 ms hop: the K-weighted energy of both channels.
    let mut hops = Vec::with_capacity(frames / HOP);
    let mut state = [[0f64; 4]; 4]; // [channel * 2 + stage][x1, x2, y1, y2]
    let mut acc = 0f64;
    for f in 0..frames {
        for c in 0..2 {
            let mut x = samples[f * 2 + c] as f64;
            for (k, (b, a)) in [SHELF, HIGHPASS].iter().enumerate() {
                let st = &mut state[c * 2 + k];
                let y = b[0] * x + b[1] * st[0] + b[2] * st[1] - a[0] * st[2] - a[1] * st[3];
                st[1] = st[0];
                st[0] = x;
                st[3] = st[2];
                st[2] = y;
                x = y;
            }
            acc += x * x;
        }
        if (f + 1) % HOP == 0 {
            hops.push(acc / HOP as f64);
            acc = 0.0;
        }
    }
    let blocks: Vec<f64> = hops.windows(4).map(|w| w.iter().sum::<f64>() / 4.0).collect();
    let lufs = |power: f64| -0.691 + 10.0 * power.log10();
    let gated = |threshold: f64| blocks.iter().copied().filter(move |&p| p > 0.0 && lufs(p) > threshold);
    let mean = |it: &mut dyn Iterator<Item = f64>| {
        let (sum, n) = it.fold((0.0, 0usize), |(s, n), p| (s + p, n + 1));
        (n > 0).then(|| sum / n as f64)
    };
    let absolute = mean(&mut gated(-70.0))?;
    let relative = lufs(absolute) - 10.0;
    mean(&mut gated(relative)).map(lufs)
}

/// Decode a file into a playable track.
pub fn load(path: &Path) -> anyhow::Result<Track> {
    let (rate, samples) = decode(path, 2)?;
    let samples = if rate == SAMPLE_RATE { samples } else { resample(&samples, rate, SAMPLE_RATE)? };
    let mut track = Track::from_samples(path.to_owned(), samples);
    track.normalize();
    Ok(track)
}

/// Decode to mono f32 at the file's own rate (left/right averaged), for analysis.
pub fn decode_mono(path: &Path) -> anyhow::Result<(u32, Vec<f32>)> {
    decode(path, 1)
}

/// Decode to interleaved f32 at the file's own rate: `out_channels` 2 gives
/// stereo (mono duplicated, wider files keep their first two channels), 1 gives
/// the average of the first two channels.
fn decode(path: &Path, out_channels: usize) -> anyhow::Result<(u32, Vec<f32>)> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .with_context(|| format!("unrecognised audio file {}", path.display()))?;
    let track = format.default_track(TrackType::Audio).ok_or_else(|| anyhow!("no audio track"))?;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| anyhow!("no audio codec parameters"))?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .context("no decoder for this codec")?;
    let track_id = track.id;

    let mut rate = 0u32;
    let mut out: Vec<f32> = Vec::new();
    let mut scratch: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(SymError::ResetRequired) => break,
            Err(SymError::IoError(_)) if decoded_enough(&out, rate, out_channels) => break,
            Err(e) => return Err(e).context("read packet"),
        };
        if packet.track_id != track_id {
            continue;
        }
        let buf = match decoder.decode(&packet) {
            Ok(b) => b,
            Err(SymError::DecodeError(_)) => continue,
            // A file cut off mid-frame: keep what decoded, if it's a real track.
            Err(SymError::IoError(_)) if decoded_enough(&out, rate, out_channels) => break,
            Err(e) => return Err(e).context("decode"),
        };
        rate = buf.spec().rate();
        let channels = buf.spec().channels().count().max(1);
        scratch.resize(buf.samples_interleaved(), 0.0);
        buf.copy_to_slice_interleaved(&mut scratch);
        out.reserve(scratch.len() / channels * out_channels);
        for frame in scratch.chunks_exact(channels) {
            let l = frame[0];
            let r = if channels > 1 { frame[1] } else { l };
            if out_channels == 1 {
                out.push(0.5 * (l + r));
            } else {
                out.push(l);
                out.push(r);
            }
        }
    }
    if out.is_empty() || rate == 0 {
        return Err(anyhow!("no audio decoded from {}", path.display()));
    }
    Ok((rate, out))
}

/// More than 5 s decoded: an I/O error now means a truncated file, not a bogus one.
fn decoded_enough(out: &[f32], rate: u32, channels: usize) -> bool {
    rate > 0 && out.len() / channels > rate as usize * 5
}

fn resample(samples: &[f32], from: u32, to: u32) -> anyhow::Result<Vec<f32>> {
    let frames = samples.len() / 2;
    let mut resampler = Fft::<f32>::new(from as usize, to as usize, 1024, 2, FixedSync::Both)
        .map_err(|e| anyhow!("resampler: {e}"))?;
    let input = InterleavedSlice::new(samples, 2, frames).map_err(|e| anyhow!("resampler input: {e}"))?;
    let output = resampler.process_all(&input, frames, None).map_err(|e| anyhow!("resample: {e}"))?;
    Ok(output.take_data())
}

/// Three-band peak level per block, like a DJ waveform: the mono mix split at
/// 250 Hz and 3 kHz by 4th-order Linkwitz-Riley filters (so a kick lands in low
/// and a hat in high), the largest |sample| of each band per block, linear,
/// full scale = 255. Linear and unnormalised, so breakdowns stay quieter than drops.
fn band_levels(samples: &[f32]) -> Vec<[u8; 3]> {
    let mut low = [Biquad::lowpass(250.0), Biquad::lowpass(250.0)];
    let mut mid = [Biquad::highpass(250.0), Biquad::highpass(250.0), Biquad::lowpass(3000.0), Biquad::lowpass(3000.0)];
    let mut high = [Biquad::highpass(3000.0), Biquad::highpass(3000.0)];
    samples
        .chunks(WAVE_BLOCK * 2)
        .map(|block| {
            let mut peak = [0f32; 3];
            for f in block.chunks_exact(2) {
                let x = 0.5 * (f[0] + f[1]);
                let l = low.iter_mut().fold(x, |v, f| f.run(v));
                let h = high.iter_mut().fold(x, |v, f| f.run(v));
                let m = mid.iter_mut().fold(x, |v, f| f.run(v));
                for (p, v) in peak.iter_mut().zip([l, m, h]) {
                    *p = p.max(v.abs());
                }
            }
            peak.map(|p| (p.min(1.0) * 255.0).round() as u8)
        })
        .collect()
}

/// A 2nd-order Butterworth section (RBJ cookbook); two in a row make a Linkwitz-Riley filter.
struct Biquad {
    b: [f32; 3],
    a: [f32; 2],
    z: [f32; 2],
}

impl Biquad {
    fn new(fc: f32, high: bool) -> Self {
        let w = std::f32::consts::TAU * fc / SAMPLE_RATE as f32;
        let (sin, cos) = w.sin_cos();
        let alpha = sin / std::f32::consts::SQRT_2;
        let a0 = 1.0 + alpha;
        let b = if high {
            [(1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0]
        } else {
            [(1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0]
        };
        Self { b: b.map(|v| v / a0), a: [-2.0 * cos / a0, (1.0 - alpha) / a0], z: [0.0; 2] }
    }

    fn lowpass(fc: f32) -> Self {
        Self::new(fc, false)
    }

    fn highpass(fc: f32) -> Self {
        Self::new(fc, true)
    }

    /// Transposed direct form II.
    fn run(&mut self, x: f32) -> f32 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

fn peaks(samples: &[f32]) -> Vec<u8> {
    let frames = samples.len() / 2;
    if frames == 0 {
        return vec![0; PEAK_BUCKETS];
    }
    (0..PEAK_BUCKETS)
        .map(|b| {
            let start = b * frames / PEAK_BUCKETS;
            let end = ((b + 1) * frames / PEAK_BUCKETS).max(start + 1).min(frames);
            let peak = samples[start * 2..end * 2].iter().fold(0f32, |m, s| m.max(s.abs()));
            (peak.min(1.0) * 255.0).round() as u8
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waveform_bands_separate_kicks_from_hats_and_keep_dynamics() {
        // Stereo frames: 1 s of a 60 Hz tone at half scale, 1 s of an 8 kHz tone at
        // half scale, then 1 s of the 60 Hz tone at a tenth.
        let tone = |hz: f32, amp: f32| (0..SAMPLE_RATE as usize).flat_map(move |i| {
            let v = amp * (std::f32::consts::TAU * hz * i as f32 / SAMPLE_RATE as f32).sin();
            [v, v]
        });
        let samples: Vec<f32> = tone(60.0, 0.5).chain(tone(8000.0, 0.5)).chain(tone(60.0, 0.1)).collect();
        let bands = band_levels(&samples);
        let at = |sec: f32| bands[(sec * SAMPLE_RATE as f32 / WAVE_BLOCK as f32) as usize];
        let kick = at(0.5);
        assert!((kick[0] as i32 - 128).abs() <= 6 && kick[2] < 10, "kick in low only: {kick:?}");
        let hat = at(1.5);
        // 8 kHz is 6 samples a cycle, so the sampled peak reads a little under the true one.
        assert!(hat[2] >= 100 && hat[0] < 10 && hat[1] < 30, "hat in high only: {hat:?}");
        let quiet = at(2.5);
        assert!((quiet[0] as i32 - 26).abs() <= 3, "a tenth of the level reads a tenth: {quiet:?}");
    }

    fn write_wav(path: &Path, rate: u32, channels: u16, frames: usize) {
        let mut data = Vec::new();
        for i in 0..frames {
            let s = ((i as f64 * 440.0 * std::f64::consts::TAU / rate as f64).sin() * 16000.0) as i16;
            for _ in 0..channels {
                data.extend_from_slice(&s.to_le_bytes());
            }
        }
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
        wav.extend_from_slice(&(channels * 2).to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
        wav.extend_from_slice(&data);
        std::fs::write(path, wav).unwrap();
    }

    #[test]
    fn loads_mono_44k1_as_48k_stereo() {
        let dir = std::env::temp_dir().join(format!("x1-d-four-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tone.wav");
        write_wav(&path, 44_100, 1, 44_100);
        let track = load(&path).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert!((track.frames() as i64 - 48_000).abs() <= 2, "frames {}", track.frames());
        let mid = track.frames() / 2 * 2;
        assert_eq!(track.samples[mid], track.samples[mid + 1]);
        let peak = track.samples.iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!((0.45..0.52).contains(&peak), "peak {peak}");
        assert_eq!(track.peaks.len(), PEAK_BUCKETS);
    }

    fn sine(amplitude: f32, seconds: usize) -> Vec<f32> {
        (0..SAMPLE_RATE as usize * seconds)
            .flat_map(|i| {
                let v = amplitude * (std::f32::consts::TAU * 1000.0 * i as f32 / SAMPLE_RATE as f32).sin();
                [v, v]
            })
            .collect()
    }

    #[test]
    fn loudness_of_a_full_scale_sine() {
        // BS.1770: a 0 dBFS 1 kHz sine in both channels measures about 0 LUFS.
        let l = integrated_loudness(&sine(1.0, 5)).unwrap();
        assert!(l.abs() < 0.3, "{l}");
        let quiet = integrated_loudness(&sine(0.1, 5)).unwrap();
        assert!((quiet - (l - 20.0)).abs() < 0.1, "{quiet}");
    }

    #[test]
    fn normalization_cuts_loud_and_boosts_quiet_without_clipping() {
        let loud = normalization_gain(&sine(1.0, 5));
        assert!((20.0 * loud.log10() - TARGET_LUFS as f32).abs() < 0.3, "cuts to the target: {loud}");
        // About −26 LUFS wants +15 dB: held to +9 dB, then to the peak ceiling.
        let quiet = normalization_gain(&sine(0.05, 5));
        assert!(quiet > 1.0 && quiet * 0.05 <= PEAK_CEILING + 1e-4, "{quiet}");
        assert_eq!(normalization_gain(&vec![0.0; 96_000 * 2]), 1.0, "silence is left alone");
    }
}
