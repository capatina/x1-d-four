//! Minimal Linux usbfs access: raw ioctls on /dev/bus/usb/BBB/DDD.
//!
//! Only what the Xone:4D needs. Struct layouts and request numbers follow
//! `include/uapi/linux/usbdevice_fs.h`.

use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, RawFd};
use std::path::{Path, PathBuf};

const IOC_NONE: u32 = 0;
const IOC_WRITE: u32 = 1;
const IOC_READ: u32 = 2;

const fn ioc(dir: u32, nr: u32, size: usize) -> libc::c_ulong {
    ((dir << 30) | ((size as u32) << 16) | ((b'U' as u32) << 8) | nr) as libc::c_ulong
}

#[repr(C)]
struct CtrlTransfer {
    request_type: u8,
    request: u8,
    value: u16,
    index: u16,
    length: u16,
    timeout: u32,
    data: *mut c_void,
}

#[repr(C)]
struct SetInterface {
    interface: u32,
    altsetting: u32,
}

#[repr(C)]
struct UsbIoctl {
    ifno: i32,
    ioctl_code: i32,
    data: *mut c_void,
}

#[repr(C)]
struct DisconnectClaim {
    interface: u32,
    flags: u32,
    driver: [u8; 256],
}

/// `struct usbdevfs_urb` without iso descriptors.
#[repr(C)]
#[derive(Debug)]
pub struct Urb {
    pub kind: u8,
    pub endpoint: u8,
    pub status: i32,
    pub flags: u32,
    pub buffer: *mut c_void,
    pub buffer_length: i32,
    pub actual_length: i32,
    pub start_frame: i32,
    pub number_of_packets: i32,
    pub error_count: i32,
    pub signr: u32,
    pub usercontext: *mut c_void,
}

pub const URB_TYPE_INTERRUPT: u8 = 1;
pub const URB_TYPE_BULK: u8 = 3;

const USBDEVFS_CONTROL: libc::c_ulong = ioc(IOC_READ | IOC_WRITE, 0, size_of::<CtrlTransfer>());
const USBDEVFS_SETINTERFACE: libc::c_ulong = ioc(IOC_READ, 4, size_of::<SetInterface>());
const USBDEVFS_SUBMITURB: libc::c_ulong = ioc(IOC_READ, 10, size_of::<Urb>());
const USBDEVFS_DISCARDURB: libc::c_ulong = ioc(IOC_NONE, 11, 0);
const USBDEVFS_REAPURBNDELAY: libc::c_ulong = ioc(IOC_WRITE, 13, size_of::<*mut c_void>());
const USBDEVFS_CLAIMINTERFACE: libc::c_ulong = ioc(IOC_READ, 15, size_of::<u32>());
const USBDEVFS_RELEASEINTERFACE: libc::c_ulong = ioc(IOC_READ, 16, size_of::<u32>());
const USBDEVFS_IOCTL: libc::c_ulong = ioc(IOC_READ | IOC_WRITE, 18, size_of::<UsbIoctl>());
const USBDEVFS_CLEAR_HALT: libc::c_ulong = ioc(IOC_READ, 21, size_of::<u32>());
const USBDEVFS_CONNECT: i32 = ioc(IOC_NONE, 23, 0) as i32;
const USBDEVFS_DISCONNECT_CLAIM: libc::c_ulong = ioc(IOC_READ, 27, size_of::<DisconnectClaim>());

/// An open usbfs device node.
pub struct UsbFs {
    file: File,
    path: PathBuf,
}

/// Find a device by vendor/product id in sysfs and return its usbfs node.
pub fn find_device(vendor: u16, product: u16) -> io::Result<PathBuf> {
    let read = |p: &Path| std::fs::read_to_string(p).map(|s| s.trim().to_owned());
    for entry in std::fs::read_dir("/sys/bus/usb/devices")? {
        let dir = entry?.path();
        let (Ok(v), Ok(p)) = (read(&dir.join("idVendor")), read(&dir.join("idProduct"))) else { continue };
        if u16::from_str_radix(&v, 16).ok() == Some(vendor) && u16::from_str_radix(&p, 16).ok() == Some(product) {
            let bus: u32 = read(&dir.join("busnum"))?.parse().map_err(io::Error::other)?;
            let dev: u32 = read(&dir.join("devnum"))?.parse().map_err(io::Error::other)?;
            return Ok(PathBuf::from(format!("/dev/bus/usb/{bus:03}/{dev:03}")));
        }
    }
    Err(io::Error::new(io::ErrorKind::NotFound, format!("USB device {vendor:04x}:{product:04x} not found")))
}

fn check(ret: libc::c_int) -> io::Result<libc::c_int> {
    if ret < 0 { Err(io::Error::last_os_error()) } else { Ok(ret) }
}

