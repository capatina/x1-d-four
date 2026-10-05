//! MIDI over the Xone:4D's USB link.
//!
//! IN: EP 0x83 bulk carries a raw MIDI byte stream padded with 0xFD and 0xFF
//! (an idle 51/s packet looks like `FD FD FD F8 FF`: filler around a clock tick).
//! OUT: one byte per PCM packet in the first MIDI slot (see `codec`).

/// A parsed MIDI message. Channels are 0-based (MIDI channel 16 is 15).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MidiMessage {
    NoteOn { ch: u8, note: u8, vel: u8 },
    NoteOff { ch: u8, note: u8, vel: u8 },
    Cc { ch: u8, num: u8, val: u8 },
    ProgramChange { ch: u8, program: u8 },
    PitchBend { ch: u8, value: u16 },
    Clock,
    Start,
    Continue,
    Stop,
}

impl MidiMessage {
    /// Encode a channel message into bytes (for MIDI out).
    pub fn to_bytes(self) -> ([u8; 3], usize) {
        match self {
            Self::NoteOn { ch, note, vel } => ([0x90 | ch, note, vel], 3),
            Self::NoteOff { ch, note, vel } => ([0x80 | ch, note, vel], 3),
            Self::Cc { ch, num, val } => ([0xB0 | ch, num, val], 3),
            Self::ProgramChange { ch, program } => ([0xC0 | ch, program, 0], 2),
            Self::PitchBend { ch, value } => ([0xE0 | ch, (value & 0x7F) as u8, (value >> 7) as u8], 3),
            Self::Clock => ([0xF8, 0, 0], 1),
            Self::Start => ([0xFA, 0, 0], 1),
            Self::Continue => ([0xFB, 0, 0], 1),
            Self::Stop => ([0xFC, 0, 0], 1),
        }
    }
}

/// True for the filler bytes the Xone pads MIDI IN packets with.
#[inline]
pub fn is_filler(b: u8) -> bool {
    b == 0xFD || b == 0xFF
}

/// Streaming MIDI parser with running status.
#[derive(Default)]
pub struct MidiParser {
    status: u8,
    data: [u8; 2],
    have: usize,
    in_sysex: bool,
}

impl MidiParser {
    /// Feed raw bytes from the device; filler bytes are skipped.
    pub fn feed(&mut self, bytes: &[u8], mut emit: impl FnMut(MidiMessage)) {
        for &b in bytes {
            if let Some(m) = self.push(b) {
                emit(m);
            }
        }
    }

    pub fn push(&mut self, b: u8) -> Option<MidiMessage> {
        if is_filler(b) {
            return None;
        }
        if b >= 0xF8 {
            // Real-time: may interleave anywhere, leaves running status alone.
            return match b {
                0xF8 => Some(MidiMessage::Clock),
                0xFA => Some(MidiMessage::Start),
                0xFB => Some(MidiMessage::Continue),
                0xFC => Some(MidiMessage::Stop),
                _ => None,
            };
        }
        if b >= 0x80 {
            self.have = 0;
            if b == 0xF0 {
                self.in_sysex = true;
                self.status = 0;
            } else if b >= 0xF0 {
                // System common (incl. 0xF7 end of SysEx) cancels running status.
                self.in_sysex = false;
                self.status = 0;
            } else {
                self.in_sysex = false;
                self.status = b;
            }
            return None;
        }
        if self.in_sysex || self.status == 0 {
            return None;
        }
        self.data[self.have] = b;
        self.have += 1;
        let needed = match self.status & 0xF0 {
            0xC0 | 0xD0 => 1,
            _ => 2,
        };
        if self.have < needed {
            return None;
        }
        self.have = 0;
        let ch = self.status & 0x0F;
        let [d1, d2] = self.data;
        match self.status & 0xF0 {
            0x90 if d2 > 0 => Some(MidiMessage::NoteOn { ch, note: d1, vel: d2 }),
            0x90 | 0x80 => Some(MidiMessage::NoteOff { ch, note: d1, vel: d2 }),
            0xB0 => Some(MidiMessage::Cc { ch, num: d1, val: d2 }),
            0xC0 => Some(MidiMessage::ProgramChange { ch, program: d1 }),
            0xE0 => Some(MidiMessage::PitchBend { ch, value: d1 as u16 | (d2 as u16) << 7 }),
            _ => None,
        }
    }
}

