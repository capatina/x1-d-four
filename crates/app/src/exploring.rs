//! Wiring the explorer into the app: library analysis, following the playing
//! deck, section updates, commands, and the `explore` / `analysis` messages.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use analysis::{Band, Cache, Index, Job};
use engine::{DECKS, SAMPLE_RATE};
use serde_json::{Value, json};

use crate::app::App;
use crate::explore::{Explorer, SECTION_WEIGHT};

/// Analysis results the explorer reads: the index and the cached features (for sections).
pub struct AnalysisData {
    pub index: Index,
    pub cache: Cache,
}

#[derive(Default, Clone)]
pub struct AnalysisStatus {
    pub done: usize,
    pub total: usize,
    pub running: bool,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct ExploreState {
    pub explorer: Mutex<Explorer>,
    pub data: RwLock<Option<Arc<AnalysisData>>>,
    pub status: Mutex<AnalysisStatus>,
    pub view: AtomicBool,
    last_tick: Mutex<Option<Instant>>,
    /// Jog ticks collected towards the next band change, and when the last came in.
    band_ticks: Mutex<(i32, Option<Instant>)>,
    xfader: Mutex<CrossfaderBand>,
}

impl App {
    // ---- analysis -----------------------------------------------------------

    /// Analyse new or changed tracks in the background, then (re)build the index.
    pub fn start_analysis(self: &Arc<Self>) {
        {
            let mut st = self.explore.status.lock().unwrap();
            if st.running {
                return;
            }
            st.running = true;
            st.error = None;
        }
        let app = self.clone();
        std::thread::Builder::new()
            .name("x1d4-analysis".into())
            .spawn(move || app.run_analysis())
            .expect("analysis thread");
    }

    fn run_analysis(self: &Arc<Self>) {
        let started = Instant::now();
        let jobs: Vec<Job> = self
            .library
            .read()
            .unwrap()
            .tracks
            .iter()
            .filter_map(|t| Job::new(t.id.clone(), t.path.clone(), t.bpm))
            .collect();
        let path = Cache::default_path();
        let cache = Mutex::new(Cache::load(&path));
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get().saturating_sub(4).max(1));
        let last_sent = Mutex::new(Instant::now() - Duration::from_secs(1));
        let analysed = analysis::analyse_library(&jobs, &cache, &path, threads, &|done, total| {
            {
                let mut st = self.explore.status.lock().unwrap();
                st.done = done;
                st.total = total;
            }
            let mut last = last_sent.lock().unwrap();
            if last.elapsed() > Duration::from_millis(500) || done == total {
                *last = Instant::now();
                self.broadcast(self.analysis_json());
            }
        });
        let cache = cache.into_inner().unwrap();
        let items: Vec<(String, &analysis::Features)> =
            jobs.iter().filter_map(|j| cache.features(&j.id).map(|f| (j.id.clone(), f))).collect();
        let failed = jobs.len() - items.len();
        let index = Index::build(&items);
        tracing::info!(analysed, indexed = index.len(), failed, took = ?started.elapsed(), "library analysis ready");
        *self.explore.data.write().unwrap() = Some(Arc::new(AnalysisData { index, cache }));
        {
            let mut st = self.explore.status.lock().unwrap();
            // Unreadable files are skipped, not an error; `failed` is in the log.
            st.running = false;
        }
        self.broadcast(self.analysis_json());
        // A rescan can change indices: start the tree over.
        self.explore.explorer.lock().unwrap().reset();
        self.explore_tick(true);
    }

    pub fn analysis_json(&self) -> Value {
        let st = self.explore.status.lock().unwrap().clone();
        json!({ "type": "analysis", "done": st.done, "total": st.total, "running": st.running, "error": st.error })
    }

