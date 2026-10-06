# Explore: the Datastream

Explore is a fast flight over an endless neon grid, in the style of the German
demoscene: black, crisp neon lines, wireframe solids, copper bars, a chrome
sine scroller, bloom and hard flashes on the beat. The visuals are the track
browser: the paths ahead are the tracks most similar to where you are.

![Aiming sprouts the paths beyond a gate](screenshots/datastream/02-aim-sprouts-paths-1080.webp)

## What each element means

| On screen | Means | Driven by |
|---|---|---|
| The trunk under the camera, splitting ahead | where you stand (`current`) | `explore.current` |
| A light rail from the split to a spinning wireframe gate | a candidate track; the gate's size and brightness show its similarity | `explore.nodes` (children) |
| A lit rail, a head of light running down it, a light column over its gate | the aimed track | `explore.aim` |
| Small rails and gates sprouting from the aimed gate | the aimed track's own similar tracks (grandchildren) | `explore.nodes` |
| Flying down the branch and through its gate | loading the aimed track (a **commit**) | `reason: "commit"` |
| The same flight, then a desaturated picture with grain | a **scout** (button M); it clears when a load claims the track | `reason: "dive"` |
| Flying back down the trunk | going back up the path | `reason: "back"` |
| A tear across the frame | a new root, band or re-shuffle (a **cut**) | other reasons |
| The grid's colour: magenta, acid green or cyan | the low, mid or high band (Sector Sub, Chord, Air) | `explore.band` |
| A copper bar in the sky and a laser rising from the deck's card | decks 1–4, by level; they bounce on the deck's own beat, so synced decks move together | `state.decks`, `viz.decks` |
| A ring racing out over the grid | each beat of the master deck | the master's grid |
| A white flash, a shock wave and a surge of speed | a drop after a breakdown (low band under 0.25 for 8 s, then above 0.6) | smoothed `viz.bands` |
| The scroller | where you are, how many paths lie ahead, the sector | `explore`, the library |

## Travel

The world is built in the frame of the current fan, with the camera resting at
its origin looking down −z.

- **Speed.** Travel is clocked to tempo, never to deck position: beats per
  second × (14 + 16 × smoothed energy) units per beat, ×2.5 just after a drop.
  At 126 BPM that is 30–60 units a second. The grid streams under the camera,
  speed streaks lengthen with speed, and light packets race down the rails a
  little faster than you travel.
- **Stopping.** When nothing plays, the speed halves at once and then drifts to
  a stop; the colours dim and the packets slow.
- **The flight.** On a commit or scout, the new fan is built at once in a frame
  that stands on the taken gate and faces along the branch. The camera flies
  down the trunk and the branch (720 ms, ease in and out), dips through the
  gate, and settles onto the new fan's line of sight. The old fan fades behind
  it. On arrival the world is rebased so that the new fan's frame is the world
  again; the grid's rotation and offset absorb the move, so the grid never
  jumps. A message during a flight lands it at once first.

## Instant, then flourish

State changes in the message frame, and flourish decays from it.

- Label text, `data-kind`, the lit rail and the gate are written before the
  next animation frame. Keys, the wheel and clicks aim in the same event, and
  the server's echo reconciles.
- Aiming: the branch is lit at frame 0, a head of light runs down it in
  160 ms, and the gate's own paths sprout over 220 ms after 60 ms. The
  previous aim decays in 140 ms and its paths shrink back to stubs.
- Band colours settle in 180 ms. A cut tears the frame for 220 ms.
- Label positions are projected only on layout or resize, from the resting
  camera, so they never move during travel.

## Rendering

One forward pass into a 4× MSAA half-float target: the sky (a sphere that
follows the camera), the floor (a plane that follows the camera, with the grid
computed in the shader), the two fans (rails as flat strips with a slot
attribute, gates as barycentric wireframes) and the streaks. Then a bright
pass at ¼ resolution, two blur passes at ¼ and two at ⅛, and the composite:
bloom, deck lasers, chromatic aberration, mist, flashes, ACES tone mapping,
scanlines and a vignette. The frame loop allocates nothing.

With `prefers-reduced-motion`, there is no travel, flight, flash, tear or
aberration; changes are instant.

## QA

With `?qa`, `window.__datastream` freezes and steps the clock (CSS animations
with it), records message-to-frame timings, reads GPU timer queries and can
force a drop. `?stats` shows fps, draw calls, frame times, course and speed.
