//! config/mappings.toml: control name -> action, plus LED feedback rules.

use anyhow::{Context, anyhow, bail};
use serde::{Deserialize, Serialize};

use crate::controls::{Catalog, ControlEvent, Kind};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Mapping {
    pub control: String,
    pub action: String,
    /// 1-4; omitted = the focused deck.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deck: Option<u8>,
    /// Step size or range, meaning depends on the action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub led: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(default, rename = "map")]
    maps: Vec<Mapping>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Action {
    PlayPause,
    Play,
    Pause,
    Cue,
    LoadSelected,
    Eject,
    Focus,
    RateReset,
    Nudge,
    Rate,
    Trim,
    Scroll,
}

impl Action {
    fn parse(s: &str) -> anyhow::Result<Self> {
        Ok(match s {
            "deck.play_pause" => Self::PlayPause,
            "deck.play" => Self::Play,
            "deck.pause" => Self::Pause,
            "deck.cue" => Self::Cue,
            "deck.load_selected" | "library.load_selected" => Self::LoadSelected,
            "deck.eject" => Self::Eject,
            "deck.focus" => Self::Focus,
            "deck.rate_reset" => Self::RateReset,
            "deck.nudge" => Self::Nudge,
            "deck.rate" => Self::Rate,
            "deck.trim" => Self::Trim,
            "library.scroll" => Self::Scroll,
            other => bail!("unknown action {other:?}"),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LedRule {
    DeckPlaying,
    DeckLoaded,
    DeckFocused,
}

/// What a mapping asks the app to do. `deck: None` means the focused deck.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Intent {
    PlayPause(Option<usize>),
    Play(Option<usize>),
    Pause(Option<usize>),
    Cue(Option<usize>, bool),
    LoadSelected(Option<usize>),
    Eject(Option<usize>),
    Focus(usize),
    RateReset(Option<usize>),
    Nudge(Option<usize>, f64),
    RateDelta(Option<usize>, f64),
    RateSet(Option<usize>, f64),
    TrimSet(Option<usize>, f64),
    TrimDelta(Option<usize>, f64),
    Scroll(i32),
}

pub struct Rule {
    pub source: Mapping,
    pub action: Action,
    pub deck: Option<usize>,
    pub amount: Option<f64>,
    /// LED feedback: rule plus the note that toggles the ring.
    pub led: Option<(LedRule, u8)>,
}

impl Rule {
    pub fn describe(&self) -> String {
        let mut s = self.source.action.clone();
        if let Some(d) = self.source.deck {
            s.push_str(&format!(" deck={d}"));
        }
        if let Some(a) = self.amount {
            s.push_str(&format!(" amount={a}"));
        }
        s
    }

    /// Turn a control event into an intent, if this rule reacts to it.
    pub fn intent(&self, event: ControlEvent) -> Option<Intent> {
        use ControlEvent::*;
        let d = self.deck;
        let a = self.amount;
        Some(match (self.action, event) {
            (Action::PlayPause, Press) => Intent::PlayPause(d),
            (Action::Play, Press) => Intent::Play(d),
            (Action::Pause, Press) => Intent::Pause(d),
            (Action::Cue, Press) => Intent::Cue(d, true),
            (Action::Cue, Release) => Intent::Cue(d, false),
            (Action::LoadSelected, Press) => Intent::LoadSelected(d),
            (Action::Eject, Press) => Intent::Eject(d),
            (Action::Focus, Press) => Intent::Focus(d?),
            (Action::RateReset, Press) => Intent::RateReset(d),
            (Action::Nudge, Press) => Intent::Nudge(d, a.unwrap_or(0.01)),
            (Action::Nudge, Delta(n)) => Intent::Nudge(d, n as f64 * a.unwrap_or(0.01)),
            (Action::Rate, Press) => Intent::RateDelta(d, a.unwrap_or(0.01)),
            (Action::Rate, Delta(n)) => Intent::RateDelta(d, n as f64 * a.unwrap_or(0.0005)),
            (Action::Rate, Value(v)) => Intent::RateSet(d, 1.0 + (v as f64 - 64.0) / 64.0 * a.unwrap_or(0.08)),
            (Action::Trim, Value(v)) => Intent::TrimSet(d, v as f64 / 127.0 * 2.0),
            (Action::Trim, Delta(n)) => Intent::TrimDelta(d, n as f64 * a.unwrap_or(0.02)),
            (Action::Scroll, Delta(n)) => Intent::Scroll(n as i32 * a.unwrap_or(1.0) as i32),
            (Action::Scroll, Press) => Intent::Scroll(a.unwrap_or(1.0) as i32),
            _ => return None,
        })
    }
}

pub struct Mappings {
    pub rules: Vec<Rule>,
}

impl Mappings {
    pub fn parse(text: &str, catalog: &Catalog) -> anyhow::Result<Self> {
        let file: File = toml::from_str(text).context("mappings.toml")?;
        let mut rules = Vec::new();
        for (i, m) in file.maps.into_iter().enumerate() {
            let at = || format!("map #{} ({})", i + 1, m.control);
            let (control, _shift) = catalog.find(&m.control).ok_or_else(|| anyhow!("{}: unknown control", at()))?;
            let action = Action::parse(&m.action).with_context(at)?;
            let deck = match m.deck {
                None => None,
                Some(d @ 1..=4) => Some(d as usize - 1),
                Some(d) => bail!("{}: deck {d} out of range 1-4", at()),
            };
            if action == Action::Focus && deck.is_none() {
                bail!("{}: deck.focus needs deck", at());
            }
            let kind = control.kind();
            let fits = match action {
                Action::Rate | Action::Scroll | Action::Nudge => true,
                Action::Trim => kind != Kind::Button,
                _ => kind == Kind::Button,
            };
            if !fits {
                bail!("{}: {} can't be driven by a {:?} control", at(), m.action, kind);
            }
            let led = match m.led.as_deref() {
                None => None,
                Some(rule) => {
                    let Some(note) = control.note.filter(|_| control.led) else {
                        bail!("{}: control has no LED", at());
                    };
                    let rule = match rule {
                        "deck.playing" => LedRule::DeckPlaying,
                        "deck.loaded" => LedRule::DeckLoaded,
                        "deck.focused" => LedRule::DeckFocused,
                        other => bail!("{}: unknown led rule {other:?}", at()),
                    };
                    Some((rule, note))
                }
            };
            rules.push(Rule { amount: m.amount, source: m, action, deck, led });
        }
        Ok(Self { rules })
    }

    pub fn load(path: &std::path::Path, catalog: &Catalog) -> anyhow::Result<Self> {
        Self::parse(&std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?, catalog)
    }

    pub fn for_control<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Rule> + 'a {
        self.rules.iter().filter(move |r| r.source.control == name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Catalog {
        Catalog::parse(include_str!("../../../config/controls.toml")).unwrap()
    }

    #[test]
    fn shipped_mappings_parse() {
        let m = Mappings::parse(include_str!("../../../config/mappings.toml"), &catalog()).unwrap();
        assert!(!m.rules.is_empty());
        let play = m.for_control("right.lit1").next().unwrap();
        assert_eq!(play.intent(ControlEvent::Press), Some(Intent::PlayPause(Some(0))));
        assert_eq!(play.led, Some((LedRule::DeckPlaying, 70)));
        let load = m.for_control("left.lit2").next().unwrap();
        assert_eq!(load.intent(ControlEvent::Press), Some(Intent::LoadSelected(Some(1))));
    }

    #[test]
    fn rejects_bad_rules() {
        let c = catalog();
        for bad in [
            "[[map]]\ncontrol = \"nope\"\naction = \"deck.play\"",
            "[[map]]\ncontrol = \"left.lit1\"\naction = \"deck.fly\"",
            "[[map]]\ncontrol = \"left.lit1\"\naction = \"deck.play\"\ndeck = 5",
            "[[map]]\ncontrol = \"left.fader1\"\naction = \"deck.play\"",
            "[[map]]\ncontrol = \"left.button.A\"\naction = \"deck.play\"\nled = \"deck.playing\"",
            "[[map]]\ncontrol = \"left.lit1\"\naction = \"deck.play\"\ncolour = 1",
        ] {
            assert!(Mappings::parse(bad, &c).is_err(), "{bad}");
        }
    }

    #[test]
    fn continuous_controls() {
        let c = catalog();
        let m = Mappings::parse(
            "[[map]]\ncontrol = \"left.fader1\"\naction = \"deck.rate\"\ndeck = 2\n\
             [[map]]\ncontrol = \"left.encoder1\"\naction = \"deck.rate\"\n\
             [[map]]\ncontrol = \"right.browse\"\naction = \"library.scroll\"",
            &c,
        )
        .unwrap();
        assert_eq!(m.rules[0].intent(ControlEvent::Value(127)), Some(Intent::RateSet(Some(1), 1.0 + 63.0 / 64.0 * 0.08)));
        assert_eq!(m.rules[1].intent(ControlEvent::Delta(-2)), Some(Intent::RateDelta(None, -0.001)));
        assert_eq!(m.rules[2].intent(ControlEvent::Delta(3)), Some(Intent::Scroll(3)));
        assert_eq!(m.rules[2].intent(ControlEvent::Release), None);
    }
}
