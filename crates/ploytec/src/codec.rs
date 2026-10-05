//! Ploytec PCM codec and packet layout for the Xone:4D on firmware 1.4.1.
//!
//! Ported from the Ozzy driver:
//! - frame codec: `common/devices/ploytec/ploytec_codec.c`
//! - interrupt OUT layout: `common/devices/ploytec/ploytec_protocol.h:198-240`
//!   (A&H `dmaEncode10_AH_Int964_C`)

/// Audio channels in each direction.
pub const CHANNELS: usize = 8;
/// Frames carried by one PCM packet, in and out.
pub const FRAMES_PER_PACKET: usize = 80;
/// Encoded size of one output frame.
pub const OUT_FRAME_SIZE: usize = 48;
/// Encoded size of one input frame.
pub const IN_FRAME_SIZE: usize = 64;
/// Interrupt OUT packet: 8 sub-packets of 482 bytes.
pub const OUT_PACKET_SIZE: usize = 3856;
/// Interrupt IN packet: 80 frames of 64 bytes.
pub const IN_PACKET_SIZE: usize = FRAMES_PER_PACKET * IN_FRAME_SIZE;
/// MIDI idle byte, used in OUT slots and as filler in MIDI IN.
pub const MIDI_IDLE: u8 = 0xFD;

const SUBPACKET_SIZE: usize = 482;
const SUBPACKETS: usize = 8;
/// Offset of the 2 MIDI bytes inside each sub-packet, after its first 9 frames.
const MIDI_SLOT: usize = 9 * OUT_FRAME_SIZE;

/// One frame of 8 channels, signed 24-bit samples in the low bits of an i32.
pub type Frame = [i32; CHANNELS];

/// Byte offset of output frame `f` (0..80) inside an OUT packet.
///
/// In sub-packet k, frames 10k..10k+8 sit at 482k + 48j, the MIDI bytes at
/// 482k+432..433, and frame 10k+9 at 482k+434.
#[inline]
pub const fn out_frame_offset(f: usize) -> usize {
    let k = f / 10;
    let j = f % 10;
    let base = k * SUBPACKET_SIZE;
    if j < 9 { base + j * OUT_FRAME_SIZE } else { base + MIDI_SLOT + 2 }
}

/// Byte offsets of the 16 MIDI slot bytes in an OUT packet.
pub fn midi_slot_offsets() -> impl Iterator<Item = usize> {
    (0..SUBPACKETS).flat_map(|k| [k * SUBPACKET_SIZE + MIDI_SLOT, k * SUBPACKET_SIZE + MIDI_SLOT + 1])
}

/// Encode one frame into the 48-byte bit-interleaved device format.
///
/// `out[24h + i]` bit c = bit (23 - i) of channel 2c + h: bytes 0..24 carry
/// channels 1/3/5/7 in bits 0..3, bytes 24..48 carry channels 2/4/6/8, MSB first.
#[inline]
pub fn encode_frame(out: &mut [u8], frame: &Frame) {
    debug_assert!(out.len() >= OUT_FRAME_SIZE);
    for h in 0..2 {
        let a = frame[h] as u32;
        let b = frame[2 + h] as u32;
        let c = frame[4 + h] as u32;
        let d = frame[6 + h] as u32;
        for i in 0..24 {
            let s = 23 - i;
            out[24 * h + i] = (((a >> s) & 1) | (((b >> s) & 1) << 1) | (((c >> s) & 1) << 2) | (((d >> s) & 1) << 3)) as u8;
        }
    }
}

/// Decode one 48-byte output frame (the inverse of [`encode_frame`]); used by tests and tools.
pub fn decode_out_frame(input: &[u8]) -> Frame {
    decode_interleaved(input, 24)
}

/// Decode one 64-byte input frame. Same bit rule as the output, with the even
/// channels starting at byte 32; bytes 24..32 and 56..64 are unused.
#[inline]
pub fn decode_in_frame(input: &[u8]) -> Frame {
    decode_interleaved(input, 32)
}