    /// Beat grid for a freshly decoded track: the analysed tempo (or the tag) as a
    /// starting point, refined with the first beat on the samples the deck plays.
    pub fn beat_grid(&self, track: &crate::library::LibTrack, decoded: &engine::Track) -> Option<engine::Grid> {
        let hint = self
            .data()
            .and_then(|d| d.cache.features(&track.id).map(|f| f.tempo as f64))
            .or(track.bpm)?;
        let mono: Vec<f32> = decoded.samples.chunks_exact(2).map(|f| 0.5 * (f[0] + f[1])).collect();
        let grid = analysis::beat_grid(&mono, SAMPLE_RATE, hint)?;
        Some(engine::Grid { bpm: grid.bpm, first_beat: grid.first_beat * SAMPLE_RATE as f64 })
    }

    // ---- view -----------------------------------------------------------------

    pub fn view_name(&self) -> &'static str {
        if self.explore.view.load(Ordering::Relaxed) { "explore" } else { "decks" }
    }

    pub fn set_view(&self, explore: bool) {
        self.explore.view.store(explore, Ordering::Relaxed);
    }

    // ---- tree -----------------------------------------------------------------

    fn data(&self) -> Option<Arc<AnalysisData>> {
        self.explore.data.read().unwrap().clone()
    }

    /// Tracks loaded on decks don't show up as portals.
    fn exclusions(&self, data: &AnalysisData) -> HashSet<usize> {
        let ui = self.ui.lock().unwrap();
        ui.decks.iter().filter_map(|d| d.track.as_ref()).filter_map(|t| data.index.position(&t.id)).collect()
    }

    /// The root's query: its own vector blended with the section playing now.
    fn root_query(&self, data: &AnalysisData, ex: &Explorer) -> Option<Vec<f32>> {
        let (root, deck) = (ex.root()?, ex.root_deck?);
        let snap = self.shared.deck(deck);
        let features = data.cache.features(&data.index.ids[root])?;
        let section = features.section_at(snap.position / SAMPLE_RATE as f64)?;
        let own = data.index.vector(ex.band, root);
        let now = data.index.embed(ex.band, &section[ex.band.index()]);
        Some(Index::blend(own, &now, SECTION_WEIGHT))
    }

    fn section_of(&self, ex: &Explorer) -> Option<usize> {
        let deck = ex.root_deck?;
        let snap = self.shared.deck(deck);
        snap.playing.then(|| (snap.position / SAMPLE_RATE as f64 / analysis::features::SECTION_SECS as f64) as usize)
    }

    /// Publish the tree and make the aimed portal the library selection.
    fn explore_changed(&self, data: &AnalysisData, ex: &Explorer, reason: &str) {
        self.broadcast(ex.to_json(&data.index, reason));
        if let Some(aim) = ex.aimed() {
            // Not `select`: that syncs back into the explorer, whose lock we hold.
            self.select_from_explorer(data.index.ids[aim].clone());
        }
    }

    pub fn explore_json(&self) -> Option<Value> {
        let data = self.data()?;
        Some(self.explore.explorer.lock().unwrap().to_json(&data.index, "init"))
    }

    /// The library selection moved (mixer encoder, UI): aim at it if it's a portal.
    pub fn explore_follow_selection(&self, id: &str) {
        let Some(data) = self.data() else { return };
        let Some(track) = data.index.position(id) else { return };
        let mut ex = self.explore.explorer.lock().unwrap();
        if ex.aimed() != Some(track) && ex.aim_at(track) {
            self.broadcast(ex.to_json(&data.index, "aim"));
        }
    }

    /// Follow the playing deck and the section it's in. Runs about twice a second.
    pub fn explore_tick(&self, force: bool) {
        {
            let mut last = self.explore.last_tick.lock().unwrap();
            if !force && last.is_some_and(|t| t.elapsed() < Duration::from_millis(500)) {
                return;
            }
            *last = Some(Instant::now());
        }
        let Some(data) = self.data() else { return };
        // The tree grows from the focused deck's track (playing or not).
        let (focused, tracks): (usize, [Option<String>; DECKS]) = {
            let ui = self.ui.lock().unwrap();
            (ui.focused, std::array::from_fn(|d| ui.decks[d].track.as_ref().map(|t| t.id.clone())))
        };
        let candidate = tracks[focused].is_some().then_some(focused);
        let exclude = self.exclusions(&data);
        let mut ex = self.explore.explorer.lock().unwrap();
        let candidate_track = candidate.and_then(|d| tracks[d].as_deref().and_then(|id| data.index.position(id)).map(|t| (d, t)));

        if let Some((deck, track)) = candidate_track.filter(|_| ex.follow || ex.root().is_none()) {
            if ex.root() != Some(track) {
                ex.reroot(&data.index, track, Some(deck), None, &exclude);
                ex.root_deck = Some(deck);
                let q = self.root_query(&data, &ex);
                ex.rebuild(&data.index, q, &exclude);
                ex.section = self.section_of(&ex);
                self.explore_changed(&data, &ex, "root");
                return;
            }
            ex.root_deck = Some(deck);
        }
        if ex.root().is_none() {
            // Nothing playing yet: start from the library selection so there's something to fly through.
            let selected = self.ui.lock().unwrap().selected.clone();
            if let Some(track) = selected.and_then(|id| data.index.position(&id)) {
                ex.reroot(&data.index, track, None, None, &exclude);
                self.explore_changed(&data, &ex, "init");
            }
            return;
        }
        // Section updates only while standing on the root, so a dive isn't pulled away.
        if ex.at_root() {
            let section = self.section_of(&ex);
            if section.is_some() && section != ex.section {
                ex.section = section;
                let before: Vec<usize> = ex.children().collect();
                let q = self.root_query(&data, &ex);
                ex.rebuild(&data.index, q, &exclude);
                if ex.children().collect::<Vec<_>>() != before {
                    self.explore_changed(&data, &ex, "section");
                }
            }
        }
    }

    // ---- commands -------------------------------------------------------------

    pub fn explore_band(&self, band: Band) {
        self.with_tree("band", |app, data, ex, exclude| {
            ex.band = band;
            let query = if ex.at_root() { app.root_query(data, ex) } else { None };
            ex.set_band(band, &data.index, query, exclude);
            true
        });
    }

    /// A jog wheel turns the band: once `per_step` ticks pile up in one direction,
    /// move one band (stopping at low/high). A pause forgets a half-turned step.
    pub fn explore_band_ticks(&self, ticks: i32, per_step: i32) {
        let steps = {
            let mut acc = self.explore.band_ticks.lock().unwrap();
            if acc.1.is_none_or(|t| t.elapsed() > Duration::from_millis(600)) || acc.0.signum() * ticks.signum() < 0 {
                acc.0 = 0;
            }
            acc.0 += ticks;
            acc.1 = Some(Instant::now());
            let steps = acc.0 / per_step;
            acc.0 -= steps * per_step;
            steps
        };
        if steps != 0 {
            let current = self.explore.explorer.lock().unwrap().band;
            let band = current.step(steps);
            if band != current {
                self.explore_band(band);
            }
        }
    }

    /// A fader picks the band: left third low, middle mid, right third high.
    /// Each region gives a little before handing over, so a fader resting on a
    /// boundary doesn't flicker between two bands.
    pub fn explore_band_fader(&self, value: u8) {
        let current = self.explore.explorer.lock().unwrap().band;
        let band = fader_band(value, current);
        if band != current {
            self.explore_band(band);
        }
    }

    /// The crossfader picks the band: left low, middle mid, right high.
    pub fn explore_band_crossfader(&self, value: u8) {
        let current = self.explore.explorer.lock().unwrap().band;
        let band = self.explore.xfader.lock().unwrap().feed(value, Instant::now(), current);
        if band != current {
            self.explore_band(band);
        }
    }

    /// Called from the app tick: a crossfader glide that stopped short of an end
    /// only shows where it is once it rests.
    pub fn explore_crossfader_settle(&self) {
        if !self.explore.xfader.lock().unwrap().unsettled() {
            return;
        }
        let current = self.explore.explorer.lock().unwrap().band;
        let band = self.explore.xfader.lock().unwrap().settle(Instant::now(), current);
        if band != current {
            self.explore_band(band);
        }
    }

    pub fn explore_cycle_band(&self) {
        let band = self.explore.explorer.lock().unwrap().band.next();
        self.explore_band(band);
    }

    pub fn explore_aim(&self, delta: Option<i32>, id: Option<&str>) {
        self.with_tree("aim", |_, data, ex, _| match (id, delta) {
            (Some(id), _) => data.index.position(id).is_some_and(|t| ex.aim_at(t)),
            (None, Some(d)) => ex.aim_by(d),
            _ => false,
        });
    }

    pub fn explore_dive(&self, id: Option<&str>) {
        self.with_tree("dive", |_, data, ex, exclude| {
            let target = id.and_then(|i| data.index.position(i));
            if id.is_some() && target.is_none() {
                return false;
            }
            ex.dive(&data.index, target, exclude)
        });
    }

    pub fn explore_back(&self) {
        self.with_tree("back", |app, data, ex, exclude| {
            // `back` only uses the root query if it lands on the root.
            let q = app.root_query(data, ex);
            ex.back(&data.index, q, exclude)
        });
    }

    pub fn explore_follow(&self, follow: Option<bool>) {
        {
            let mut ex = self.explore.explorer.lock().unwrap();
            ex.follow = follow.unwrap_or(!ex.follow);
        }
        if let Some(data) = self.data() {
            let ex = self.explore.explorer.lock().unwrap();
            self.broadcast(ex.to_json(&data.index, "follow"));
        }
        self.explore_tick(true);
    }

    pub fn explore_root(&self, id: &str) -> Result<(), String> {
        let data = self.data().ok_or("the library is still being analysed")?;
        let track = data.index.position(id).ok_or_else(|| format!("{id} hasn't been analysed"))?;
        let exclude = self.exclusions(&data);
        let mut ex = self.explore.explorer.lock().unwrap();
        ex.follow = false;
        ex.reroot(&data.index, track, None, None, &exclude);
        self.explore_changed(&data, &ex, "root");
        Ok(())
    }

    /// Start the tree at whatever the library selection is (the left jog scrolls it).
    pub fn explore_root_selected(&self) -> Result<(), String> {
        let selected = self.ui.lock().unwrap().selected.clone().ok_or("nothing selected in the library")?;
        self.explore_root(&selected)
    }

    fn with_tree(&self, reason: &str, f: impl FnOnce(&App, &AnalysisData, &mut Explorer, &HashSet<usize>) -> bool) {
        let Some(data) = self.data() else { return };
        let exclude = self.exclusions(&data);
        let mut ex = self.explore.explorer.lock().unwrap();
        if ex.root().is_none() {
            return;
        }
        if f(self, &data, &mut ex, &exclude) {
            self.explore_changed(&data, &ex, reason);
        }
    }
}

