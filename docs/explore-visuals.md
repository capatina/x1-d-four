# Explore: the Wayfaring

Explore is a journey down a river through a mythic, Myst-like realm. Creative
direction is by **Fable** (the Wayfaring spec: concept, meaning map, motion
language, palette, type and taste guardrails). It is built on **Astra's** river
valley, which it keeps as its ground. The guardrail for every element is the
same: earthy, painterly and contemplative, never kitsch and never neon.

![The Lowmarch while travelling](screenshots/wayfaring/01-lowmarch-travel-1080.webp)

## The realm

You ride **the Current** in a vessel: only its bow shows, a dark crescent on
the water behind the Keepers. The river forks ahead toward **spires** on
floating shards of rock, and each spire is a track similar to the one you
stand on.

Each part of the realm stands for something in the music:

| In the realm | Means | Driven by |
|---|---|---|
| A spire (broch, needle or ruin) on a floating shard, a **gate** arc at its foot | a candidate track; its lit window band is its similarity | `explore.nodes` |
| Six **routes** (causeway, planks or pale slabs) from the river to the gates | current's children, in the server's order | `explore` |
| The **Wayfinder** lantern's beam, a lit ley line, a gate that closes and ignites | the aimed route; nothing moves to the front | `explore.aim` |
| Passing under the aimed gate into new country | loading the aimed track (a **commit**) | `reason: "commit"` |
| The same passage, with the land beyond misted | a **scout** (button M) | `reason: "dive"` |
| Small far spires scattered in the haze beyond each gate | grandchildren | `explore.nodes` |
| The **Lowmarch** (ochre moor), the **Greenwold** (old wood), the **Highreach** (pale fells) | the low, mid and high band | `explore.band` |
| Four hooded **Keepers** at the bow, lanterns in deck colours | decks 1–4 | `state.decks`, `viz.decks` |
| The Keeper with the staff and gem | the master deck | `master` |
| Lanterns swinging together or drifting apart | sync | the deck's grid and position |
| A rune ring turning on the water by a Keeper, once per loop | a loop | `loop.start/end` |
| Wind, ley flow, lantern light | energy | smoothed `viz.bands` |
| Dawn, day, dusk and night, as the land grows old | how long the mix has run | music time |
| A dragon you are not sure you saw, its shadow first | an earned drop | onsets and the low band |

Lore lives only in place names and captions. The legend still says aim, dive
and band.

## Finish

After Fable's first review of the build:

- **Spires.**
  - Each is 0.7–1.35 times the base height, from a hash of the track id.
  - The silhouette comes from the same hash: 45 % brochs, 30 % needles
    (radius 0.55, apex 8.6, no ledge) and 25 % ruins (top tier and cap gone,
    the second tier's top ragged, no window).
  - The window band sits at 50–75 % of the tower and is 0.25–0.5 units tall.
    Unaimed windows glow at 55 %; only the aimed one burns full.
  - Grandchildren stand 12–40 units beyond their child, x ± 4, and half of
    them are ruins.
- **Depth.** Spire fog is 0.005 near and 0.008 beyond z = −100, and ×1.6 on
  grandchildren. That makes three planes: the near land, the gates, and the
  far spires.
- **The sun** keeps to the right edge, in the top fifth of the frame, until
  dusk: never behind slot 0, and clear of slot 5's label even when it is
  aimed and grows upward. Its disc is soft (`smoothstep(0.018, 0.03)`) with a
  halo.
- **Near trees part ahead of the vessel.** Nearer than z = −26, no crown
  stands within x ± 46, so the gates' sightlines stay clear.
- **Gates.** An unaimed gate is a 1.5 px hairline in the haze at 18 % alpha:
  a 270° arc, open at the bottom where its route enters. Only the aimed gate
  closes, and its band of runes ignites.
- **Routes.** A lit route is 0.22 units wide, soft over its outer quarter,
  70 % alpha, coloured `mix(accent, haze, 0.3)`, with flow dashes at 40 %
  contrast.
- **The Wayfinder** is twice its first size, antialiased, in a warm halo three
  times its size at 0.2. Its reflection is a broken streak on the water, and
  it bobs ± 0.1.
- **Keepers.**
  - Slim cloaks at 1 : 3.2, drawn 100–115 px tall at 1080p.
  - Shoulders 19 px wide from head + 28, a hem of 22–26 px flaring only below
    head + 90, and a back-seam highlight.
  - Lanterns hang at shoulder height and lay a pool on the bank beyond the
    bow: radius 2, the deck's colour at 0.35.
  - The master's staff is 2.5 px with a crook, and its 6 px gem carries a
    reflection streak.
- **The dragon.**
  - It crosses at a distance over 14 s, from (130, 74, −140) through
    (20, 46, −230) toward (−260, 30, −300), mirrored at random. It never
    flies below y = 40, so it stays in the sky band behind every spire.
  - Scale 1.2, wingspan 7 × scale.
  - It is lighter than the cloud it crosses (`mix(haze, zenith, 0.55)`), with
    dithered coverage of 0.7 in the gaps and 0.4 in the cloud, and none
    behind cover.
  - Its body undulates two waves along its length (2.2 × scale). Each wing
    has four fingers with scallops half the chord deep, and a thumb crook.
  - The beat is fast down, slow up: `1 − 2·pow(fract(bar), 0.4)`.
  - Its shadow, a soft 18 × 9 ellipse at 0.22, leads the body by 2 s.
- **Shrine lanterns** light their own post and cap, at 0.6 of their former
  intensity.

## Travel

The camera never moves. The world streams toward it instead: one uniform,
`uCourse`, feeds every shader, and the river is re-centred under the vessel, so
the land swings sideways as the river bends.

- **Speed.** Travel is clocked to tempo, never to deck position: bars per
  second × (4.5 + 3 × smoothed energy) units per bar. Jogs and cues therefore
  never teleport the land.
- **Grass, trees, stones and wildlife** are wrap-around instances. Each one
  re-derives its place, size and variant from a hash of its index and wrap
  count, so nothing is allocated while travelling.
- **Waystones** pass the bow on each phrase downbeat (8 bars), with a larger
  one every 32 bars.
- **Stopping.** When nothing plays, the speed halves at once and then drifts
  to a stop. The realm keeps **vigil**: the wind falls to ambient, the ley
  lines stop flowing, the runes burn low and wisps rise.
- **New country.** A commit, scout, back, re-root or band switch reseeds the
  land from 40 units ahead (a two-seed wipe swept in from the horizon in
  300 ms). Realm furniture keeps the realm it spawned in, so a new realm's
  furniture arrives from the horizon while the colours crossfade in 180 ms.

## Instant, then flourish

The rule is that **state changes in the message frame, and flourish decays
from it.** Nothing eases toward a response; no transition lasts longer than
300 ms; every transition can be interrupted and restarts from the current
values.

- **Synchronous messages.** `explore` messages reach the engine in their own
  task. Label text, `data-kind`, the lit route, the gate, the beam, the
  minimap and the breadcrumb are all written before the next animation frame.
- **Label positions** are projected only on layout or resize. The slots are
  fixed and the camera is fixed.
- **Local input.** Keys, the wheel and clicks aim in the same event, and the
  server's echo reconciles.
- **A commit, frame by frame:**
  - The new fan and its labels are there at frame 0.
  - The heading swings toward the taken route (±22°, fastest at frame 0, level
    by 300 ms).
  - A stone arch sweeps over the camera. As it passes, at about 110 ms, the
    outer 12 % of the frame brightens in the realm's hot colour (at most
    20 %).
  - The course surges ×6.
  - The old labels slide out while the new ones rise 8 px; the label layer
    rides the swing.
  - All of this is CSS `translate` or `opacity` on the compositor, written
    once.
- **Loads from the mixer commit as well.** The server makes a
  `load_selected` of the aimed track the explorer's `current`, with
  `reason: "commit"` (see [protocol](protocol.md)).
- **The strip** snaps any position error above 25 ms and only eases clock
  jitter.

## Over a mix, and within a track

- **The ages.** Music time drives a monotonic age through Fable's light table:
  dawn, day, dusk, night and a second dawn. The land grows older:
  - day brings full waystones;
  - dusk brings stone circles and broken arches;
  - night brings stone bridges over the Current, lit shrine lanterns, stars
    and, late in a set, an aurora capped at 18 %.
- **Magic at night.** Ley lines and lanterns are brightest when the land is
  darkest, and the labels stay readable because they are DOM.
- **Breakdown.** The fog thickens, the ley flow slows and the lanterns carry
  the light.
- **Build-up.** The far dragon circles the horizon.
- **Drop.** A wave of light runs down the aimed ley line and a gust crosses
  the grass. If the drop is earned (3 minutes apart, once per track), the
  dragon flies over: its shadow crosses the land first, then the body comes
  down out of the haze. Wings beat once per bar.
