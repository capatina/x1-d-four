//! Per-track features in three bands, built from a short-time spectrum: the
//! band's vibe in the body of the track (its louder sections, not the intro,
//! outro or breakdowns).
//!
//! - low (20-250 Hz): kick, sub and bassline. Spectral shape, its movement, the
//!   groove (onset autocorrelation), the beat pattern (where in the beat the
//!   kicks and bass hit, anchored on the kick), how much the bass pumps, tempo.
//! - mid (250-3000 Hz): harmony. Spectral shape, chroma, tonality, how clearly
//!   tonal it is, how fast the harmony moves, major vs minor; and the key.
//! - high (3-16 kHz): hats, percussion and air. Spectral shape, groove, the beat
//!   pattern relative to the kick, density, brightness.
//!
//! Every vector is loudness-independent: levels are relative to the track's own mean.

use realfft::RealFftPlanner;
use serde::{Deserialize, Serialize};

pub const N_FFT: usize = 4096;
pub const HOP: usize = 1024;
/// Sub-bands per band.
pub const SUB: usize = 8;
/// The body: the loudest half of the track's 8 s sections.
const SECTION_SECS: f32 = 8.0;
const BODY_SHARE: f32 = 0.5;
/// Steps per beat in the beat patterns (16ths).
const STEPS: usize = 4;

pub const BAND_EDGES: [(f32, f32); 3] = [(20.0, 250.0), (250.0, 3000.0), (3000.0, 16000.0)];
const CHROMA_RANGE: (f32, f32) = (110.0, 3000.0);
/// Rhythm lags in beats: 16th, 8th, dotted 8th, beat, 1.5 beats, half bar, 3 beats, bar.
const RHYTHM_LAGS: [f32; 8] = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0];

/// Layout of each band's vector, so similarity can weight groups (see `index`).
pub const LOW_DIMS: usize = SUB * 2 + RHYTHM_LAGS.len() + STEPS + 3; // shape, movement, groove, pattern, pump, level, tempo
pub const MID_DIMS: usize = SUB * 2 + 12 + 5; // shape, movement, chroma, flatness, level, clarity, harmonic rhythm, mode
pub const HIGH_DIMS: usize = SUB * 2 + RHYTHM_LAGS.len() + STEPS + 4; // shape, movement, groove, pattern, density, centroid, flatness, level
pub const DIMS: [usize; 3] = [LOW_DIMS, MID_DIMS, HIGH_DIMS];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Features {
    pub tempo: f32,
    pub tempo_from_tag: bool,
    pub duration: f32,
    /// The body's vectors: [low, mid, high].
    pub bands: [Vec<f32>; 3],
    /// Estimated key: 0-11 major (C = 0), 12-23 minor (A minor = 21).
    pub key: u8,
    /// How clearly tonal the track is, 0..1 (chords and melody vs drums and noise).
    pub clarity: f32,
}

