//! The Xone:4D control catalog (config/controls.toml): MIDI message -> control name.

use std::collections::HashMap;

use anyhow::{Context, bail};
use ploytec::MidiMessage;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Button,
    Absolute,
    Relative,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Control {
    pub name: String,
    #[serde(default)]
    pub note: Option<u8>,
    #[serde(default)]
    pub cc: Option<u8>,
    #[serde(default)]
    pub kind: Option<Kind>,
    #[serde(default)]
    pub led: bool,
    /// Map 1 encoders: the note sent per click turning [left, right].
    #[serde(default)]
    pub turn_notes: Option<[u8; 2]>,
}

impl Control {
    pub fn kind(&self) -> Kind {
        self.kind.unwrap_or(if self.note.is_some() { Kind::Button } else { Kind::Absolute })
    }
}

#[derive(Deserialize)]
struct File {
    base_channel: u8,
    #[serde(rename = "control")]
    controls: Vec<Control>,
}

/// What a control did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase", tag = "event", content = "value")]
pub enum ControlEvent {
    Press,
    Release,
    /// Absolute position 0..=127.
    Value(u8),
    /// Relative encoder steps.
    Delta(i8),
}

/// A resolved incoming message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// Catalog name, with "shift." prefixed on the shift layer.
    pub name: String,
    pub base: usize,
    pub event: ControlEvent,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Key {
    Note(u8),
    Cc(u8),
}

pub struct Catalog {
    /// 0-based MIDI channel the mixer sends on.
    pub channel: u8,
    pub controls: Vec<Control>,
    /// Message -> control, plus the step for a Map 1 turn note.
    by_key: HashMap<Key, (usize, Option<i8>)>,
    by_name: HashMap<String, usize>,
}

impl Catalog {
    pub fn parse(text: &str) -> anyhow::Result<Self> {
        let file: File = toml::from_str(text).context("controls.toml")?;
        if !(1..=16).contains(&file.base_channel) {
            bail!("base_channel must be 1-16");
        }
        let mut by_key = HashMap::new();
        let mut by_name = HashMap::new();
        for (i, c) in file.controls.iter().enumerate() {
            let key = match (c.note, c.cc) {
                (Some(n), None) => Key::Note(n),
                (None, Some(n)) => Key::Cc(n),
                _ => bail!("control {} needs exactly one of note or cc", c.name),
            };
            if by_key.insert(key, (i, None)).is_some() {
                bail!("control {} reuses a MIDI message", c.name);
            }
            if let Some([left, right]) = c.turn_notes {
                for (note, step) in [(left, -1), (right, 1)] {
                    if by_key.insert(Key::Note(note), (i, Some(step))).is_some() {
                        bail!("control {} reuses note {note}", c.name);
                    }
                }
            }
            if by_name.insert(c.name.clone(), i).is_some() {
                bail!("duplicate control name {}", c.name);
            }
        }
        Ok(Self { channel: file.base_channel - 1, controls: file.controls, by_key, by_name })
    }

    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        Self::parse(&std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?)
    }

    /// Look up a name as used in mappings ("shift." prefix allowed).
    pub fn find(&self, name: &str) -> Option<(&Control, bool)> {
        let (base, shift) = match name.strip_prefix("shift.") {
            Some(rest) => (rest, true),
            None => (name, false),
        };
        self.by_name.get(base).map(|&i| (&self.controls[i], shift))
    }

    pub fn resolve(&self, msg: &MidiMessage) -> Option<Resolved> {
        let (ch, key, event) = match *msg {
            MidiMessage::NoteOn { ch, note, .. } => (ch, Key::Note(note), ControlEvent::Press),
            MidiMessage::NoteOff { ch, note, .. } => (ch, Key::Note(note), ControlEvent::Release),
            MidiMessage::Cc { ch, num, val } => (ch, Key::Cc(num), ControlEvent::Value(val)),
            _ => return None,
        };
        let shift = if ch == self.channel {
            false
        } else if ch == (self.channel + 15) % 16 {
            true
        } else {
            return None;
        };
        let &(i, turn) = self.by_key.get(&key)?;
        let control = &self.controls[i];
        if let Some(step) = turn {
            // Map 1 encoder click: a note on per step; ignore any note off.
            if event != ControlEvent::Press {
                return None;
            }
            let name = if shift { format!("shift.{}", control.name) } else { control.name.clone() };
            return Some(Resolved { name, base: i, event: ControlEvent::Delta(step) });
        }
        let event = match (control.kind(), event) {
            (Kind::Relative, ControlEvent::Value(v)) => ControlEvent::Delta(if v < 64 { v as i8 } else { (v as i16 - 128) as i8 }),
            (_, e) => e,
        };
        let name = if shift { format!("shift.{}", control.name) } else { control.name.clone() };
        Some(Resolved { name, base: i, event })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Catalog {
        Catalog::parse(include_str!("../../../config/controls.toml")).unwrap()
    }

    #[test]
    fn shipped_catalog_parses() {
        let c = catalog();
        assert_eq!(c.channel, 15);
        assert_eq!(c.controls.len(), 106);
        assert_eq!(c.find("right.lit1").unwrap().0.note, Some(70));
        assert!(c.find("shift.left.jog").unwrap().1);
    }

    #[test]
    fn resolves_buttons_encoders_and_shift() {
        let c = catalog();
        let r = c.resolve(&MidiMessage::NoteOn { ch: 15, note: 38, vel: 127 }).unwrap();
        assert_eq!((r.name.as_str(), r.event), ("left.lit1", ControlEvent::Press));
        let r = c.resolve(&MidiMessage::Cc { ch: 15, num: 36, val: 127 }).unwrap();
        assert_eq!((r.name.as_str(), r.event), ("left.browse", ControlEvent::Delta(-1)));
        let r = c.resolve(&MidiMessage::Cc { ch: 14, num: 19, val: 100 }).unwrap();
        assert_eq!((r.name.as_str(), r.event), ("shift.left.fader1", ControlEvent::Value(100)));
        assert!(c.resolve(&MidiMessage::NoteOn { ch: 3, note: 38, vel: 1 }).is_none());
    }

    #[test]
    fn map1_encoder_notes_turn_the_same_control() {
        let c = catalog();
        let r = c.resolve(&MidiMessage::NoteOn { ch: 15, note: 90, vel: 127 }).unwrap();
        assert_eq!((r.name.as_str(), r.event), ("left.encoder1", ControlEvent::Delta(1)));
        let r = c.resolve(&MidiMessage::NoteOn { ch: 15, note: 89, vel: 127 }).unwrap();
        assert_eq!((r.name.as_str(), r.event), ("left.encoder1", ControlEvent::Delta(-1)));
        let r = c.resolve(&MidiMessage::NoteOn { ch: 15, note: 104, vel: 127 }).unwrap();
        assert_eq!((r.name.as_str(), r.event), ("right.encoder4", ControlEvent::Delta(1)));
        assert!(c.resolve(&MidiMessage::NoteOff { ch: 15, note: 90, vel: 0 }).is_none());
        // Map 2's CC still works for the same control.
        let r = c.resolve(&MidiMessage::Cc { ch: 15, num: 32, val: 127 }).unwrap();
        assert_eq!((r.name.as_str(), r.event), ("left.encoder1", ControlEvent::Delta(-1)));
    }
}
