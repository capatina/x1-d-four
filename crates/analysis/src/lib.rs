//! Library analysis for the explorer: per-track low/mid/high features, a
//! persistent cache, and band similarity.

pub mod beats;
pub mod features;
pub mod index;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};

pub use beats::{BeatGrid, beat_grid};
pub use features::{Features, analyse_file};
pub use index::{Band, Index};

/// Bump when features change shape or meaning; old caches are then ignored.
pub const CACHE_VERSION: u32 = 2;

#[derive(Serialize, Deserialize)]
pub struct Entry {
    pub size: u64,
    pub mtime: i64,
    pub result: Result<Features, String>,
}

#[derive(Serialize, Deserialize)]
pub struct Cache {
    pub version: u32,
    pub entries: HashMap<String, Entry>,
}

impl Default for Cache {
    fn default() -> Self {
        Self { version: CACHE_VERSION, entries: HashMap::new() }
    }
}

impl Cache {
    pub fn default_path() -> PathBuf {
        let base = std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
            .unwrap_or_else(|| PathBuf::from("."));
        base.join("x1-d-four").join(format!("analysis-v{CACHE_VERSION}.bin"))
    }

    /// Load, or start empty if the file is missing, unreadable or from another version.
    pub fn load(path: &Path) -> Self {
        match std::fs::read(path) {
            Ok(bytes) => match postcard::from_bytes::<Cache>(&bytes) {
                Ok(c) if c.version == CACHE_VERSION => c,
                Ok(_) => Cache::default(),
                Err(e) => {
                    tracing::warn!(error = %e, path = %path.display(), "analysis cache unreadable, starting over");
                    Cache::default()
                }
            },
            Err(_) => Cache::default(),
        }
    }

    /// Write atomically (temp file + rename).
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, postcard::to_allocvec(self)?)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn is_fresh(&self, id: &str, size: u64, mtime: i64) -> bool {
        self.entries.get(id).is_some_and(|e| e.size == size && e.mtime == mtime)
    }

    pub fn features(&self, id: &str) -> Option<&Features> {
        self.entries.get(id).and_then(|e| e.result.as_ref().ok())
    }
}

/// One file to analyse.
#[derive(Clone)]
pub struct Job {
    pub id: String,
    pub path: PathBuf,
    pub size: u64,
    pub mtime: i64,
    pub tag_bpm: Option<f64>,
}

impl Job {
    /// Fill size and mtime from the filesystem.
    pub fn new(id: String, path: PathBuf, tag_bpm: Option<f64>) -> Option<Self> {
        let meta = std::fs::metadata(&path).ok()?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs() as i64);
        Some(Self { id, path, size: meta.len(), mtime, tag_bpm })
    }
}

/// Analyse every job that isn't already fresh in `cache`, in parallel at low
/// priority. Calls `progress(done, total)` as files finish and saves the cache
/// every 100 files and at the end. Returns how many were analysed.
pub fn analyse_library(
    jobs: &[Job],
    cache: &Mutex<Cache>,
    cache_path: &Path,
    threads: usize,
    progress: &(dyn Fn(usize, usize) + Sync),
) -> usize {
    use rayon::prelude::*;
    let stale: Vec<&Job> = {
        let c = cache.lock().unwrap();
        jobs.iter().filter(|j| !c.is_fresh(&j.id, j.size, j.mtime)).collect()
    };
    let total = stale.len();
    progress(0, total);
    if total == 0 {
        return 0;
    }
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads.max(1))
        .thread_name(|i| format!("x1d4-analyse-{i}"))
        .start_handler(|_| unsafe {
            // Nice 10 for this thread only (Linux: per-thread nice via the tid).
            libc::setpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t, 10);
        })
        .build()
        .expect("analysis thread pool");
    let done = AtomicUsize::new(0);
    pool.install(|| {
        stale.par_iter().for_each(|job| {
            let result = analyse_file(&job.path, job.tag_bpm).map_err(|e| format!("{e:#}"));
            if let Err(e) = &result {
                tracing::debug!(id = %job.id, error = %e, "analysis failed");
            }
            let n = {
                let mut c = cache.lock().unwrap();
                c.entries.insert(job.id.clone(), Entry { size: job.size, mtime: job.mtime, result });
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 100 == 0 {
                    if let Err(e) = c.save(cache_path) {
                        tracing::warn!(error = %e, "saving analysis cache");
                    }
                }
                n
            };
            progress(n, total);
        });
    });
    if let Err(e) = cache.lock().unwrap().save(cache_path) {
        tracing::warn!(error = %e, "saving analysis cache");
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_round_trip() {
        let dir = std::env::temp_dir().join(format!("x1d4-cache-{}", std::process::id()));
        let path = dir.join("a.bin");
        let mut c = Cache::default();
        let f = Features {
            tempo: 128.0,
            tempo_from_tag: false,
            duration: 300.0,
            bands: [vec![1.0; 3], vec![2.0; 3], vec![3.0; 3]],
            key: 9,
            clarity: 0.5,
        };
        c.entries.insert("a.mp3".into(), Entry { size: 10, mtime: 20, result: Ok(f.clone()) });
        c.entries.insert("b.mp3".into(), Entry { size: 1, mtime: 2, result: Err("bad".into()) });
        c.save(&path).unwrap();
        let back = Cache::load(&path);
        std::fs::remove_dir_all(&dir).ok();
        assert!(back.is_fresh("a.mp3", 10, 20));
        assert!(!back.is_fresh("a.mp3", 10, 21));
        assert_eq!(back.features("a.mp3"), Some(&f));
        assert!(back.features("b.mp3").is_none());
    }
}
