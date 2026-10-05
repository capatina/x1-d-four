# Explore: the Wayfaring

Explore is a journey down a river through a mythic, Myst-like realm. Creative
direction is by **Fable** (the Wayfaring spec: concept, meaning map, motion
language, palette, type and taste guardrails). It is built on **Astra's** river
valley, which it keeps as its ground. The guardrail for every element is the
same: earthy, painterly and contemplative, never kitsch and never neon.

![The Lowmarch while travelling](screenshots/wayfaring/01-lowmarch-travel-1080.webp)

## The realm

You ride **the Current** in a vessel you never see. The river forks ahead
toward **spires** on floating shards of rock, and each spire is a track similar
to the one you stand on.

Each part of the realm stands for something in the music:

| In the realm | Means | Driven by |
|---|---|---|
| A spire on a floating shard, a rune-ring **gate** at its foot | a candidate track; its lit window band is its similarity | `explore.nodes` |
| Six **routes** (causeway, planks or pale slabs) from the river to the gates | current's children, in the server's order | `explore` |
| The **Wayfinder** lantern's beam, a lit ley line, a ring that ignites | the aimed route; nothing moves to the front | `explore.aim` |
| Passing under the aimed gate into new country | loading the aimed track (a **commit**) | `reason: "commit"` |
| The same passage, with the land beyond misted | a **scout** (button M) | `reason: "dive"` |
| Small far spires in the haze beyond each gate | grandchildren | `explore.nodes` |
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
    vignette edge brightens in the realm's hot colour.
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
- Loop brackets end in rune ticks.

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
