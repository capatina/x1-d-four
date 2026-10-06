//! Similarity in one band: library-wide standardisation, group weights, cosine,
//! then how well the two would mix: tempo for every band, the key for the mids.

use crate::features::{DIMS, Features, SUB, key_distance};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Band {
    Low,
    Mid,
    High,
}

impl Band {
    pub const ALL: [Band; 3] = [Band::Low, Band::Mid, Band::High];

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn next(self) -> Band {
        Band::ALL[(self.index() + 1) % 3]
    }

    /// One band up (`steps` > 0) or down, stopping at low and high.
    pub fn step(self, steps: i32) -> Band {
        Band::ALL[(self.index() as i32 + steps).clamp(0, 2) as usize]
    }

    pub fn name(self) -> &'static str {
        ["low", "mid", "high"][self.index()]
    }

    pub fn parse(s: &str) -> Option<Band> {
        Band::ALL.into_iter().find(|b| b.name() == s)
    }
}

/// Relative weight of each feature group, per band. Groups are spread over their
/// dimensions, so a group's total pull is its weight regardless of its size.
fn group_weights(band: Band) -> Vec<f32> {
    let spread = |n: usize, w: f32| std::iter::repeat_n(w / (n as f32).sqrt(), n);
    let mut v = Vec::new();
    match band {
        Band::Low => {
            v.extend(spread(SUB, 0.9)); // shape: sub vs kick vs bass
            v.extend(spread(SUB, 0.5)); // movement
            v.extend(spread(8, 1.0)); // groove
            v.extend(spread(4, 1.3)); // beat pattern: four-on-the-floor vs broken, rolling bass
            v.extend(spread(1, 0.6)); // pumping vs sustained bass
            v.extend(spread(1, 0.4)); // bass weight
            v.extend(spread(1, 0.6)); // tempo
        }
        Band::Mid => {
            v.extend(spread(SUB, 0.7)); // shape
            v.extend(spread(SUB, 0.4)); // movement
            v.extend(spread(12, 1.0)); // chroma: harmony and key
            v.extend(spread(1, 0.4)); // tonal vs noisy
            v.extend(spread(1, 0.3)); // mid weight
            v.extend(spread(1, 0.6)); // clarity: melodic vs percussive
            v.extend(spread(1, 0.6)); // harmonic rhythm: static vs moving chords
            v.extend(spread(1, 0.8)); // mood: major vs minor
        }
        Band::High => {
            v.extend(spread(SUB, 0.9)); // shape
            v.extend(spread(SUB, 0.5)); // movement
            v.extend(spread(8, 1.0)); // hat/percussion groove
            v.extend(spread(4, 1.3)); // beat pattern: off-beat hats vs rolling 16ths
            v.extend(spread(1, 0.8)); // density
            v.extend(spread(1, 0.6)); // brightness
            v.extend(spread(1, 0.5)); // noisiness
            v.extend(spread(1, 0.3)); // high weight
        }
    }
    debug_assert_eq!(v.len(), DIMS[band.index()]);
    v
}

/// A track's name as a set of words, for spotting other edits of the same song.
fn title_key(id: &str) -> Vec<String> {
    const NOISE: &[&str] = &[
        "original", "mix", "extended", "radio", "edit", "version", "album", "club", "feat", "ft", "featuring", "remastered",
        "remaster", "mp3", "flac", "wav", "aiff", "m4a", "the", "and", "vs", "www", "com",
    ];
    let stem = id.rsplit('/').next().unwrap_or(id);
    let stem = stem.rsplit_once('.').map_or(stem, |(s, _)| s);
    let mut words: Vec<String> = stem
        .split(|c: char| !c.is_alphanumeric())
        .map(|w| w.to_lowercase())
        .filter(|w| w.len() > 1 && !w.chars().all(|c| c.is_ascii_digit()) && !NOISE.contains(&w.as_str()))
        .collect();
    words.sort();
    words.dedup();
    words
}

/// How well two tempos mix (half and double time count): 1 at the same tempo, 0.37 at 6 % apart.
fn tempo_match(a: f32, b: f32) -> f32 {
    if a <= 0.0 || b <= 0.0 {
        return 0.5;
    }
    let d = [0.5f32, 1.0, 2.0].iter().map(|m| (b / (a * m)).ln().abs()).fold(f32::MAX, f32::min);
    (-(d / 0.06).powi(2)).exp()
}

