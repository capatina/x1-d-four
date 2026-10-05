# X1 D. Four

A browser-controlled 4-deck player for the Allen & Heath Xone:4D. It drives the mixer through its own userspace USB driver: raw usbfs ioctls, no libusb, ALSA or PipeWire. Deck n plays into USB pair 2n+1/2n+2, which feeds mixer channel n+1 when that channel's source switch is on SC (USB).

## Layout
- `crates/ploytec`: the driver.
  - `codec.rs`: packet layout and bit-interleaved frames.
  - `usbfs.rs`: ioctls.
  - `device.rs`: bring-up, streaming loop and hand-back.
  - `midi.rs`: MIDI parser and the out-queue.
- `crates/engine`: decks and track loading (symphonia + rubato). `Rt` renders on the USB thread; `Control` is the other side.
- `crates/app`: the `x1-d-four` binary.
  - axum server (`server.rs`, protocol in `docs/protocol.md`).
  - Application logic (`app.rs`).
  - Control catalog (`controls.rs`) and mappings (`mapping.rs`).
  - Audio thread (`audio.rs`).
- `ui/`: Svelte 5 + Vite, built with bun into `ui/dist` and embedded at compile time.
- `config/controls.toml`: the mixer's MIDI controls, from the A&H user guide.
- `config/mappings.toml`: live mappings, hot-reloaded.

## Running
- One-time setup: `setup/install` (pkexec) installs a udev rule so the user can open the device.
- Build: `(cd ui && bun install && bun run build) && cargo build --release`.
- `target/release/x1-d-four`: serves http://127.0.0.1:7878 and takes the Xone (from snd-usb-ozzy, if bound) until it quits. Ctrl-C hands it back.
- `x1-d-four serve --no-device`: the same, without hardware.
- `x1-d-four probe --pair N`: test tone.
- `x1-d-four release`: rebind the kernel driver after a crash.
- `cargo test`: codec golden packets (captured from the kernel driver), MIDI parser, decks, mappings.

## Hardware rules (learned the hard way)
- **Never reset the device, and never cancel a PCM URB mid-packet.** Either one wedges the 4D's audio engine until the mixer is power-cycled. The symptoms: EP5 OUT completes with -71 (EPROTO) and EP6 IN never completes.
  - Our shutdown lets PCM URBs finish and only cancels the MIDI reads.
  - snd-usb-ozzy must drain before it unbinds. That needs the drain + `soft_unbind` fix (capatina/Ozzy, branch `ginkomarchy`); older builds can wedge the mixer when X1 D. Four takes it over.
- Just after streaming, the 4D stalls SET_INTERFACE for a while. The hand-back switches both interfaces to alt 0 itself, retrying, before releasing them. Otherwise the kernel defers the switch to snd-usb-ozzy's probe, which then fails with -32.
- Bring-up follows `ploytec.c` exactly. Control transfers time out after 300 ms and retry, because the device drops the transfer that follows a cancelled URB.
- **Firmware 1.4.1 only:** PCM is on interrupt endpoints there.
- **Every OUT packet must be complete:** 80 frames, with 0xFD in all 16 MIDI bytes.

## Mapping Xone controls by prompt

Users ask for mappings in plain words ("make the left pod's first lit button play deck 2"). To make one:
1. Find the control in `config/controls.toml`. Names look like:
   - `left.lit1..4`, `right.lit1..4`
   - `left.button.A..L`, `right.button.M..X`
   - `left.encoderN` / `.push`, `left.upperN`, `left.lowerN`, `left.faderN`, `left.browse` / `.push`, `left.jog`, `left.jog.up/down/left/right`
   - `xfader`, `filter1.on`, `ch1.cue`
   - The shift layer prefixes `shift.`.
2. If you're unsure which physical control the user means (the jog switches and Map 1 vs Map 2 are unconfirmed), ask them to press it. Then read `curl -s localhost:7878/api/midi/recent | jq '.[-5:]'`: each entry has `raw`, the resolved `control` (null if it isn't in the catalog) and the `action` that fired. If the control is missing, add it to `controls.toml`.
3. Edit `config/mappings.toml` using the action vocabulary in its header comment.
4. Saving reloads the file. Check `curl -s localhost:7878/api/mappings | jq '{ok, error, count}'`; the UI's MIDI panel shows the same status.

Holding the left JOG/SELECT encoder (above the left jog wheel) for about half a second toggles the mixer's shift layer: the BPM display shows SFT and every control sends on channel 15 (`shift.*`). Unmapped shift controls look like "nothing works".

LED rings toggle on every Note On; the mixer has no absolute on/off. `led = "deck.playing"` etc. only works with the mixer's host-driven ring mode (third illuminated button unlit in the power-on map setup).