- **Long blend.** Two synced decks playing together for 2 minutes merge their
  lantern pools.

## The Current (waveform strip)

The waveform is unchanged: the same per-band linear peaks at one scale for
the whole track, low, mid and high overlaid from the centre, and the same
timing, ticks, loop brackets and focused fill. Only its frame changed:

- The playhead is a thin staff with a gem in the realm's accent.
- A 6 % ley glow sits under the lead deck's envelope.
- Each deck's number badge carries its **sigil** (◆ ▲ ● ■), from the same rune
  atlas the gates and loop rings use. The sigils also appear on the HUD cards
  and the Keepers' lanterns.
- The lead deck's bands are 75 % (low), 60 % (mid) and 45 % (high) opaque,
  so the river shows through.
- Below the waterline, the reflection is tinted half way to the water.
- The sigils are 9 px, in deck colour.
- Loop brackets have 2 px arms, and an 8 px rune stands on the lower ruler at
  each end.

The deck colours are lapis, amber, moonstone and heather. Identity survives
colour-vision deficiencies through pattern, sigil, number and lightness.

## Reduced motion

With reduced motion:

- the course holds, and there is no heading swing, arch or flow;
- commits and scouts become a 150 ms crossfade of the ley lines and labels;
- wind, water, clouds, wildlife, lantern swing and rune rotation stop;
- an earned drop perches the dragon on a far crag for 20 seconds instead of a
  flyover;
- growth and the ages still change slowly.

## What came from Astra

Astra's valley is the ground this stands on:

- the terrain, water, grass, porous tree crowns, swallows and butterflies,
  rebuilt to stream;
- the shared-uniform ShaderMaterial pattern and the common GLSL;
- the sky, wind driven by smoothed audio, and growth over a mix;
- the DOM label pipeline, adaptive resolution, and no strobing or bloom;
- the strip's dead reckoning and linear timing;
- the QA harness, which became `ui/scripts/wayfaring-qa.ts`.

## Where it differs from the spec

- **Labels.**
  - They are `min(220px, 15.8vw)` wide rather than 16.5vw, so six fit side by
    side at 1280 px.
  - Slots span f = 0.09…0.91.
  - Neighbours are staggered 60 px.
  - Labels keep clear of the header boxes; the device chip now sits beside a
    minimap that shrinks on short screens.
- **The Wayfinder** floats about 43 units ahead, not 12: at 12 it would be
  hidden behind the waveform strip.
- **Gates** are rune rings hovering at the shard's tip, so passing hills
  never bury them.
- **The dragon's path** ends at y = 30 in the review, which conflicts with
  "never below y = 40". The flight is clamped at 40, so its last third
  levels out.
- **The vessel's bow** is not at a fixed z = 10–13, which lies behind the
  deck cards at 1080p (z = 10 projects to y ≈ 990). It is cast from the
  Keepers' screen rows onto the water instead: its far edge 28 % of the way
  up their figures, its near edge 12 % (about z = −12 to −9 at 1080p).
  There the river is only about ± 9 wide, so the tips meet at most 10 units
  either side (less where it narrows) and the banks hide them when the river
  bends. Keepers 2 and 3 stand at its ends; 1 and 4 stand on the banks, where
  their lantern pools fall.
- **Near trees** keep out of x ± 46 nearer than z = −26, not ± 26 at
  z > −20. The outer gates' sightlines pass x ± 26 at z = −10, so the
  narrower clearing parked crowns right on them.
- **The loop rune** stands on the lower ruler. "Above the ruler" at the top
  would be off the canvas.
- **Keepers' lanterns** swing on each deck's own beat grid, including the
  master's, rather than `viz.beat`. The mixer's MIDI clock isn't phase-locked
  to the master deck, and the grid keeps synced decks visibly together.
- **Waystones** are bar-locked: they ride the phrase grid, sliding slightly
  against the land only when the energy (and so the speed per bar) changes.
- **Bridges** keep a fixed size. Where the river widens toward the vessel,
  their piers stand in the water. Scaling them with the near river made
  black monoliths.
- **The render-on-message option** (spec §6, "optional, measure first") was
  measured and not taken. Chromium presents a canvas at the next frame either
  way, and the change is always in the very next frame (see QA).

See [verification and measurements](explore-visuals-qa.md) and the
[screenshots](screenshots/wayfaring/README.md).
