//! Xone:4D bring-up, streaming loop and hand-back to the kernel driver.
//!
//! The bring-up is a port of the verified Ozzy sequence (`linux/devices/ploytec.c:214-273`,
//! `ploytec_restart_streams` at `:186-206`). The rules learned the hard way:
//! - never reset the device (the 4D needs a power cycle afterwards);
//! - a URB cancelled mid-packet makes the device drop the next control transfer,
//!   so control transfers use a short timeout and retry;
//! - without CLEAR_HALT on 0x86 and 0x05 the audio engine never starts;
//! - OUT packets must always be complete, with 0xFD in every MIDI slot.

use std::ffi::c_void;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::codec::{self, FRAMES_PER_PACKET, Frame, IN_PACKET_SIZE, OUT_PACKET_SIZE};
use crate::usbfs::{self, URB_TYPE_BULK, URB_TYPE_INTERRUPT, Urb, UsbFs};

pub const VENDOR_ID: u16 = 0x0a4a;
pub const PRODUCT_ID: u16 = 0xff4d;

const EP_PCM_OUT: u8 = 0x05;
const EP_PCM_IN: u8 = 0x86;
const EP_MIDI_IN: u8 = 0x83;
const MIDI_IN_SIZE: usize = 512;

const REQ_FIRMWARE: u8 = 0x56; // 'V'
const REQ_STATUS: u8 = 0x49; // 'I'
const UAC_SET_CUR: u8 = 0x01;
const UAC_GET_CUR: u8 = 0x81;
const UAC_SAMPLING_FREQ: u16 = 0x0100;

const CONTROL_TIMEOUT_MS: u32 = 300;
const CONTROL_ATTEMPTS: usize = 3;

/// The device's only clock we drive: everything runs at 48 kHz.
pub const SAMPLE_RATE: u32 = 48_000;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{what}: {source}")]
    Usb { what: &'static str, source: io::Error },
    #[error("Xone:4D firmware v1.{0}.{1} is not supported; flash 1.4.1 (interrupt endpoints)")]
    Firmware(u8, u8),
    #[error("Xone:4D reports sample rate {0} Hz after SET_CUR {SAMPLE_RATE}")]
    Rate(u32),
}

pub type Result<T> = std::result::Result<T, Error>;

trait Context<T> {
    fn ctx(self, what: &'static str) -> Result<T>;
}

impl<T> Context<T> for io::Result<T> {
    fn ctx(self, what: &'static str) -> Result<T> {
        self.map_err(|source| Error::Usb { what, source })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Firmware {
    pub chip_id: u8,
    pub major: u8,
    pub minor: u8,
}

impl std::fmt::Display for Firmware {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "v1.{}.{} (chip 0x{:02X})", self.major, self.minor, self.chip_id)
    }
}

/// What the streaming loop asks of the audio engine. Called on the streaming
/// thread: implementations must not block or allocate.
pub trait Renderer {
    /// Produce the next 80 frames (8 channels, signed 24-bit).
    fn render(&mut self, frames: &mut [Frame; FRAMES_PER_PACKET]);
    /// Next MIDI byte to send, one per packet.
    fn midi_out(&mut self) -> Option<u8> {
        None
    }
    /// Raw MIDI IN bytes as received (filler included; the parser drops it).
    fn midi_in(&mut self, _bytes: &[u8]) {}
    /// 80 frames recorded by the mixer.
    fn captured(&mut self, _frames: &[Frame; FRAMES_PER_PACKET]) {}
}

#[derive(Debug, Clone, Copy)]
pub struct StreamConfig {
    /// OUT URBs in flight. Output latency is this many 80-frame packets.
    pub out_urbs: usize,
    pub in_urbs: usize,
    pub midi_urbs: usize,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self { out_urbs: 3, in_urbs: 4, midi_urbs: 2 }
    }
}

