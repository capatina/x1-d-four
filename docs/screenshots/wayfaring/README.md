# The Wayfaring: screenshots

All captured by `ui/scripts/wayfaring-qa.ts` from the production bundle against
the mock (four synced decks playing), in a dedicated headless Chromium on the
AMD Radeon iGPU (ANGLE/Vulkan). Sequences come from the frozen, stepped QA
clock, so their frame timings are exact. See
[the design notes](../../explore-visuals.md) and
[verification](../../explore-visuals-qa.md).

## Travelling

| | |
|---|---|
| ![](01-lowmarch-travel-1080.webp) | ![](02-lowmarch-travel-later-1080.webp) |
| The Lowmarch while four decks play: six routes to six spires, the aimed one lit, the Wayfinder's beam, the Keepers at the bow. | Four seconds later, the land has streamed toward the vessel; spires, gates and labels hold station. |

![](03-aim-cycling-1080.webp)

After three turns of the aim, only the lit route, ring, beam and label have
moved on. The harness checks that every label keeps its place and size; the
aimed one only grows upward.

## A commit from the mixer, frame by frame

`load_selected` (left lit 3) loads the aimed track, and the server answers
with `reason: "commit"`. The new fan and its labels are there at 0 ms, the
heading swings toward the taken route, and a stone arch passes over the camera
(at about 110 ms the vignette edge brightens). Everything is settled by 300 ms.

| | | |
|---|---|---|
| ![](04-commit-000ms.webp) 0 ms | ![](04-commit-060ms.webp) 60 ms | ![](04-commit-110ms.webp) 110 ms |
| ![](04-commit-160ms.webp) 160 ms | ![](04-commit-230ms.webp) 230 ms | ![](04-commit-300ms.webp) 300 ms |

## Scouting, realms, loops, vigil

| | |
|---|---|
| ![](05-scout-1080.webp) | ![](06-greenwold-1080.webp) |
| A scout (M): the breadcrumb says "scouting · 1 ahead", the land beyond is misted and the ley lines dim until a load claims it. | The Greenwold (mid band). |
| ![](07-highreach-800.webp) | ![](08-loop-800.webp) |
| The Highreach (high band) at 1280×800. | Loops at 1280×800: a rune ring turns by each looping Keeper, and the HUD keeps the length. |
| ![](09-search-drag-800.webp) | ![](10-vigil-1080.webp) |
| Search by typing anywhere; a result dragged onto deck 4. | Vigil: nothing playing, travel drifted to a stop, runes burning low. |

## The ages of a mix

| | |
|---|---|
| ![](11-age-dawn-1080.webp) | ![](11-age-day-1080.webp) |
| Dawn: fewer stones. | Day: waystones and standing stones. |
| ![](11-age-dusk-1080.webp) | ![](11-age-night-1080.webp) |
| Dusk: broken arches, stone circles, shrine posts. | Night: a stone bridge over the Current, lit shrines, stars, the aurora, the brightest ley lines. |

## The dragon

| | |
|---|---|
| ![](12-dragon-shadow-1080.webp) | ![](13-dragon-flyover-1080.webp) |
| An earned drop (forced through the QA hook): its shadow crosses the land first. | Then the body comes down out of the haze, wings beating once per bar. |
| ![](14-dragon-far-1080.webp) | ![](15-reduced-perch-800.webp) |
| A build-up: the far dragon circles the horizon. | Reduced motion: no flyover; the dragon perches on a far crag. |

## The Current

![](16-current-strip-1080.webp)

The waveform strip itself is unchanged (a faithful 3-band DJ waveform at one
scale per track). Around it: the staff playhead with its gem in the realm's
accent, a faint ley glow under the lead deck, the deck sigils ◆ ▲ ● ■ beside
the badges and on the HUD cards, and rune ticks on the loop brackets.

## Before the journey

| | |
|---|---|
| ![](17-empty-800.webp) | ![](18-analysis-800.webp) |
| An empty library: the prompt to load a track onto the focused deck. | A library still being analysed: progress in the header while routes appear. |

## Measurements

- `verification.json`: every check, the latency records and the measurements from the AMD run, including the 3-minute soak.
- `performance-rtx4090-*.json`: the RTX 4090, paced at 60 Hz and uncapped (for 144 Hz).
- `performance-amd-dev-server.json`: frame-loop allocations, sampled on the unminified dev build.

