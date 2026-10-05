#!/usr/bin/env python3
"""Capture the Xone:4D's USB traffic with usbmon and check the PCM OUT stream.

Usage: tools/usbmon-check.py [seconds] [--tone-pair N --tone-hz F]
Runs the capture through pkexec (usbmon needs root), then reports:
  - OUT/IN completion rates and gaps (should be ~600/s, 1.6-1.76 ms apart)
  - the minimum number of OUT URBs still queued after a completion (0 = underrun risk)
  - URB statuses (anything but 0 is a problem; -71 means the mixer's engine is wedged)
  - with --tone-pair: continuity of a sine on that USB pair (x[n+1] = 2cos(w)x[n] - x[n-1])
"""

import argparse
import collections
import math
import os
import struct
import subprocess
import sys
import tempfile

CAPTURE = r'''
import fcntl, os, struct, sys, time
bus, secs, out = int(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
fd = os.open(f"/dev/usbmon{bus}", os.O_RDONLY)
fcntl.ioctl(fd, (0x92 << 8) | 4, 1200 * 1024)
end = time.monotonic() + secs
with open(out, "wb") as f:
    while time.monotonic() < end:
        f.write(os.read(fd, 1 << 16))
st = bytearray(8); fcntl.ioctl(fd, (2 << 30) | (8 << 16) | (0x92 << 8) | 3, st)
print("usbmon dropped events:", struct.unpack("<II", st)[1])
os.chown(out, int(sys.argv[4]), int(sys.argv[4]))
'''

SUBPACKETS = [(0, 9, 0), (9, 10, 434), (19, 10, 916), (29, 10, 1398), (39, 10, 1880), (49, 10, 2362),
              (59, 10, 2844), (69, 10, 3326), (79, 1, 3808)]


def find_device():
    for d in os.listdir("/sys/bus/usb/devices"):
        p = f"/sys/bus/usb/devices/{d}"
        try:
            if open(f"{p}/idVendor").read().strip() == "0a4a" and open(f"{p}/idProduct").read().strip() == "ff4d":
                return int(open(f"{p}/busnum").read()), int(open(f"{p}/devnum").read())
        except OSError:
            pass
    sys.exit("Xone:4D not found")


def decode_frame(fr):
    ch = [0] * 8
    for half in (0, 1):
        for i in range(24):
            b = fr[half * 24 + i]
            for k in range(4):
                ch[2 * k + half] = (ch[2 * k + half] << 1) | ((b >> k) & 1)
    return [c - (1 << 24) if c & 0x800000 else c for c in ch]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("seconds", nargs="?", type=float, default=10)
    ap.add_argument("--tone-pair", type=int)
    ap.add_argument("--tone-hz", type=float, default=440)
    ap.add_argument("--file", help="analyse an existing capture instead")
    a = ap.parse_args()
    bus, dev = find_device()
    path = a.file
    if not path:
        script = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False)
        script.write(CAPTURE)
        script.close()
        path = tempfile.mktemp(suffix=".usbmon")
        subprocess.run(["pkexec", sys.executable, script.name, str(bus), str(a.seconds), path, str(os.getuid())], check=True)
        os.unlink(script.name)

    data = open(path, "rb").read()
    hdr = struct.Struct("<QBBBBHbbqiiII8s")
    ev, off = [], 0
    while off + 48 <= len(data):
        f = hdr.unpack_from(data, off)
        ev.append(dict(t=chr(f[1]), ep=f[3], dev=f[4], ts=f[8] + f[9] / 1e6, status=f[10], len=f[11], cap=f[12], at=off + 48))
        off += 48 + f[12]
    ev = [e for e in ev if e["dev"] == dev]
    if not ev:
        sys.exit(f"no events for device {dev}")
    span = ev[-1]["ts"] - ev[0]["ts"]
    for name, ep in (("PCM OUT", 0x05), ("PCM IN", 0x86), ("MIDI IN", 0x83)):
        comp = [e for e in ev if e["ep"] == ep and e["t"] == "C"]
        statuses = collections.Counter(e["status"] for e in comp)
        gaps = sorted((b["ts"] - a_["ts"]) * 1000 for a_, b in zip(comp, comp[1:]))
        g = f"gaps p50 {gaps[len(gaps) // 2]:.3f} max {gaps[-1]:.3f} ms" if gaps else "no gaps"
        print(f"{name:8} {len(comp) / span:7.1f}/s  statuses {dict(statuses)}  {g}")

    inflight, low = 0, None
    for e in ev:
        if e["ep"] != 0x05:
            continue
        inflight += 1 if e["t"] == "S" else -1
        if e["t"] == "C":
            low = inflight if low is None else min(low, inflight)
    print(f"min OUT URBs queued after a completion (relative to start): {low}")

    if a.tone_pair:
        ch = 2 * (a.tone_pair - 1)
        samples = []
        for e in ev:
            if e["ep"] == 0x05 and e["t"] == "S" and e["cap"] == 3856:
                p = data[e["at"]:e["at"] + 3856]
                for sf, cnt, bo in SUBPACKETS:
                    for f in range(cnt):
                        samples.append(decode_frame(p[bo + 48 * f: bo + 48 * f + 48])[ch])
        c2 = 2 * math.cos(2 * math.pi * a.tone_hz / 48000)
        bad = [i for i in range(1, len(samples) - 1) if abs(samples[i + 1] - c2 * samples[i] + samples[i - 1]) > 20]
        print(f"tone on pair {a.tone_pair}: {len(samples)} frames, peak {max(map(abs, samples)) if samples else 0}, discontinuities {len(bad)}")


if __name__ == "__main__":
    main()