/// Krumhansl-Kessler key profiles.
const MAJOR: [f32; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR: [f32; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

fn correlate(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len() as f32;
    let (ma, mb) = (a.iter().sum::<f32>() / n, b.iter().sum::<f32>() / n);
    let (mut num, mut da, mut db) = (0f32, 0f32, 0f32);
    for (x, y) in a.iter().zip(b) {
        num += (x - ma) * (y - mb);
        da += (x - ma).powi(2);
        db += (y - mb).powi(2);
    }
    num / (da * db).sqrt().max(1e-9)
}

/// Key (0-11 major, 12-23 minor) and how much more major than minor it sounds.
fn estimate_key(chroma: &[f32; 12]) -> (u8, f32) {
    let rotated = |profile: &[f32; 12], tonic: usize| -> Vec<f32> { (0..12).map(|i| profile[(i + 12 - tonic) % 12]).collect() };
    let (mut best, mut key) = (f32::MIN, 0u8);
    let (mut best_major, mut best_minor) = (f32::MIN, f32::MIN);
    for tonic in 0..12 {
        let maj = correlate(chroma, &rotated(&MAJOR, tonic));
        let min = correlate(chroma, &rotated(&MINOR, tonic));
        best_major = best_major.max(maj);
        best_minor = best_minor.max(min);
        if maj > best {
            (best, key) = (maj, tonic as u8);
        }
        if min > best {
            (best, key) = (min, 12 + tonic as u8);
        }
    }
    (key, best_major - best_minor)
}

/// Camelot-wheel distance between two keys: 0 same, 1 relative or a fifth away, 2 two steps, more beyond.
pub fn key_distance(a: u8, b: u8) -> u8 {
    let camelot = |k: u8| -> (i32, bool) {
        let (tonic, minor) = ((k % 12) as i32, k >= 12);
        // Minor keys share a number with their relative major (three semitones up).
        let t = if minor { (tonic + 3) % 12 } else { tonic };
        ((t * 7 + 7) % 12, minor)
    };
    let ((na, ma), (nb, mb)) = (camelot(a), camelot(b));
    let d = (na - nb).rem_euclid(12);
    let steps = d.min(12 - d) as u8;
    steps + u8::from(ma != mb)
}

/// Per-frame summary; the full spectrum is never kept.
#[derive(Clone, Copy, Default)]
struct Frame {
    /// log10 energy per sub-band, per band.
    sub: [[f32; SUB]; 3],
    chroma: [f32; 12],
    /// Spectral flatness of mid and high.
    flat: [f32; 2],
    /// Centroid of the high band, 0..1 across 3-16 kHz.
    centroid: f32,
    /// Total linear power, for silence gating.
    power: f32,
}

/// Bin -> (band, sub-band) and bin -> pitch class, for one sample rate.
struct BinMap {
    band_sub: Vec<Option<(usize, usize)>>,
    pitch: Vec<Option<usize>>,
    hz: Vec<f32>,
}

impl BinMap {
    fn new(rate: u32) -> Self {
        let bins = N_FFT / 2 + 1;
        let bin_hz = rate as f32 / N_FFT as f32;
        let mut band_sub = vec![None; bins];
        let mut pitch = vec![None; bins];
        let mut hz = vec![0.0; bins];
        for (b, slot) in band_sub.iter_mut().enumerate() {
            let f = b as f32 * bin_hz;
            hz[b] = f;
            for (band, &(lo, hi)) in BAND_EDGES.iter().enumerate() {
                if f >= lo && f < hi {
                    let k = ((f / lo).ln() / (hi / lo).ln() * SUB as f32) as usize;
                    *slot = Some((band, k.min(SUB - 1)));
                }
            }
            if f >= CHROMA_RANGE.0 && f < CHROMA_RANGE.1 {
                let midi = 69.0 + 12.0 * (f / 440.0).log2();
                pitch[b] = Some((midi.round() as i64).rem_euclid(12) as usize);
            }
        }
        Self { band_sub, pitch, hz }
    }
}

fn spectrum_frames(samples: &[f32], rate: u32) -> Vec<Frame> {
    if samples.len() < N_FFT {
        return Vec::new();
    }
    let map = BinMap::new(rate);
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N_FFT);
    let window: Vec<f32> =
        (0..N_FFT).map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / N_FFT as f32).cos()).collect();
    let mut input = fft.make_input_vec();
    let mut output = fft.make_output_vec();
    let mut scratch = fft.make_scratch_vec();
    let count = (samples.len() - N_FFT) / HOP + 1;
    let mut frames = Vec::with_capacity(count);
    const EPS: f32 = 1e-10;
    for i in 0..count {
        let chunk = &samples[i * HOP..i * HOP + N_FFT];
        for ((d, s), w) in input.iter_mut().zip(chunk).zip(&window) {
            *d = s * w;
        }
        fft.process_with_scratch(&mut input, &mut output, &mut scratch).expect("fft sizes");
        let mut energy = [[0f32; SUB]; 3];
        let mut chroma = [0f32; 12];
        let (mut log_sum, mut lin_sum, mut n) = ([0f32; 2], [0f32; 2], [0usize; 2]);
        let (mut cent_num, mut cent_den) = (0f32, 0f32);
        let mut power = 0f32;
        for (b, c) in output.iter().enumerate() {
            let p = c.norm_sqr();
            power += p;
            if let Some((band, k)) = map.band_sub[b] {
                energy[band][k] += p;
                if band > 0 {
                    log_sum[band - 1] += (p + EPS).ln();
                    lin_sum[band - 1] += p;
                    n[band - 1] += 1;
                }
                if band == 2 {
                    cent_num += map.hz[b] * p;
                    cent_den += p;
                }
            }
            if let Some(pc) = map.pitch[b] {
                chroma[pc] += p.sqrt();
            }
        }
        let mut frame = Frame { power, ..Default::default() };
        for band in 0..3 {
            for k in 0..SUB {
                frame.sub[band][k] = (energy[band][k] + EPS).log10();
            }
        }
        let csum: f32 = chroma.iter().sum::<f32>() + EPS;
        frame.chroma = chroma.map(|c| c / csum);
        for j in 0..2 {
            if n[j] > 0 {
                let geo = (log_sum[j] / n[j] as f32).exp();
                let arith = lin_sum[j] / n[j] as f32 + EPS;
                frame.flat[j] = (geo / arith).clamp(0.0, 1.0);
            }
        }
        frame.centroid = if cent_den > EPS { ((cent_num / cent_den - 3000.0) / 13000.0).clamp(0.0, 1.0) } else { 0.0 };
        frames.push(frame);
    }
    frames
}

