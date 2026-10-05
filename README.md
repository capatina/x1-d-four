# X1 D. Four

**DJ decks and a music visualizer in one, for the Allen & Heath Xone:4D.** Four decks play straight into the mixer's channels through X1 D. Four's own Rust USB driver at 5 ms latency, and the screen that runs your mix turns your library into a mythic realm you travel through as you play. The visuals are the track browser: you pick the next track by choosing a path, and the world answers the music and the mixer's own controls.

*Unofficial: not affiliated with or endorsed by Allen & Heath.*

![X1 D. Four Explore: the Wayfaring](docs/screenshots/wayfaring/01-lowmarch-travel-1080.webp)

The Xone:4D's built-in soundcard only has drivers for Windows and macOS. X1 D. Four talks to its Ploytec USB chip directly through Linux usbfs: no kernel module, no ALSA, no PipeWire, no libusb. It renders each deck straight into the USB packets on a real-time thread, and the mixer's own knobs and buttons drive both the decks and the visuals.

## What you get

### Mix

- **4 decks → 4 channels.** Deck *n* plays into USB pair *n*, and each mixer channel set to **SC (USB)** plays its deck. All the mixing (faders, EQ, filters, FX, cueing) stays on the mixer's analog hardware.
- **5 ms output latency.** Each packet carries 80 frames (1.67 ms at 48 kHz), and 3 packets are in flight by default (`--urbs 2` gives 3.3 ms). The driver's output matches the packets of the reverse-engineered kernel driver byte for byte.
- **Decks:** beat sync phase-locked to the master deck, loops from ½ beat to 32 bars (8 bars by default), a jog that jumps through a track and speeds up as you spin, a fine shift to fix a sync by ear, varispeed from the pitch faders, and click-free starts and stops. Every track gets a beat grid when it loads.
- **Library:** everything in `~/Music`. Type anywhere to search, then load from the mixer or drag a result onto a deck. Plays MP3, FLAC, WAV, AIFF, AAC/ALAC and Vorbis.
- **The mixer's MIDI controls**: buttons, encoders, faders and jog wheels, mapped in a TOML file that reloads on save, with LED feedback on the lit buttons. The on-screen legend shows what each control does, and `/api/midi/recent` names every control as you touch it.
- **Readout of the mixer's own MIDI clock BPM.**

### Visualize

- **A realm built from your library** (below): tracks similar to what's playing become routes ahead of you, in the band you choose. Wind, light and lanterns follow the music; the journey travels with the tempo and ages from dawn to night over a set.
- **Faithful 3-band waveforms** of all four decks on one timeline: kicks stand out as low peaks, breakdowns drop, and synced decks' beats line up.
- **Instant:** every mixer move shows in the next frame, and the scene runs at 60 fps on integrated graphics.

## Explore: the Wayfaring

The main screen is a journey down a river through a mythic realm, and it travels while you play.
- Every track is analysed in three bands, like the mixer's EQ: **low** (kick, bass, groove), **mid** (harmony, key) and **high** (hats, percussion, air). Each band is a realm: the Lowmarch, the Greenwold, the Highreach.
- The river forks ahead toward spires on floating shards: the tracks most similar to where you stand. Aiming lights a route and its gate; nothing jumps to the front.
- Loading the aimed track takes its route: you pass under its gate into that track's country. Diving (M) scouts ahead without a deck, and the land stays misted until a load claims it.
- Four Keepers at the bow carry the decks' lanterns, swinging on the beat. Over a long set the land ages from dawn to night, with bridges and lit shrines; an earned drop may bring a dragon. The deck waveforms run along the bottom as one faithful 3-band strip.
- Every response appears in the next frame; flourishes take at most 300 ms.
- Analysing a 2,300-track library takes about a minute on a desktop CPU; after that it's instant from a cache.

It's played entirely from the mixer:

| | Left pod | Right pod |
|---|---|---|
| Lit buttons 1–4 | load the aimed track onto deck 1–4 (and take its route) | play/pause deck 1–4 |
| Jog wheel | move through the focused deck: turn slowly for precision, spin to fly (a synced deck moves in whole beats) | shift the focused deck to fix its sync (it keeps the offset) |
| JOG/SELECT | focus deck 1–4 (the realm grows from it); push to start from the search selection | aim between routes; push to reset the focused deck's sync |
| Buttons | A low, B mid, C high band; E follow the focused deck on/off | M scout down the aimed route |
| Encoders 1–4 | push = 8-bar loop on deck 1–4; turn = loop length | skip ±2 s; push = sync |
| Faders 1–4 | pitch ±8 % | |

The crossfader picks the band: left low, middle mid, right high. It only sends MIDI with **XFADE CURVE** turned fully left.

