//! Four-deck playback engine. [`Rt`] runs on the USB streaming thread and
//! renders each deck into its USB pair (deck n -> USB n*2+1/n*2+2 -> mixer
//! channel n+1 with its source on SC). [`Control`] is the other end, used by
//! the server: it sends commands, receives events and reads deck state.

pub mod deck;
pub mod track;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use ploytec::{FRAMES_PER_PACKET, Frame, MidiMessage, MidiOutQueue, MidiParser, Renderer};

pub use deck::Deck;
pub use track::Track;

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
}

#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct DeckSnapshot {
    pub position: f64,
    pub length: f64,
    pub rate: f64,
    pub cue: f64,
    pub playing: bool,
}

/// Lock-free state shared between the RT thread and the control side.
#[derive(Default)]
pub struct Shared {
    pub decks: [DeckState; DECKS],
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
    pub fn deck(&self, n: usize) -> DeckSnapshot {
        let d = &self.decks[n];
        DeckSnapshot {
            position: load(&d.position),
            length: load(&d.length),
            rate: load(&d.rate),
            cue: load(&d.cue),
            playing: d.playing.load(Ordering::Relaxed),
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
}

/// The control side.
pub struct Control {
    commands: rtrb::Producer<Command>,
    pub events: rtrb::Consumer<Event>,
    garbage: rtrb::Consumer<Arc<Track>>,
    pub shared: Arc<Shared>,
}

pub fn new() -> (Control, Rt) {
    let (cmd_tx, cmd_rx) = rtrb::RingBuffer::new(1024);
    let (ev_tx, ev_rx) = rtrb::RingBuffer::new(4096);
    let (gc_tx, gc_rx) = rtrb::RingBuffer::new(64);
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
    };
    (Control { commands: cmd_tx, events: ev_rx, garbage: gc_rx, shared }, rt)
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
            Command::Rate { deck, rate } => self.decks[deck].rate = rate.clamp(0.25, 4.0),
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
        }
    }
}

impl Renderer for Rt {
    fn render(&mut self, frames: &mut [Frame; FRAMES_PER_PACKET]) {
        while let Ok(cmd) = self.commands.pop() {
            self.apply(cmd);
        }
        for f in frames.iter_mut() {
            *f = [0; 8];
        }
        for n in 0..DECKS {
            let mut mix = self.mix;
            let outcome = self.decks[n].render(&mut mix);
            for (f, [l, r]) in frames.iter_mut().zip(mix) {
                f[2 * n] = to_s24(l);
                f[2 * n + 1] = to_s24(r);
            }
            if outcome.ended {
                self.emit(Event::Ended { deck: n });
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