/// Counters shared with other threads. `min_inflight` and `max_interval_us`
/// are reset by whoever reads them (`take_window`).
pub struct StreamStats {
    pub running: AtomicBool,
    pub packets_out: AtomicU64,
    pub packets_in: AtomicU64,
    /// OUT completions that left no OUT URB queued: the device may have gone hungry.
    pub underruns: AtomicU64,
    pub urb_errors: AtomicU64,
    /// Status of the most recent failed URB (negative errno) and its endpoint.
    pub last_error: std::sync::atomic::AtomicI32,
    pub last_error_ep: AtomicU32,
    pub min_inflight: AtomicU32,
    pub max_interval_us: AtomicU32,
    /// Per OUT packet, packed by [`Timing::pack`]: the gap since the previous one, the
    /// time to render and encode it, and the OUT URBs left queued. A ring the USB
    /// thread writes without locking; `timing_head` counts every packet written.
    pub timing: Box<[AtomicU64]>,
    pub timing_head: AtomicU64,
}

/// Packets kept in the timing ring (about 6.8 s).
pub const TIMING_RING: usize = 4096;

/// One OUT packet's timing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timing {
    /// Time since the previous OUT completion, µs (nominally 1667).
    pub interval_us: u32,
    /// Time to render and encode the packet, µs.
    pub render_us: u16,
    /// OUT URBs still queued at the device when it completed.
    pub queued: u8,
}

impl Timing {
    pub fn pack(self) -> u64 {
        self.interval_us as u64 | (self.render_us as u64) << 32 | (self.queued as u64) << 48
    }
    pub fn unpack(v: u64) -> Self {
        Self { interval_us: v as u32, render_us: (v >> 32) as u16, queued: (v >> 48) as u8 }
    }
}

impl Default for StreamStats {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
            packets_out: AtomicU64::new(0),
            packets_in: AtomicU64::new(0),
            underruns: AtomicU64::new(0),
            urb_errors: AtomicU64::new(0),
            last_error: std::sync::atomic::AtomicI32::new(0),
            last_error_ep: AtomicU32::new(0),
            min_inflight: AtomicU32::new(u32::MAX),
            max_interval_us: AtomicU32::new(0),
            timing: (0..TIMING_RING).map(|_| AtomicU64::new(0)).collect(),
            timing_head: AtomicU64::new(0),
        }
    }
}

impl StreamStats {
    /// Read and reset the windowed values: (min OUT URBs left queued, max OUT completion gap in µs).
    pub fn take_window(&self) -> (u32, u32) {
        (self.min_inflight.swap(u32::MAX, Ordering::Relaxed), self.max_interval_us.swap(0, Ordering::Relaxed))
    }

    /// Record one OUT packet's timing (USB thread only).
    pub fn record(&self, t: Timing) {
        let head = self.timing_head.load(Ordering::Relaxed);
        self.timing[head as usize % TIMING_RING].store(t.pack(), Ordering::Relaxed);
        self.timing_head.store(head + 1, Ordering::Release);
    }

    /// Packets recorded since `from` (a previous `timing_head`), oldest first; at most
    /// the ring's worth. Returns the new head.
    pub fn read_since(&self, from: u64, out: &mut Vec<Timing>) -> u64 {
        let head = self.timing_head.load(Ordering::Acquire);
        let start = from.max(head.saturating_sub(TIMING_RING as u64 - 64));
        for i in start..head {
            out.push(Timing::unpack(self.timing[i as usize % TIMING_RING].load(Ordering::Relaxed)));
        }
        head
    }
}

#[derive(Debug)]
pub enum StreamEnd {
    /// `stop` was set.
    Stopped,
    /// No OUT completion for 200 ms: the mixer's USB engine stalled and probably needs a power cycle.
    Stalled,
    /// The device went away or a URB failed fatally.
    Disconnected(io::Error),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Out,
    In,
    Midi,
}

struct Slot {
    urb: Urb,
    buf: Vec<u8>,
    kind: Kind,
    inflight: bool,
}