/// Fixed-size byte FIFO for MIDI out, drained one byte per PCM packet.
/// Allocation-free so the RT thread can own it.
pub struct MidiOutQueue {
    buf: [u8; 1024],
    head: usize,
    len: usize,
}

impl Default for MidiOutQueue {
    fn default() -> Self {
        Self { buf: [0; 1024], head: 0, len: 0 }
    }
}

impl MidiOutQueue {
    /// Queue a whole message; returns false (and queues nothing) if it doesn't fit.
    pub fn push_message(&mut self, bytes: &[u8]) -> bool {
        if self.len + bytes.len() > self.buf.len() {
            return false;
        }
        for &b in bytes {
            let i = (self.head + self.len) % self.buf.len();
            self.buf[i] = b;
            self.len += 1;
        }
        true
    }

    pub fn pop(&mut self) -> Option<u8> {
        if self.len == 0 {
            return None;
        }
        let b = self.buf[self.head];
        self.head = (self.head + 1) % self.buf.len();
        self.len -= 1;
        Some(b)
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(bytes: &[u8]) -> Vec<MidiMessage> {
        let mut p = MidiParser::default();
        let mut out = vec![];
        p.feed(bytes, |m| out.push(m));
        out
    }

    #[test]
    fn idle_packet_is_one_clock() {
        assert_eq!(parse(&[0xFD, 0xFD, 0xFD, 0xF8, 0xFF]), vec![MidiMessage::Clock]);
    }

    #[test]
    fn running_status_and_interleaved_clock() {
        let msgs = parse(&[0x9F, 0x24, 0x7F, 0xF8, 0x24, 0x00, 0xFD, 0xBF, 0x20, 0x01, 0x20, 0x7F]);
        assert_eq!(
            msgs,
            vec![
                MidiMessage::NoteOn { ch: 15, note: 0x24, vel: 0x7F },
                MidiMessage::Clock,
                MidiMessage::NoteOff { ch: 15, note: 0x24, vel: 0 },
                MidiMessage::Cc { ch: 15, num: 0x20, val: 1 },
                MidiMessage::Cc { ch: 15, num: 0x20, val: 0x7F },
            ]
        );
    }

    #[test]
    fn message_split_across_packets() {
        let mut p = MidiParser::default();
        let mut out = vec![];
        p.feed(&[0xFD, 0x9F, 0x48, 0xFF], |m| out.push(m));
        assert!(out.is_empty());
        p.feed(&[0xFD, 0x7F, 0xFF], |m| out.push(m));
        assert_eq!(out, vec![MidiMessage::NoteOn { ch: 15, note: 0x48, vel: 0x7F }]);
    }

    #[test]
    fn sysex_is_skipped() {
        assert_eq!(parse(&[0xF0, 0x41, 0x10, 0xF7, 0x9F, 1, 2]), vec![MidiMessage::NoteOn { ch: 15, note: 1, vel: 2 }]);
    }

    #[test]
    fn out_queue_is_fifo_and_bounded() {
        let mut q = MidiOutQueue::default();
        assert!(q.push_message(&[0x9F, 0x26, 0x7F]));
        assert_eq!((q.pop(), q.pop(), q.pop(), q.pop()), (Some(0x9F), Some(0x26), Some(0x7F), None));
        for _ in 0..341 {
            assert!(q.push_message(&[1, 2, 3]));
        }
        assert!(!q.push_message(&[1, 2, 3]));
    }
}
