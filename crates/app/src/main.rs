//! xone-deck: a browser-controlled 4-deck player that drives the Allen & Heath
//! Xone:4D through its own userspace USB driver.

mod app;
mod audio;
mod controls;
mod library;
mod mapping;
mod server;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::Context;
use clap::{Parser, Subcommand};
use notify::{RecursiveMode, Watcher};
use ploytec::{FRAMES_PER_PACKET, Frame, Renderer, StreamConfig, StreamStats, Xone};

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the player and its web UI (the default).
    Serve(ServeArgs),
    /// Bring the Xone:4D up and play a test tone on one USB pair.
    Probe {
        /// USB pair 1-4 (feeds mixer channel 1-4).
        #[arg(long, default_value_t = 1)]
        pair: usize,
        #[arg(long, default_value_t = 5.0)]
        seconds: f64,
        #[arg(long, default_value_t = -30.0, allow_hyphen_values = true)]
        dbfs: f64,
        /// OUT URBs in flight (latency = urbs x 1.67 ms).
        #[arg(long, default_value_t = 3)]
        urbs: usize,
    },
    /// Give the Xone:4D back to the kernel driver (after a crash).
    Release,
}

#[derive(clap::Args, Default)]
struct ServeArgs {
    /// Music folder (default ~/Music).
    #[arg(long)]
    music: Option<PathBuf>,
    /// Folder with controls.toml and mappings.toml (default: the repo's config/).
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long, default_value_t = 7878)]
    port: u16,
    /// OUT URBs in flight (latency = urbs x 1.67 ms).
    #[arg(long, default_value_t = 3)]
    urbs: usize,
    /// Run without the mixer (renders on a timer).
    #[arg(long)]
    no_device: bool,
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,ploytec=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    match cli.command.unwrap_or(Cmd::Serve(ServeArgs { port: 7878, urbs: 3, ..Default::default() })) {
        Cmd::Serve(args) => serve(args),
        Cmd::Probe { pair, seconds, dbfs, urbs } => probe(pair, seconds, dbfs, urbs),
        Cmd::Release => {
            ploytec::device::rebind_kernel_driver()?;
            println!("Xone:4D handed back to snd-usb-ozzy");
            Ok(())
        }
    }
}

fn default_config_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../config")
}

fn serve(args: ServeArgs) -> anyhow::Result<()> {
    let home = std::env::var_os("HOME").map(PathBuf::from).context("HOME not set")?;
    let music = args.music.unwrap_or_else(|| home.join("Music"));
    let config_dir = args.config.unwrap_or_else(default_config_dir);
    let config_dir = config_dir.canonicalize().with_context(|| format!("config dir {}", config_dir.display()))?;

    let runtime = tokio::runtime::Runtime::new()?;
    let (control, rt) = engine::new();
    let app = app::App::new(control, music, config_dir.clone(), args.urbs, runtime.handle().clone());
    let stop = Arc::new(AtomicBool::new(false));

    // Audio thread.
    let audio = {
        let (app, stop) = (app.clone(), stop.clone());
        let config = StreamConfig { out_urbs: args.urbs, ..Default::default() };
        let no_device = args.no_device;
        std::thread::Builder::new().name("xone-audio".into()).spawn(move || {
            if no_device {
                app.set_device(app::DeviceState::Missing, Some("running without the mixer (--no-device)".into()), None);
                audio::run_virtual(rt, stop);
            } else {
                audio::run(app, rt, stop, config);
            }
        })?
    };

    // Event pump: MIDI from the mixer -> mappings. Polls every millisecond.
    {
        let (app, stop) = (app.clone(), stop.clone());
        std::thread::Builder::new().name("xone-events".into()).spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                if app.pump_events() == 0 {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        })?;
    }

    // Hot-reload controls.toml / mappings.toml.
    let (reload_tx, mut reload_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| p.extension().is_some_and(|e| e == "toml")) && !ev.kind.is_access() {
                let _ = reload_tx.send(());
            }
        }
    })?;
    watcher.watch(&config_dir, RecursiveMode::NonRecursive)?;

    runtime.block_on(async {
        {
            let app = app.clone();
            tokio::spawn(async move {
                while reload_rx.recv().await.is_some() {
                    // Editors save in several steps; settle first.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    while reload_rx.try_recv().is_ok() {}
                    app.reload_config();
                }
            });
        }
        {
            let app = app.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_millis(33));
                loop {
                    tick.tick().await;
                    app.tick();
                }
            });
        }
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], args.port));
        let listener = tokio::net::TcpListener::bind(addr).await.with_context(|| format!("bind {addr}"))?;
        tracing::info!("xone-deck on http://{addr}");
        axum::serve(listener, server::router(app.clone()))
            .with_graceful_shutdown(async {
                let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
                tracing::info!("shutting down");
            })
            .await?;
        anyhow::Ok(())
    })?;

    stop.store(true, Ordering::Relaxed);
    drop(watcher);
    let _ = audio.join();
    runtime.shutdown_timeout(Duration::from_millis(500));
    Ok(())
}

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

fn probe(pair: usize, seconds: f64, dbfs: f64, urbs: usize) -> anyhow::Result<()> {
    anyhow::ensure!((1..=4).contains(&pair), "pair must be 1-4");
    let t0 = Instant::now();
    let mut xone = Xone::open()?;
    println!("Xone:4D firmware {} up in {:?} ({} URBs = {:.1} ms)", xone.firmware(), t0.elapsed(), urbs, urbs as f64 * 80.0 / 48.0);
    let stop = AtomicBool::new(false);
    let stats = StreamStats::default();
    let mut tone = Tone {
        pair: pair - 1,
        amp: 10f64.powf(dbfs / 20.0),
        phase: 0.0,
        step: std::f64::consts::TAU * 440.0 / ploytec::SAMPLE_RATE as f64,
    };
    let config = StreamConfig { out_urbs: urbs, ..Default::default() };
    let end = std::thread::scope(|s| {
        s.spawn(|| {
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs_f64(seconds) && stats_running_or_starting(&stats, start) {
                std::thread::sleep(Duration::from_secs(1));
                let (min_q, max_gap) = stats.take_window();
                println!(
                    "out {:>6}  in {:>6}  underruns {}  errors {} (last {} ep {:#x})  min queued {}  max gap {} us",
                    stats.packets_out.load(Ordering::Relaxed),
                    stats.packets_in.load(Ordering::Relaxed),
                    stats.underruns.load(Ordering::Relaxed),
                    stats.urb_errors.load(Ordering::Relaxed),
                    stats.last_error.load(Ordering::Relaxed),
                    stats.last_error_ep.load(Ordering::Relaxed),
                    if min_q == u32::MAX { "-".into() } else { min_q.to_string() },
                    max_gap
                );
            }
            stop.store(true, Ordering::Relaxed);
        });
        xone.stream(&config, &mut tone, &stop, &stats)
    })?;
    println!("stream end: {end:?}");
    xone.release()?;
    println!("handed back to snd-usb-ozzy");
    Ok(())
}

fn stats_running_or_starting(stats: &StreamStats, start: Instant) -> bool {
    stats.running.load(Ordering::Relaxed) || start.elapsed() < Duration::from_secs(1)
}
