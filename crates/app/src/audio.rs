//! The audio thread: owns the Xone:4D and the engine's RT side.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use engine::Rt;
use ploytec::{FRAMES_PER_PACKET, Renderer, StreamConfig, StreamEnd, Xone};

use crate::app::{App, DeviceState};

/// Drive the device until `stop` is set, reconnecting after unplug or a mixer power cycle.
pub fn run(app: Arc<App>, mut rt: Rt, stop: Arc<AtomicBool>, config: StreamConfig) {
    // The soft RLIMIT_RTTIME budget is derived from these frames, and going over it
    // sends SIGXCPU, which kills the process by default. One packet (1.67 ms) is too
    // tight for device bring-up and reconnects, so ask for 100 ms and ignore SIGXCPU;
    // rtkit's 200 ms hard limit still stops a runaway thread.
    unsafe {
        libc::signal(libc::SIGXCPU, libc::SIG_IGN);
    }
    match audio_thread_priority::promote_current_thread_to_real_time(ploytec::SAMPLE_RATE / 10, ploytec::SAMPLE_RATE) {
        Ok(handle) => {
            std::mem::forget(handle);
            tracing::info!("audio thread is real-time");
        }
        Err(e) => tracing::warn!(error = %e, "could not make the audio thread real-time"),
    }
    let mut fresh_tries = 0;
    while !stop.load(Ordering::Relaxed) {
        app.set_device(DeviceState::Connecting, None, None);
        let mut xone = match Xone::open() {
            Ok(x) => x,
            Err(e) => {
                let kind = match &e {
                    ploytec::device::Error::Usb { source, .. } => Some(source.kind()),
                    _ => None,
                };
                // Right after the mixer re-enumerates, udev hasn't granted access yet.
                if kind == Some(std::io::ErrorKind::PermissionDenied) && fresh_tries < 12 {
                    fresh_tries += 1;
                    sleep_unless(&stop, Duration::from_millis(250));
                    continue;
                }
                let state = if kind == Some(std::io::ErrorKind::NotFound) { DeviceState::Missing } else { DeviceState::Error };
                tracing::warn!(error = %e, "Xone:4D not available");
                app.set_device(state, Some(e.to_string()), None);
                sleep_unless(&stop, Duration::from_secs(2));
                continue;
            }
        };
        fresh_tries = 0;
        let path = xone.path().to_owned();
        app.set_device(DeviceState::Running, None, Some(xone.firmware().to_string()));
        match xone.stream(&config, &mut rt, &stop, &app.stats) {
            Ok(StreamEnd::Stopped) => {
                if let Err(e) = xone.release() {
                    tracing::warn!(error = %e, "hand-back failed");
                }
                break;
            }
            Ok(StreamEnd::Stalled) => {
                let _ = xone.release();
                app.set_device(
                    DeviceState::Stalled,
                    Some("The mixer stopped taking audio. Power-cycle the Xone:4D; it reconnects by itself.".into()),
                    None,
                );
                wait_for_reenumeration(&stop, &path);
            }
            Ok(StreamEnd::Disconnected(e)) => {
                drop(xone);
                tracing::warn!(error = %e, "Xone:4D disconnected");
                app.set_device(DeviceState::Missing, Some(format!("Disconnected: {e}")), None);
                sleep_unless(&stop, Duration::from_secs(1));
            }
            Err(e) => {
                drop(xone);
                app.set_device(DeviceState::Error, Some(e.to_string()), None);
                sleep_unless(&stop, Duration::from_secs(2));
            }
        }
    }
    app.set_device(DeviceState::Missing, Some("stopped".into()), None);
}

fn sleep_unless(stop: &AtomicBool, d: Duration) {
    let end = Instant::now() + d;
    while Instant::now() < end && !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A power cycle gives the mixer a new USB device number.
fn wait_for_reenumeration(stop: &AtomicBool, old: &std::path::Path) {
    while !stop.load(Ordering::Relaxed) {
        match ploytec::usbfs::find_device(ploytec::device::VENDOR_ID, ploytec::device::PRODUCT_ID) {
            Ok(p) if p != old => return,
            _ => std::thread::sleep(Duration::from_millis(500)),
        }
    }
}

/// Without hardware: render on a timer so the UI and engine can be exercised.
pub fn run_virtual(mut rt: Rt, stop: Arc<AtomicBool>) {
    let period = Duration::from_secs_f64(FRAMES_PER_PACKET as f64 / ploytec::SAMPLE_RATE as f64);
    let mut frames = [[0i32; 8]; FRAMES_PER_PACKET];
    let mut next = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        rt.render(&mut frames);
        while rt.midi_out().is_some() {}
        next += period;
        if let Some(wait) = next.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        } else {
            next = Instant::now();
        }
    }
}
