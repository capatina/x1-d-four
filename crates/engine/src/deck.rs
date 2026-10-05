//! One deck: a loaded track, a playhead, and transport. Rendered on the RT thread.

use std::sync::Arc;

use crate::track::Track;

/// Frames for fade-in/out around start, stop and jumps, to avoid clicks (~2.7 ms).
const FADE_FRAMES: f32 = 128.0;

#[derive(Default)]
pub struct Deck {
    pub track: Option<Arc<Track>>,
    pub position: f64,
    pub playing: bool,
    /// Speed actually used: `base_rate`, or the sync engine's choice while synced.
    pub rate: f64,
    /// Speed the user set (pitch fader).
    pub base_rate: f64,
    /// Lock tempo and phase to the master deck. Survives loads.
    pub sync: bool,
    pub trim: f32,
    pub cue: f64,
    /// Playing only while the cue button is held.
    cue_preview: bool,
    /// 0..1 gain ramp used to de-click transport changes.
    fade: f32,
    /// A jump waiting for the fade-out to finish.
    pending_seek: Option<f64>,
    /// Stop once the pending jump lands.
    stop_after_seek: bool,
}

/// What a render pass reports back.
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
pub struct RenderOutcome {
    pub ended: bool,
}

impl Deck {
    pub fn new() -> Self {
        Self { rate: 1.0, base_rate: 1.0, trim: 1.0, ..Default::default() }
    }

    pub fn grid(&self) -> Option<crate::track::Grid> {
        self.track.as_ref().and_then(|t| t.grid)
    }

    pub fn len(&self) -> f64 {
        self.track.as_ref().map_or(0.0, |t| t.frames() as f64)
    }

    /// Swap in a new track; returns the old one so the caller can free it off the RT thread.
    pub fn load(&mut self, track: Option<Arc<Track>>) -> Option<Arc<Track>> {
        self.playing = false;
        self.cue_preview = false;
        self.position = 0.0;
        self.cue = 0.0;
        self.fade = 0.0;
        self.pending_seek = None;
        self.stop_after_seek = false;
        std::mem::replace(&mut self.track, track)
    }

    pub fn play(&mut self) {
        if self.track.is_some() && self.position < self.len() {
            self.playing = true;
            self.cue_preview = false;
            self.stop_after_seek = false;
        }
    }

    pub fn pause(&mut self) {
        self.playing = false;
        self.cue_preview = false;
    }

    pub fn toggle(&mut self) {
        if self.playing { self.pause() } else { self.play() }
    }

    pub fn seek(&mut self, frame: f64) {
        let frame = frame.clamp(0.0, self.len());
        if self.playing || self.fade > 0.0 {
            self.pending_seek = Some(frame);
        } else {
            self.position = frame;
        }
    }

    pub fn nudge(&mut self, frames: f64) {
        let target = self.pending_seek.unwrap_or(self.position) + frames;
        self.seek(target);
    }

    /// CDJ-style cue. Playing: jump back to the cue point and stop.
    /// Paused: set the cue point here and play while held; on release, return to it.
    pub fn cue(&mut self, pressed: bool) {
        if self.track.is_none() {
            return;
        }
        if pressed {
            if self.playing && !self.cue_preview {
                self.pending_seek = Some(self.cue);
                self.stop_after_seek = true;
            } else {
                self.cue = self.pending_seek.unwrap_or(self.position);
                self.play();
                self.cue_preview = true;
            }
        } else if self.cue_preview {
            self.cue_preview = false;
            self.pending_seek = Some(self.cue);
            self.stop_after_seek = true;
        }
    }

    /// Mix this deck's next frames into `out` (interleaved stereo).
    pub fn render(&mut self, out: &mut [[f32; 2]]) -> RenderOutcome {
        let mut outcome = RenderOutcome::default();
        let Some(track) = self.track.clone() else {
            out.fill([0.0; 2]);
            return outcome;
        };
        let samples = &track.samples;
        let len = (samples.len() / 2) as f64;
        let step = 1.0 / FADE_FRAMES;
        for o in out.iter_mut() {
            let target = if self.playing && self.pending_seek.is_none() { 1.0 } else { 0.0 };
            if self.fade < target {
                self.fade = (self.fade + step).min(1.0);
            } else if self.fade > target {
                self.fade = (self.fade - step).max(0.0);
            }
            if self.fade == 0.0 {
                if let Some(to) = self.pending_seek.take() {
                    self.position = to;
                    if self.stop_after_seek {
                        self.playing = false;
                        self.stop_after_seek = false;
                    }
                }
                if !self.playing {
                    *o = [0.0; 2];
                    continue;
                }
            }
            let [l, r] = sample_at(samples, self.position);
            let g = self.fade * self.trim;
            *o = [l * g, r * g];
            self.position += self.rate;
            if self.position >= len {
                self.position = len;
                self.playing = false;
                self.cue_preview = false;
                self.fade = 0.0;
                outcome.ended = true;
            }
        }
        outcome
    }
}

