//! Bring the Xone:4D up, play a sine on one USB pair for a few seconds, hand it back.
//! Usage: cargo run --release --example tone -- [pair 1-4] [seconds] [dbfs] [out_urbs]

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use ploytec::{FRAMES_PER_PACKET, Frame, Renderer, StreamConfig, StreamStats, Xone};

struct Tone {
    pair: usize,
    amp: f64,
    phase: f64,
    step: f64,
}

impl Renderer for Tone {
    fn render(&mut self, frames: &mut [Frame; FRAMES_PER_PACKET]) {
        for f in frames.iter_mut() {
            *f = [0; 8];
            let s = (self.amp * self.phase.sin() * 8_388_607.0) as i32;
            f[2 * self.pair] = s;
            f[2 * self.pair + 1] = s;
            self.phase = (self.phase + self.step) % std::f64::consts::TAU;
        }
    }
}

fn main() {
    tracing_subscriber_init();
    let args: Vec<String> = std::env::args().collect();
    let pair: usize = args.get(1).map_or(1, |s| s.parse().unwrap());
    let secs: f64 = args.get(2).map_or(5.0, |s| s.parse().unwrap());
    let dbfs: f64 = args.get(3).map_or(-40.0, |s| s.parse().unwrap());
    let out_urbs: usize = args.get(4).map_or(3, |s| s.parse().unwrap());

    let t0 = Instant::now();
    let mut xone = Xone::open().expect("open Xone:4D");
    eprintln!("bring-up took {:?}, firmware {}", t0.elapsed(), xone.firmware());

    let stop = AtomicBool::new(false);
    let stats = StreamStats::default();
    let mut tone = Tone { pair: pair - 1, amp: 10f64.powf(dbfs / 20.0), phase: 0.0, step: std::f64::consts::TAU * 440.0 / 48_000.0 };
    let config = StreamConfig { out_urbs, ..Default::default() };
    let end = std::thread::scope(|s| {
        s.spawn(|| {
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs_f64(secs) {
                std::thread::sleep(Duration::from_secs(1));
                let (min_q, max_gap) = stats.take_window();
                eprintln!(
                    "out {} in {} underruns {} errors {} (last {} on ep {:#x}) min_queued {} max_gap {} us",
                    stats.packets_out.load(Ordering::Relaxed),
                    stats.packets_in.load(Ordering::Relaxed),
                    stats.underruns.load(Ordering::Relaxed),
                    stats.urb_errors.load(Ordering::Relaxed),
                    stats.last_error.load(Ordering::Relaxed),
                    stats.last_error_ep.load(Ordering::Relaxed),
                    min_q,
                    max_gap
                );
            }
            stop.store(true, Ordering::Relaxed);
        });
        xone.stream(&config, &mut tone, &stop, &stats)
    });
    eprintln!("stream end: {end:?}");
    let t1 = Instant::now();
    xone.release().expect("hand back");
    eprintln!("hand-back took {:?}", t1.elapsed());
}

fn tracing_subscriber_init() {
    tracing_subscriber::fmt().with_writer(std::io::stderr).init();
}
