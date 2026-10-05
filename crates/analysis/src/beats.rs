//! Beat grid: tempo and the position of the first beat, precise to about a
//! millisecond, from a kick-band onset envelope sampled at 1 kHz.

/// Tempo in BPM and the first beat, in seconds from the start of the track.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BeatGrid {
    pub bpm: f64,
    pub first_beat: f64,
}

impl BeatGrid {
    pub fn beat_seconds(&self) -> f64 {
        60.0 / self.bpm
    }

    /// Phase within the beat (0..1) at `seconds`.
    pub fn phase_at(&self, seconds: f64) -> f64 {
        ((seconds - self.first_beat) / self.beat_seconds()).rem_euclid(1.0)
    }
}

const ENV_RATE: f64 = 1000.0;

/// Kick-band onset strength at 1 kHz: band-pass ~40-160 Hz, rectify, smooth,
/// then the positive slope.
fn onset_envelope(mono: &[f32], rate: u32) -> Vec<f32> {
    let fs = rate as f32;
    let a_hp = (-std::f32::consts::TAU * 40.0 / fs).exp();
    let a_lp = 1.0 - (-std::f32::consts::TAU * 160.0 / fs).exp();
    let a_env = 1.0 - (-std::f32::consts::TAU * 30.0 / fs).exp();
    let step = (fs as f64 / ENV_RATE).max(1.0);
    let (mut hp_prev_in, mut hp, mut lp, mut env) = (0f32, 0f32, 0f32, 0f32);
    let mut out = Vec::with_capacity((mono.len() as f64 / step) as usize + 1);
    let mut next = 0.0f64;
    for (i, &x) in mono.iter().enumerate() {
        hp = a_hp * (hp + x - hp_prev_in);
        hp_prev_in = x;
        lp += a_lp * (hp - lp);
        env += a_env * (lp.abs() - env);
        if i as f64 >= next {
            out.push(env);
            next += step;
        }
    }
    let mut onset = vec![0f32; out.len()];
    for i in 1..out.len() {
        onset[i] = (out[i] - out[i - 1]).max(0.0);
    }
    onset
}

/// Sum of the envelope at every beat for a given period and offset (in envelope samples).
fn comb(env: &[f32], period: f64, offset: f64) -> f32 {
    let mut t = offset;
    let mut sum = 0.0;
    let last = env.len() as f64 - 2.0;
    while t < last {
        let i = t as usize;
        let f = (t - i as f64) as f32;
        sum += env[i] * (1.0 - f) + env[i + 1] * f;
        t += period;
    }
    sum
}

/// Find the grid near `tempo_hint` (BPM): tempo within ±0.6 %, first beat to 1 ms.
pub fn beat_grid(mono: &[f32], rate: u32, tempo_hint: f64) -> Option<BeatGrid> {
    if !(40.0..=250.0).contains(&tempo_hint) || mono.len() < rate as usize * 10 {
        return None;
    }
    let env = onset_envelope(mono, rate);
    let mut best = (f32::MIN, tempo_hint, 0.0f64);
    // Coarse tempo steps, then fine around the best.
    for (span, step) in [(0.006, 0.0005), (0.0006, 0.00002)] {
        let centre = best.1;
        let mut ratio = 1.0 - span;
        while ratio <= 1.0 + span {
            let bpm = centre * ratio;
            let period = 60.0 * ENV_RATE / bpm;
            let mut offset = 0.0;
            while offset < period {
                let s = comb(&env, period, offset);
                if s > best.0 {
                    best = (s, bpm, offset);
                }
                offset += 1.0;
            }
            ratio += step;
        }
    }
    let (_, bpm, offset) = best;
    Some(refine_by_drift(&env, BeatGrid { bpm, first_beat: offset / ENV_RATE }))
}