## Map controls by talking to your agent

Every control on the mixer has a name in [`config/controls.toml`](config/controls.toml) (`left.jog`, `right.lit1`, `left.fader3`…). Mappings are plain TOML:

```toml
[[map]]
control = "right.lit1"
action = "deck.play_pause"
deck = 1
led = "deck.playing"
```

The repo ships a [`CLAUDE.md`](CLAUDE.md), so you can ask an AI coding agent for things like *"make the left jog wheel scroll the library"*. It finds the control, edits the file, and the app picks up the change while it plays.

## Requirements

- Linux (tested on Arch, kernel 7.2) and an **Allen & Heath Xone:4D on audio firmware 1.4.1**.
  - Earlier firmware uses different USB endpoints and isn't supported.
  - A&H's firmware updater runs on Windows; a VM with USB passthrough works.
- Rust 1.85 or newer, and [bun](https://bun.sh) for the UI.

## Quick start

```sh
git clone https://github.com/capatina/x1-d-four && cd x1-d-four
setup/install                              # udev rule: lets your user open the mixer (asks for your password once)
(cd ui && bun install && bun run build)
cargo build --release
target/release/x1-d-four --open             # or open http://127.0.0.1:7878 yourself
```

Set each channel's source switch on the mixer to **SC**. Type to search, or aim a route in the realm with the right JOG/SELECT knob, then load it onto a deck with the left lit buttons 1–4; the right lit buttons play/pause decks 1–4. The full layout is in the table above.

Other commands:
- `x1-d-four probe --pair 2`: plays a test tone into USB pair 2.
- `x1-d-four serve --no-device`: runs the UI without hardware.
- `x1-d-four release`: hands the mixer back to the kernel driver after a crash.

### Rings that follow the decks

Rings that light while a deck plays need the mixer's host-driven ring mode, set once on the mixer:
1. Hold the push-knob above the left jog wheel (**JOG/SELECT**) and press the right one. The lit buttons now show the MIDI channel.
2. Press the left JOG/SELECT once.
3. Make sure the 2nd lit button is on (Map 2) and the 3rd is **off**.
4. Press the left JOG/SELECT again to save.

A long press on the left JOG/SELECT toggles the shift layer (**SFT** on the display), and the shift layer has its own mappings.

## With the Ozzy kernel driver

You don't need a kernel driver at all. If you also use [Ozzy](https://github.com/mischa85/Ozzy) (`snd-usb-ozzy`) for desktop audio, X1 D. Four takes the mixer from it on start and gives it back on exit. Use a build with the unbind drain fix from [capatina/Ozzy@ginkomarchy](https://github.com/capatina/Ozzy/commits/ginkomarchy); an older build cuts its stream mid-packet when it lets go, and the 4D then needs a power cycle.

## How it works

```
 Xone:4D ──USB──▶ /dev/bus/usb/BBB/DDD (usbfs: SUBMITURB / REAPURB / CONTROL / CLEAR_HALT)
                    │
          RT thread │ reap any URB:
                    │   EP 0x05 OUT  render 80 frames of 4 decks → 3856-byte packet (+1 MIDI byte) → resubmit
                    │   EP 0x86 IN   recycle (8 record channels)
                    │   EP 0x83 IN   MIDI from the mixer's controls
                    ▼
     lock-free queues ◀──▶ control side: mappings, library, track decoding, axum HTTP + WebSocket
                                                                     ▲
                                                           browser UI (Svelte)
```

Everything runs on one real-time thread and one file descriptor, with no event loop in between. The protocol details, and the rules that keep the 4D from locking up, are in [`CLAUDE.md`](CLAUDE.md). The browser↔server protocol is in [`docs/protocol.md`](docs/protocol.md).

| Crate / folder | What |
|---|---|
| `crates/ploytec` | the driver: usbfs ioctls, bring-up, packet codec, MIDI |
| `crates/engine` | decks, track decoding (symphonia + rubato), the real-time renderer |
| `crates/app` | the `x1-d-four` binary: server, library, control catalog, mappings |
| `ui/` | Svelte 5 + Vite, embedded in the binary |

## Credits

- **[Ozzy](https://github.com/mischa85/Ozzy)** by Marcel Bierling reverse-engineered the Ploytec protocol; the codec and bring-up sequence are ported from it.
- The control catalog follows Allen & Heath's Xone:4D user guide (AP7265 issue 3).

Not affiliated with or endorsed by Allen & Heath. "Xone" is their trademark. Use at your own risk: a misbehaving USB stream can lock up the mixer's audio until you power-cycle it.

## License

[MIT](LICENSE)