/// An initialised Xone:4D, owned by this process until released.
pub struct Xone {
    usb: UsbFs,
    firmware: Firmware,
    claimed: bool,
}

impl Xone {
    /// Take the Xone:4D from snd-usb-ozzy and bring its audio engine up at 48 kHz.
    pub fn open() -> Result<Self> {
        let path = usbfs::find_device(VENDOR_ID, PRODUCT_ID).ctx("find Xone:4D")?;
        let usb = UsbFs::open(&path).ctx("open usbfs node")?;
        usb.disconnect_claim(0).ctx("claim interface 0")?;
        let mut dev = Self { usb, firmware: Firmware { chip_id: 0, major: 0, minor: 0 }, claimed: true };
        dev.usb.disconnect_claim(1).ctx("claim interface 1")?;
        dev.usb.set_interface(0, 1).ctx("set interface 0 alt 1")?;
        dev.usb.set_interface(1, 1).ctx("set interface 1 alt 1")?;
        dev.bring_up()?;
        Ok(dev)
    }

    pub fn firmware(&self) -> Firmware {
        self.firmware
    }

    pub fn path(&self) -> &std::path::Path {
        self.usb.path()
    }

    fn control(&self, what: &'static str, rt: u8, req: u8, value: u16, index: u16, data: &mut [u8]) -> Result<usize> {
        let mut last = None;
        for attempt in 1..=CONTROL_ATTEMPTS {
            match self.usb.control(rt, req, value, index, data, CONTROL_TIMEOUT_MS) {
                Ok(n) => return Ok(n),
                Err(e) if e.raw_os_error() == Some(libc::ETIMEDOUT) => {
                    tracing::warn!(what, attempt, "control transfer timed out, retrying");
                    last = Some(e);
                }
                Err(e) => return Err(Error::Usb { what, source: e }),
            }
        }
        Err(Error::Usb { what, source: last.unwrap() })
    }

    fn read_status(&self) -> Result<u8> {
        let mut st = [0u8; 1];
        self.control("status read", 0xC0, REQ_STATUS, 0, 0, &mut st)?;
        Ok(st[0])
    }

    fn get_rate(&self) -> Result<u32> {
        let mut r = [0u8; 3];
        self.control("GET_CUR rate", 0xA2, UAC_GET_CUR, UAC_SAMPLING_FREQ, 0, &mut r)?;
        Ok(u32::from_le_bytes([r[0], r[1], r[2], 0]))
    }

    fn bring_up(&mut self) -> Result<()> {
        let mut fw = [0u8; 15];
        self.control("firmware read", 0xC0, REQ_FIRMWARE, 0, 0, &mut fw)?;
        self.firmware = Firmware { chip_id: fw[0], major: fw[2] / 10, minor: fw[2] % 10 };
        if (self.firmware.major, self.firmware.minor) != (4, 1) {
            return Err(Error::Firmware(self.firmware.major, self.firmware.minor));
        }
        let status = self.read_status()?;
        let current = self.get_rate()?;
        tracing::info!(firmware = %self.firmware, status = format_args!("0x{status:02X}"), current, "Xone:4D found");

        // SET_CUR to both PCM endpoints (ploytec.c:301-309).
        let mut rate = SAMPLE_RATE.to_le_bytes();
        for ep in [EP_PCM_IN, EP_PCM_OUT] {
            self.control("SET_CUR rate", 0x22, UAC_SET_CUR, UAC_SAMPLING_FREQ, ep as u16, &mut rate[..3])?;
        }
        let rate = self.get_rate()?;
        if rate != SAMPLE_RATE {
            return Err(Error::Rate(rate));
        }

        // Confirm the status with bit 5 set, sign-extended like the A&H driver's
        // (short)(char) cast: 0x92 -> 0xFFB2 (ploytec_protocol.h:132-136).
        self.read_status()?;
        let status = self.read_status()?;
        let confirm = ((status | 0x20) as i8) as i16 as u16;
        self.control("status confirm", 0x40, REQ_STATUS, confirm, 0, &mut [])?;

        // Arm the PCM endpoints the way the Windows driver does (ploytec.c:186-206).
        std::thread::sleep(Duration::from_millis(500));
        self.usb.clear_halt(EP_PCM_IN).ctx("clear halt 0x86")?;
        self.usb.clear_halt(EP_PCM_OUT).ctx("clear halt 0x05")?;
        tracing::info!(confirm = format_args!("0x{confirm:04X}"), "Xone:4D ready at {SAMPLE_RATE} Hz");
        Ok(())
    }