/// Half-wave rectified log-energy flux of one band.
fn band_flux(frames: &[Frame], band: usize) -> Vec<f32> {
    let mut flux = vec![0f32; frames.len()];
    for t in 1..frames.len() {
        flux[t] = (0..SUB).map(|k| (frames[t].sub[band][k] - frames[t - 1].sub[band][k]).max(0.0)).sum();
    }
    flux
}

/// Autocorrelation of a mean-removed signal at a fractional lag, normalised by lag 0.
fn acf_at(x: &[f32], lag: f32) -> f32 {
    let n = x.len();
    let l0 = lag.floor() as usize;
    if n < l0 + 3 {
        return 0.0;
    }
    let frac = lag - l0 as f32;
    let var: f32 = x.iter().map(|v| v * v).sum::<f32>() + 1e-9;
    let acf = |l: usize| -> f32 { x[..n - l].iter().zip(&x[l..]).map(|(a, b)| a * b).sum::<f32>() };
    ((1.0 - frac) * acf(l0) + frac * acf(l0 + 1)) / var
}

fn demean(x: &[f32]) -> Vec<f32> {
    let m = x.iter().sum::<f32>() / x.len().max(1) as f32;
    x.iter().map(|v| v - m).collect()
}

/// Tempo from the low-band onset envelope, 70-190 BPM, with a prior around 124
/// BPM against octave errors.
pub fn estimate_tempo_from_flux(flux: &[f32], frame_rate: f32) -> f32 {
    let x = demean(flux);
    // Coarse: a few beat multiples, with a prior around 124 BPM against octave errors.
    let mut best = (f32::MIN, 120.0f32);
    let mut bpm = 70.0f32;
    while bpm <= 190.0 {
        let lag = 60.0 * frame_rate / bpm;
        let score: f32 = (1..=4).map(|m| acf_at(&x, lag * m as f32) / m as f32).sum::<f32>();
        let prior = (-0.5 * ((bpm / 124.0).log2() / 0.5).powi(2)).exp();
        let s = score * (0.5 + 0.5 * prior);
        if s > best.0 {
            best = (s, bpm);
        }
        bpm += 0.25;
    }
    // Fine: long lags (4-32 beats) turn a one-frame error into a tiny tempo error.
    let max_lag = x.len() as f32 * 0.6;
    let coarse = best.1;
    let mut fine = (f32::MIN, coarse);
    let mut bpm = coarse - 1.5;
    while bpm <= coarse + 1.5 {
        let lag = 60.0 * frame_rate / bpm;
        let score: f32 = [4.0f32, 8.0, 16.0, 32.0]
            .iter()
            .filter(|m| lag * *m < max_lag)
            .map(|m| acf_at(&x, lag * m))
            .sum::<f32>();
        if score > fine.0 {
            fine = (score, bpm);
        }
        bpm += 0.01;
    }
    (fine.1 * 100.0).round() / 100.0
}

