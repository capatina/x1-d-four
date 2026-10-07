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
    /// Turn sync on/off; `None` toggles. Sync matches tempo only: the beats are
    /// lined up by hand (`Shift`), or once on request (`Align`).
    Sync { deck: usize, on: Option<bool> },
    /// Sync on, and one jump onto the master's beat (de-clicked). Never automatic.
    Align { deck: usize },
    /// Start a loop at the nearest beat, or leave the active one.
    Loop { deck: usize },
    /// Halve (negative) or double (positive) the loop length.
    LoopLength { deck: usize, steps: i32 },
    /// Move the active loop `steps` steps of `beats` (0 = a beat, or the loop's length when
    /// shorter); the playhead moves with it.
    LoopMove { deck: usize, steps: i32, beats: f64 },
    /// Jump this many frames of track time (+ = forward), at once. A synced deck
    /// moves in whole beats, so its beats stay where they were lined up.
    Jog { deck: usize, frames: f64 },
    /// Smooth nudge by this many frames: playing = brief speed bend, paused = glide.
    /// With tempo sync and no phase lock, a synced deck simply keeps the new offset.
    Shift { deck: usize, frames: f64 },
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
    looping: AtomicBool,
    loop_beats: AtomicU64,
    loop_start: AtomicU64,
    loop_end: AtomicU64,
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
    pub looping: bool,
    /// Loop length in beats (the next loop's, when not looping).
    pub loop_beats: f64,
    /// Active loop's start and end frame.
    pub loop_range: Option<(f64, f64)>,
}

/// Lock-free state shared between the RT thread and the control side.
#[derive(Default)]
pub struct Shared {
    pub decks: [DeckState; DECKS],
    /// Per deck low/mid/high RMS of the last packet (f32 bits), for visuals.
    pub levels: [[AtomicU32; 3]; DECKS],
    /// RMS of the 8 channels the mixer sends back over USB (its record channels),
    /// per packet (f32 bits, 0..1 of full scale).
    pub inputs: [AtomicU32; 8],
    /// Low/mid/high RMS of each record pair (1/2, 3/4, 5/6, 7/8) in the last packet (f32 bits):
    /// with channels 1-3's soundcard inputs on their channel post-fader, each mixer
    /// channel as you hear it, after its fader and EQ.
    pub input_bands: [[AtomicU32; 3]; 4],
    /// The loudest of `input_bands` since the visualiser last took them (f32 bits; a
    /// non-negative f32's bits order like the number, so `fetch_max` works).
    pub input_band_peaks: [[AtomicU32; 3]; 4],
    /// While set, every frame the mixer sends back goes to the capture feed (recording).
    pub capture_on: AtomicBool,
    /// Frames the capture feed had no room for (the writer fell behind).
    pub capture_dropped: AtomicU64,
    /// MIDI clock ticks received (24 per beat).
    pub clock_ticks: AtomicU64,
    /// The mixer's tempo from its MIDI clock (f64 bits; 0 = no clock): the global
    /// tempo every synced deck plays at.
    pub clock_bpm: AtomicU64,
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
    /// Low/mid/high RMS (0..~1) of each of the mixer's 4 record pairs in the last packet.
    pub fn input_bands(&self) -> [[f32; 3]; 4] {
        std::array::from_fn(|p| std::array::from_fn(|b| f32::from_bits(self.input_bands[p][b].load(Ordering::Relaxed))))
    }

    /// The loudest low/mid/high of each record pair since the last call (then reset).
    pub fn take_input_band_peaks(&self) -> [[f32; 3]; 4] {
        std::array::from_fn(|p| std::array::from_fn(|b| f32::from_bits(self.input_band_peaks[p][b].swap(0, Ordering::Relaxed))))
    }

    /// RMS (0..1) of the mixer's 8 record channels in the last packet.
    pub fn inputs(&self) -> [f32; 8] {
        std::array::from_fn(|c| f32::from_bits(self.inputs[c].load(Ordering::Relaxed)))
    }

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
            looping: d.looping.load(Ordering::Relaxed),
            loop_beats: load(&d.loop_beats),
            loop_range: d.looping.load(Ordering::Relaxed).then(|| (load(&d.loop_start), load(&d.loop_end))),
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
    capture: rtrb::Producer<Frame>,
    /// Band-split states of the 4 record pairs.
    input_split: [[f32; 2]; 4],
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
    clock: ClockTempo,
}