    /// Stream until `stop` is set, the device stalls or disconnects.
    ///
    /// Each OUT completion renders the next 80 frames straight into that URB and
    /// resubmits it, so output latency is `out_urbs` packets (1.67 ms each).
    pub fn stream<R: Renderer>(
        &mut self,
        config: &StreamConfig,
        renderer: &mut R,
        stop: &AtomicBool,
        stats: &StreamStats,
    ) -> Result<StreamEnd> {
        let mut slots: Vec<Box<Slot>> = Vec::new();
        let mut add = |kind: Kind, count: usize| {
            for _ in 0..count {
                let (size, ep, ty) = match kind {
                    Kind::Out => (OUT_PACKET_SIZE, EP_PCM_OUT, URB_TYPE_INTERRUPT),
                    Kind::In => (IN_PACKET_SIZE, EP_PCM_IN, URB_TYPE_INTERRUPT),
                    Kind::Midi => (MIDI_IN_SIZE, EP_MIDI_IN, URB_TYPE_BULK),
                };
                let mut slot = Box::new(Slot {
                    urb: Urb {
                        kind: ty,
                        endpoint: ep,
                        status: 0,
                        flags: 0,
                        buffer: std::ptr::null_mut(),
                        buffer_length: size as i32,
                        actual_length: 0,
                        start_frame: 0,
                        number_of_packets: 0,
                        error_count: 0,
                        signr: 0,
                        usercontext: std::ptr::null_mut(),
                    },
                    buf: vec![0u8; size],
                    kind,
                    inflight: false,
                });
                if kind == Kind::Out {
                    codec::init_out_packet(&mut slot.buf);
                }
                slot.urb.buffer = slot.buf.as_mut_ptr().cast();
                slot.urb.usercontext = slots.len() as *mut c_void;
                slots.push(slot);
            }
        };
        // Same order as Ozzy: IN, then OUT, then MIDI.
        add(Kind::In, config.in_urbs);
        add(Kind::Out, config.out_urbs.clamp(2, 16));
        add(Kind::Midi, config.midi_urbs);

        for slot in slots.iter_mut() {
            self.submit(slot).ctx("submit URB")?;
        }

        let mut frames = [[0i32; codec::CHANNELS]; FRAMES_PER_PACKET];
        let mut in_frames = [[0i32; codec::CHANNELS]; FRAMES_PER_PACKET];
        let mut inflight_out = config.out_urbs.clamp(2, 16) as u32;
        let mut last_out = Instant::now();
        stats.running.store(true, Ordering::Relaxed);

        let end = 'run: loop {
            if stop.load(Ordering::Relaxed) {
                break StreamEnd::Stopped;
            }
            match self.usb.wait(50) {
                Ok(true) => {}
                Ok(false) => {
                    if last_out.elapsed() > Duration::from_millis(200) {
                        break StreamEnd::Stalled;
                    }
                    continue;
                }
                Err(e) => break StreamEnd::Disconnected(e),
            }
            loop {
                let urb = match self.usb.reap() {
                    Ok(Some(urb)) => urb,
                    Ok(None) => break,
                    Err(e) => break 'run StreamEnd::Disconnected(e),
                };
                let idx = unsafe { (*urb).usercontext } as usize;
                let slot = &mut slots[idx];
                slot.inflight = false;
                let status = slot.urb.status;
                if status == -libc::ENODEV || status == -libc::ESHUTDOWN {
                    break 'run StreamEnd::Disconnected(io::Error::from_raw_os_error(-status));
                }
                if status != 0 {
                    stats.urb_errors.fetch_add(1, Ordering::Relaxed);
                    stats.last_error.store(status, Ordering::Relaxed);
                    stats.last_error_ep.store(slot.urb.endpoint as u32, Ordering::Relaxed);
                }
                match slot.kind {
                    Kind::Out => {
                        inflight_out -= 1;
                        stats.min_inflight.fetch_min(inflight_out, Ordering::Relaxed);
                        if inflight_out == 0 {
                            stats.underruns.fetch_add(1, Ordering::Relaxed);
                        }
                        let now = Instant::now();
                        let gap = now.duration_since(last_out).as_micros().min(u32::MAX as u128) as u32;
                        stats.max_interval_us.fetch_max(gap, Ordering::Relaxed);
                        last_out = now;
                        renderer.render(&mut frames);
                        let midi = renderer.midi_out();
                        codec::encode_out_packet(&mut slot.buf, &frames, midi);
                        let render_us = now.elapsed().as_micros().min(u16::MAX as u128) as u16;
                        stats.record(Timing { interval_us: gap, render_us, queued: inflight_out.min(255) as u8 });
                        stats.packets_out.fetch_add(1, Ordering::Relaxed);
                        if let Err(e) = self.submit(slot) {
                            break 'run StreamEnd::Disconnected(e);
                        }
                        inflight_out += 1;
                    }
                    Kind::In => {
                        if slot.urb.actual_length as usize == IN_PACKET_SIZE {
                            codec::decode_in_packet(&slot.buf, &mut in_frames);
                            renderer.captured(&in_frames);
                        }
                        stats.packets_in.fetch_add(1, Ordering::Relaxed);
                        if let Err(e) = self.submit(slot) {
                            break 'run StreamEnd::Disconnected(e);
                        }
                    }
                    Kind::Midi => {
                        let n = (slot.urb.actual_length.max(0) as usize).min(MIDI_IN_SIZE);
                        renderer.midi_in(&slot.buf[..n]);
                        if let Err(e) = self.submit(slot) {
                            break 'run StreamEnd::Disconnected(e);
                        }
                    }
                }
            }
        };

