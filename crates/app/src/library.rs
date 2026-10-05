//! The music library: a recursive scan of the music folder with tag metadata.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use lofty::prelude::*;
use serde::Serialize;

/// Extensions symphonia can decode (no Opus decoder there).
const EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "wave", "aif", "aiff", "aifc", "m4a", "mp4", "aac", "ogg", "oga", "caf", "mka", "webm"];

#[derive(Debug, Clone, Serialize)]
pub struct LibTrack {
    /// Path relative to the music folder.
    pub id: String,
    #[serde(skip)]
    pub path: PathBuf,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub bpm: Option<f64>,
    pub duration: Option<f64>,
    #[serde(skip)]
    search: String,
    #[serde(skip)]
    search_title: String,
    #[serde(skip)]
    search_artist: String,
}

#[derive(Default)]
pub struct Library {
    pub tracks: Vec<LibTrack>,
    by_id: HashMap<String, usize>,
}

impl Library {
    pub fn scan(root: &Path) -> Self {
        let mut tracks: Vec<LibTrack> = walkdir::WalkDir::new(root)
            .follow_links(true)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .filter(|e| {
                e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .is_some_and(|x| EXTENSIONS.contains(&x.to_ascii_lowercase().as_str()))
            })
            .filter(|e| !is_mac_leftover(e.path()))
            .map(|e| read_track(root, e.path()))
            .collect();
        tracks.sort_by(|a, b| {
            let key = |t: &LibTrack| (t.artist.clone().unwrap_or_default().to_lowercase(), t.title.to_lowercase());
            key(a).cmp(&key(b))
        });
        let by_id = tracks.iter().enumerate().map(|(i, t)| (t.id.clone(), i)).collect();
        Self { tracks, by_id }
    }

    pub fn get(&self, id: &str) -> Option<&LibTrack> {
        self.by_id.get(id).map(|&i| &self.tracks[i])
    }

    /// Ids matching every word of `query` (case-insensitive, any field). With a
    /// query, best matches come first: words that start the title, then words at a
    /// word start in title or artist, then anywhere (album, file path).
    pub fn filter(&self, query: &str) -> Vec<String> {
        let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        if words.is_empty() {
            return self.tracks.iter().map(|t| t.id.clone()).collect();
        }
        let mut hits: Vec<(u32, usize)> = self
            .tracks
            .iter()
            .enumerate()
            .filter(|(_, t)| words.iter().all(|w| t.search.contains(w.as_str())))
            .map(|(i, t)| (words.iter().map(|w| word_score(t, w)).sum(), i))
            .collect();
        hits.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        hits.into_iter().map(|(_, i)| self.tracks[i].id.clone()).collect()
    }
}

/// How well one query word matches a track.
fn word_score(t: &LibTrack, w: &str) -> u32 {
    let title = &t.search_title;
    let artist = &t.search_artist;
    if title.starts_with(w) {
        8
    } else if at_word_start(title, w) {
        5
    } else if artist.starts_with(w) || at_word_start(artist, w) {
        4
    } else if title.contains(w) || artist.contains(w) {
        2
    } else {
        1
    }
}

/// `w` appears in `text` right after a non-alphanumeric character.
fn at_word_start(text: &str, w: &str) -> bool {
    text.match_indices(w).any(|(i, _)| i == 0 || !text[..i].chars().next_back().is_some_and(char::is_alphanumeric))
}

/// macOS Finder aliases and AppleDouble files copied along with real tracks:
/// named like audio but aren't (an alias starts with "book....mark").
fn is_mac_leftover(path: &Path) -> bool {
    if path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("._")) {
        return true;
    }
    let mut head = [0u8; 12];
    match std::fs::File::open(path).and_then(|mut f| std::io::Read::read_exact(&mut f, &mut head)) {
        Ok(()) => &head[..4] == b"book" && &head[8..12] == b"mark",
        Err(_) => false,
    }
}

fn read_track(root: &Path, path: &Path) -> LibTrack {
    let id = path.strip_prefix(root).unwrap_or(path).to_string_lossy().into_owned();
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| id.clone());
    let mut track = LibTrack {
        id,
        path: path.to_owned(),
        title: stem,
        artist: None,
        album: None,
        bpm: None,
        duration: None,
        search: String::new(),
        search_title: String::new(),
        search_artist: String::new(),
    };
    if let Ok(tagged) = lofty::read_from_path(path) {
        let secs = tagged.properties().duration().as_secs_f64();
        track.duration = (secs > 0.0).then_some(secs);
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(t) = tag.title().filter(|t| !t.trim().is_empty()) {
                track.title = t.into_owned();
            }
            track.artist = tag.artist().map(|a| a.into_owned()).filter(|a| !a.trim().is_empty());
            track.album = tag.album().map(|a| a.into_owned()).filter(|a| !a.trim().is_empty());
            track.bpm = tag
                .get_string(ItemKey::Bpm)
                .or_else(|| tag.get_string(ItemKey::IntegerBpm))
                .and_then(|b| b.trim().parse::<f64>().ok())
                .filter(|b| *b > 0.0);
        }
    }
    track.search_title = track.title.to_lowercase();
    track.search_artist = track.artist.as_deref().unwrap_or("").to_lowercase();
    track.search = format!(
        "{} {} {} {}",
        track.title,
        track.artist.as_deref().unwrap_or(""),
        track.album.as_deref().unwrap_or(""),
        track.id
    )
    .to_lowercase();
    track
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib(items: &[(&str, &str, Option<&str>)]) -> Library {
        let tracks: Vec<LibTrack> = items
            .iter()
            .map(|(id, title, artist)| {
                let mut t = LibTrack {
                    id: id.to_string(),
                    path: PathBuf::from(id),
                    title: title.to_string(),
                    artist: artist.map(str::to_string),
                    album: None,
                    bpm: None,
                    duration: None,
                    search: String::new(),
                    search_title: title.to_lowercase(),
                    search_artist: artist.unwrap_or("").to_lowercase(),
                };
                t.search = format!("{} {} {}", t.search_title, t.search_artist, id.to_lowercase());
                t
            })
            .collect();
        let by_id = tracks.iter().enumerate().map(|(i, t)| (t.id.clone(), i)).collect();
        Library { tracks, by_id }
    }

    #[test]
    fn ranks_title_starts_then_word_starts_then_anywhere() {
        let l = lib(&[
            ("a.mp3", "Planet Jump", Some("Someone")),
            ("b.mp3", "Long Jump (Original Mix)", Some("Marco Carola")),
            ("jump/c.mp3", "Other", Some("X")),
            ("d.mp3", "Jumpstart", Some("Y")),
        ]);
        assert_eq!(l.filter("jump"), vec!["d.mp3", "a.mp3", "b.mp3", "jump/c.mp3"]);
        assert_eq!(l.filter("carola jump"), vec!["b.mp3"]);
        assert_eq!(l.filter("").len(), 4);
        assert!(l.filter("zzz").is_empty());
    }
}