/// Linear interpolation into a per-frame signal (0 outside it).
fn at(x: &[f32], t: f32) -> f32 {
    if t < 0.0 {
        return 0.0;
    }
    let i = t.floor() as usize;
    if i + 1 >= x.len() {
        return 0.0;
    }
    let f = t - i as f32;
    x[i] * (1.0 - f) + x[i + 1] * f
}

/// Beat phase (in frames) from the low band's onsets: where the kicks land.
fn beat_phase(low_flux: &[f32], beat: f32) -> f32 {
    let beats = (low_flux.len() as f32 / beat) as usize;
    let mut best = (f32::MIN, 0.0);
    let mut o = 0.0;
    while o < beat {
        let score: f32 = (0..beats).map(|k| at(low_flux, o + k as f32 * beat)).sum();
        if score > best.0 {
            best = (score, o);
        }
        o += 0.25;
    }
    best.1
}

/// Where in the beat a band hits: its onset strength on each 16th (on, e, and, a),
/// counted from the kick, as shares of the total; and the share of 16ths that hit hard.
fn beat_pattern(flux: &[f32], phase: f32, beat: f32, body: &[bool]) -> ([f32; STEPS], f32) {
    let mut pattern = [0f32; STEPS];
    let mut steps = Vec::new();
    let mut k = 0;
    loop {
        let t0 = phase + k as f32 * beat;
        if t0 + beat >= flux.len() as f32 {
            break;
        }
        if body.get(t0 as usize).copied().unwrap_or(false) {
            for (s, p) in pattern.iter_mut().enumerate() {
                let v = at(flux, t0 + s as f32 * beat / STEPS as f32);
                *p += v;
                steps.push(v);
            }
        }
        k += 1;
    }
    let total = pattern.iter().sum::<f32>().max(1e-9);
    let pattern = pattern.map(|p| p / total);
    let density = if steps.is_empty() {
        0.0
    } else {
        let mut sorted = steps.clone();
        sorted.sort_by(f32::total_cmp);
        let median = sorted[sorted.len() / 2].max(1e-6);
        steps.iter().filter(|&&v| v > median * 1.5).count() as f32 / steps.len() as f32
    };
    (pattern, density)
}

/// The body: frames in the louder sections (the drops and grooves, not the intro,
/// outro or breakdowns), plus frames above near-silence.
fn body_mask(frames: &[Frame], frame_rate: f32) -> Vec<bool> {
    let per = ((SECTION_SECS * frame_rate) as usize).max(1);
    let energies: Vec<f32> = frames.chunks(per).map(|c| c.iter().map(|f| f.power).sum::<f32>() / c.len() as f32).collect();
    // A short last section (under half the length) goes with the one before it.
    let full = if energies.len() > 1 && frames.len() % per != 0 && frames.len() % per < per / 2 { energies.len() - 1 } else { energies.len() };
    let mut order: Vec<usize> = (0..full).collect();
    order.sort_by(|&a, &b| energies[b].total_cmp(&energies[a]));
    let mut loud = vec![false; energies.len()];
    for &i in order.iter().take(((full as f32 * BODY_SHARE).ceil() as usize).max(1)) {
        loud[i] = true;
    }
    if full < energies.len() {
        loud[full] = loud[full - 1];
    }
    let max_power = frames.iter().map(|f| f.power).fold(0f32, f32::max);
    frames.iter().enumerate().map(|(i, f)| loud[i / per] && f.power > max_power * 1e-6).collect()
}