/// Band for a fader position, given the band now: three regions with a small
/// dead zone between them where the current band holds.
fn fader_band(value: u8, current: Band) -> Band {
    match (value, current) {
        (0..=37, _) => Band::Low,
        (90..=127, _) => Band::High,
        (48..=79, _) => Band::Mid,
        // In a dead zone: hold, unless that's two regions away.
        (38..=47, Band::High) => Band::Mid,
        (80..=89, Band::Low) => Band::Mid,
        _ => current,
    }
}

/// Reads the Xone:4D crossfader (CC5) as a band. With XFADE CURVE fully left
/// (the only setting where it sends MIDI), CC5 climbs from 0 at the left end
/// (quarter ~45, middle ~62, three-quarters ~90) to ~98, then over the last
/// stretch the mixer glides it straight back to 0: both ends read 0. A glide
/// to 0 that turns down straight after a climb past `WRAP_PEAK` is the right
/// end, and the band stays high there. Leaving the right end glides the value
/// back up past ~100 before it follows the fader down again.
#[derive(Default)]
pub struct CrossfaderBand {
    last: Option<(u8, Instant)>,
    /// +1 climbing, -1 falling, 0 just started after a rest.
    dir: i8,
    /// Highest value of the current climb.
    peak: u8,
    /// The current climb is the glide out of the right end, so it can't wrap.
    climb_from_end: bool,
    /// Falling straight after a climb past `WRAP_PEAK`: hold the band until it
    /// lands on 0 (the right end) or rests somewhere (an ordinary move).
    falling: bool,
    /// At the right end, reading 0, or gliding back up out of it.
    right_end: bool,
}

