//! Userspace driver for the Allen & Heath Xone:4D over Linux usbfs.
//!
//! The protocol knowledge comes from the Ozzy driver (`ginkomarchy/drivers/ozzy`)
//! and USB captures of the official A&H Windows driver.

pub mod codec;
pub mod device;
pub mod midi;
pub mod usbfs;

pub use codec::{FRAMES_PER_PACKET, Frame};
pub use device::{Firmware, Renderer, SAMPLE_RATE, StreamConfig, StreamEnd, StreamStats, Xone};
pub use midi::{MidiMessage, MidiOutQueue, MidiParser};