        stats.running.store(false, Ordering::Relaxed);
        if !matches!(end, StreamEnd::Disconnected(_)) {
            self.drain(&mut slots);
        }
        tracing::info!(?end, "stream ended");
        Ok(end)
    }

    fn submit(&self, slot: &mut Slot) -> io::Result<()> {
        slot.urb.status = 0;
        slot.urb.actual_length = 0;
        unsafe { self.usb.submit(&mut slot.urb)? };
        slot.inflight = true;
        Ok(())
    }

    /// Let PCM URBs finish on their own (cancelling mid-packet upsets the
    /// device), then cancel the MIDI reads, which only complete when MIDI arrives.
    fn drain(&self, slots: &mut [Box<Slot>]) {
        let reap_all = |slots: &mut [Box<Slot>]| {
            while let Ok(Some(urb)) = self.usb.reap() {
                let idx = unsafe { (*urb).usercontext } as usize;
                slots[idx].inflight = false;
            }
        };
        let pcm_busy = |slots: &[Box<Slot>]| slots.iter().any(|s| s.inflight && s.kind != Kind::Midi);
        let deadline = Instant::now() + Duration::from_millis(100);
        while pcm_busy(slots) && Instant::now() < deadline {
            let _ = self.usb.wait(10);
            reap_all(slots);
        }
        for slot in slots.iter_mut().filter(|s| s.inflight) {
            let _ = unsafe { self.usb.discard(&mut slot.urb) };
        }
        let deadline = Instant::now() + Duration::from_millis(100);
        while slots.iter().any(|s| s.inflight) && Instant::now() < deadline {
            let _ = self.usb.wait(10);
            reap_all(slots);
        }
        if slots.iter().any(|s| s.inflight) {
            tracing::warn!("URBs still in flight after drain");
        }
    }

    /// Give the device back to snd-usb-ozzy.
    pub fn release(mut self) -> Result<()> {
        self.hand_back()
    }

    fn hand_back(&mut self) -> Result<()> {
        if !self.claimed {
            return Ok(());
        }
        self.claimed = false;
        // Absorb a control transfer the device may drop after the MIDI cancel,
        // so the kernel driver's own handshake (no retries) succeeds.
        let mut fw = [0u8; 15];
        let _ = self.control("firmware read", 0xC0, REQ_FIRMWARE, 0, 0, &mut fw);
        // Releasing an interface switches it to alt 0. Right after streaming the
        // 4D stalls that request for a while, and the kernel then retries it in
        // snd-usb-ozzy's probe, which fails with -EPIPE. Do the switch ourselves.
        for iface in [1, 0] {
            self.set_alt_zero(iface);
        }
        let _ = self.usb.release(1);
        self.usb.release(0).ctx("release interface 0")?;
        // snd-usb-ozzy binds interface 0 and claims 1 itself.
        match self.usb.connect_driver(0) {
            Ok(()) => {}
            Err(e) if e.raw_os_error() == Some(libc::EBUSY) => {}
            Err(e) => return Err(Error::Usb { what: "rebind kernel driver", source: e }),
        }
        tracing::info!("Xone:4D handed back to the kernel driver");
        Ok(())
    }

    fn set_alt_zero(&self, iface: u32) {
        let start = Instant::now();
        loop {
            match self.usb.set_interface(iface, 0) {
                Ok(()) => {
                    if start.elapsed() > Duration::from_millis(1) {
                        tracing::debug!(iface, waited = ?start.elapsed(), "interface back at alt 0");
                    }
                    return;
                }
                Err(e) if e.raw_os_error() == Some(libc::EPIPE) && start.elapsed() < Duration::from_secs(3) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    tracing::warn!(iface, error = %e, waited = ?start.elapsed(), "could not switch interface to alt 0");
                    return;
                }
            }
        }
    }
}

