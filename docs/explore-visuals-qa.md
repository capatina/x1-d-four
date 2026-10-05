# The Wayfaring: verification

Verified on 5 October 2026 on the `earth-visuals` branch. The checks used the
production bundle, dedicated headless Chromium instances and the local mock
on **7979**, with fresh empty and analysis fixtures on **7981** and **7982**.
The Vite development check used **5179** with
`X1D4_SERVER=http://127.0.0.1:7979`. No Rust executable, USB device, live mixer
server or other checkout was used.

## Reproduce

From `ui`:

1. Build with `bun run build`. The mock serves that bundle directly.
2. Start the mock:

   ```sh
   bun mock/server.ts --port 7979 --tracks 120 --loop --section-seconds 0
   ```

3. Launch a **dedicated** headless Chromium with its own profile and CDP port.
   Choose the GPU with `VK_DRIVER_FILES`:

   ```sh
   VK_DRIVER_FILES=/usr/share/vulkan/icd.d/radeon_icd.json /usr/bin/chromium \
     --headless=new --no-sandbox --disable-dev-shm-usage --no-first-run \
     --no-default-browser-check --disable-background-networking \
     --disable-features=Vulkan --use-gl=angle --use-angle=vulkan \
     --remote-debugging-port=9239 --user-data-dir=/tmp/x1d4-wayfaring-amd about:blank
   ```

   - For the RTX 4090, use `nvidia_icd.json`, port 9240 and its own profile.
   - For the 144 Hz check, add `--disable-gpu-vsync --disable-frame-rate-limit`.
     Headless Chromium otherwise paces `requestAnimationFrame` at 60 Hz, so the
     uncapped frame intervals show what the scene could sustain at 144 Hz.

4. From the repo root, run `bun ui/scripts/wayfaring-qa.ts`.

The harness takes these options:

| Variable | Default | What it does |
|---|---|---|
| `CDP_PORT` | 9239 | Chromium's debugging port |
| `WAYFARING_PERF_ONLY=1` | off | Second-GPU run: pacing, GPU, CPU and allocations at 1080p and 1440p |
| `WAYFARING_LABEL` | | Names the performance report |
| `WAYFARING_SOAK_SECONDS` | 180 | Length of the continuous mix before the last measurement |
| `WAYFARING_PAGE` | the mock | Page origin; the Vite server gives readable allocation profiles |
| `WAYFARING_EMPTY` | | Origin of a fresh `--empty` mock (no-root prompt) |
| `WAYFARING_ANALYSIS` | | Origin of a fresh `--idle --analysis-seconds 12` mock (analysis progress) |

The harness never starts or stops a server. Close the Chromium instances and
the mock or Vite processes when you are done.

### The `?qa` hook

`?qa` exposes `window.__wayfaring` and is off otherwise:

- `freeze()`, `advance(ms)` and `resume()` drive a frozen engine clock. The
  page's CSS and WAAPI animations step with it, so frame sequences are exact.
- `records` holds, for every `explore` message or local aim, its arrival
  time, the handler's end, and the first animation frame. That frame checks
  that the aimed label (and its title text) and the lit route and gate are
  already there.
- `gpu` holds samples from `EXT_disjoint_timer_query_webgl2`, and
  `cpuSamples()` the per-frame CPU of the world. `window.__waveCpu` holds the
  strip's per-frame CPU.
- `setMinutes(m)` jumps to an age.
- `dragon('far' | 'flyover' | 'perch' | 'drop', seed?)` forces the dragon. A
  seed (0…1) fixes its side for repeatable captures.

## Coverage

Each run checks:

- **Budget:** 18 draw calls or fewer and 270k triangles or fewer. The GPU
  must be hardware, not SwiftShader.
- **Labels:** six at 1920×1080 and 1280×800 (also with a loop), each with
  title, artist, BPM and similarity, clear of each other and of the footer.