/// Clock ticks the tempo is measured over (8 beats), and how long without a tick
/// means the clock stopped (half a second, in packets).
const CLOCK_SPAN: usize = 192;
const CLOCK_TIMEOUT: u64 = SAMPLE_RATE as u64 / 2 / FRAMES_PER_PACKET as u64;

/// The mixer's MIDI clock against our own sample clock: tick arrival times in
/// packets (1.67 ms), measured over up to 8 beats, so USB jitter averages out.
struct ClockTempo {
    at: [u64; CLOCK_SPAN + 1],
    head: usize,
    count: usize,
    bpm: Option<f64>,
}

impl Default for ClockTempo {
    fn default() -> Self {
        Self { at: [0; CLOCK_SPAN + 1], head: 0, count: 0, bpm: None }
    }
}

impl ClockTempo {
    fn last(&self) -> u64 {
        self.at[(self.head + self.at.len() - 1) % self.at.len()]
    }

    fn tick(&mut self, packet: u64) {
        let n = self.at.len();
        if self.count > 0 && packet - self.last() > CLOCK_TIMEOUT {
            self.count = 0;
        }
        self.at[self.head] = packet;
        self.head = (self.head + 1) % n;
        self.count = (self.count + 1).min(n);
        // At least a beat before trusting it.
        if self.count > 24 {
            let oldest = self.at[(self.head + n - self.count) % n];
            let span = (packet - oldest) as f64 * FRAMES_PER_PACKET as f64 / SAMPLE_RATE as f64;
            if span > 0.0 {
                self.bpm = Some((self.count - 1) as f64 / 24.0 * 60.0 / span);
            }
        }
    }

    /// The tempo, or None once the clock has stopped.
    fn bpm(&mut self, packet: u64) -> Option<f64> {
        if self.count == 0 || packet - self.last() > CLOCK_TIMEOUT {
            self.count = 0;
            self.bpm = None;
        }
        self.bpm
    }
}

/// Band-split coefficients for 250 Hz and 3 kHz one-pole low-passes.
fn split_coefficients() -> [f32; 2] {
    [250.0f32, 3000.0].map(|fc| 1.0 - (-std::f32::consts::TAU * fc / SAMPLE_RATE as f32).exp())
}