/// How well two keys mix on the Camelot wheel, 0..1.
fn key_match(a: u8, b: u8) -> f32 {
    [1.0, 0.85, 0.55, 0.3, 0.15][(key_distance(a, b) as usize).min(4)]
}

pub struct Index {
    pub ids: Vec<String>,
    pub tempo: Vec<f32>,
    key: Vec<u8>,
    clarity: Vec<f32>,
    /// The first track with identical features (copies of the same file share one).
    canonical: Vec<usize>,
    mean: [Vec<f32>; 3],
    std: [Vec<f32>; 3],
    weight: [Vec<f32>; 3],
    /// n x d unit vectors per band.
    vecs: [Vec<f32>; 3],
}

fn normalise(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 1e-9 {
        v.iter_mut().for_each(|x| *x /= n);
    }
}

impl Index {
    pub fn build(items: &[(String, &Features)]) -> Self {
        let n = items.len().max(1) as f32;
        let mut mean: [Vec<f32>; 3] = std::array::from_fn(|b| vec![0.0; DIMS[b]]);
        let mut var: [Vec<f32>; 3] = std::array::from_fn(|b| vec![0.0; DIMS[b]]);
        for (_, f) in items {
            for b in 0..3 {
                for (m, x) in mean[b].iter_mut().zip(&f.bands[b]) {
                    *m += x / n;
                }
            }
        }
        for (_, f) in items {
            for b in 0..3 {
                for ((v, x), m) in var[b].iter_mut().zip(&f.bands[b]).zip(&mean[b]) {
                    *v += (x - m).powi(2) / n;
                }
            }
        }
        let std = var.map(|v| v.into_iter().map(|x| x.sqrt().max(1e-3)).collect::<Vec<_>>());
        let weight = Band::ALL.map(group_weights);
        // Byte-identical copies first; near-identical ones (same recording, other
        // file) are merged after embedding.
        let mut first: std::collections::HashMap<Vec<u32>, usize> = std::collections::HashMap::new();
        let canonical = items
            .iter()
            .enumerate()
            .map(|(i, (_, f))| {
                let key: Vec<u32> = f.bands.iter().flatten().map(|x| x.to_bits()).collect();
                *first.entry(key).or_insert(i)
            })
            .collect();
        let mut index = Index {
            ids: items.iter().map(|(id, _)| id.clone()).collect(),
            tempo: items.iter().map(|(_, f)| f.tempo).collect(),
            key: items.iter().map(|(_, f)| f.key).collect(),
            clarity: items.iter().map(|(_, f)| f.clarity).collect(),
            canonical,
            mean,
            std,
            weight,
            vecs: [Vec::new(), Vec::new(), Vec::new()],
        };
        for band in Band::ALL {
            let b = band.index();
            let mut all = Vec::with_capacity(items.len() * DIMS[b]);
            for (_, f) in items {
                all.extend(index.embed(band, &f.bands[b]));
            }
            index.vecs[b] = all;
        }
        let durations: Vec<f32> = items.iter().map(|(_, f)| f.duration).collect();
        index.merge_near_copies(&durations);
        index.merge_same_titles();
        index
    }

    /// Other edits of the same song count as the same track: files whose names come
    /// down to the same words ("Original Mix", "Extended", "Album Version" and the
    /// like don't count; a remixer's name does, so remixes stay apart).
    fn merge_same_titles(&mut self) {
        let mut first: std::collections::HashMap<Vec<String>, usize> = std::collections::HashMap::new();
        for i in 0..self.ids.len() {
            let key = title_key(&self.ids[i]);
            if key.len() < 2 {
                continue;
            }
            let c = self.canonical[i];
            match first.get(&key) {
                Some(&j) if self.canonical[j] != c => {
                    let target = self.canonical[j];
                    for k in 0..self.canonical.len() {
                        if self.canonical[k] == c {
                            self.canonical[k] = target;
                        }
                    }
                }
                Some(_) => {}
                None => {
                    first.insert(key, i);
                }
            }
        }
    }

