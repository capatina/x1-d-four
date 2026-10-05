//! The explorer: a tree of similar tracks in one band, rooted at what's playing.
//!
//! You stand on `current` (the last element of `path`) and see its children
//! ahead, each with its own children behind it. Diving moves `current` into the
//! aimed child; back climbs up the path. The aimed child is the library
//! selection, so the existing "load selected" controls load it.

use std::collections::HashSet;

use analysis::{Band, Index};
use serde_json::{Value, json};

/// Portals ahead of you, and how many each of them shows behind it.
pub const CHILDREN: usize = 6;
pub const GRANDCHILDREN: usize = 4;
/// Weight of the section playing now in the root's query.
pub const SECTION_WEIGHT: f32 = 0.4;

pub struct Explorer {
    pub band: Band,
    pub follow: bool,
    pub root_deck: Option<usize>,
    /// Track indices from the root to where you stand.
    path: Vec<usize>,
    /// Similarity of each path element to the previous one (1.0 for the root).
    path_sims: Vec<f32>,
    children: Vec<(usize, f32)>,
    grandchildren: Vec<Vec<(usize, f32)>>,
    aim: usize,
    /// Section of the root track the current tree was built from.
    pub section: Option<usize>,
}

impl Default for Explorer {
    fn default() -> Self {
        Self {
            band: Band::Low,
            follow: true,
            root_deck: None,
            path: Vec::new(),
            path_sims: Vec::new(),
            children: Vec::new(),
            grandchildren: Vec::new(),
            aim: 0,
            section: None,
        }
    }
}

impl Explorer {
    /// Forget the tree (indices change after a re-analysis); keep band and follow.
    pub fn reset(&mut self) {
        *self = Explorer { band: self.band, follow: self.follow, ..Default::default() };
    }

    pub fn root(&self) -> Option<usize> {
        self.path.first().copied()
    }

    pub fn current(&self) -> Option<usize> {
        self.path.last().copied()
    }

    pub fn at_root(&self) -> bool {
        self.path.len() == 1
    }

    pub fn aimed(&self) -> Option<usize> {
        self.children.get(self.aim).map(|c| c.0)
    }

