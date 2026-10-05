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
    /// When each deck last started playing, to pick the root.
    started: Mutex<[Option<Instant>; DECKS]>,
    was_playing: Mutex<[bool; DECKS]>,
    last_tick: Mutex<Option<Instant>>,
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
        // Which decks play, and which started most recently.
        let (focused, tracks): (usize, [Option<String>; DECKS]) = {
            let ui = self.ui.lock().unwrap();
            (ui.focused, std::array::from_fn(|d| ui.decks[d].track.as_ref().map(|t| t.id.clone())))
        };
        let playing: [bool; DECKS] = std::array::from_fn(|d| self.shared.deck(d).playing && tracks[d].is_some());
        {
            let mut was = self.explore.was_playing.lock().unwrap();
            let mut started = self.explore.started.lock().unwrap();
            for d in 0..DECKS {
                if playing[d] && !was[d] {
                    started[d] = Some(Instant::now());
                }
            }
            *was = playing;
        }
        let started = *self.explore.started.lock().unwrap();
        let candidate = if playing[focused] {
            Some(focused)
        } else {
            (0..DECKS).filter(|&d| playing[d]).max_by_key(|&d| started[d])
        };
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