impl UsbFs {
    pub fn open(path: &Path) -> io::Result<Self> {
        let file = OpenOptions::new().read(true).write(true).open(path).map_err(|e| {
            io::Error::new(e.kind(), format!("{}: {e} (is the udev rule installed?)", path.display()))
        })?;
        Ok(Self { file, path: path.to_owned() })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn fd(&self) -> RawFd {
        self.file.as_raw_fd()
    }

    /// Detach any kernel driver from `iface` and claim it.
    pub fn disconnect_claim(&self, iface: u32) -> io::Result<()> {
        let mut dc = DisconnectClaim { interface: iface, flags: 0, driver: [0; 256] };
        check(unsafe { libc::ioctl(self.fd(), USBDEVFS_DISCONNECT_CLAIM, &mut dc) }).map(drop)
    }

    pub fn claim(&self, iface: u32) -> io::Result<()> {
        let mut i = iface;
        check(unsafe { libc::ioctl(self.fd(), USBDEVFS_CLAIMINTERFACE, &mut i) }).map(drop)
    }

    pub fn release(&self, iface: u32) -> io::Result<()> {
        let mut i = iface;
        check(unsafe { libc::ioctl(self.fd(), USBDEVFS_RELEASEINTERFACE, &mut i) }).map(drop)
    }

    /// Let kernel drivers bind to `iface` again.
    pub fn connect_driver(&self, iface: u32) -> io::Result<()> {
        let mut cmd = UsbIoctl { ifno: iface as i32, ioctl_code: USBDEVFS_CONNECT, data: std::ptr::null_mut() };
        check(unsafe { libc::ioctl(self.fd(), USBDEVFS_IOCTL, &mut cmd) }).map(drop)
    }

    pub fn set_interface(&self, iface: u32, alt: u32) -> io::Result<()> {
        let mut si = SetInterface { interface: iface, altsetting: alt };
        check(unsafe { libc::ioctl(self.fd(), USBDEVFS_SETINTERFACE, &mut si) }).map(drop)
    }

    /// Synchronous control transfer; returns the number of bytes transferred.
    pub fn control(
        &self,
        request_type: u8,
        request: u8,
        value: u16,
        index: u16,
        data: &mut [u8],
        timeout_ms: u32,
    ) -> io::Result<usize> {
        let mut ct = CtrlTransfer {
            request_type,
            request,
            value,
            index,
            length: data.len() as u16,
            timeout: timeout_ms,
            data: if data.is_empty() { std::ptr::null_mut() } else { data.as_mut_ptr().cast() },
        };
        check(unsafe { libc::ioctl(self.fd(), USBDEVFS_CONTROL, &mut ct) }).map(|n| n as usize)
    }

    /// CLEAR_FEATURE(ENDPOINT_HALT) and reset the host-side data toggle.
    pub fn clear_halt(&self, endpoint: u8) -> io::Result<()> {
        let mut ep = endpoint as u32;
        check(unsafe { libc::ioctl(self.fd(), USBDEVFS_CLEAR_HALT, &mut ep) }).map(drop)
    }

    /// Submit an URB.
    ///
    /// # Safety
    /// `urb` and its buffer must stay valid and unmoved until it is reaped.
    pub unsafe fn submit(&self, urb: *mut Urb) -> io::Result<()> {
        check(unsafe { libc::ioctl(self.fd(), USBDEVFS_SUBMITURB, urb) }).map(drop)
    }

    /// Cancel an URB; it still has to be reaped.
    ///
    /// # Safety
    /// `urb` must be a pointer previously passed to [`UsbFs::submit`].
    pub unsafe fn discard(&self, urb: *mut Urb) -> io::Result<()> {
        check(unsafe { libc::ioctl(self.fd(), USBDEVFS_DISCARDURB, urb) }).map(drop)
    }

    /// Reap one completed URB without blocking.
    pub fn reap(&self) -> io::Result<Option<*mut Urb>> {
        let mut urb: *mut Urb = std::ptr::null_mut();
        match check(unsafe { libc::ioctl(self.fd(), USBDEVFS_REAPURBNDELAY, &mut urb) }) {
            Ok(_) => Ok(Some(urb)),
            Err(e) if e.raw_os_error() == Some(libc::EAGAIN) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Wait until a completed URB can be reaped. Returns false on timeout.
    pub fn wait(&self, timeout_ms: i32) -> io::Result<bool> {
        let mut pfd = libc::pollfd { fd: self.fd(), events: libc::POLLOUT, revents: 0 };
        loop {
            match check(unsafe { libc::poll(&mut pfd, 1, timeout_ms) }) {
                Ok(0) => return Ok(false),
                Ok(_) => {
                    if pfd.revents & (libc::POLLERR | libc::POLLHUP) != 0 && pfd.revents & libc::POLLOUT == 0 {
                        return Err(io::Error::new(io::ErrorKind::BrokenPipe, "USB device disconnected"));
                    }
                    return Ok(true);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_numbers_match_the_kernel_header() {
        assert_eq!(size_of::<Urb>(), 56);
        assert_eq!(size_of::<CtrlTransfer>(), 24);
        assert_eq!(USBDEVFS_CONTROL, 0xC018_5500);
        assert_eq!(USBDEVFS_SUBMITURB, 0x8038_550A);
        assert_eq!(USBDEVFS_REAPURBNDELAY, 0x4008_550D);
        assert_eq!(USBDEVFS_CLAIMINTERFACE, 0x8004_550F);
        assert_eq!(USBDEVFS_IOCTL, 0xC010_5512);
        assert_eq!(USBDEVFS_CLEAR_HALT, 0x8004_5515);
        assert_eq!(USBDEVFS_DISCONNECT_CLAIM, 0x8108_551B);
        assert_eq!(USBDEVFS_CONNECT, 0x5517);
    }
}