/// Build the three band vectors and the key from the frames.
fn band_vectors(frames: &[Frame], tempo: f32, frame_rate: f32) -> Option<([Vec<f32>; 3], u8, f32)> {
    let body = body_mask(frames, frame_rate);
    let active: Vec<&Frame> = frames.iter().zip(&body).filter(|(_, b)| **b).map(|(f, _)| f).collect();
    if active.len() < 8 {
        return None;
    }
    let n = active.len() as f32;
    let mut mean = [[0f32; SUB]; 3];
    for f in &active {
        for b in 0..3 {
            for k in 0..SUB {
                mean[b][k] += f.sub[b][k] / n;
            }
        }
    }
    let mut std = [[0f32; SUB]; 3];
    for f in &active {
        for b in 0..3 {
            for k in 0..SUB {
                std[b][k] += (f.sub[b][k] - mean[b][k]).powi(2) / n;
            }
        }
    }
    let std = std.map(|b| b.map(f32::sqrt));
    let global = mean.iter().flatten().sum::<f32>() / (3 * SUB) as f32;
    let level = |b: usize| mean[b].iter().sum::<f32>() / SUB as f32 - global;
    let shape = |b: usize| mean[b].iter().map(|v| v - global).collect::<Vec<_>>();
    let beat = 60.0 * frame_rate / tempo.max(1.0);
    let flux = [band_flux(frames, 0), band_flux(frames, 1), band_flux(frames, 2)];
    let groove = |b: usize| {
        let x = demean(&flux[b]);
        RHYTHM_LAGS.iter().map(|m| acf_at(&x, beat * m)).collect::<Vec<_>>()
    };
    let phase = beat_phase(&flux[0], beat);
    let (low_pattern, _) = beat_pattern(&flux[0], phase, beat, &body);
    let (high_pattern, high_density) = beat_pattern(&flux[2], phase, beat, &body);
    // How much the bass pumps: the low band's energy swing within the body.
    let low_energy: Vec<f32> = active.iter().map(|f| f.sub[0].iter().map(|v| 10f32.powf(*v)).sum::<f32>()).collect();
    let le_mean = low_energy.iter().sum::<f32>() / n;
    let pump = (low_energy.iter().map(|v| (v - le_mean).powi(2)).sum::<f32>() / n).sqrt() / le_mean.max(1e-12);
    let mut chroma = [0f32; 12];
    let mut flat = [0f32; 2];
    let mut centroid = 0f32;
    for f in &active {
        for c in 0..12 {
            chroma[c] += f.chroma[c] / n;
        }
        flat[0] += f.flat[0] / n;
        flat[1] += f.flat[1] / n;
        centroid += f.centroid / n;
    }
    // Tonal clarity: how far the chroma is from flat (1 - normalised entropy).
    let csum = chroma.iter().sum::<f32>().max(1e-9);
    let entropy: f32 = chroma.iter().map(|c| c / csum).filter(|p| *p > 0.0).map(|p| -p * p.ln()).sum::<f32>() / 12f32.ln();
    let clarity = ((1.0 - entropy) * 8.0).clamp(0.0, 1.0);
    // Harmonic rhythm: how much the chroma changes from beat to beat in the body.
    let mut changes = (0f32, 0usize);
    let mut prev: Option<[f32; 12]> = None;
    let mut t = phase;
    while t + beat < frames.len() as f32 {
        let (a, b) = (t as usize, (t + beat) as usize);
        if body[a] {
            let mut c = [0f32; 12];
            for f in &frames[a..b] {
                for i in 0..12 {
                    c[i] += f.chroma[i];
                }
            }
            if let Some(p) = prev {
                let dot: f32 = c.iter().zip(&p).map(|(x, y)| x * y).sum();
                let norm = (c.iter().map(|x| x * x).sum::<f32>() * p.iter().map(|x| x * x).sum::<f32>()).sqrt().max(1e-9);
                changes.0 += 1.0 - dot / norm;
                changes.1 += 1;
            }
            prev = Some(c);
        } else {
            prev = None;
        }
        t += beat;
    }
    let harmonic_rhythm = if changes.1 > 0 { changes.0 / changes.1 as f32 } else { 0.0 };
    let (key, mode) = estimate_key(&chroma);

    let mut low = shape(0);
    low.extend(std[0]);
    low.extend(groove(0));
    low.extend(low_pattern);
    low.push(pump);
    low.push(level(0));
    low.push((tempo / 120.0).log2());
    let mut mid = shape(1);
    mid.extend(std[1]);
    mid.extend(chroma);
    mid.push(flat[0]);
    mid.push(level(1));
    mid.push(clarity);
    mid.push(harmonic_rhythm);
    mid.push(mode);
    let mut high = shape(2);
    high.extend(std[2]);
    high.extend(groove(2));
    high.extend(high_pattern);
    high.push(high_density);
    high.push(centroid);
    high.push(flat[1]);
    high.push(level(2));
    debug_assert_eq!([low.len(), mid.len(), high.len()], DIMS);
    Some(([low, mid, high], key, clarity))
}