/// Measure where the beats fall in 30 s windows across the track and fit a line
/// through them: its slope corrects the tempo, so the grid still sits on the
/// kicks at the end of a long track. Falls back to `grid` if the fit is poor.
fn refine_by_drift(env: &[f32], grid: BeatGrid) -> BeatGrid {
    let period = 60.0 * ENV_RATE / grid.bpm;
    let (win, hop) = (30.0 * ENV_RATE, 15.0 * ENV_RATE);
    // (window centre in s, beat offset in envelope samples relative to the grid, weight)
    let mut points: Vec<(f64, f64, f64)> = Vec::new();
    let mut start = 0.0;
    while start + win <= env.len() as f64 {
        let (a, b) = (start as usize, (start + win) as usize);
        let w = &env[a..b];
        let mut best = (f32::MIN, 0.0);
        let mut sum = 0.0f64;
        let mut n = 0.0f64;
        let mut o = 0.0;
        while o < period {
            let s = comb(w, period, o);
            sum += s as f64;
            n += 1.0;
            if s > best.0 {
                best = (s, o);
            }
            o += 0.5;
        }
        let mean = sum / n.max(1.0);
        // How clearly this window has a beat: peak over mean of the comb.
        let clarity = if mean > 0.0 { best.0 as f64 / mean } else { 0.0 };
        if clarity > 1.5 {
            // Offset relative to where the global grid puts the beat, wrapped to +-half a beat.
            let predicted = (grid.first_beat * ENV_RATE - a as f64).rem_euclid(period);
            let d = (best.1 - predicted + period / 2.0).rem_euclid(period) - period / 2.0;
            points.push(((a as f64 + win / 2.0) / ENV_RATE, d, clarity - 1.0));
        }
        start += hop;
    }
    if points.len() < 4 {
        return grid;
    }
    // Weighted least squares d(t) = c + m * t (envelope samples per second).
    let sw: f64 = points.iter().map(|p| p.2).sum();
    let mt = points.iter().map(|p| p.0 * p.2).sum::<f64>() / sw;
    let md = points.iter().map(|p| p.1 * p.2).sum::<f64>() / sw;
    let sxx: f64 = points.iter().map(|p| p.2 * (p.0 - mt).powi(2)).sum();
    if sxx <= 0.0 {
        return grid;
    }
    let m = points.iter().map(|p| p.2 * (p.0 - mt) * (p.1 - md)).sum::<f64>() / sxx;
    let c = md - m * mt;
    let residual = (points.iter().map(|p| p.2 * (p.1 - c - m * p.0).powi(2)).sum::<f64>() / sw).sqrt();
    // Only trust a straight line (constant tempo); a wobbly fit means tempo changes.
    if residual > 15.0 {
        return grid;
    }
    // Beats arrive m/1000 s later per second than the grid says: the true period is longer.
    let drift = m / ENV_RATE;
    let bpm = grid.bpm / (1.0 + drift);
    let first_beat = (grid.first_beat + c / ENV_RATE).rem_euclid(60.0 / bpm);
    BeatGrid { bpm, first_beat }
}

/// Where the beats fall (seconds, modulo one beat) within a window, for a fixed
/// tempo. Comparing early and late windows shows whether a tempo drifts.
pub fn local_offset(mono: &[f32], rate: u32, bpm: f64, from: f64, to: f64) -> f64 {
    let env = onset_envelope(mono, rate);
    let (a, b) = ((from * ENV_RATE) as usize, ((to * ENV_RATE) as usize).min(env.len()));
    let window = &env[a.min(b)..b];
    let period = 60.0 * ENV_RATE / bpm;
    let mut best = (f32::MIN, 0.0);
    let mut offset = 0.0;
    while offset < period {
        let s = comb(window, period, offset);
        if s > best.0 {
            best = (s, offset);
        }
        offset += 0.5;
    }
    // Back to track time, modulo one beat.
    ((a as f64 + best.1) / ENV_RATE).rem_euclid(60.0 / bpm)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::synth::*;

    fn kicks_from(out: &mut [f32], bpm: f64, start: f64) {
        let beat = 60.0 / bpm * RATE as f64;
        let mut t = start * RATE as f64;
        while (t as usize) < out.len() {
            let s0 = t as usize;
            for i in 0..(RATE as usize / 6).min(out.len() - s0) {
                let tt = i as f32 / RATE as f32;
                out[s0 + i] += 0.8 * (std::f32::consts::TAU * (50.0 + 70.0 * (-tt * 40.0).exp()) * tt).sin() * (-tt * 14.0).exp();
            }
            t += beat;
        }
    }

    #[test]
    fn finds_tempo_and_first_beat() {
        for (bpm, start) in [(128.0, 0.137), (124.3, 0.402), (131.0, 0.0)] {
            let mut x = silence(60.0);
            kicks_from(&mut x, bpm, start);
            // A rounded tag-like hint.
            let g = beat_grid(&x, RATE, bpm.round()).unwrap();
            assert!((g.bpm - bpm).abs() < 0.02, "bpm {} vs {bpm}", g.bpm);
            // The detected beat sits on a kick (allow for the envelope's attack).
            let err = (g.phase_at(start) + 0.5).rem_euclid(1.0) - 0.5;
            assert!((err * g.beat_seconds()).abs() < 0.012, "phase error {:.4} s", err * g.beat_seconds());
        }
    }

    #[test]
    fn needs_a_plausible_hint_and_enough_audio() {
        assert!(beat_grid(&silence(5.0), RATE, 128.0).is_none());
        assert!(beat_grid(&silence(20.0), RATE, 0.0).is_none());
    }
}