#[inline]
fn decode_interleaved(input: &[u8], half: usize) -> Frame {
    let mut frame = [0u32; CHANNELS];
    for h in 0..2 {
        for i in 0..24 {
            let byte = input[half * h + i] as u32;
            for c in 0..4 {
                frame[2 * c + h] = (frame[2 * c + h] << 1) | ((byte >> c) & 1);
            }
        }
    }
    // Sign-extend from 24 bits.
    frame.map(|v| ((v << 8) as i32) >> 8)
}

/// Fill an OUT packet with silence and idle MIDI bytes. Every MIDI slot must
/// hold 0xFD: zeros there stalled the stream (Ozzy commit 6ad3bb5).
pub fn init_out_packet(packet: &mut [u8]) {
    packet[..OUT_PACKET_SIZE].fill(0);
    for off in midi_slot_offsets() {
        packet[off] = MIDI_IDLE;
    }
}

/// Encode 80 frames into an OUT packet and put one MIDI byte (or idle) in the
/// first slot. The other 15 slot bytes stay idle, as in the A&H drivers.
pub fn encode_out_packet(packet: &mut [u8], frames: &[Frame; FRAMES_PER_PACKET], midi: Option<u8>) {
    for (f, frame) in frames.iter().enumerate() {
        let off = out_frame_offset(f);
        encode_frame(&mut packet[off..off + OUT_FRAME_SIZE], frame);
    }
    for off in midi_slot_offsets() {
        packet[off] = MIDI_IDLE;
    }
    if let Some(byte) = midi {
        packet[MIDI_SLOT] = byte;
    }
}

/// Decode an IN packet into 80 frames.
pub fn decode_in_packet(packet: &[u8], frames: &mut [Frame; FRAMES_PER_PACKET]) {
    for (f, frame) in frames.iter_mut().enumerate() {
        *frame = decode_in_frame(&packet[f * IN_FRAME_SIZE..(f + 1) * IN_FRAME_SIZE]);
    }
}

/// Decode an OUT packet back into frames and its 16 MIDI slot bytes (tests and tools).
pub fn decode_out_packet(packet: &[u8]) -> ([Frame; FRAMES_PER_PACKET], [u8; 16]) {
    let mut frames = [[0; CHANNELS]; FRAMES_PER_PACKET];
    for (f, frame) in frames.iter_mut().enumerate() {
        let off = out_frame_offset(f);
        *frame = decode_out_frame(&packet[off..off + OUT_FRAME_SIZE]);
    }
    let mut midi = [0u8; 16];
    for (i, off) in midi_slot_offsets().enumerate() {
        midi[i] = packet[off];
    }
    (frames, midi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_covers_packet_exactly() {
        let mut used = vec![0u8; OUT_PACKET_SIZE];
        for f in 0..FRAMES_PER_PACKET {
            for b in &mut used[out_frame_offset(f)..out_frame_offset(f) + OUT_FRAME_SIZE] {
                *b += 1;
            }
        }
        for off in midi_slot_offsets() {
            used[off] += 1;
        }
        assert!(used.iter().all(|&n| n == 1), "every byte used exactly once");
        assert_eq!(out_frame_offset(9), 434);
        assert_eq!(out_frame_offset(79), 3808);
    }

    #[test]
    fn frame_roundtrip() {
        let frame: Frame = [0x7F_FFFF, -0x80_0000, 1, -1, 0x12_3456, -0x65_4321, 0, 0x55_AA55];
        let mut buf = [0u8; OUT_FRAME_SIZE];
        encode_frame(&mut buf, &frame);
        assert!(buf.iter().all(|b| b & 0xF0 == 0));
        assert_eq!(decode_out_frame(&buf), frame);
    }

    #[test]
    fn in_frame_uses_offset_32() {
        let frame: Frame = [3, -3, 0x40_0000, -0x40_0000, 7, 8, 9, -10];
        let mut out = [0u8; OUT_FRAME_SIZE];
        encode_frame(&mut out, &frame);
        let mut input = [0u8; IN_FRAME_SIZE];
        input[..24].copy_from_slice(&out[..24]);
        input[32..56].copy_from_slice(&out[24..48]);
        assert_eq!(decode_in_frame(&input), frame);
    }
}