    pub fn children(&self) -> impl Iterator<Item = usize> + '_ {
        self.children.iter().map(|c| c.0)
    }

    /// Recompute the portals around `current`. `query` replaces current's own
    /// vector (the root uses a blend with the section playing now).
    pub fn rebuild(&mut self, index: &Index, query: Option<Vec<f32>>, exclude: &HashSet<usize>) {
        let Some(current) = self.current() else {
            self.children.clear();
            self.grandchildren.clear();
            return;
        };
        let aimed_before = self.aimed();
        let band = self.band;
        let query = query.unwrap_or_else(|| index.vector(band, current).to_vec());
        // Copies of a track count as the track itself.
        let mut taken: HashSet<usize> = self.path.iter().chain(exclude).map(|&t| index.canonical(t)).collect();
        self.children = index.nearest(band, &query, CHILDREN, |i| taken.contains(&i));
        taken.extend(self.children.iter().map(|c| c.0));
        self.grandchildren = self
            .children
            .iter()
            .map(|&(child, _)| {
                let near = index.nearest(band, index.vector(band, child), GRANDCHILDREN, |i| taken.contains(&i));
                taken.extend(near.iter().map(|n| n.0));
                near
            })
            .collect();
        // Keep aiming at the same track if it survived the rebuild.
        self.aim = aimed_before.and_then(|a| self.children.iter().position(|c| c.0 == a)).unwrap_or(0);
    }

    /// Start a new tree at `root`.
    pub fn reroot(&mut self, index: &Index, root: usize, deck: Option<usize>, query: Option<Vec<f32>>, exclude: &HashSet<usize>) {
        self.path = vec![root];
        self.path_sims = vec![1.0];
        self.root_deck = deck;
        self.aim = 0;
        self.rebuild(index, query, exclude);
    }

    pub fn set_band(&mut self, band: Band, index: &Index, query: Option<Vec<f32>>, exclude: &HashSet<usize>) {
        self.band = band;
        self.rebuild(index, query, exclude);
    }

    /// Rotate the aim; returns whether it moved.
    pub fn aim_by(&mut self, delta: i32) -> bool {
        let n = self.children.len() as i32;
        if n == 0 || delta == 0 {
            return false;
        }
        let next = (self.aim as i32 + delta).rem_euclid(n) as usize;
        let moved = next != self.aim;
        self.aim = next;
        moved
    }

    /// Aim at a specific child track; false if it isn't one.
    pub fn aim_at(&mut self, track: usize) -> bool {
        match self.children.iter().position(|c| c.0 == track) {
            Some(i) => {
                self.aim = i;
                true
            }
            None => false,
        }
    }

    /// Dive into the aimed child (or `target`, if it's a child).
    pub fn dive(&mut self, index: &Index, target: Option<usize>, exclude: &HashSet<usize>) -> bool {
        if let Some(t) = target {
            if !self.aim_at(t) {
                return false;
            }
        }
        let Some(&(child, sim)) = self.children.get(self.aim) else { return false };
        self.path.push(child);
        self.path_sims.push(sim);
        self.aim = 0;
        self.rebuild(index, None, exclude);
        true
    }

    /// Climb one step up; the node you came from stays aimed.
    pub fn back(&mut self, index: &Index, root_query: Option<Vec<f32>>, exclude: &HashSet<usize>) -> bool {
        if self.path.len() < 2 {
            return false;
        }
        let from = self.path.pop().unwrap();
        self.path_sims.pop();
        let query = if self.at_root() { root_query } else { None };
        self.rebuild(index, query, exclude);
        self.aim_at(from);
        true
    }

    pub fn to_json(&self, index: &Index, reason: &str) -> Value {
        let id = |i: usize| index.ids[i].as_str();
        let tempo = |i: usize| index.tempo.get(i).copied().map(|t| (t * 10.0).round() / 10.0);
        let mut nodes = Vec::new();
        for (d, (&t, &sim)) in self.path.iter().zip(&self.path_sims).enumerate() {
            nodes.push(json!({
                "id": id(t),
                "parent": if d == 0 { None } else { Some(id(self.path[d - 1])) },
                "depth": d,
                "sim": sim,
                "tempo": tempo(t),
            }));
        }
        let depth = self.path.len();
        if let Some(current) = self.current() {
            for (&(child, sim), grand) in self.children.iter().zip(&self.grandchildren) {
                nodes.push(json!({ "id": id(child), "parent": id(current), "depth": depth, "sim": sim, "tempo": tempo(child) }));
                for &(g, gsim) in grand {
                    nodes.push(json!({ "id": id(g), "parent": id(child), "depth": depth + 1, "sim": gsim, "tempo": tempo(g) }));
                }
            }
        }
        json!({
            "type": "explore",
            "band": self.band.name(),
            "follow": self.follow,
            "root": self.root().map(id),
            "root_deck": self.root_deck,
            "path": self.path.iter().map(|&t| id(t)).collect::<Vec<_>>(),
            "current": self.current().map(id),
            "aim": self.aimed().map(id),
            "nodes": nodes,
            "reason": reason,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use analysis::Features;

    /// 40 tracks on a circle in every band: neighbours by index are similar.
    fn index() -> Index {
        let feats: Vec<Features> = (0..40)
            .map(|i| {
                let a = i as f32 / 40.0 * std::f32::consts::TAU;
                let v = |dims: usize, phase: f32| -> Vec<f32> {
                    (0..dims).map(|d| ((a + phase) * (1.0 + d as f32 * 0.01)).sin() + (d as f32 * 0.37).cos()).collect()
                };
                Features {
                    tempo: 120.0 + i as f32,
                    tempo_from_tag: false,
                    duration: 300.0,
                    bands: [v(analysis::features::DIMS[0], 0.0), v(analysis::features::DIMS[1], 1.0), v(analysis::features::DIMS[2], 2.0)],
                    sections: vec![],
                }
            })
            .collect();
        let items: Vec<(String, &Features)> = feats.iter().enumerate().map(|(i, f)| (format!("t{i:02}"), f)).collect();
        Index::build(&items)
    }

    fn all_ids(e: &Explorer) -> Vec<usize> {
        let mut v: Vec<usize> = e.path.clone();
        v.extend(e.children.iter().map(|c| c.0));
        v.extend(e.grandchildren.iter().flatten().map(|c| c.0));
        v
    }

    #[test]
    fn tree_has_no_duplicates_and_respects_exclusions() {
        let index = index();
        let mut e = Explorer::default();
        let exclude: HashSet<usize> = [5, 6].into();
        e.reroot(&index, 4, Some(0), None, &exclude);
        assert_eq!(e.children.len(), CHILDREN);
        assert!(e.grandchildren.iter().all(|g| g.len() == GRANDCHILDREN));
        let ids = all_ids(&e);
        let unique: HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len());
        assert!(!ids.contains(&5) && !ids.contains(&6));
        // Similarity is sorted best first.
        assert!(e.children.windows(2).all(|w| w[0].1 >= w[1].1));
    }

    #[test]
    fn dive_back_and_aim() {
        let index = index();
        let none = HashSet::new();
        let mut e = Explorer::default();
        e.reroot(&index, 10, None, None, &none);
        assert!(e.aim_by(2));
        let aimed = e.aimed().unwrap();
        assert!(e.dive(&index, None, &none));
        assert_eq!(e.current(), Some(aimed));
        assert_eq!(e.path.len(), 2);
        assert!(!e.children().any(|c| c == 10), "root isn't offered again below");
        assert!(e.back(&index, None, &none));
        assert_eq!(e.current(), Some(10));
        assert_eq!(e.aimed(), Some(aimed), "back re-aims where you came from");
        assert!(!e.back(&index, None, &none));
        assert!(e.aim_by(-1));
        assert!(!e.dive(&index, Some(39_999), &none));
    }

    #[test]
    fn band_switch_rebuilds_and_json_lists_the_tree() {
        let index = index();
        let none = HashSet::new();
        let mut e = Explorer::default();
        e.reroot(&index, 0, Some(1), None, &none);
        let low: Vec<usize> = e.children().collect();
        e.set_band(Band::High, &index, None, &none);
        let high: Vec<usize> = e.children().collect();
        assert_eq!(e.band, Band::High);
        assert_eq!(low.len(), high.len());
        let v = e.to_json(&index, "band");
        assert_eq!(v["band"], "high");
        assert_eq!(v["root"], "t00");
        assert_eq!(v["nodes"].as_array().unwrap().len(), 1 + CHILDREN * (1 + GRANDCHILDREN));
        assert_eq!(v["nodes"][0]["parent"], Value::Null);
        assert_eq!(v["aim"], v["nodes"][1]["id"]);
    }
}