/// Analyse mono samples. `tag_bpm` (from the file's tags) wins over the estimate.
pub fn analyse_samples(samples: &[f32], rate: u32, tag_bpm: Option<f64>) -> anyhow::Result<Features> {
    let frames = spectrum_frames(samples, rate);
    let frame_rate = rate as f32 / HOP as f32;
    let tag = tag_bpm.map(|b| b as f32).filter(|b| (60.0..=200.0).contains(b));
    let tempo = tag.unwrap_or_else(|| estimate_tempo_from_flux(&band_flux(&frames, 0), frame_rate));
    let (bands, key, clarity) = band_vectors(&frames, tempo, frame_rate).ok_or_else(|| anyhow::anyhow!("too little audio to analyse"))?;
    Ok(Features { tempo, tempo_from_tag: tag.is_some(), duration: samples.len() as f32 / rate as f32, bands, key, clarity })
}

/// Decode and analyse a file.
pub fn analyse_file(path: &std::path::Path, tag_bpm: Option<f64>) -> anyhow::Result<Features> {
    let (rate, samples) = engine::track::decode_mono(path)?;
    analyse_samples(&samples, rate, tag_bpm)
}

#[cfg(test)]
pub(crate) mod synth {
    //! Synthetic test material.
    pub const RATE: u32 = 44_100;

    pub fn silence(secs: f32) -> Vec<f32> {
        vec![0.0; (secs * RATE as f32) as usize]
    }

    /// Decaying 50 Hz kick on every beat.
    pub fn kicks(out: &mut [f32], bpm: f32, gain: f32) {
        let beat = (60.0 / bpm * RATE as f32) as usize;
        for start in (0..out.len()).step_by(beat) {
            for i in 0..(RATE as usize / 5).min(out.len() - start) {
                let t = i as f32 / RATE as f32;
                let f = 50.0 + 80.0 * (-t * 40.0).exp();
                out[start + i] += gain * (std::f32::consts::TAU * f * t).sin() * (-t * 12.0).exp();
            }
        }
    }