- **Travel:** the course advances on its own while the decks play.
- **Aim:** three aim steps. Every label keeps its place and size (the aimed
  one only grows upward), and no spire or gate moves.
- **Latency:** message (or key) to the first animation frame, for:
  - 20 key aims;
  - 40 server aims;
  - 6 band switches;
  - 6 commits from a mixer-style `load_selected`, and 6 backs.

  Every sample must have its label text and lit route in that first frame.
- **Commit sequence:** at 0, 60, 110, 160, 230 and 300 ms.
- **Scouting:** the breadcrumb and the mist, then a load that claims the
  route.
- **Realms:** the Greenwold and the Highreach by name.
- **Loop:** the loop and its length on deck 2.
- **Search and drag:** search by typing anywhere; a real Chromium drag onto
  deck 4; the search keeps its filter.
- **Vigil:** after stopping, travel drifts to a stop.
- **Ages:** dawn, day, dusk and night, with a close-up of the Keepers at
  night.
- **Dragon:** shadow, flyover and far form.
- **Reduced motion:** switched on live; the course holds, the heading never
  swings, and an earned drop perches the dragon.
- **The strip:** synced bar ticks still align within one CSS pixel.
- **Health:** no browser errors and no external network requests.
- **Measurements:** frame pacing, GPU time, per-frame CPU (world and strip)
  and frame-loop allocations, then a soak.

## Results

All 32 checks passed on the final build. GPUs were confirmed through Chromium's
ANGLE renderer string, with no software rasterizer:

- AMD Ryzen 9 9950X integrated Radeon (RADV);
- NVIDIA RTX 4090.

### Latency: message (or key) to the frame that shows it

Every sample had its label text and lit route (and gate) in the **first**
animation frame after the message.

| Input | Samples | Handler (p50 / max) | To first frame (p50 / p95 / max) | First frame complete |
|---|---:|---:|---:|---:|
| Aim from a key (local) | 20 | 0.0 / 0.0 ms | 9.2 / 15.6 / 15.6 ms | 20/20 |
| Aim from the server (encoder) | 40 | 0.5 / 1.4 ms | 15.3 / 15.9 / 15.9 ms | 40/40 |
| Band switch | 6 | 1.8 / 2.8 ms | 16.5 / 18.4 / 18.4 ms | 6/6 |
| Commit from a mixer-style `load_selected` | 6 | 1.8 / 3.1 ms | 11.7 / 16.1 / 16.1 ms | 6/6 |
| Back | 6 | 1.5 / 2.4 ms | 9.9 / 16.2 / 16.2 ms | 6/6 |

How to read this table:

- The **handler** is the synchronous work in the message task: labels, aim,
  slots, routes and the passage start.
- The **rest** is waiting for the next display frame, which headless Chromium
  paces at 60 Hz (16.7 ms). Messages that arrive just after a frame wait
  almost a whole one; that is why server aims cluster near 15 ms.
- Every first frame's rAF timestamp fell within one display period of the
  message (at most 15.3 ms here). A rAF callback can run a little after its
  timestamp, which is why the band switch's p95 reads 18.4 ms. Photons follow one display frame later:
  ≤ 7 ms at 144 Hz, ≤ 17 ms at 60 Hz.
- The spec's optional "render immediately" was not added. Chromium presents
  a WebGL canvas at the next frame either way, so it can't make the change
  visible sooner.
- **Commit sequence:** at 0, 60, 110, 160, 230 and 300 ms (screenshots). The
  new fan is present at 0 ms and everything is settled by 300 ms.

### Frame time

The final AMD run used the production bundle, four decks and diagnostics,
DPR 1 and no adaptive resolution, on a quiet machine (load average about 2).

