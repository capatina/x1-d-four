//! Application state and behaviour shared by the HTTP/WS server, the MIDI
//! event pump and the audio thread.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use engine::{Command, DECKS, SAMPLE_RATE};
use ploytec::{MidiMessage, StreamStats};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::controls::{Catalog, ControlEvent};
use crate::library::{LibTrack, Library};
use crate::mapping::{Intent, LedRule, Mappings};

const MIDI_LOG: usize = 200;
/// An incoming note on an LED we toggled this recently is treated as the mixer echoing it.
const LED_ECHO_WINDOW: Duration = Duration::from_millis(80);

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum ClientCommand {
    Load { deck: usize, track_id: String },
    LoadSelected { deck: Option<usize> },
    Eject { deck: usize },
    Play { deck: usize },
    Pause { deck: usize },
    PlayPause { deck: usize },
    Cue { deck: usize, pressed: bool },
    Seek { deck: usize, fraction: f64 },
    Nudge { deck: usize, seconds: f64 },
    Rate { deck: usize, rate: f64 },
    Trim { deck: usize, gain: f64 },
    Focus { deck: usize },
    Browse { query: String },
    Select { track_id: String },
    Scroll { delta: i32 },
    Rescan,
    /// Raw MIDI to the mixer, e.g. [0x9F, 38, 127] toggles the left.lit1 ring.
    MidiOut { bytes: Vec<u8> },
    View { view: String },
    ExploreBand { band: String },
    ExploreCycleBand,
    ExploreAim { delta: Option<i32>, id: Option<String> },
    ExploreDive { id: Option<String> },
    ExploreBack,
    ExploreFollow { follow: bool },
    ExploreRoot { id: String },
    ExploreRootSelected,
    /// Turn beat sync on or off; leave `on` out to toggle.
    Sync { deck: usize, on: Option<bool> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceState {
    Connecting,
    Running,
    Stalled,
    Missing,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceStatus {
    pub state: DeviceState,
    pub message: Option<String>,
    pub firmware: Option<String>,
}

#[derive(Default, Clone)]
pub(crate) struct DeckMeta {
    pub(crate) track: Option<LibTrack>,
    loading: bool,
    trim: f64,
    peaks: Vec<u8>,
    length: f64,
}

pub(crate) struct Ui {
    query: String,
    ids: Vec<String>,
    pub(crate) selected: Option<String>,
    pub(crate) focused: usize,
    pub(crate) decks: [DeckMeta; DECKS],
}

struct Config {
    catalog: Option<Catalog>,
    mappings: Option<Mappings>,
    ok: bool,
    error: Option<String>,
}

#[derive(Default)]
struct Leds {
    /// Ring state we believe each LED note has (they toggle; there is no absolute set).
    lit: HashMap<u8, bool>,
    sent: HashMap<u8, Instant>,
}

#[derive(Default)]
pub(crate) struct Clock {
    last_ticks: u64,
    last_at: Option<Instant>,
    pub(crate) bpm: Option<f64>,
}

#[derive(Default, Clone, Copy)]
struct Window {
    min_queued: Option<u32>,
    max_gap_us: Option<u32>,
}

pub struct App {
    pub control: Mutex<engine::Control>,
    pub shared: Arc<engine::Shared>,
    pub stats: Arc<StreamStats>,
    pub library: RwLock<Library>,
    pub(crate) ui: Mutex<Ui>,
    config: Mutex<Config>,
    leds: Mutex<Leds>,
    pub(crate) clock: Mutex<Clock>,
    window: Mutex<(Instant, Window)>,
    device: Mutex<DeviceStatus>,
    midi_log: Mutex<VecDeque<Value>>,
    load_gen: [AtomicU64; DECKS],
    pub tx: broadcast::Sender<Arc<str>>,
    pub started: Instant,
    pub music_dir: PathBuf,
    pub config_dir: PathBuf,
    pub out_urbs: usize,
    pub runtime: tokio::runtime::Handle,
    pub(crate) explore: crate::exploring::ExploreState,
}

impl App {
    pub fn new(
        control: engine::Control,
        music_dir: PathBuf,
        config_dir: PathBuf,
        out_urbs: usize,
        runtime: tokio::runtime::Handle,
    ) -> Arc<Self> {
        let shared = control.shared.clone();
        let library = Library::scan(&music_dir);
        tracing::info!(tracks = library.tracks.len(), dir = %music_dir.display(), "library scanned");
        let ids = library.filter("");
        let (tx, _) = broadcast::channel(512);
        let app = Arc::new(Self {
            control: Mutex::new(control),
            shared,
            stats: Arc::new(StreamStats::default()),
            library: RwLock::new(library),
            ui: Mutex::new(Ui {
                query: String::new(),
                selected: ids.first().cloned(),
                ids,
                focused: 0,
                decks: std::array::from_fn(|_| DeckMeta { trim: 1.0, ..Default::default() }),
            }),
            config: Mutex::new(Config { catalog: None, mappings: None, ok: false, error: None }),
            leds: Mutex::default(),
            clock: Mutex::default(),
            window: Mutex::new((Instant::now(), Window::default())),
            device: Mutex::new(DeviceStatus { state: DeviceState::Connecting, message: None, firmware: None }),
            midi_log: Mutex::new(VecDeque::with_capacity(MIDI_LOG)),
            load_gen: std::array::from_fn(|_| AtomicU64::new(0)),
            tx,
            started: Instant::now(),
            music_dir,
            config_dir,
            out_urbs,
            runtime,
            explore: Default::default(),
        });
        app.reload_config();
        // The tunnel is the main view; the decks are one button away.
        app.set_view(true);
        app
    }

    pub(crate) fn broadcast(&self, msg: Value) {
        let _ = self.tx.send(Arc::from(msg.to_string()));
    }

    fn send(&self, cmd: Command) {
        if self.control.lock().unwrap().send(cmd).is_err() {
            tracing::warn!("engine command queue full");
        }
    }

    pub fn set_device(&self, state: DeviceState, message: Option<String>, firmware: Option<String>) {
        let mut d = self.device.lock().unwrap();
        d.state = state;
        d.message = message;
        if firmware.is_some() {
            d.firmware = firmware;
        }
    }

    // ---- configuration -------------------------------------------------

    pub fn controls_path(&self) -> PathBuf {
        self.config_dir.join("controls.toml")
    }

    pub fn mappings_path(&self) -> PathBuf {
        self.config_dir.join("mappings.toml")
    }

    /// (Re)load controls.toml and mappings.toml. A broken file keeps the previous mappings.
    pub fn reload_config(&self) {
        let result = Catalog::load(&self.controls_path())
            .and_then(|catalog| Mappings::load(&self.mappings_path(), &catalog).map(|m| (catalog, m)));
        let mut cfg = self.config.lock().unwrap();
        match result {
            Ok((catalog, mappings)) => {
                tracing::info!(rules = mappings.rules.len(), "mappings loaded");
                cfg.catalog = Some(catalog);
                cfg.mappings = Some(mappings);
                cfg.ok = true;
                cfg.error = None;
            }
            Err(e) => {
                let msg = format!("{e:#}");
                tracing::warn!(error = %msg, "mappings not applied");
                cfg.ok = false;
                cfg.error = Some(msg);
            }
        }
        let status = Self::mappings_status(&cfg, &self.mappings_path());
        drop(cfg);
        self.broadcast(status);
    }

    fn mappings_status(cfg: &Config, path: &std::path::Path) -> Value {
        json!({
            "type": "mappings",
            "ok": cfg.ok,
            "error": cfg.error,
            "count": cfg.mappings.as_ref().map_or(0, |m| m.rules.len()),
            "path": path.display().to_string(),
        })
    }

    pub fn mappings_json(&self) -> Value {
        let cfg = self.config.lock().unwrap();
        let mut v = Self::mappings_status(&cfg, &self.mappings_path());
        v["mappings"] = json!(cfg.mappings.as_ref().map(|m| m.rules.iter().map(|r| &r.source).collect::<Vec<_>>()));
        v
    }

    pub fn controls_json(&self) -> Value {
        let cfg = self.config.lock().unwrap();
        json!(cfg.catalog.as_ref().map(|c| c
            .controls
            .iter()
            .map(|ctl| json!({
                "name": ctl.name,
                "kind": ctl.kind(),
                "midi": match (ctl.note, ctl.cc) {
                    (Some(n), _) => format!("note {n}"),
                    (_, Some(n)) => format!("cc {n}"),
                    _ => String::new(),
                },
                "led": ctl.led,
            }))
            .collect::<Vec<_>>()))
    }

    // ---- commands --------------------------------------------------------

    pub fn command(self: &Arc<Self>, cmd: ClientCommand) -> Result<(), String> {
        let deck_ok = |d: usize| if d < DECKS { Ok(d) } else { Err(format!("deck {d} out of range 0-3")) };
        match cmd {
            ClientCommand::Load { deck, track_id } => self.load(deck_ok(deck)?, &track_id)?,
            ClientCommand::LoadSelected { deck } => self.load_selected(deck.map(deck_ok).transpose()?)?,
            ClientCommand::Eject { deck } => self.eject(deck_ok(deck)?),
            ClientCommand::Play { deck } => self.send(Command::Play { deck: deck_ok(deck)? }),
            ClientCommand::Pause { deck } => self.send(Command::Pause { deck: deck_ok(deck)? }),
            ClientCommand::PlayPause { deck } => self.send(Command::TogglePlay { deck: deck_ok(deck)? }),
            ClientCommand::Cue { deck, pressed } => self.send(Command::Cue { deck: deck_ok(deck)?, pressed }),
            ClientCommand::Seek { deck, fraction } => {
                let deck = deck_ok(deck)?;
                let length = self.shared.deck(deck).length;
                self.send(Command::Seek { deck, frame: fraction.clamp(0.0, 1.0) * length });
            }
            ClientCommand::Nudge { deck, seconds } => {
                self.send(Command::Nudge { deck: deck_ok(deck)?, frames: seconds * SAMPLE_RATE as f64 })
            }
            ClientCommand::Rate { deck, rate } => self.send(Command::Rate { deck: deck_ok(deck)?, rate }),
            ClientCommand::Trim { deck, gain } => self.set_trim(deck_ok(deck)?, gain),
            ClientCommand::Focus { deck } => self.focus(deck_ok(deck)?),
            ClientCommand::Browse { query } => self.browse(query),
            ClientCommand::Select { track_id } => self.select(Some(track_id)),
            ClientCommand::Scroll { delta } => self.scroll(delta),
            ClientCommand::MidiOut { bytes } => {
                if !(1..=3).contains(&bytes.len()) {
                    return Err("midi_out takes 1-3 bytes".into());
                }
                let mut b = [0u8; 3];
                b[..bytes.len()].copy_from_slice(&bytes);
                self.send(Command::MidiOut { bytes: b, len: bytes.len() as u8 });
            }
            ClientCommand::View { view } => match view.as_str() {
                "explore" => self.set_view(true),
                "decks" => self.set_view(false),
                other => return Err(format!("unknown view {other:?}")),
            },
            ClientCommand::ExploreBand { band } => {
                self.explore_band(analysis::Band::parse(&band).ok_or_else(|| format!("unknown band {band:?}"))?)
            }
            ClientCommand::ExploreCycleBand => self.explore_cycle_band(),
            ClientCommand::ExploreAim { delta, id } => self.explore_aim(delta, id.as_deref()),
            ClientCommand::ExploreDive { id } => self.explore_dive(id.as_deref()),
            ClientCommand::ExploreBack => self.explore_back(),
            ClientCommand::ExploreFollow { follow } => self.explore_follow(Some(follow)),
            ClientCommand::ExploreRoot { id } => self.explore_root(&id)?,
            ClientCommand::ExploreRootSelected => self.explore_root_selected()?,
            ClientCommand::Sync { deck, on } => self.send(Command::Sync { deck: deck_ok(deck)?, on }),
            ClientCommand::Rescan => {
                let app = self.clone();
                self.runtime.spawn_blocking(move || app.rescan());
            }
        }
        Ok(())
    }

    fn deck_or_focused(&self, deck: Option<usize>) -> usize {
        deck.unwrap_or_else(|| self.ui.lock().unwrap().focused)
    }

    fn apply_intent(self: &Arc<Self>, intent: Intent) {
        let result = match intent {
            Intent::PlayPause(d) => Ok(self.send(Command::TogglePlay { deck: self.deck_or_focused(d) })),
            Intent::Play(d) => Ok(self.send(Command::Play { deck: self.deck_or_focused(d) })),
            Intent::Pause(d) => Ok(self.send(Command::Pause { deck: self.deck_or_focused(d) })),
            Intent::Cue(d, pressed) => Ok(self.send(Command::Cue { deck: self.deck_or_focused(d), pressed })),
            Intent::LoadSelected(d) => self.load_selected(d),
            Intent::Eject(d) => Ok(self.eject(self.deck_or_focused(d))),
            Intent::Focus(d) => Ok(self.focus(d)),
            Intent::RateReset(d) => Ok(self.send(Command::Rate { deck: self.deck_or_focused(d), rate: 1.0 })),
            Intent::Nudge(d, secs) => {
                Ok(self.send(Command::Nudge { deck: self.deck_or_focused(d), frames: secs * SAMPLE_RATE as f64 }))
            }
            Intent::RateDelta(d, delta) => {
                let deck = self.deck_or_focused(d);
                let rate = self.shared.deck(deck).rate + delta;
                Ok(self.send(Command::Rate { deck, rate }))
            }
            Intent::RateSet(d, rate) => Ok(self.send(Command::Rate { deck: self.deck_or_focused(d), rate })),
            Intent::TrimSet(d, gain) => Ok(self.set_trim(self.deck_or_focused(d), gain)),
            Intent::TrimDelta(d, delta) => {
                let deck = self.deck_or_focused(d);
                let gain = self.ui.lock().unwrap().decks[deck].trim + delta;
                Ok(self.set_trim(deck, gain))
            }
            Intent::Scroll(n) => Ok(self.scroll(n)),
            Intent::ExploreBand(b) => Ok(self.explore_band(analysis::Band::ALL[b.min(2) as usize])),
            Intent::ExploreCycleBand => Ok(self.explore_cycle_band()),
            Intent::ExploreAim(n) => Ok(self.explore_aim(Some(n), None)),
            Intent::ExploreDive => Ok(self.explore_dive(None)),
            Intent::ExploreBack => Ok(self.explore_back()),
            Intent::ExploreFollow => Ok(self.explore_follow(None)),
            Intent::ExploreRootSelected => self.explore_root_selected(),
            Intent::Sync(d) => Ok(self.send(Command::Sync { deck: self.deck_or_focused(d), on: None })),
            Intent::ToggleView => Ok(self.set_view(self.view_name() == "decks")),
        };
        if let Err(e) = result {
            self.broadcast(json!({ "type": "error", "message": e }));
        }
    }

    fn set_trim(&self, deck: usize, gain: f64) {
        let gain = gain.clamp(0.0, 2.0);
        self.ui.lock().unwrap().decks[deck].trim = gain;
        self.send(Command::Trim { deck, gain: gain as f32 });
    }

    fn focus(&self, deck: usize) {
        self.ui.lock().unwrap().focused = deck;
    }

    fn load_selected(self: &Arc<Self>, deck: Option<usize>) -> Result<(), String> {
        let (deck, selected) = {
            let ui = self.ui.lock().unwrap();
            (deck.unwrap_or(ui.focused), ui.selected.clone())
        };
        let id = selected.ok_or("nothing selected in the library")?;
        self.load(deck, &id)
    }

    fn load(self: &Arc<Self>, deck: usize, id: &str) -> Result<(), String> {
        let track = self.library.read().unwrap().get(id).cloned().ok_or_else(|| format!("unknown track {id}"))?;
        let generation = self.load_gen[deck].fetch_add(1, Ordering::Relaxed) + 1;
        self.ui.lock().unwrap().decks[deck].loading = true;
        let app = self.clone();
        self.runtime.spawn_blocking(move || {
            let started = Instant::now();
            let result = engine::track::load(&track.path).map(|mut decoded| {
                decoded.grid = app.beat_grid(&track, &decoded);
                decoded
            });
            if app.load_gen[deck].load(Ordering::Relaxed) != generation {
                return; // superseded by a newer load on this deck
            }
            match result {
                Ok(decoded) => {
                    tracing::info!(deck, id = %track.id, secs = decoded.seconds(), grid = ?decoded.grid, took = ?started.elapsed(), "loaded");
                    let length = decoded.seconds();
                    let peaks = decoded.peaks.clone();
                    app.send(Command::Load { deck, track: Some(Arc::new(decoded)) });
                    let msg = {
                        let mut ui = app.ui.lock().unwrap();
                        let meta = &mut ui.decks[deck];
                        meta.track = Some(track.clone());
                        meta.loading = false;
                        meta.peaks = peaks;
                        meta.length = length;
                        deck_loaded_json(deck, meta)
                    };
                    app.broadcast(msg);
                }
                Err(e) => {
                    app.ui.lock().unwrap().decks[deck].loading = false;
                    tracing::warn!(deck, id = %track.id, error = %e, "load failed");
                    app.broadcast(json!({ "type": "error", "message": format!("Couldn't load {}: {e:#}", track.title) }));
                }
            }
        });
        Ok(())
    }

    fn eject(&self, deck: usize) {
        self.load_gen[deck].fetch_add(1, Ordering::Relaxed);
        self.send(Command::Load { deck, track: None });
        let mut ui = self.ui.lock().unwrap();
        ui.decks[deck] = DeckMeta { trim: ui.decks[deck].trim, ..Default::default() };
        drop(ui);
        self.broadcast(json!({ "type": "deck_ejected", "deck": deck }));
    }

    // ---- library browser -------------------------------------------------

    fn browse(&self, query: String) {
        let ids = self.library.read().unwrap().filter(&query);
        let mut ui = self.ui.lock().unwrap();
        // A search selects its best match, so the mixer's load buttons act on it;
        // clearing the search keeps whatever was selected.
        let searching = !query.trim().is_empty() && query.trim() != ui.query.trim();
        if searching || !ui.selected.as_ref().is_some_and(|s| ids.contains(s)) {
            ui.selected = ids.first().cloned();
        }
        ui.query = query;
        ui.ids = ids;
        let msg = browser_json(&ui);
        drop(ui);
        self.broadcast(msg);
    }

    /// Set the library selection without telling the explorer (it's the one asking).
    pub(crate) fn select_from_explorer(&self, id: String) {
        let mut ui = self.ui.lock().unwrap();
        if ui.selected.as_deref() == Some(&id) {
            return;
        }
        ui.selected = Some(id);
        let msg = browser_json(&ui);
        drop(ui);
        self.broadcast(msg);
    }

    pub(crate) fn select(&self, id: Option<String>) {
        let mut ui = self.ui.lock().unwrap();
        ui.selected = id.clone();
        let msg = browser_json(&ui);
        drop(ui);
        self.broadcast(msg);
        if let Some(id) = id {
            self.explore_follow_selection(&id);
        }
    }

    fn scroll(&self, delta: i32) {
        let mut ui = self.ui.lock().unwrap();
        if ui.ids.is_empty() {
            return;
        }
        let current = ui.selected.as_ref().and_then(|s| ui.ids.iter().position(|i| i == s));
        let next = match current {
            Some(i) => (i as i64 + delta as i64).clamp(0, ui.ids.len() as i64 - 1) as usize,
            None => 0,
        };
        ui.selected = Some(ui.ids[next].clone());
        let id = ui.ids[next].clone();
        let msg = browser_json(&ui);
        drop(ui);
        self.broadcast(msg);
        self.explore_follow_selection(&id);
    }

    pub fn rescan(self: &Arc<Self>) {
        let library = Library::scan(&self.music_dir);
        let count = library.tracks.len();
        *self.library.write().unwrap() = library;
        let query = self.ui.lock().unwrap().query.clone();
        self.browse(query);
        tracing::info!(tracks = count, "library rescanned");
        self.broadcast(json!({ "type": "library_changed", "tracks": count }));
        self.start_analysis();
    }

    // ---- MIDI --------------------------------------------------------------

    /// Drain engine events (MIDI in, end of track). Called from the event pump thread.
    pub fn pump_events(self: &Arc<Self>) -> usize {
        let mut events = Vec::new();
        {
            let mut control = self.control.lock().unwrap();
            while let Ok(ev) = control.events.pop() {
                events.push(ev);
            }
        }
        let n = events.len();
        for ev in events {
            match ev {
                engine::Event::Midi(msg) => self.on_midi(msg),
                engine::Event::Ended { deck } => tracing::debug!(deck, "track ended"),
            }
        }
        n
    }

    fn on_midi(self: &Arc<Self>, msg: MidiMessage) {
        let (bytes, len) = msg.to_bytes();
        let raw = bytes[..len].iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ");
        let echo = match msg {
            MidiMessage::NoteOn { note, .. } | MidiMessage::NoteOff { note, .. } => {
                self.leds.lock().unwrap().sent.get(&note).is_some_and(|t| t.elapsed() < LED_ECHO_WINDOW)
            }
            _ => false,
        };
        let mut intents = Vec::new();
        let mut actions = Vec::new();
        let resolved = {
            let cfg = self.config.lock().unwrap();
            let resolved = cfg.catalog.as_ref().and_then(|c| c.resolve(&msg));
            if let (Some(r), Some(m), false) = (&resolved, &cfg.mappings, echo) {
                for rule in m.for_control(&r.name) {
                    if let Some(intent) = rule.intent(r.event) {
                        intents.push(intent);
                        actions.push(rule.describe());
                    }
                }
            }
            resolved
        };
        for intent in intents {
            self.apply_intent(intent);
        }
        let (event, value) = match resolved.as_ref().map(|r| r.event) {
            Some(ControlEvent::Press) => (Some("press"), None),
            Some(ControlEvent::Release) => (Some("release"), None),
            Some(ControlEvent::Value(v)) => (Some("value"), Some(v as i32)),
            Some(ControlEvent::Delta(d)) => (Some("delta"), Some(d as i32)),
            None => (None, None),
        };
        let entry = json!({
            "type": "midi",
            "t": self.started.elapsed().as_millis() as u64,
            "raw": raw,
            "desc": describe(&msg),
            "control": resolved.map(|r| r.name),
            "event": event,
            "value": value,
            "action": if echo { Some("(LED echo ignored)".to_owned()) } else if actions.is_empty() { None } else { Some(actions.join(", ")) },
        });
        {
            let mut log = self.midi_log.lock().unwrap();
            if log.len() == MIDI_LOG {
                log.pop_front();
            }
            log.push_back(entry.clone());
        }
        self.broadcast(entry);
    }

    pub fn midi_recent(&self) -> Value {
        json!(self.midi_log.lock().unwrap().iter().collect::<Vec<_>>())
    }

    /// Bring LED rings in line with their rules. Rings toggle on every Note On,
    /// so we only send when the state we track differs from the desired one.
    fn sync_leds(&self) {
        let focused = self.ui.lock().unwrap().focused;
        let loaded: [bool; DECKS] = {
            let ui = self.ui.lock().unwrap();
            std::array::from_fn(|d| ui.decks[d].track.is_some())
        };
        let mut wanted: Vec<(u8, bool)> = Vec::new();
        let channel;
        {
            let cfg = self.config.lock().unwrap();
            let (Some(m), Some(c)) = (&cfg.mappings, &cfg.catalog) else { return };
            channel = c.channel;
            for rule in &m.rules {
                let Some((led, note)) = rule.led else { continue };
                if wanted.iter().any(|(n, _)| *n == note) {
                    continue;
                }
                let deck = rule.deck.unwrap_or(focused);
                let on = match led {
                    LedRule::DeckPlaying => self.shared.deck(deck).playing,
                    LedRule::DeckLoaded => loaded[deck],
                    LedRule::DeckFocused => focused == deck,
                    LedRule::DeckSynced => self.shared.deck(deck).sync,
                };
                wanted.push((note, on));
            }
        }
        let mut leds = self.leds.lock().unwrap();
        // Rings left lit by a rule that was remapped away get switched off.
        let orphans: Vec<u8> =
            leds.lit.iter().filter(|(n, on)| **on && !wanted.iter().any(|(w, _)| w == *n)).map(|(n, _)| *n).collect();
        wanted.extend(orphans.into_iter().map(|n| (n, false)));
        for (note, on) in wanted {
            let lit = leds.lit.entry(note).or_insert(false);
            if *lit != on {
                *lit = on;
                leds.sent.insert(note, Instant::now());
                let _ = self.control.lock().unwrap().midi_out(MidiMessage::NoteOn { ch: channel, note, vel: 127 });
            }
        }
    }

    // ---- periodic state ----------------------------------------------------

    fn bpm(&self) -> Option<f64> {
        let ticks = self.shared.clock_ticks.load(Ordering::Relaxed);
        let mut clock = self.clock.lock().unwrap();
        let now = Instant::now();
        match clock.last_at {
            Some(at) if now.duration_since(at) >= Duration::from_secs(1) => {
                let dt = now.duration_since(at).as_secs_f64();
                let dticks = ticks - clock.last_ticks;
                clock.bpm = (dticks > 0).then(|| (dticks as f64 / 24.0) * 60.0 / dt).map(|b| (b * 10.0).round() / 10.0);
                clock.last_ticks = ticks;
                clock.last_at = Some(now);
            }
            None => {
                clock.last_ticks = ticks;
                clock.last_at = Some(now);
            }
            _ => {}
        }
        clock.bpm
    }

    fn window(&self) -> Window {
        let mut w = self.window.lock().unwrap();
        if w.0.elapsed() >= Duration::from_secs(1) {
            let (min_q, max_gap) = self.stats.take_window();
            w.1 = Window {
                min_queued: (min_q != u32::MAX).then_some(min_q),
                max_gap_us: (max_gap != 0).then_some(max_gap),
            };
            w.0 = Instant::now();
        }
        w.1
    }

    pub fn state_json(&self) -> Value {
        let sr = SAMPLE_RATE as f64;
        let ui = self.ui.lock().unwrap();
        let decks: Vec<Value> = (0..DECKS)
            .map(|d| {
                let s = self.shared.deck(d);
                let meta = &ui.decks[d];
                json!({
                    "track_id": meta.track.as_ref().map(|t| &t.id),
                    "loading": meta.loading,
                    "playing": s.playing,
                    "position": s.position / sr,
                    "length": s.length / sr,
                    "rate": s.rate,
                    "cue": s.cue / sr,
                    "trim": meta.trim,
                    "sync": s.sync,
                    "master": s.master,
                    "bpm": s.bpm.map(|b| (b * s.rate * 100.0).round() / 100.0),
                })
            })
            .collect();
        let focused = ui.focused;
        drop(ui);
        let device = self.device.lock().unwrap().clone();
        let w = self.window();
        json!({
            "type": "state",
            "decks": decks,
            "focused": focused,
            "view": self.view_name(),
            "device": {
                "state": device.state,
                "message": device.message,
                "firmware": device.firmware,
                "out_urbs": self.out_urbs,
                "latency_ms": self.out_urbs as f64 * 80.0 / sr * 1000.0,
                "packets_out": self.stats.packets_out.load(Ordering::Relaxed),
                "underruns": self.stats.underruns.load(Ordering::Relaxed),
                "urb_errors": self.stats.urb_errors.load(Ordering::Relaxed),
                "min_queued": w.min_queued,
                "max_gap_us": w.max_gap_us,
            },
            "bpm": self.bpm(),
        })
    }

    /// Runs ~30 times a second: state broadcast and LED sync.
    pub fn tick(&self) {
        self.sync_leds();
        self.explore_tick(false);
        if self.tx.receiver_count() > 0 {
            self.broadcast(self.state_json());
        }
        self.control.lock().unwrap().collect_garbage();
    }

    /// Messages a freshly connected client needs before the live stream.
    pub fn hello(&self) -> Vec<Value> {
        let mut out = Vec::new();
        out.push(self.state_json());
        let ui = self.ui.lock().unwrap();
        out.push(browser_json(&ui));
        for (d, meta) in ui.decks.iter().enumerate() {
            if meta.track.is_some() && !meta.peaks.is_empty() {
                out.push(deck_loaded_json(d, meta));
            }
        }
        drop(ui);
        let cfg = self.config.lock().unwrap();
        out.push(Self::mappings_status(&cfg, &self.mappings_path()));
        drop(cfg);
        out.push(self.analysis_json());
        out.extend(self.explore_json());
        out
    }

    pub fn decks_json(&self) -> Value {
        let ui = self.ui.lock().unwrap();
        json!(ui
            .decks
            .iter()
            .enumerate()
            .filter(|(_, m)| m.track.is_some())
            .map(|(d, m)| deck_loaded_json(d, m))
            .collect::<Vec<_>>())
    }
}

fn browser_json(ui: &Ui) -> Value {
    json!({ "type": "browser", "query": ui.query, "ids": ui.ids, "selected": ui.selected })
}

fn deck_loaded_json(deck: usize, meta: &DeckMeta) -> Value {
    json!({
        "type": "deck_loaded",
        "deck": deck,
        "track": meta.track,
        "length": meta.length,
        "peaks": meta.peaks,
    })
}

fn describe(msg: &MidiMessage) -> String {
    match *msg {
        MidiMessage::NoteOn { ch, note, vel } => format!("note on ch{} {note} vel {vel}", ch + 1),
        MidiMessage::NoteOff { ch, note, vel } => format!("note off ch{} {note} vel {vel}", ch + 1),
        MidiMessage::Cc { ch, num, val } => format!("cc ch{} {num} = {val}", ch + 1),
        MidiMessage::ProgramChange { ch, program } => format!("program ch{} {program}", ch + 1),
        MidiMessage::PitchBend { ch, value } => format!("pitch bend ch{} {value}", ch + 1),
        MidiMessage::Clock => "clock".into(),
        MidiMessage::Start => "start".into(),
        MidiMessage::Continue => "continue".into(),
        MidiMessage::Stop => "stop".into(),
    }
}
