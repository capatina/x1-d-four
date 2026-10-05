# xone-deck

A local, browser-controlled 4-deck player for the Allen & Heath Xone:4D, with its own userspace USB driver written in Rust.

- **Audio path:** each deck plays into one of the mixer's USB channels (decks 1-4 go to channels 1-4 with the source on SC). Audio is rendered straight into the USB packets, with about 5 ms of output latency at the default 3 packets in flight.
- **Hardware controls:** the Xone's buttons and encoders are mapped in `config/mappings.toml`, which reloads on save. The controls are named in `config/controls.toml`.
- **UI:** at http://127.0.0.1:7878. The browser is only a control surface; audio never goes through it.

Setup, running and the hardware rules are in [CLAUDE.md](CLAUDE.md). The wire protocol is in [docs/protocol.md](docs/protocol.md).
