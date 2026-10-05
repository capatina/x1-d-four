//! Packets captured with usbmon from the Ozzy kernel driver (2026-10-04) while it
//! played a -60 dBFS 997 Hz tone on USB 7-8. Our encoder must reproduce them byte for byte.

use ploytec::codec::{self, FRAMES_PER_PACKET, OUT_PACKET_SIZE};

const OUT: &[u8] = include_bytes!("fixtures/kernel_out_4pkts.bin");
const IN: &[u8] = include_bytes!("fixtures/kernel_in_1pkt.bin");

#[test]
fn reencodes_kernel_packets_byte_for_byte() {
    let mut samples = vec![];
    for pkt in OUT.chunks(OUT_PACKET_SIZE) {
        let (frames, midi) = codec::decode_out_packet(pkt);
        assert_eq!(midi, [0xFD; 16]);
        let mut ours = vec![0u8; OUT_PACKET_SIZE];
        codec::encode_out_packet(&mut ours, &frames, None);
        assert_eq!(ours, pkt);
        samples.extend(frames);
    }
    assert_eq!(samples.len(), 4 * FRAMES_PER_PACKET);
    for f in &samples {
        assert!(f[..6].iter().all(|&s| s == 0));
    }
    // The tone is continuous across packet boundaries: x[n+1] = 2cos(w)x[n] - x[n-1].
    let c2 = 2.0 * (2.0 * std::f64::consts::PI * 997.0 / 48_000.0).cos();
    for ch in [6, 7] {
        let peak = samples.iter().map(|f| f[ch].abs()).max().unwrap();
        assert!((8000..8400).contains(&peak), "peak {peak}");
        for w in samples.windows(3) {
            let r = w[2][ch] as f64 - c2 * w[1][ch] as f64 + w[0][ch] as f64;
            assert!(r.abs() < 20.0, "discontinuity {r}");
        }
    }
}

#[test]
fn decodes_a_kernel_in_packet() {
    let mut frames = [[0; 8]; FRAMES_PER_PACKET];
    codec::decode_in_packet(IN, &mut frames);
    assert!(frames.iter().flatten().all(|&s| (-(1 << 23)..(1 << 23)).contains(&s)));
}