impl CrossfaderBand {
    /// Messages closer together than this are one movement.
    const MOVING: Duration = Duration::from_millis(150);
    const SETTLE: Duration = Duration::from_millis(250);
    const WRAP_PEAK: u8 = 90;
    const HIGH: u8 = 84;

    fn feed(&mut self, value: u8, now: Instant, current: Band) -> Band {
        let last = self.last.replace((value, now));
        if last.is_none_or(|(_, at)| now.duration_since(at) >= Self::MOVING) {
            self.dir = 0;
            self.falling = false;
        }
        let prev = last.map_or(value, |(v, _)| v);
        if value > prev {
            if self.dir != 1 {
                self.peak = 0;
                self.climb_from_end = self.right_end;
                self.falling = false;
            }
            self.dir = 1;
            self.peak = self.peak.max(value);
        } else if value < prev {
            if self.dir == 1 && self.peak >= Self::WRAP_PEAK && !self.climb_from_end {
                self.falling = true;
            }
            // Out of the right end the value climbs past `HIGH` before it turns:
            // turning lower means it was never there (a quick swing to the left end).
            if self.dir == 1 && self.right_end && self.peak < Self::HIGH {
                self.right_end = false;
            }
            self.dir = -1;
        }

        if self.right_end {
            if value >= Self::HIGH {
                self.right_end = false;
            }
            return Band::High;
        }
        if self.falling {
            if value == 0 {
                self.falling = false;
                self.right_end = true;
                return Band::High;
            }
            return current;
        }
        crossfader_zone(value, current)
    }