    /// Short noise bursts on the off-beats, crudely high-passed.
    pub fn hats(out: &mut [f32], bpm: f32, gain: f32) {
        let beat = (60.0 / bpm * RATE as f32) as usize;
        let mut seed = 12345u32;
        let mut prev = 0.0;
        for start in (beat / 2..out.len()).step_by(beat) {
            for i in 0..(RATE as usize / 30).min(out.len() - start) {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let white = (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0;
                let hp = white - prev;
                prev = white;
                out[start + i] += gain * hp * (-(i as f32) / RATE as f32 * 60.0).exp();
            }
        }
    }

    /// Sustained chord of sine partials (MIDI note numbers).
    pub fn chord(out: &mut [f32], notes: &[i32], gain: f32) {
        for (i, s) in out.iter_mut().enumerate() {
            let t = i as f32 / RATE as f32;
            for &n in notes {
                let f = 440.0 * 2f32.powf((n - 69) as f32 / 12.0);
                *s += gain * ((std::f32::consts::TAU * f * t).sin() + 0.3 * (std::f32::consts::TAU * 2.0 * f * t).sin());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::synth::*;
    use super::*;

    #[test]
    fn tempo_of_a_kick_loop() {
        for bpm in [122.0f32, 128.0, 135.0] {
            let mut x = silence(40.0);
            kicks(&mut x, bpm, 0.8);
            let f = analyse_samples(&x, RATE, None).unwrap();
            assert!((f.tempo - bpm).abs() < 0.6, "estimated {} for {bpm}", f.tempo);
            assert!(!f.tempo_from_tag);
        }
    }

    #[test]
    fn tag_bpm_wins() {
        let mut x = silence(20.0);
        kicks(&mut x, 128.0, 0.8);
        let f = analyse_samples(&x, RATE, Some(127.5)).unwrap();
        assert_eq!(f.tempo, 127.5);
        assert!(f.tempo_from_tag);
    }

    #[test]
    fn vectors_have_the_documented_shape() {
        let mut x = silence(30.0);
        kicks(&mut x, 126.0, 0.8);
        hats(&mut x, 126.0, 0.3);
        let f = analyse_samples(&x, RATE, None).unwrap();
        assert_eq!([f.bands[0].len(), f.bands[1].len(), f.bands[2].len()], DIMS);
        assert!(f.bands.iter().flatten().all(|v| v.is_finite()));
    }

    #[test]
    fn beat_patterns_hear_where_the_hits_land() {
        // Kicks on the beat, hats on the off-beat: the low pattern peaks on step 0, the high on step 2.
        let mut x = silence(30.0);
        kicks(&mut x, 125.0, 0.8);
        hats(&mut x, 125.0, 0.4);
        let f = analyse_samples(&x, RATE, None).unwrap();
        let p = SUB * 2 + RHYTHM_LAGS.len();
        let low = &f.bands[0][p..p + STEPS];
        let high = &f.bands[2][p..p + STEPS];
        assert!(low[0] > low[1] && low[0] > low[2] && low[0] > low[3], "low {low:?}");
        // The kick's attack reaches the highs too; the hats show as the off-beat, relative to it.
        assert!(high[2] > high[1] && high[2] > high[3], "high {high:?}");
        assert!(high[2] / high[0] > 4.0 * low[2] / low[0], "high {high:?} low {low:?}");
    }

    #[test]
    fn keys_and_the_camelot_wheel() {
        let mut x = silence(20.0);
        chord(&mut x, &[60, 64, 67, 72], 0.1);
        let c = analyse_samples(&x, RATE, None).unwrap();
        assert_eq!(c.key, 0, "C major");
        assert!(c.clarity > 0.3, "clarity {}", c.clarity);
        let mut y = silence(20.0);
        chord(&mut y, &[57, 60, 64, 69], 0.1);
        assert_eq!(analyse_samples(&y, RATE, None).unwrap().key, 21, "A minor");
        assert_eq!(key_distance(0, 21), 1, "relative minor");
        assert_eq!(key_distance(0, 7), 1, "a fifth up");
        assert_eq!(key_distance(0, 5), 1, "a fifth down");
        assert_eq!(key_distance(0, 0), 0);
        assert!(key_distance(0, 6) >= 6, "tritone is far");
    }

    #[test]
    fn the_body_ignores_a_long_quiet_intro() {
        // 40 s of soft hats, then 40 s of kicks over them: the body is the kick section.
        let mut x = silence(80.0);
        let half = x.len() / 2;
        hats(&mut x, 125.0, 0.05);
        kicks(&mut x[half..], 125.0, 0.8);
        let frames = spectrum_frames(&x, RATE);
        let frame_rate = RATE as f32 / HOP as f32;
        let body = body_mask(&frames, frame_rate);
        let split = (40.0 * frame_rate) as usize;
        assert!(body[..split - 10].iter().all(|b| !b), "the intro is not the body");
        let in_body = body[split + 10..].iter().filter(|b| **b).count();
        // (Near-silent frames between the synthetic kicks are left out, like any silence.)
        assert!(in_body as f32 > (body.len() - split - 10) as f32 * 0.5, "the kicks are the body: {in_body}");
    }
}
