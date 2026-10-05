//! Four-deck playback engine. [`Rt`] runs on the USB streaming thread and
//! renders each deck into its USB pair (deck n -> USB n*2+1/n*2+2 -> mixer
//! channel n+1 with its source on SC). [`Control`] is the other end, used by
//! the server: it sends commands, receives events and reads deck state.

pub mod deck;
pub mod track;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use ploytec::{FRAMES_PER_PACKET, Frame, MidiMessage, MidiOutQueue, MidiParser, Renderer};

pub use deck::Deck;
pub use track::{Grid, Track};

pub const DECKS: usize = 4;
pub const SAMPLE_RATE: u32 = ploytec::SAMPLE_RATE;

/// Control -> RT.
pub enum Command {
    Load { deck: usize, track: Option<Arc<Track>> },
    Play { deck: usize },
    Pause { deck: usize },
    TogglePlay { deck: usize },
    Cue { deck: usize, pressed: bool },
    Seek { deck: usize, frame: f64 },
    Nudge { deck: usize, frames: f64 },
    Rate { deck: usize, rate: f64 },
    /// Turn sync on/off; `None` toggles.
    Sync { deck: usize, on: Option<bool> },
    Trim { deck: usize, gain: f32 },
    /// Raw MIDI to the mixer (LED rings), sent one byte per packet.
    MidiOut { bytes: [u8; 3], len: u8 },
}

/// RT -> control.
#[derive(Debug, Clone, Copy)]
pub enum Event {
    Midi(MidiMessage),
    Ended { deck: usize },
}

/// Deck state published by the RT thread every packet.
#[derive(Default)]
pub struct DeckState {
    position: AtomicU64,
    length: AtomicU64,
    rate: AtomicU64,
    cue: AtomicU64,
    playing: AtomicBool,
    sync: AtomicBool,
    master: AtomicBool,
    /// Track tempo (BPM) from the beat grid, 0 if none.
    bpm: AtomicU64,
}

#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct DeckSnapshot {
    pub position: f64,
    pub length: f64,
    pub rate: f64,
    pub cue: f64,
    pub playing: bool,
    pub sync: bool,
    /// The deck others sync to.
    pub master: bool,
    /// Track tempo from the beat grid; playing tempo is `bpm * rate`.
    pub bpm: Option<f64>,
}

/// Lock-free state shared between the RT thread and the control side.
#[derive(Default)]
pub struct Shared {
    pub decks: [DeckState; DECKS],
    /// Per deck low/mid/high RMS of the last packet (f32 bits), for visuals.
    pub levels: [[AtomicU32; 3]; DECKS],
    /// MIDI clock ticks received (24 per beat) for a BPM readout.
    pub clock_ticks: AtomicU64,
    pub events_dropped: AtomicU64,
    pub midi_out_dropped: AtomicU64,
}

fn store(a: &AtomicU64, v: f64) {
    a.store(v.to_bits(), Ordering::Relaxed);
}

fn load(a: &AtomicU64) -> f64 {
    f64::from_bits(a.load(Ordering::Relaxed))
}

impl Shared {
    /// Low/mid/high RMS (0..~1) of each deck's last packet.
    pub fn levels(&self) -> [[f32; 3]; DECKS] {
        std::array::from_fn(|d| std::array::from_fn(|b| f32::from_bits(self.levels[d][b].load(Ordering::Relaxed))))
    }

    pub fn deck(&self, n: usize) -> DeckSnapshot {
        let d = &self.decks[n];
        DeckSnapshot {
            position: load(&d.position),
            length: load(&d.length),
            rate: load(&d.rate),
            cue: load(&d.cue),
            playing: d.playing.load(Ordering::Relaxed),
            sync: d.sync.load(Ordering::Relaxed),
            master: d.master.load(Ordering::Relaxed),
            bpm: Some(load(&d.bpm)).filter(|b| *b > 0.0),
        }
    }
}

/// The real-time side. Owns the decks; never blocks or allocates while rendering.
pub struct Rt {
    decks: [Deck; DECKS],
    commands: rtrb::Consumer<Command>,
    events: rtrb::Producer<Event>,
    /// Tracks replaced on the RT thread go back to be freed elsewhere.
    garbage: rtrb::Producer<Arc<Track>>,
    shared: Arc<Shared>,
    parser: MidiParser,
    midi_out: MidiOutQueue,
    mix: [[f32; 2]; FRAMES_PER_PACKET],
    /// One-pole low-pass states per deck at 250 Hz and 3 kHz (the band splits).
    split: [[f32; 2]; DECKS],
    split_coef: [f32; 2],
    /// Mono mix of all decks for the visualiser; pushes fail silently when nobody reads.
    viz: rtrb::Producer<f32>,
    sync: SyncState,
}

