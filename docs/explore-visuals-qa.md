# Earth Explore: verification

Verified on 5 October 2026, in `earth-visuals`, using the production bundle,
Chromium headless, and the local mock on **7979** (fresh empty/analysis fixtures
on **7981**). The Vite development check
used **5179** with `X1D4_SERVER=http://127.0.0.1:7979`. No Rust executable,
USB device, live mixer server, or other checkout was used.

## What changed

- `engine.ts`, `meshes.ts`: an open procedural valley, seeded terrain, river,
  worn branching paths, stone cairns for children and grandchildren, 44,000
  instanced grass blades, porous tree crowns, swallows and butterflies.
- Smoothed spectrum and per-deck energy drive wind. Accumulated music grows
  the vegetation and gradually changes daylight. Navigation preserves this
  accumulated growth, while band changes and dives change the landscape.
- `waveRender.ts`, `WaveStrip.svelte`: four overlaid riverbank contours and
  shallow reflections. The existing linear timing, clock interpolation,
  beat/bar grids, loop extents and focused fill are retained. Gradients,
  ordering storage and sample buffers are reused.
- `decks.ts`, `palette.ts`, `app.css`, Explore/HUD/search/minimap styling:
  mineral blue, ochre, limestone and heather decks; ochre/sage/blue bands.
  Deck numbers, luminance differences and solid/dashed/dotted/dash-dot strokes
  supplement colour. Labels expose full track details on hover as well.
- Reduced motion freezes camera flight, wind, water, cloud drift and animal
  movement; aim changes settle immediately. Growth and daylight remain slow.
  The functional waveform keeps its clock.
- `vite.config.ts`: optional `X1D4_SERVER` proxy override. Production protocol
  and Rust crates are unchanged. The obsolete tunnel bend helper is removed.

## Reproduce

From `ui`, start `bun mock/server.ts --port 7979 --tracks 120 --loop --section-seconds 0`.
Build with `bun run build`; the mock serves that production bundle directly.
For development, use `X1D4_SERVER=http://127.0.0.1:7979 bunx vite --port 5179 --strictPort`.

Launch a **dedicated** headless Chromium with a temporary profile and CDP:

```sh
VK_DRIVER_FILES=/usr/share/vulkan/icd.d/radeon_icd.json /usr/bin/chromium \
  --headless=new --no-sandbox --disable-dev-shm-usage --no-first-run \
  --no-default-browser-check --disable-background-networking \
  --disable-features=Vulkan --use-gl=angle --use-angle=vulkan \
  --remote-debugging-port=9239 --user-data-dir=/tmp/x1d4-earth-qa about:blank
```

Use `nvidia_icd.json` and a different profile/port for the RTX check. Driver
selection was verified through Chromium's reported ANGLE renderer; neither run
used SwiftShader. From the repo root, run `bun ui/scripts/earth-qa.ts`.
`CDP_PORT`, `EARTH_OUTPUT`, `EARTH_REPORT` and `EARTH_PROGRESS_SECONDS` override
the defaults; `EARTH_PERF_ONLY=1` runs only the performance checks. The harness
uses the mock exclusively and never starts or stops an app server. Close the
dedicated Chromium and stop the mock/Vite processes afterward.

## Coverage

- Six candidate labels at 1920×1080 and 1280×800; automated overlap and bounds
  checks. Title, artist, BPM and similarity remain readable.
- Aim, dive, upstream/back, three bands, load-selected onto deck 4, focus,
  play, loop length, sync/master/root badges, the mixer legend and status.
- Keyboard search and actual Chromium drag data dropped onto a deck. An open
  query is restored if re-rooting clears the server filter after a drop.
- A live reduced-motion preference change, without a reload.
- An uninterrupted three-minute playing/looping mix: screenshots before and
  after, and growth/light readings every 30 seconds.
- Bar-tick canvas coordinates checked for all four synced decks (≤1 px error).
- Browser exceptions, shader errors and unexpected external HTTP requests.
- Separate fresh-mock checks on 7981: `--empty` for the no-root prompt;
  `--tracks 120 --idle --analysis-seconds 12 --section-seconds 2` for progress
  and section changes after starting deck 1.

Measurements and screenshots are in `docs/screenshots/earth/`. The `world`
and `wave` times in the stats text are CPU work/submission times, not GPU time.
RAF sampling includes the complete page, with four decks and diagnostics on,
at native DPR 1 and adaptive resolution disabled. Headless refresh is capped
at 60 Hz; this does not establish the maximum FPS of the RTX display.

## Results

Each refresh sample contains 900 measured frames over 15 seconds after warm-up.
No sampled frame exceeded 25 ms. Both GPU identities were confirmed through
ANGLE/Vulkan, with hardware rasterization enabled.

| GPU / viewport / scene | FPS | Frame interval p95 | World GPU median / p95 |
| --- | ---: | ---: | ---: |
| AMD Ryzen 9 9950X integrated Radeon, 1920×1080 | 60.00 | 16.70 ms | 7.21 / 8.94 ms |
| AMD, 1280×800, four decks + loop | 60.00 | 16.70 ms | — |
| AMD, 1920×1080, after the three-minute soak | 60.00 | 16.80 ms | — |
| RTX 4090, 1920×1080 | 60.00 | 16.70 ms | 0.93 / 2.28 ms |
| RTX 4090, 3840×2160 | 60.00 | 16.80 ms | 3.88 / 3.92 ms |

GPU times use nonblocking `EXT_disjoint_timer_query_webgl2` queries across the
world's ten draw calls (59 completed queries per sample). The scene has about
237k triangles. At 1080p the measured CPU world work was 0.18–0.29 ms on AMD,
and waveform drawing about 0.34–0.49 ms. At 4K on RTX, these were 0.08 ms and
0.50 ms respectively. CPU and GPU times overlap; do not add them together.

The final AMD soak reached 77% growth and 18% evening light, with no navigation,
time jumps or page reloads during its three-minute before/after interval.
The extra RTX functional run confirmed that search keeps its query after a
drop causes a re-root. Fresh fixtures also confirmed the exact no-root prompt,
analysis progress (31/123) and candidates changing at section boundaries.

`bun run build` passed with **zero Svelte errors or warnings**; `bun run check`
passed, including the verification script. The complete uncompressed production
output is approximately **679 kB**, with **zero added image/model/font assets**.
Rust is unchanged, so no backend build or `cargo test` was needed.

There are no known functional blockers. Physical mixer/USB operation was
intentionally not exercised; the mappings and protocol were tested through the
mock. The headless 60 Hz results do not claim 120/144 Hz display verification.
