//! Decode files the way a deck does and report the result.
//! Usage: cargo run --release -p engine --example load -- FILE...

fn main() {
    for path in std::env::args().skip(1) {
        let t = std::time::Instant::now();
        match engine::track::load(std::path::Path::new(&path)) {
            Ok(track) => println!("ok   {:7.2} s  in {:?}  {path}", track.seconds(), t.elapsed()),
            Err(e) => println!("FAIL {e:#}  {path}"),
        }
    }
}