/// Sync bookkeeping on the RT thread.
#[derive(Default)]
struct SyncState {
    packets: u64,
    was_playing: [bool; DECKS],
    /// Packet count when each deck last started playing (master = longest playing).
    started: [u64; DECKS],
    master: Option<usize>,
    /// No phase snap on this deck before this packet (lets a jump land first).
    snap_hold: [u64; DECKS],
}

/// Phase errors above this many beats are fixed with a jump, smaller ones by bending speed.
const SNAP_BEATS: f64 = 0.05;
/// Speed bend per beat of phase error, and its limit (0.8 % is ~14 cents).
const PHASE_GAIN: f64 = 0.3;
const MAX_BEND: f64 = 0.008;

/// Band-split coefficients for 250 Hz and 3 kHz one-pole low-passes.
fn split_coefficients() -> [f32; 2] {
    [250.0f32, 3000.0].map(|fc| 1.0 - (-std::f32::consts::TAU * fc / SAMPLE_RATE as f32).exp())
}

/// The control side.
pub struct Control {
    /// Mono mix samples for the visualiser (taken once by whoever draws).
    viz: Option<rtrb::Consumer<f32>>,
    commands: rtrb::Producer<Command>,
    pub events: rtrb::Consumer<Event>,
    garbage: rtrb::Consumer<Arc<Track>>,
    pub shared: Arc<Shared>,
}

pub fn new() -> (Control, Rt) {
    let (cmd_tx, cmd_rx) = rtrb::RingBuffer::new(1024);
    let (ev_tx, ev_rx) = rtrb::RingBuffer::new(4096);
    let (gc_tx, gc_rx) = rtrb::RingBuffer::new(64);
    let (viz_tx, viz_rx) = rtrb::RingBuffer::new(8192);
    let shared = Arc::new(Shared::default());
    for d in &shared.decks {
        store(&d.rate, 1.0);
    }
    let rt = Rt {
        decks: std::array::from_fn(|_| Deck::new()),
        commands: cmd_rx,
        events: ev_tx,
        garbage: gc_tx,
        shared: shared.clone(),
        parser: MidiParser::default(),
        midi_out: MidiOutQueue::default(),
        mix: [[0.0; 2]; FRAMES_PER_PACKET],
        split: [[0.0; 2]; DECKS],
        split_coef: split_coefficients(),
        viz: viz_tx,
        sync: SyncState::default(),
    };
    (Control { viz: Some(viz_rx), commands: cmd_tx, events: ev_rx, garbage: gc_rx, shared }, rt)
}

impl Control {
    /// Queue a command for the next packet. Fails only if 1024 commands are pending.
    pub fn send(&mut self, cmd: Command) -> Result<(), Command> {
        self.collect_garbage();
        self.commands.push(cmd).map_err(|rtrb::PushError::Full(c)| c)
    }

    pub fn midi_out(&mut self, msg: MidiMessage) -> Result<(), Command> {
        let (bytes, len) = msg.to_bytes();
        self.send(Command::MidiOut { bytes, len: len as u8 })
    }

    /// The visualiser's mono mix feed; `None` after the first call.
    pub fn take_viz(&mut self) -> Option<rtrb::Consumer<f32>> {
        self.viz.take()
    }

    /// Free tracks the RT thread let go of.
    pub fn collect_garbage(&mut self) {
        while self.garbage.pop().is_ok() {}
    }
}

