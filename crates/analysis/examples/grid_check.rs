//! Beat grids on real files, and how far the beats drift from start to end
//! under the refined tempo vs the tag.
//! Usage: cargo run --release -p analysis --example grid_check -- FILE:TAGBPM...

use analysis::beats::local_offset;

fn drift_ms(mono: &[f32], bpm: f64, secs: f64) -> f64 {
    let beat = 60.0 / bpm;
    let early = local_offset(mono, 48_000, bpm, 15.0, 75.0);
    let late = local_offset(mono, 48_000, bpm, secs - 75.0, secs - 15.0);
    ((late - early + beat / 2.0).rem_euclid(beat) - beat / 2.0) * 1000.0
}

fn main() {
    for arg in std::env::args().skip(1) {
        let (path, tag) = arg.rsplit_once(':').unwrap();
        let tag: f64 = tag.parse().unwrap();
        let track = engine::track::load(std::path::Path::new(path)).unwrap();
        let mono: Vec<f32> = track.samples.chunks_exact(2).map(|f| 0.5 * (f[0] + f[1])).collect();
        let secs = mono.len() as f64 / 48_000.0;
        let g = analysis::beat_grid(&mono, 48_000, tag.round()).unwrap();
        println!(
            "grid {:>8.3} drift {:>+6.1} ms | tag {:>6.1} drift {:>+6.1} ms  ({:.0} s) {}",
            g.bpm, drift_ms(&mono, g.bpm, secs), tag, drift_ms(&mono, tag, secs), secs, path.rsplit('/').next().unwrap()
        );
        if std::env::var_os("WINDOWS").is_some() {
            windows(&mono, g.bpm, secs);
        }
    }
}

#[allow(dead_code)]
pub fn windows(mono: &[f32], bpm: f64, secs: f64) {
    let beat = 60.0 / bpm;
    let base = local_offset(mono, 48_000, bpm, 15.0, 45.0);
    let mut t = 0.0;
    while t + 30.0 <= secs {
        let o = local_offset(mono, 48_000, bpm, t, t + 30.0);
        let d = ((o - base + beat / 2.0).rem_euclid(beat) - beat / 2.0) * 1000.0;
        print!("{:.0}s:{:+.0} ", t + 15.0, d);
        t += 30.0;
    }
    println!();
}