/// Cubic Hermite interpolation at a fractional frame position.
#[inline]
fn sample_at(samples: &[f32], pos: f64) -> [f32; 2] {
    let frames = samples.len() / 2;
    let i = pos.floor() as isize;
    let t = (pos - i as f64) as f32;
    let at = |k: isize, c: usize| -> f32 {
        if k < 0 || k as usize >= frames { 0.0 } else { samples[k as usize * 2 + c] }
    };
    let mut out = [0.0; 2];
    for (c, o) in out.iter_mut().enumerate() {
        let (x0, x1, x2, x3) = (at(i - 1, c), at(i, c), at(i + 1, c), at(i + 2, c));
        if t == 0.0 {
            *o = x1;
            continue;
        }
        let c1 = 0.5 * (x2 - x0);
        let c2 = x0 - 2.5 * x1 + 2.0 * x2 - 0.5 * x3;
        let c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2);
        *o = ((c3 * t + c2) * t + c1) * t + x1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn ramp(frames: usize) -> Arc<Track> {
        let samples = (0..frames).flat_map(|i| [i as f32 / frames as f32, -(i as f32) / frames as f32]).collect();
        Arc::new(Track::from_samples(PathBuf::from("ramp"), samples))
    }

    fn run(deck: &mut Deck, frames: usize) -> (Vec<[f32; 2]>, bool) {
        let mut out = vec![[0.0; 2]; frames];
        let ended = deck.render(&mut out).ended;
        (out, ended)
    }

    #[test]
    fn plays_from_start_with_fade_in() {
        let mut d = Deck::new();
        d.load(Some(ramp(48_000)));
        d.play();
        let (out, _) = run(&mut d, 400);
        assert!(out[0][0].abs() < 1e-6);
        let (out, _) = run(&mut d, 1);
        assert!((out[0][0] - 400.0 / 48_000.0).abs() < 1e-6);
        assert_eq!(d.position, 401.0);
    }

    #[test]
    fn stops_at_end_and_reports_it() {
        let mut d = Deck::new();
        d.load(Some(ramp(100)));
        d.play();
        let (_, ended) = run(&mut d, 160);
        assert!(ended);
        assert!(!d.playing);
        assert_eq!(d.position, 100.0);
    }

    #[test]
    fn pause_fades_out_then_holds_position() {
        let mut d = Deck::new();
        d.load(Some(ramp(48_000)));
        d.play();
        run(&mut d, 1000);
        d.pause();
        run(&mut d, 200);
        let held = d.position;
        assert!(held > 1000.0 && held < 1000.0 + FADE_FRAMES as f64 + 1.0);
        let (out, _) = run(&mut d, 80);
        assert_eq!(d.position, held);
        assert!(out.iter().all(|s| *s == [0.0, 0.0]));
    }

    #[test]
    fn seek_while_playing_lands_after_fade() {
        let mut d = Deck::new();
        d.load(Some(ramp(48_000)));
        d.play();
        run(&mut d, 1000);
        d.seek(10_000.0);
        run(&mut d, FADE_FRAMES as usize + 1);
        assert!(d.position >= 10_000.0 && d.position <= 10_002.0);
        assert!(d.playing);
    }

    #[test]
    fn cue_sets_previews_and_returns() {
        let mut d = Deck::new();
        d.load(Some(ramp(48_000)));
        d.seek(5000.0);
        d.cue(true);
        assert_eq!(d.cue, 5000.0);
        run(&mut d, 1000);
        assert!(d.playing);
        d.cue(false);
        run(&mut d, 400);
        assert!(!d.playing);
        assert_eq!(d.position, 5000.0);
        // Playing: cue jumps back and stops.
        d.play();
        run(&mut d, 2000);
        d.cue(true);
        run(&mut d, 400);
        assert!(!d.playing);
        assert_eq!(d.position, 5000.0);
    }

    #[test]
    fn varispeed_interpolates() {
        let mut d = Deck::new();
        d.load(Some(ramp(48_000)));
        d.rate = 0.5;
        d.seek(1000.0);
        d.play();
        run(&mut d, 400);
        let (out, _) = run(&mut d, 1);
        // A linear ramp interpolates exactly.
        assert!((out[0][0] as f64 - d.position.mul_add(1.0, -0.5) / 48_000.0).abs() < 1e-5);
    }
}