impl Rt {
    fn apply(&mut self, cmd: Command) {
        match cmd {
            Command::Load { deck, track } => {
                if let Some(old) = self.decks[deck].load(track) {
                    // If the queue is full the drop happens here; it never is in practice.
                    let _ = self.garbage.push(old);
                }
            }
            Command::Play { deck } => self.decks[deck].play(),
            Command::Pause { deck } => self.decks[deck].pause(),
            Command::TogglePlay { deck } => self.decks[deck].toggle(),
            Command::Cue { deck, pressed } => self.decks[deck].cue(pressed),
            Command::Seek { deck, frame } => self.decks[deck].seek(frame),
            Command::Nudge { deck, frames } => self.decks[deck].nudge(frames),
            Command::Rate { deck, rate } => {
                let d = &mut self.decks[deck];
                d.base_rate = rate.clamp(0.25, 4.0);
                if !d.sync || self.sync.master == Some(deck) {
                    d.rate = d.base_rate;
                }
            }
            Command::Sync { deck, on } => {
                let d = &mut self.decks[deck];
                d.sync = on.unwrap_or(!d.sync);
                if !d.sync {
                    d.rate = d.base_rate;
                }
                self.sync.snap_hold[deck] = 0;
            }
            Command::Trim { deck, gain } => self.decks[deck].trim = gain.clamp(0.0, 4.0),
            Command::MidiOut { bytes, len } => {
                if !self.midi_out.push_message(&bytes[..len as usize]) {
                    self.shared.midi_out_dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }

    fn emit(&mut self, ev: Event) {
        if self.events.push(ev).is_err() {
            self.shared.events_dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn publish(&self) {
        for (deck, state) in self.decks.iter().zip(&self.shared.decks) {
            store(&state.position, deck.position);
            store(&state.length, deck.len());
            store(&state.rate, deck.rate);
            store(&state.cue, deck.cue);
            state.playing.store(deck.playing, Ordering::Relaxed);
            state.sync.store(deck.sync, Ordering::Relaxed);
            store(&state.bpm, deck.grid().map_or(0.0, |g| g.bpm));
        }
        for (n, state) in self.shared.decks.iter().enumerate() {
            state.master.store(self.sync.master == Some(n), Ordering::Relaxed);
        }
    }

    /// Pick the master and steer synced decks onto its tempo and beat phase.
    fn run_sync(&mut self) {
        let s = &mut self.sync;
        s.packets += 1;
        for (n, d) in self.decks.iter().enumerate() {
            if d.playing && !s.was_playing[n] {
                s.started[n] = s.packets;
            }
            s.was_playing[n] = d.playing;
        }
        // Master: the longest-playing deck with a grid, preferring one that isn't synced.
        let candidates = || (0..DECKS).filter(|&n| self.decks[n].playing && self.decks[n].grid().is_some());
        let master = candidates()
            .filter(|&n| !self.decks[n].sync)
            .min_by_key(|&n| s.started[n])
            .or_else(|| candidates().min_by_key(|&n| s.started[n]));
        s.master = master;
        let Some(m) = master else {
            for d in self.decks.iter_mut().filter(|d| d.sync) {
                d.rate = d.base_rate;
            }
            return;
        };
        let mg = self.decks[m].grid().expect("master has a grid");
        self.decks[m].rate = self.decks[m].base_rate;
        let master_bpm = mg.bpm * self.decks[m].rate;
        let master_phase = mg.phase_at(self.decks[m].position);
        for n in 0..DECKS {
            let d = &mut self.decks[n];
            if n == m || !d.sync {
                continue;
            }
            let Some(g) = d.grid() else { continue };
            let target = master_bpm / g.bpm;
            if !d.playing {
                d.rate = target;
                continue;
            }
            let err = (master_phase - g.phase_at(d.position) + 0.5).rem_euclid(1.0) - 0.5;
            if err.abs() > SNAP_BEATS && s.packets >= s.snap_hold[n] {
                // Jump onto the beat; the fade-out/in hides it. Both decks already run
                // at the same tempo, so the phase holds while the fade plays out.
                d.seek(d.position + err * g.beat_frames());
                d.rate = target;
                s.snap_hold[n] = s.packets + 300; // ~0.5 s
            } else {
                d.rate = target * (1.0 + (PHASE_GAIN * err).clamp(-MAX_BEND, MAX_BEND));
            }
        }
    }
}

impl Renderer for Rt {
    fn render(&mut self, frames: &mut [Frame; FRAMES_PER_PACKET]) {
        while let Ok(cmd) = self.commands.pop() {
            self.apply(cmd);
        }
        self.run_sync();
        for f in frames.iter_mut() {
            *f = [0; 8];
        }
        let mut mono = [0f32; FRAMES_PER_PACKET];
        for n in 0..DECKS {
            let mut mix = self.mix;
            let outcome = self.decks[n].render(&mut mix);
            let [mut lp1, mut lp2] = self.split[n];
            let [a1, a2] = self.split_coef;
            let mut sq = [0f32; 3];
            for ((f, [l, r]), m) in frames.iter_mut().zip(mix).zip(mono.iter_mut()) {
                f[2 * n] = to_s24(l);
                f[2 * n + 1] = to_s24(r);
                let x = 0.5 * (l + r);
                *m += x;
                lp1 += a1 * (x - lp1);
                lp2 += a2 * (x - lp2);
                sq[0] += lp1 * lp1;
                sq[1] += (lp2 - lp1) * (lp2 - lp1);
                sq[2] += (x - lp2) * (x - lp2);
            }
            self.split[n] = [lp1, lp2];
            for (b, s) in sq.iter().enumerate() {
                let rms = (s / FRAMES_PER_PACKET as f32).sqrt();
                self.shared.levels[n][b].store(rms.to_bits(), Ordering::Relaxed);
            }
            if outcome.ended {
                self.emit(Event::Ended { deck: n });
            }
        }
        if self.viz.slots() >= FRAMES_PER_PACKET {
            for m in mono {
                let _ = self.viz.push(m);
            }
        }
        self.publish();
    }

    fn midi_out(&mut self) -> Option<u8> {
        self.midi_out.pop()
    }

    fn midi_in(&mut self, bytes: &[u8]) {
        for &b in bytes {
            match self.parser.push(b) {
                Some(MidiMessage::Clock) => {
                    self.shared.clock_ticks.fetch_add(1, Ordering::Relaxed);
                }
                Some(m) => self.emit(Event::Midi(m)),
                None => {}
            }
        }
    }
}

#[inline]
fn to_s24(x: f32) -> i32 {
    (x.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn decks_land_on_their_usb_pairs() {
        let (mut control, mut rt) = new();
        let dc = |v: f32| Arc::new(Track::from_samples(PathBuf::from("dc"), vec![v; 96_000]));
        control.send(Command::Load { deck: 1, track: Some(dc(0.5)) }).ok();
        control.send(Command::Load { deck: 3, track: Some(dc(-0.25)) }).ok();
        control.send(Command::Play { deck: 1 }).ok();
        control.send(Command::Play { deck: 3 }).ok();
        let mut frames = [[0; 8]; FRAMES_PER_PACKET];
        for _ in 0..4 {
            rt.render(&mut frames);
        }
        let f = frames[79];
        assert_eq!(&f[0..2], &[0, 0]);
        assert_eq!(&f[2..4], &[to_s24(0.5), to_s24(0.5)]);
        assert_eq!(&f[4..6], &[0, 0]);
        assert_eq!(&f[6..8], &[to_s24(-0.25), to_s24(-0.25)]);
        assert!(control.shared.deck(1).playing);
        assert_eq!(control.shared.deck(1).position, 320.0);
    }

    #[test]
    fn meters_and_viz_feed() {
        let (mut control, mut rt) = new();
        let mut viz = control.take_viz().unwrap();
        assert!(control.take_viz().is_none());
        // 60 Hz sine on deck 0: low band only.
        let sine: Vec<f32> = (0..96_000).flat_map(|i| {
            let v = 0.5 * (std::f32::consts::TAU * 60.0 * i as f32 / 48_000.0).sin();
            [v, v]
        }).collect();
        control.send(Command::Load { deck: 0, track: Some(Arc::new(Track::from_samples(PathBuf::from("s"), sine))) }).ok();
        control.send(Command::Play { deck: 0 }).ok();
        let mut frames = [[0; 8]; FRAMES_PER_PACKET];
        for _ in 0..40 {
            rt.render(&mut frames);
        }
        let [low, mid, high] = control.shared.levels()[0];
        assert!(low > 0.2 && mid < low * 0.5 && high < low * 0.05, "{low} {mid} {high}");
        assert_eq!(control.shared.levels()[1], [0.0; 3]);
        assert_eq!(viz.slots(), 40 * FRAMES_PER_PACKET);
        assert!((viz.pop().unwrap()).abs() < 1e-6);
    }

    fn grid_track(bpm: f64, first_beat: f64) -> Arc<Track> {
        let mut t = Track::from_samples(PathBuf::from("g"), vec![0.0; 48_000 * 2 * 60]);
        t.grid = Some(Grid { bpm, first_beat });
        Arc::new(t)
    }

    fn phase_error(control: &Control, a: usize, b: usize, ga: Grid, gb: Grid) -> f64 {
        let pa = ga.phase_at(control.shared.deck(a).position);
        let pb = gb.phase_at(control.shared.deck(b).position);
        (pa - pb + 0.5).rem_euclid(1.0) - 0.5
    }

    #[test]
    fn sync_locks_tempo_and_phase_to_the_master() {
        let (mut control, mut rt) = new();
        let (ga, gb) = (Grid { bpm: 120.0, first_beat: 0.0 }, Grid { bpm: 125.0, first_beat: 7_000.0 });
        control.send(Command::Load { deck: 0, track: Some(grid_track(ga.bpm, ga.first_beat)) }).ok();
        control.send(Command::Load { deck: 1, track: Some(grid_track(gb.bpm, gb.first_beat)) }).ok();
        control.send(Command::Rate { deck: 0, rate: 1.02 }).ok();
        control.send(Command::Play { deck: 0 }).ok();
        let mut frames = [[0; 8]; FRAMES_PER_PACKET];
        for _ in 0..300 {
            rt.render(&mut frames);
        }
        control.send(Command::Sync { deck: 1, on: Some(true) }).ok();
        control.send(Command::Play { deck: 1 }).ok();
        for _ in 0..1200 {
            rt.render(&mut frames);
        }
        let (a, b) = (control.shared.deck(0), control.shared.deck(1));
        assert!(a.master && !b.master && b.sync);
        let playing_bpm = (a.bpm.unwrap() * a.rate, b.bpm.unwrap() * b.rate);
        assert!((playing_bpm.0 - playing_bpm.1).abs() < 0.2, "{playing_bpm:?}");
        assert!(phase_error(&control, 0, 1, ga, gb).abs() < 0.01, "phase {}", phase_error(&control, 0, 1, ga, gb));
        // Moving the master's pitch carries the synced deck along.
        control.send(Command::Rate { deck: 0, rate: 0.98 }).ok();
        for _ in 0..1200 {
            rt.render(&mut frames);
        }
        let (a, b) = (control.shared.deck(0), control.shared.deck(1));
        assert!((a.bpm.unwrap() * a.rate - b.bpm.unwrap() * b.rate).abs() < 0.2);
        assert!(phase_error(&control, 0, 1, ga, gb).abs() < 0.01);
        // Sync off: back to its own fader.
        control.send(Command::Sync { deck: 1, on: Some(false) }).ok();
        rt.render(&mut frames);
        assert_eq!(control.shared.deck(1).rate, 1.0);
    }

    #[test]
    fn master_is_the_longest_playing_unsynced_deck() {
        let (mut control, mut rt) = new();
        for d in 0..3 {
            control.send(Command::Load { deck: d, track: Some(grid_track(124.0, 0.0)) }).ok();
        }
        control.send(Command::Sync { deck: 0, on: Some(true) }).ok();
        let mut frames = [[0; 8]; FRAMES_PER_PACKET];
        control.send(Command::Play { deck: 0 }).ok();
        rt.render(&mut frames);
        assert!(control.shared.deck(0).master, "a lone synced deck leads");
        control.send(Command::Play { deck: 2 }).ok();
        rt.render(&mut frames);
        assert!(control.shared.deck(2).master, "an unsynced deck beats a synced one");
        control.send(Command::Play { deck: 1 }).ok();
        rt.render(&mut frames);
        assert!(control.shared.deck(2).master, "the longest playing unsynced deck stays master");
    }

    #[test]
    fn midi_in_skips_clock_and_filler() {
        let (mut control, mut rt) = new();
        rt.midi_in(&[0xFD, 0xFD, 0xFD, 0xF8, 0xFF]);
        rt.midi_in(&[0x9F, 0x26, 0x7F, 0xFF]);
        assert_eq!(control.shared.clock_ticks.load(Ordering::Relaxed), 1);
        assert!(matches!(control.events.pop(), Ok(Event::Midi(MidiMessage::NoteOn { ch: 15, note: 0x26, vel: 0x7F }))));
        assert!(control.events.pop().is_err());
    }

    #[test]
    fn midi_out_goes_one_byte_per_packet() {
        let (mut control, mut rt) = new();
        control.midi_out(MidiMessage::NoteOn { ch: 15, note: 38, vel: 127 }).ok();
        let mut frames = [[0; 8]; FRAMES_PER_PACKET];
        let mut sent = vec![];
        for _ in 0..4 {
            rt.render(&mut frames);
            sent.extend(rt.midi_out());
        }
        assert_eq!(sent, vec![0x9F, 38, 127]);
    }
}
