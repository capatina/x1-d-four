//! The 120 Hz feed for the Explore view: a spectrum of what the decks send, band
//! levels, kick onsets and the beat phase from the mixer's MIDI clock. Only does
//! work while someone is looking at the tunnel.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use engine::{DECKS, SAMPLE_RATE};
use realfft::RealFftPlanner;
use serde_json::json;

use crate::app::App;

const N: usize = 2048;
const BINS: usize = 64;
const FRAME: Duration = Duration::from_micros(8_333);

/// RMS of a music signal sits well below 1; this maps typical levels onto 0..1.
fn level(rms: f32) -> f32 {
    (rms * 2.5).min(1.0)
}

/// FFT bin ranges for 64 log-spaced bands between 30 Hz and 16 kHz.
fn bin_ranges() -> Vec<(usize, usize)> {
    let hz = SAMPLE_RATE as f32 / N as f32;
    (0..BINS)
        .map(|i| {
            let f0 = 30.0 * (16_000.0f32 / 30.0).powf(i as f32 / BINS as f32);
            let f1 = 30.0 * (16_000.0f32 / 30.0).powf((i + 1) as f32 / BINS as f32);
            let a = (f0 / hz).floor() as usize;
            let b = ((f1 / hz).ceil() as usize).max(a + 1).min(N / 2);
            (a, b)
        })
        .collect()
}

pub fn run(app: Arc<App>, mut rx: rtrb::Consumer<f32>, stop: Arc<AtomicBool>) {
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(N);
    let hann: Vec<f32> = (0..N).map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / N as f32).cos()).collect();
    let ranges = bin_ranges();
    let mut ring = vec![0f32; N];
    let mut write = 0usize;
    let mut input = fft.make_input_vec();
    let mut output = fft.make_output_vec();
    let mut scratch = fft.make_scratch_vec();
    let mut smooth = [0f32; BINS];
    let mut low_avg = 0f32;
    let mut last_onset = Instant::now();
    let (mut tick_count, mut tick_at) = (u64::MAX, Instant::now());
    let mut next = Instant::now();

    while !stop.load(Ordering::Relaxed) {
        next += FRAME;
        match next.checked_duration_since(Instant::now()) {
            Some(wait) => std::thread::sleep(wait),
            None => next = Instant::now(),
        }
        while let Ok(x) = rx.pop() {
            ring[write] = x;
            write = (write + 1) % N;
        }
        if !app.explore.view.load(Ordering::Relaxed) || app.tx.receiver_count() == 0 {
            continue;
        }

        for (i, (d, w)) in input.iter_mut().zip(&hann).enumerate() {
            *d = ring[(write + i) % N] * w;
        }
        if fft.process_with_scratch(&mut input, &mut output, &mut scratch).is_err() {
            continue;
        }
        let mut spectrum = [0u8; BINS];
        for (i, &(a, b)) in ranges.iter().enumerate() {
            let mag = output[a..b].iter().map(|c| c.norm()).fold(0f32, f32::max);
            let db = 20.0 * (mag * 4.0 / N as f32 + 1e-9).log10();
            let v = ((db + 72.0) / 72.0).clamp(0.0, 1.0);
            smooth[i] = v.max(smooth[i] * 0.86);
            spectrum[i] = (smooth[i] * 255.0) as u8;
        }

        let levels = app.shared.levels();
        let decks: Vec<[f32; 3]> = levels.iter().map(|d| d.map(level)).collect();
        let total: [f32; 3] =
            std::array::from_fn(|b| level((0..DECKS).map(|d| levels[d][b] * levels[d][b]).sum::<f32>().sqrt()));
        low_avg = 0.92 * low_avg + 0.08 * total[0];
        let onset = total[0] > low_avg * 1.35 + 0.03 && last_onset.elapsed() > Duration::from_millis(150);
        if onset {
            last_onset = Instant::now();
        }

        // Beat phase from the mixer's MIDI clock (24 ticks per beat), smoothed between ticks.
        let bpm = app.bpm();
        let ticks = app.shared.clock_ticks.load(Ordering::Relaxed);
        if ticks != tick_count {
            tick_count = ticks;
            tick_at = Instant::now();
        }
        let beat = bpm.filter(|b| *b > 0.0).map(|b| {
            let tick_secs = 60.0 / (b as f32 * 24.0);
            let frac = (tick_at.elapsed().as_secs_f32() / tick_secs).min(1.0);
            (((ticks % 24) as f32 + frac) / 24.0).fract()
        });

        let round = |v: f32| (v * 1000.0).round() / 1000.0;
        app.broadcast(json!({
            "type": "viz",
            "t": app.started.elapsed().as_millis() as u64,
            "spectrum": spectrum.to_vec(),
            "bands": total.map(round),
            "decks": decks.iter().map(|d| d.map(round)).collect::<Vec<_>>(),
            "onset": onset,
            "beat": beat.map(round),
            "bpm": bpm,
            // The mixer's record pairs, loudest since the last frame: the mix volume and each
            // channel after its fader, at the feed's full rate.
            "returns": app.shared.take_input_band_peaks().map(|p| p.map(|v| (v * 10000.0).round() / 10000.0)),
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bins_cover_30hz_to_16khz_in_order() {
        let r = bin_ranges();
        assert_eq!(r.len(), BINS);
        assert!(r.iter().all(|(a, b)| a < b && *b <= N / 2));
        assert!(r.windows(2).all(|w| w[0].0 <= w[1].0));
        assert_eq!(r[0].0, 1);
        assert!(r[BINS - 1].1 >= 682 && r[BINS - 1].1 <= 684);
    }
}