impl Drop for Xone {
    fn drop(&mut self) {
        if let Err(e) = self.hand_back() {
            tracing::warn!(error = %e, "could not hand the Xone:4D back");
        }
    }
}

/// Rebind the kernel driver after a crash left the device unclaimed.
pub fn rebind_kernel_driver() -> Result<()> {
    let path = usbfs::find_device(VENDOR_ID, PRODUCT_ID).ctx("find Xone:4D")?;
    let usb = UsbFs::open(&path).ctx("open usbfs node")?;
    match usb.connect_driver(0) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(libc::EBUSY) => Ok(()),
        Err(e) => Err(Error::Usb { what: "rebind kernel driver", source: e }),
    }
}

#[cfg(test)]
mod timing_tests {
    use super::*;

    #[test]
    fn timing_ring_reads_what_was_written() {
        let stats = StreamStats::default();
        let t = |i: u32| Timing { interval_us: 1600 + i, render_us: 40, queued: 2 };
        for i in 0..10 {
            stats.record(t(i));
        }
        let mut out = vec![];
        let head = stats.read_since(0, &mut out);
        assert_eq!(head, 10);
        assert_eq!(out, (0..10).map(t).collect::<Vec<_>>());
        out.clear();
        stats.record(t(99));
        assert_eq!(stats.read_since(head, &mut out), 11);
        assert_eq!(out, vec![t(99)]);
        // Far behind: only the newest ring's worth.
        for i in 0..(TIMING_RING as u32 * 2) {
            stats.record(t(i % 50));
        }
        out.clear();
        stats.read_since(0, &mut out);
        assert_eq!(out.len(), TIMING_RING - 64);
    }
}