    /// Treat tracks of nearly the same length that match in every band as copies
    /// of one recording (other encodes, re-downloads, renamed files).
    fn merge_near_copies(&mut self, durations: &[f32]) {
        const SAME: f32 = 0.99;
        let mut order: Vec<usize> = (0..self.ids.len()).collect();
        order.sort_by(|&a, &b| durations[a].total_cmp(&durations[b]));
        for (pos, &i) in order.iter().enumerate() {
            if self.canonical[i] != i {
                continue;
            }
            for &j in order[..pos].iter().rev() {
                if durations[i] - durations[j] > 2.0 {
                    break;
                }
                let j = self.canonical[j];
                let same = Band::ALL.iter().all(|&band| {
                    self.vector(band, i).iter().zip(self.vector(band, j)).map(|(x, y)| x * y).sum::<f32>() >= SAME
                });
                if same {
                    self.canonical[i] = j;
                    break;
                }
            }
        }
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// The track this one is a copy of (itself if it's the first or only copy).
    pub fn canonical(&self, i: usize) -> usize {
        self.canonical[i]
    }

    pub fn position(&self, id: &str) -> Option<usize> {
        self.ids.iter().position(|i| i == id)
    }

    /// Standardise, weight and normalise a raw band vector.
    pub fn embed(&self, band: Band, raw: &[f32]) -> Vec<f32> {
        let b = band.index();
        let mut v: Vec<f32> = raw
            .iter()
            .zip(&self.mean[b])
            .zip(&self.std[b])
            .zip(&self.weight[b])
            .map(|(((x, m), s), w)| (x - m) / s * w)
            .collect();
        normalise(&mut v);
        v
    }

    pub fn vector(&self, band: Band, i: usize) -> &[f32] {
        let d = DIMS[band.index()];
        &self.vecs[band.index()][i * d..(i + 1) * d]
    }

    /// How well track `b` would follow track `a` in this band, as a factor 0..1:
    /// tempo for every band (most for the groove), the key for the mids (as far
    /// as both are tonal).
    fn mix_factor(&self, band: Band, a: usize, b: usize) -> f32 {
        let tempo = tempo_match(self.tempo[a], self.tempo[b]);
        let mut f = match band {
            Band::Low => 0.65 + 0.35 * tempo,
            Band::Mid => 0.9 + 0.1 * tempo,
            Band::High => 0.75 + 0.25 * tempo,
        };
        if band == Band::Mid {
            let tonal = self.clarity[a].min(self.clarity[b]);
            f *= 1.0 - 0.45 * tonal + 0.45 * tonal * key_match(self.key[a], self.key[b]);
        }
        f
    }

    /// The `k` tracks whose vibe in `band` best matches track `of`, best first, as
    /// (index, similarity 0..1): the band's features, then how well they'd mix.
    /// Only first copies are returned; `skip` sees those indices.
    pub fn nearest(&self, band: Band, of: usize, k: usize, skip: impl Fn(usize) -> bool) -> Vec<(usize, f32)> {
        let d = DIMS[band.index()];
        let query = self.vector(band, of);
        let mut scored: Vec<(usize, f32)> = self.vecs[band.index()]
            .chunks_exact(d)
            .enumerate()
            .filter(|(i, _)| self.canonical[*i] == *i && !skip(*i))
            .map(|(i, v)| {
                let cosine = v.iter().zip(query).map(|(a, b)| a * b).sum::<f32>();
                (i, (cosine + 1.0) / 2.0 * self.mix_factor(band, of, i))
            })
            .collect();
        let k = k.min(scored.len());
        if k == 0 {
            return Vec::new();
        }
        scored.select_nth_unstable_by(k - 1, |a, b| b.1.total_cmp(&a.1));
        scored.truncate(k);
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        scored
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::analyse_samples;
    use crate::features::synth::*;

    fn track(f: impl Fn(&mut [f32])) -> Features {
        let mut x = silence(24.0);
        f(&mut x);
        analyse_samples(&x, RATE, None).unwrap()
    }

    fn sim(index: &Index, band: Band, a: usize, b: usize) -> f32 {
        index.vector(band, a).iter().zip(index.vector(band, b)).map(|(x, y)| x * y).sum()
    }

    #[test]
    fn low_band_groups_kick_tracks() {
        let t = [
            track(|x| kicks(x, 125.0, 0.8)),
            track(|x| kicks(x, 128.0, 0.8)),
            track(|x| hats(x, 126.0, 0.5)),
            track(|x| chord(x, &[60, 64, 67], 0.1)),
        ];
        let items: Vec<(String, &Features)> = t.iter().enumerate().map(|(i, f)| (format!("t{i}"), f)).collect();
        let index = Index::build(&items);
        assert!(sim(&index, Band::Low, 0, 1) > sim(&index, Band::Low, 0, 2));
        assert!(sim(&index, Band::Low, 0, 1) > sim(&index, Band::Low, 0, 3));
        let near = index.nearest(Band::Low, 0, 2, |i| i == 0);
        assert_eq!(near[0].0, 1);
    }

    #[test]
    fn mid_band_hears_related_keys() {
        // C major, A minor (same notes, relative key), F# major (a tritone away), plus a hats-only track.
        let t = [
            track(|x| chord(x, &[60, 64, 67, 72], 0.1)),
            track(|x| chord(x, &[57, 60, 64, 69], 0.1)),
            track(|x| chord(x, &[66, 70, 73, 78], 0.1)),
            track(|x| hats(x, 126.0, 0.5)),
        ];
        let items: Vec<(String, &Features)> = t.iter().enumerate().map(|(i, f)| (format!("t{i}"), f)).collect();
        let index = Index::build(&items);
        let near = index.nearest(Band::Mid, 0, 3, |i| i == 0);
        let score = |j: usize| near.iter().find(|n| n.0 == j).map_or(0.0, |n| n.1);
        assert!(score(1) > score(2), "C/Am {} vs C/F# {}", score(1), score(2));
    }

    #[test]
    fn copies_collapse_to_one() {
        let a = track(|x| kicks(x, 125.0, 0.8));
        let b = track(|x| hats(x, 126.0, 0.5));
        let items: Vec<(String, &Features)> =
            vec![("a".into(), &a), ("copy/a".into(), &a), ("b".into(), &b), ("c".into(), &b)];
        let index = Index::build(&items);
        assert_eq!(index.canonical(1), 0);
        assert_eq!(index.canonical(3), 2);
        let near = index.nearest(Band::Low, 0, 4, |_| false);
        assert_eq!(near.iter().map(|n| n.0).collect::<Vec<_>>(), vec![0, 2]);
    }

    #[test]
    fn mixability_shapes_the_ranking() {
        assert!(tempo_match(125.0, 125.0) > 0.99);
        assert!(tempo_match(125.0, 62.5) > 0.99, "half time mixes");
        assert!(tempo_match(125.0, 140.0) < 0.05);
        assert!(key_match(0, 21) > key_match(0, 6), "relative minor over the tritone");
        // Same kick loop at 125 and at 140 BPM, and a near-identical one at 126: the low band picks 126.
        let t = [track(|x| kicks(x, 125.0, 0.8)), track(|x| kicks(x, 140.0, 0.8)), track(|x| kicks(x, 126.0, 0.7))];
        let items: Vec<(String, &Features)> = t.iter().enumerate().map(|(i, f)| (format!("t{i}"), f)).collect();
        let index = Index::build(&items);
        let near = index.nearest(Band::Low, 0, 2, |i| i == 0);
        assert_eq!(near[0].0, 2, "{near:?}");
    }

    #[test]
    fn edits_of_one_song_are_one_track() {
        assert_eq!(
            title_key("a/Dan Caster, Sascha Braemer - Nasty Girls (Original Mix).mp3"),
            title_key("b/Sascha Braemer, Dan Caster - Nasty Girls.flac")
        );
        assert_eq!(title_key("JULIET - AVALON (Album Version).mp3"), title_key("Juliet - Avalon (Original Mix).mp3"));
        assert_ne!(title_key("Sneaky Sound System - We Love (Pleasurekraft Remix).mp3"), title_key("Sneaky Sound System - We Love.mp3"));
        let a = track(|x| kicks(x, 125.0, 0.8));
        let b = track(|x| hats(x, 126.0, 0.5));
        let items: Vec<(String, &Features)> = vec![("Artist - Song (Original Mix).mp3".into(), &a), ("x/Artist - Song.flac".into(), &b)];
        let index = Index::build(&items);
        assert_eq!(index.canonical(1), 0);
    }

    #[test]
    fn band_cycles() {
        assert_eq!(Band::Low.next(), Band::Mid);
        assert_eq!(Band::High.next(), Band::Low);
        assert_eq!(Band::parse("mid"), Some(Band::Mid));
        assert_eq!(Band::Low.step(1), Band::Mid);
        assert_eq!(Band::High.step(1), Band::High);
        assert_eq!(Band::Mid.step(-5), Band::Low);
    }
}
