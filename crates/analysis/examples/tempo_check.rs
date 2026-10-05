//! Compare estimated tempo with the BPM tag on real files.
//! Usage: cargo run --release -p analysis --example tempo_check -- FILE:TAGBPM...

fn main() {
    let mut ok = 0;
    let mut n = 0;
    for arg in std::env::args().skip(1) {
        let (path, tag) = arg.rsplit_once(':').unwrap();
        let tag: f32 = tag.parse().unwrap();
        let t = std::time::Instant::now();
        match analysis::analyse_file(std::path::Path::new(path), None) {
            Ok(f) => {
                n += 1;
                let close = (f.tempo - tag).abs() < 1.0;
                ok += close as usize;
                println!("{:>7.2} vs tag {:>6.1} {} {:>5.0} ms  {}", f.tempo, tag, if close { "ok " } else { "OFF" }, t.elapsed().as_millis(), path.rsplit('/').next().unwrap());
            }
            Err(e) => println!("FAIL {e:#} {path}"),
        }
    }
    println!("{ok}/{n} within 1 BPM");
}