| GPU / viewport | FPS | Frame interval p99 | GPU p50 / p95 / p99 | World CPU p50 / p99 | Strip CPU p50 / p99 |
|---|---:|---:|---:|---:|---:|
| AMD, 1920×1080 | 60 | 16.8 ms | 7.6 / 8.1 / 9.0 ms | 0.1 / 0.3 ms | 0.3 / 0.5 ms |
| AMD, 1920×1080, after a 3-minute soak | 60 | 16.8 ms | 8.0 / 8.5 / 8.7 ms | 0.1 / 0.2 ms | 0.3 / 0.5 ms |
| AMD, 1280×800, four loops | 60 | 16.8 ms | 4.2 / 4.4 / 4.4 ms | 0.1 / 0.3 ms | 0.3 / 0.4 ms |
| RTX 4090, 1920×1080, uncapped | 883 | 5.7 ms | 0.15 / 0.16 / 0.17 ms | 0.0 / 0.2 ms | 0.3 / 0.5 ms |
| RTX 4090, 2560×1440, uncapped | 735 | 5.7 ms | 0.21 / 0.30 / 0.50 ms | 0.0 / 0.2 ms | 0.3 / 0.5 ms |
| RTX 4090, 1920×1080, uncapped, after 60 s | 775 | 6.3 ms | 0.18 / 0.19 / 0.39 ms | 0.1 / 0.2 ms | 0.3 / 0.5 ms |

- **Fable's first review cost no GPU time.** An A/B on the AMD GPU at 1080p,
  alternating this build with the previous commit's, measured 7.61 against
  7.65 ms (median of eight 3-second medians each). The earlier 6.7 ms figure
  came from a different GPU clock state, not from a lighter scene.
- **Budget.** The scene is 15 draw calls (16 while the dragon flies) and 243k
  triangles. The budget is 18 calls and 270k triangles.
- **Pacing.** No sampled frame on either GPU took longer than 25 ms.
- **The 4090 at 144 Hz.** Uncapped at 1080p, 99 % of frame intervals were
  within 5.7 ms (6.3 ms after a minute), under the 6.9 ms a 144 Hz display
  allows; the GPU itself needs 0.15 ms.
  - At 60 Hz pacing the 4090 sits in a low power state. There its timer
    queries read 4.4 ms, which is clock speed, not work.
  - The uncapped tail (p95 4.0 ms) comes from the browser's other
    main-thread work (WebSocket messages at 180/s, the HUD), not the scene.
- **The AMD GPU budget** (spec: ≤ 10 ms at 1080p) holds at p50, p95 and
  p99. Three changes brought it back under budget, from 12.2 ms:
  - the sky draws last, on the far plane;
  - colour noise comes from a baked, mipmapped texture;
  - the land is drawn front to back.

### Allocations in the frame loop

Measured with Chromium's sampling heap profiler, counting garbage too, on the
unminified dev build (`performance-amd-dev-server.json`).

**Our frame code creates no objects, arrays, closures or strings.** Three
changes got it there:

- The scalar and vector uniforms are packed into one typed `vec4 uFrame[27]`.
  Three.js previously boxed each scalar upload.
- Three's per-frame render-list sort is off. The scene is added in draw
  order, and the sort allocated every frame.
- The strip's per-frame strings and iterators became constants and index
  loops.

Together these cut sampled frame-loop allocation from about 425 KB/s to about
110 KB/s (re-measured after Fable's first review):

| Where | Before | After |
|---|---:|---:|
| Engine frame loop (with three.js) | ~250 KB/s | ~52 KB/s |
| Strip | ~190 KB/s | ~58 KB/s |

What remains:

- **Boxed doubles** at the WebGL and Canvas bindings.
- **Three.js's frustum and projection code**, about 23 KB/s, inside
  `WebGLRenderer.render`.

The young-generation collector absorbs this; no frame in the soaks exceeded
25 ms. An A/B on the AMD GPU found no GPU cost from the uniform packing:
7.55–7.67 ms packed, 7.58–7.78 ms unpacked.

### Rust

`cargo test` passes, including the new
`exploring::tests::load_selected_commits_to_the_aimed_route`.