/// The control side.
pub struct Control {
    /// Mono mix samples for the visualiser (taken once by whoever draws).
    viz: Option<rtrb::Consumer<f32>>,
    /// The mixer's 8 record channels while `capture_on` (taken once by the recorder).
    capture: Option<rtrb::Consumer<Frame>>,
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
    // 4 s of the mixer's record channels, so the writer can stall on the disk for a moment.
    let (cap_tx, cap_rx) = rtrb::RingBuffer::new(SAMPLE_RATE as usize * 4);
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
        capture: cap_tx,
        input_split: [[0.0; 2]; 4],
        sync: SyncState::default(),
    };
    (Control { viz: Some(viz_rx), capture: Some(cap_rx), commands: cmd_tx, events: ev_rx, garbage: gc_rx, shared }, rt)
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

    /// The recorder's feed of the mixer's record channels; `None` after the first call.
    pub fn take_capture(&mut self) -> Option<rtrb::Consumer<Frame>> {
        self.capture.take()
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
                // Every loaded track starts synced; the deck's sync button turns it off.
                if track.is_some() {
                    self.decks[deck].sync = true;
                }
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
            Command::Loop { deck } => {
                self.decks[deck].toggle_loop();
            }
            Command::LoopLength { deck, steps } => self.decks[deck].change_loop_length(steps),
            Command::LoopMove { deck, steps, beats } => self.decks[deck].move_loop(steps, beats),
            Command::Jog { deck, frames } => {
                let d = &mut self.decks[deck];
                let following = d.sync && d.playing && self.sync.master.is_some_and(|m| m != deck);
                let mut frames = frames;
                if let Some(g) = d.grid().filter(|_| following) {
                    // Synced: move in whole beats, collecting smaller turns until they
                    // add up (turning back starts over). Shift moves it off the beat.
                    let rest = if d.jog_rest * frames < 0.0 { 0.0 } else { d.jog_rest };
                    let beats = rest + frames / g.beat_frames();
                    d.jog_rest = beats.fract();
                    frames = beats.trunc() * g.beat_frames();
                }
                if frames != 0.0 {
                    d.nudge(frames);
                }
            }
            // The deck itself glides by the shift; nothing pulls it back.
            Command::Shift { deck, frames } => self.decks[deck].shift_pending += frames,
            Command::Sync { deck, on } => {
                let d = &mut self.decks[deck];
                d.sync = on.unwrap_or(!d.sync);
                d.jog_rest = 0.0;
                if !d.sync {
                    d.rate = d.base_rate;
                }
            }
            Command::Align { deck } => {
                self.decks[deck].sync = true;
                self.decks[deck].jog_rest = 0.0;
                self.decks[deck].shift_pending = 0.0;
                self.align(deck);
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
            store(&state.position, deck.heading());
            store(&state.length, deck.len());
            store(&state.rate, deck.rate);
            store(&state.cue, deck.cue);
            state.playing.store(deck.playing, Ordering::Relaxed);
            state.sync.store(deck.sync, Ordering::Relaxed);
            store(&state.bpm, deck.grid().map_or(0.0, |g| g.bpm));
            if let Some((a, b)) = deck.looping {
                store(&state.loop_start, a);
                store(&state.loop_end, b);
            }
            state.looping.store(deck.looping.is_some(), Ordering::Relaxed);
            store(&state.loop_beats, deck.loop_beats());
        }
        for (n, state) in self.shared.decks.iter().enumerate() {
            state.master.store(self.sync.master == Some(n), Ordering::Relaxed);
        }
    }

    /// Pick the master and match synced decks to its tempo (not its phase).
    fn run_sync(&mut self) {
        let s = &mut self.sync;
        s.packets += 1;
        for (n, d) in self.decks.iter().enumerate() {
            if d.playing && !s.was_playing[n] {
                s.started[n] = s.packets;
            }
            s.was_playing[n] = d.playing;
        }
        // Master: the longest-playing deck with a grid, preferring one that isn't synced
        // (it's the beat `Align` lines up with).
        let candidates = || (0..DECKS).filter(|&n| self.decks[n].playing && self.decks[n].grid().is_some());
        let master = candidates()
            .filter(|&n| !self.decks[n].sync)
            .min_by_key(|&n| s.started[n])
            .or_else(|| candidates().min_by_key(|&n| s.started[n]));
        s.master = master;
        // The tempo is global: the mixer's MIDI clock when it sends one, else the master's.
        let clock = s.clock.bpm(s.packets);
        store(&self.shared.clock_bpm, clock.unwrap_or(0.0));
        let tempo = clock.or_else(|| {
            let d = &mut self.decks[master?];
            d.rate = d.base_rate;
            Some(d.grid()?.bpm * d.rate)
        });
        for (n, d) in self.decks.iter_mut().enumerate() {
            if !d.sync || (clock.is_none() && Some(n) == master) {
                continue;
            }
            // Tempo only (the pitch fader doesn't move a synced deck): the beats are
            // lined up by hand with the right jog, never pulled.
            d.rate = match (tempo, d.grid()) {
                (Some(t), Some(g)) => t / g.bpm,
                _ => d.base_rate,
            };
        }
    }

    /// One jump onto the master's beat (with the transport fade), on request only.
    fn align(&mut self, deck: usize) {
        let Some(m) = self.sync.master.filter(|&m| m != deck) else { return };
        let (Some(mg), Some(g)) = (self.decks[m].grid(), self.decks[deck].grid()) else { return };
        let master_phase = mg.phase_at(self.decks[m].heading());
        let d = &mut self.decks[deck];
        let err = (master_phase - g.phase_at(d.heading()) + 0.5).rem_euclid(1.0) - 0.5;
        if err != 0.0 {
            // Lands where it would have been after the fade, like any nudge.
            d.nudge(err * g.beat_frames());
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

    fn captured(&mut self, frames: &[Frame; FRAMES_PER_PACKET]) {
        for c in 0..8 {
            let sq: f64 = frames.iter().map(|f| (f[c] as f64 / 8_388_608.0).powi(2)).sum();
            let rms = (sq / FRAMES_PER_PACKET as f64).sqrt() as f32;
            self.shared.inputs[c].store(rms.to_bits(), Ordering::Relaxed);
        }
        // Each record pair split into low/mid/high, like the decks.
        let [a1, a2] = self.split_coef;
        for p in 0..4 {
            let [mut lp1, mut lp2] = self.input_split[p];
            let mut sq = [0f32; 3];
            for f in frames {
                let x = 0.5 * (f[p * 2] + f[p * 2 + 1]) as f32 / 8_388_608.0;
                lp1 += a1 * (x - lp1);
                lp2 += a2 * (x - lp2);
                sq[0] += lp1 * lp1;
                sq[1] += (lp2 - lp1) * (lp2 - lp1);
                sq[2] += (x - lp2) * (x - lp2);
            }
            self.input_split[p] = [lp1, lp2];
            for (b, v) in sq.iter().enumerate() {
                let rms = (v / FRAMES_PER_PACKET as f32).sqrt().to_bits();
                self.shared.input_bands[p][b].store(rms, Ordering::Relaxed);
                self.shared.input_band_peaks[p][b].fetch_max(rms, Ordering::Relaxed);
            }
        }
        if self.shared.capture_on.load(Ordering::Relaxed) {
            for f in frames {
                if self.capture.push(*f).is_err() {
                    self.shared.capture_dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }

    fn midi_in(&mut self, bytes: &[u8]) {
        for &b in bytes {
            match self.parser.push(b) {
                Some(MidiMessage::Clock) => {
                    self.shared.clock_ticks.fetch_add(1, Ordering::Relaxed);
                    self.sync.clock.tick(self.sync.packets);
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
    fn sync_matches_tempo_but_leaves_the_phase() {
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
        for _ in 0..60 {
            rt.render(&mut frames);
        }
        let (a, b) = (control.shared.deck(0), control.shared.deck(1));
        assert!(a.master && !b.master && b.sync);
        let playing_bpm = (a.bpm.unwrap() * a.rate, b.bpm.unwrap() * b.rate);
        assert!((playing_bpm.0 - playing_bpm.1).abs() < 0.01, "{playing_bpm:?}");
        // No phase lock: wherever the beats sit, they stay there.
        let before = phase_error(&control, 0, 1, ga, gb);
        for _ in 0..1200 {
            rt.render(&mut frames);
        }
        let after = phase_error(&control, 0, 1, ga, gb);
        assert!((after - before).abs() < 0.002, "phase pulled from {before} to {after}");
        // Moving the master's pitch carries the synced deck's tempo along.
        control.send(Command::Rate { deck: 0, rate: 0.98 }).ok();
        rt.render(&mut frames);
        let (a, b) = (control.shared.deck(0), control.shared.deck(1));
        assert!((a.bpm.unwrap() * a.rate - b.bpm.unwrap() * b.rate).abs() < 0.01);
        // Sync off: back to its own fader.
        control.send(Command::Sync { deck: 1, on: Some(false) }).ok();
        rt.render(&mut frames);
        assert_eq!(control.shared.deck(1).rate, 1.0);
    }

    #[test]
    fn the_mixer_clock_sets_the_tempo_of_every_synced_deck() {
        let (mut control, mut rt) = new();
        let mut frames = [[0; 8]; FRAMES_PER_PACKET];
        control.send(Command::Load { deck: 0, track: Some(grid_track(120.0, 0.0)) }).ok();
        control.send(Command::Load { deck: 1, track: Some(grid_track(128.0, 0.0)) }).ok();
        control.send(Command::Rate { deck: 0, rate: 1.04 }).ok();
        control.send(Command::Play { deck: 0 }).ok();
        control.send(Command::Play { deck: 1 }).ok();
        // 125 BPM = 50 ticks a second = a tick every 12 packets; every third one a packet late.
        for i in 0..1200u64 {
            let late = i % 36 == 12;
            if i % 12 == 0 && !late {
                rt.midi_in(&[0xF8]);
            }
            rt.render(&mut frames);
            if i % 12 == 0 && late {
                rt.midi_in(&[0xF8]);
            }
        }
        let bpm = f64::from_bits(control.shared.clock_bpm.load(Ordering::Relaxed));
        assert!((bpm - 125.0).abs() < 0.2, "clock {bpm}");
        for d in 0..2 {
            let s = control.shared.deck(d);
            assert!((s.bpm.unwrap() * s.rate - 125.0).abs() < 0.2, "deck {} at {}", d + 1, s.bpm.unwrap() * s.rate);
        }
        // The clock stops: back to the master deck's own tempo (its pitch fader counts again).
        for _ in 0..400 {
            rt.render(&mut frames);
        }
        assert_eq!(control.shared.clock_bpm.load(Ordering::Relaxed), 0f64.to_bits());
        let master = control.shared.deck(0);
        assert!((master.bpm.unwrap() * master.rate - 124.8).abs() < 0.01);
    }

    #[test]
    fn jog_jumps_paused_and_playing_decks() {
        let (mut control, mut rt) = new();
        let mut frames = [[0; 8]; FRAMES_PER_PACKET];
        control.send(Command::Load { deck: 0, track: Some(grid_track(120.0, 0.0)) }).ok();
        control.send(Command::Sync { deck: 0, on: Some(false) }).ok();
        control.send(Command::Seek { deck: 0, frame: 48_000.0 }).ok();
        control.send(Command::Jog { deck: 0, frames: 4_800.0 }).ok();
        control.send(Command::Jog { deck: 0, frames: 4_800.0 }).ok();
        rt.render(&mut frames);
        assert_eq!(control.shared.deck(0).position, 57_600.0, "paused: lands at once");
        // Playing: ends up the jogged amount ahead of where it would have been.
        control.send(Command::Play { deck: 0 }).ok();
        for _ in 0..10 {
            rt.render(&mut frames);
        }
        let base = control.shared.deck(0).position;
        control.send(Command::Jog { deck: 0, frames: -960.0 }).ok();
        for _ in 0..300 {
            rt.render(&mut frames);
        }
        let expected = base + 300.0 * 80.0 - 960.0;
        assert!((control.shared.deck(0).position - expected).abs() < 1.0, "{} vs {expected}", control.shared.deck(0).position);
    }

    #[test]
    fn shift_glides_paused_and_playing_decks() {
        let (mut control, mut rt) = new();
        let mut frames = [[0; 8]; FRAMES_PER_PACKET];
        control.send(Command::Load { deck: 0, track: Some(grid_track(120.0, 0.0)) }).ok();
        control.send(Command::Sync { deck: 0, on: Some(false) }).ok();
        control.send(Command::Seek { deck: 0, frame: 48_000.0 }).ok();
        control.send(Command::Shift { deck: 0, frames: 4_800.0 }).ok();
        rt.render(&mut frames);
        let after_one = control.shared.deck(0).position;
        assert!(after_one > 48_000.0 && after_one < 48_000.0 + 4_800.0, "glides, doesn't jump: {after_one}");
        for _ in 0..80 {
            rt.render(&mut frames);
        }
        assert_eq!(control.shared.deck(0).position, 52_800.0);
        control.send(Command::Play { deck: 0 }).ok();
        for _ in 0..10 {
            rt.render(&mut frames);
        }
        let base = control.shared.deck(0).position;
        control.send(Command::Shift { deck: 0, frames: -960.0 }).ok();
        for _ in 0..300 {
            rt.render(&mut frames);
        }
        let expected = base + 300.0 * 80.0 - 960.0;
        assert!((control.shared.deck(0).position - expected).abs() < 1.0, "{} vs {expected}", control.shared.deck(0).position);
    }

    #[test]
    fn shifting_a_synced_deck_keeps_the_new_offset() {
        let (mut control, mut rt) = new();
        let mut frames = [[0; 8]; FRAMES_PER_PACKET];
        let (ga, gb) = (Grid { bpm: 124.0, first_beat: 0.0 }, Grid { bpm: 124.0, first_beat: 3_000.0 });
        control.send(Command::Load { deck: 0, track: Some(grid_track(ga.bpm, ga.first_beat)) }).ok();
        control.send(Command::Load { deck: 1, track: Some(grid_track(gb.bpm, gb.first_beat)) }).ok();
        control.send(Command::Play { deck: 0 }).ok();
        for _ in 0..100 {
            rt.render(&mut frames);
        }
        control.send(Command::Play { deck: 1 }).ok();
        for _ in 0..100 {
            rt.render(&mut frames);
        }
        let start = phase_error(&control, 0, 1, ga, gb);
        // Shift deck 2 a tenth of a beat ahead, in small ticks.
        let tenth = gb.beat_frames() / 10.0;
        for _ in 0..10 {
            control.send(Command::Shift { deck: 1, frames: tenth / 10.0 }).ok();
            rt.render(&mut frames);
        }
        for _ in 0..1200 {
            rt.render(&mut frames);
        }
        let err = phase_error(&control, 0, 1, ga, gb);
        assert!((err - (start - 0.1)).abs() < 0.005, "moved a tenth of a beat and stays: {start} -> {err}");
        // Jogging moves whole beats: further along, same place against the beat.
        let before = control.shared.deck(1).position;
        control.send(Command::Jog { deck: 1, frames: 0.4 * gb.beat_frames() }).ok();
        control.send(Command::Jog { deck: 1, frames: 0.4 * gb.beat_frames() }).ok();
        control.send(Command::Jog { deck: 1, frames: 1.5 * gb.beat_frames() }).ok();
        for _ in 0..100 {
            rt.render(&mut frames);
        }
        let jumped = control.shared.deck(1).position - before - 100.0 * FRAMES_PER_PACKET as f64;
        assert!((jumped - 2.0 * gb.beat_frames()).abs() < 0.02 * gb.beat_frames(), "jumped {jumped} frames");
        let err2 = phase_error(&control, 0, 1, ga, gb);
        assert!((err2 - err).abs() < 0.005, "still where it was lined up: {err2}");
        // Align (on request only): one jump onto the master's beat.
        control.send(Command::Align { deck: 1 }).ok();
        for _ in 0..100 {
            rt.render(&mut frames);
        }
        let err = phase_error(&control, 0, 1, ga, gb);
        assert!(err.abs() < 0.005, "back on the beat: {err}");
    }

    #[test]
    fn tracks_carry_a_three_band_waveform() {
        let t = grid_track(120.0, 0.0);
        assert_eq!(t.bands.len(), t.frames().div_ceil(track::WAVE_BLOCK));
    }

    #[test]
    fn loads_switch_sync_on() {
        let (mut control, mut rt) = new();
        let mut frames = [[0; 8]; FRAMES_PER_PACKET];
        control.send(Command::Load { deck: 2, track: Some(grid_track(126.0, 0.0)) }).ok();
        rt.render(&mut frames);
        assert!(control.shared.deck(2).sync);
        control.send(Command::Sync { deck: 2, on: Some(false) }).ok();
        rt.render(&mut frames);
        assert!(!control.shared.deck(2).sync);
        control.send(Command::Load { deck: 2, track: Some(grid_track(128.0, 0.0)) }).ok();
        rt.render(&mut frames);
        assert!(control.shared.deck(2).sync, "the next load syncs again");
    }

    #[test]
    fn master_is_the_longest_playing_unsynced_deck() {
        let (mut control, mut rt) = new();
        for d in 0..3 {
            control.send(Command::Load { deck: d, track: Some(grid_track(124.0, 0.0)) }).ok();
        }
        // Loads sync every deck; take decks 1 and 2 back off sync for this test.
        control.send(Command::Sync { deck: 1, on: Some(false) }).ok();
        control.send(Command::Sync { deck: 2, on: Some(false) }).ok();
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

    /// Two synced decks playing in phase: deck 1 (index 0) is the master.
    fn two_synced(bpm_b: f64) -> (Control, Rt, Grid, Grid) {
        let (mut control, mut rt) = new();
        let mut frames = [[0; 8]; FRAMES_PER_PACKET];
        let (ga, gb) = (Grid { bpm: 125.0, first_beat: 1_000.0 }, Grid { bpm: bpm_b, first_beat: 7_000.0 });
        control.send(Command::Load { deck: 0, track: Some(grid_track(ga.bpm, ga.first_beat)) }).ok();
        control.send(Command::Load { deck: 1, track: Some(grid_track(gb.bpm, gb.first_beat)) }).ok();
        control.send(Command::Play { deck: 0 }).ok();
        for _ in 0..100 {
            rt.render(&mut frames);
        }
        control.send(Command::Play { deck: 1 }).ok();
        for _ in 0..1200 {
            rt.render(&mut frames);
        }
        (control, rt, ga, gb)
    }

    #[test]
    fn a_half_beat_loop_traps_only_its_own_deck() {
        for looper in [0, 1] {
            let (mut control, mut rt, _, _) = two_synced(128.0);
            let mut frames = [[0; 8]; FRAMES_PER_PACKET];
            control.send(Command::LoopLength { deck: looper, steps: -6 }).ok();
            control.send(Command::Loop { deck: looper }).ok();
            rt.render(&mut frames);
            let range = control.shared.deck(looper).loop_range.unwrap();
            let other = 1 - looper;
            let mut last = control.shared.deck(other).position;
            let mut inside = false;
            for _ in 0..3000 {
                rt.render(&mut frames);
                let p = control.shared.deck(other).position;
                assert!(p > last, "deck {} pulled back by deck {looper}'s loop", other + 1);
                last = p;
                // The loop starts at the nearest beat, which may still be ahead; once in, it holds.
                let lp = control.shared.deck(looper).position;
                inside |= lp >= range.0;
                assert!(lp < range.1 + 1.0 && (!inside || lp >= range.0 - 1.0), "the loop holds: {lp} in {range:?}");
            }
        }
    }

    #[test]
    fn shifting_the_master_moves_only_the_master() {
        let (mut control, mut rt, ga, gb) = two_synced(124.0);
        let mut frames = [[0; 8]; FRAMES_PER_PACKET];
        assert!(control.shared.deck(0).master);
        let start = phase_error(&control, 0, 1, ga, gb);
        let other = control.shared.deck(1).position;
        // A fast turn: a fifth of a beat in big ticks, then let it settle.
        for _ in 0..4 {
            control.send(Command::Shift { deck: 0, frames: ga.beat_frames() / 20.0 }).ok();
            for _ in 0..24 {
                rt.render(&mut frames);
            }
        }
        for _ in 0..600 {
            rt.render(&mut frames);
        }
        let err = phase_error(&control, 0, 1, ga, gb);
        let moved = (err - start + 0.5).rem_euclid(1.0) - 0.5;
        assert!((moved - 0.2).abs() < 0.005, "the master moved a fifth of a beat: {moved}");
        let expected = other + (96.0 + 600.0) * FRAMES_PER_PACKET as f64 * control.shared.deck(1).rate;
        assert!((control.shared.deck(1).position - expected).abs() < 2.0, "the other deck ran on untouched");
    }

    #[test]
    fn the_mixers_record_channels_are_metered() {
        let (mut control, mut rt) = new();
        let mut frames = [[0; 8]; FRAMES_PER_PACKET];
        for f in frames.iter_mut() {
            f[2] = 4_194_304; // half scale on channel 3
        }
        rt.captured(&frames);
        let inputs = control.shared.inputs();
        assert!((inputs[2] - 0.5).abs() < 1e-6 && inputs[0] == 0.0, "{inputs:?}");
        // Recording: frames reach the capture feed only while it's on.
        let mut feed = control.take_capture().unwrap();
        assert!(feed.pop().is_err());
        control.shared.capture_on.store(true, Ordering::Relaxed);
        rt.captured(&frames);
        assert_eq!(feed.slots(), FRAMES_PER_PACKET);
        assert_eq!(feed.pop().unwrap()[2], 4_194_304);
    }
}