    fn unsettled(&self) -> bool {
        self.falling || (self.right_end && self.last.is_some_and(|(v, _)| v != 0))
    }

    /// Once the fader rests, a held fall or a right end that never climbed back
    /// out was an ordinary move: show where it stopped.
    fn settle(&mut self, now: Instant, current: Band) -> Band {
        let Some((value, at)) = self.last else { return current };
        if now.duration_since(at) < Self::SETTLE || !self.unsettled() {
            return current;
        }
        self.falling = false;
        self.right_end = false;
        crossfader_zone(value, current)
    }
}

/// Band for a crossfader value away from the right end: thirds of the travel,
/// with dead zones where the current band holds.
fn crossfader_zone(value: u8, current: Band) -> Band {
    match (value, current) {
        (0..=48, _) => Band::Low,
        (56..=76, _) => Band::Mid,
        (84..=127, _) => Band::High,
        (49..=55, Band::High) | (77..=83, Band::Low) => Band::Mid,
        _ => current,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plays `moves` into a crossfader decoder, ~6.5 ms per message like the
    /// mixer, resting 3 s after each move, and returns the band after each rest.
    fn crossfader(moves: &[&[u8]]) -> Vec<Band> {
        let (mut x, mut band, mut t) = (CrossfaderBand::default(), Band::Mid, Instant::now());
        moves
            .iter()
            .map(|values| {
                for &v in *values {
                    t += Duration::from_micros(6500);
                    band = x.feed(v, t, band);
                }
                t += Duration::from_secs(3);
                band = x.settle(t, band);
                band
            })
            .collect()
    }

    fn ramp(from: u8, to: u8, step: u8) -> Vec<u8> {
        let mut v = vec![from];
        while *v.last().unwrap() != to {
            let l = *v.last().unwrap();
            v.push(if from < to { l.saturating_add(step).min(to) } else { l.saturating_sub(step).max(to) });
        }
        v
    }

    #[test]
    fn crossfader_slow_stops_left_to_right() {
        // Recorded 2026-10-05: hard left, quarter, middle, three-quarters, hard right.
        let right_end = [89, 90, 91, 92, 94, 96, 98, 95, 89, 84, 79, 73, 68, 62, 57, 51, 45, 39, 33, 26, 19, 12, 5, 0];
        let bands = crossfader(&[&ramp(49, 0, 3), &ramp(4, 44, 2), &ramp(45, 61, 1), &ramp(62, 88, 1), &right_end]);
        assert_eq!(bands, [Band::Low, Band::Low, Band::Mid, Band::High, Band::High]);
    }

    #[test]
    fn crossfader_leaving_the_right_end() {
        let to_right: Vec<u8> = ramp(0, 98, 2).into_iter().chain(ramp(95, 0, 6)).collect();
        // Out of the right end the mixer glides up past 100, then follows the fader down.
        let out_of_end = ramp(0, 107, 8);
        let to_left: Vec<u8> = out_of_end.iter().copied().chain(ramp(106, 0, 5)).collect();
        let to_middle: Vec<u8> = out_of_end.iter().copied().chain(ramp(106, 61, 3)).collect();
        assert_eq!(crossfader(&[&to_right, &to_left]), [Band::High, Band::Low]);
        assert_eq!(crossfader(&[&to_right, &to_middle]), [Band::High, Band::Mid]);
        assert_eq!(crossfader(&[&to_right, &ramp(0, 101, 8)]), [Band::High, Band::High]);
    }

    #[test]
    fn crossfader_ordinary_moves_down() {
        // From three-quarters at rest straight to the left end.
        assert_eq!(crossfader(&[&ramp(0, 93, 3), &ramp(93, 0, 6)]), [Band::High, Band::Low]);
        // Climbing high then turning back without a pause, stopping at the quarter.
        let turn: Vec<u8> = ramp(40, 95, 3).into_iter().chain(ramp(94, 44, 4)).collect();
        assert_eq!(crossfader(&[&turn]), [Band::Low]);
        // A quick swing high and back to the left end looks like the right end,
        // until the next swing turns back below `HIGH` (recorded wiggle).
        let wiggle: Vec<u8> = ramp(5, 92, 4).into_iter().chain(ramp(90, 0, 6)).chain(ramp(10, 83, 7)).chain(ramp(78, 0, 6)).collect();
        assert_eq!(crossfader(&[&wiggle]), [Band::Low]);
        // Wobbling around the middle stays mid.
        assert_eq!(crossfader(&[&[51, 57, 56, 55, 54, 52, 58, 63, 60]]), [Band::Mid]);
    }

    #[test]
    fn fader_regions_with_dead_zones() {
        assert_eq!(fader_band(0, Band::High), Band::Low);
        assert_eq!(fader_band(64, Band::Low), Band::Mid);
        assert_eq!(fader_band(127, Band::Low), Band::High);
        // Wobbling around the low/mid boundary doesn't flicker.
        assert_eq!(fader_band(42, Band::Low), Band::Low);
        assert_eq!(fader_band(42, Band::Mid), Band::Mid);
        assert_eq!(fader_band(42, Band::High), Band::Mid);
        assert_eq!(fader_band(85, Band::Mid), Band::Mid);
        assert_eq!(fader_band(85, Band::Low), Band::Mid);
    }
}
