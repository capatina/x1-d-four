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

    /// Ids matching every word of `query` (case-insensitive, any field), in library order.
    pub fn filter(&self, query: &str) -> Vec<String> {
        let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        self.tracks
            .iter()
            .filter(|t| words.iter().all(|w| t.search.contains(w.as_str())))
            .map(|t| t.id.clone())
            .collect()
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
