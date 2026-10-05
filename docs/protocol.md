# Browser ↔ server protocol

The server listens on `http://127.0.0.1:7878`. The UI is served from `/`, and live traffic goes over one WebSocket at `/ws`. Every message is a JSON object.

Decks are numbered `0..3` on the wire. Deck `n` plays into USB pair `2n+1/2n+2`, which feeds mixer channel `n+1`. Show them to people as decks 1–4.

## HTTP

| Method | Path | Returns |
|---|---|---|
| GET | `/api/library` | `Track[]` (below), sorted by artist then title |
| POST | `/api/library/rescan` | `{ "tracks": n }` once the rescan is done |
| GET | `/api/state` | the latest `state` message |
| GET | `/api/decks` | `DeckLoaded[]` for every loaded deck (same shape as the WS message) |
| GET | `/api/midi/recent` | the last 200 `midi` messages, oldest first |
| GET | `/api/controls` | the control catalog: `{ name, kind, midi, led }[]` |
| GET | `/api/mappings` | `{ ok, error, path, mappings: [...] }` |
| POST | `/api/command` | takes any client command below as its body; returns `{ ok, error? }` |

```ts
type Track = {
  id: string;          // path relative to the music folder; stable across rescans
  title: string;       // falls back to the file name
  artist: string | null;
  album: string | null;
  bpm: number | null;  // from tags only
  duration: number | null; // seconds, from tags
};
```

## Server → client

**`state`** is sent about 30 times a second:
```ts
{
  type: "state",
  decks: Array<{
    track_id: string | null,
    loading: boolean,      // a track is being decoded for this deck
    playing: boolean,
    position: number,      // seconds
    length: number,        // seconds
    rate: number,          // 1.0 = normal speed (varispeed: pitch follows)
    cue: number,           // seconds
    trim: number,          // linear gain, 1.0 = unity
  }>,
  focused: number,         // deck that "load selected" targets
  device: {
    state: "connecting" | "running" | "stalled" | "missing" | "error",
    message: string | null,  // human-readable detail for anything but running
    firmware: string | null,
    out_urbs: number,
    latency_ms: number,      // out_urbs × 80 frames / 48 kHz
    packets_out: number,
    underruns: number,       // times the OUT queue ran dry (should stay 0)
    urb_errors: number,
    min_queued: number | null,  // min OUT URBs still queued in the last second
    max_gap_us: number | null,  // max gap between OUT completions in the last second
  },
  bpm: number | null,      // from the mixer's MIDI clock (its BPM display)
}
```

**`browser`** is sent on connect and whenever the search or selection changes:
```ts
{ type: "browser", query: string, ids: string[], selected: string | null }
```
`ids` is the filtered, ordered track list for `query`. The server owns the selection, so the mixer's encoder and the UI agree on it.

**`deck_loaded`** is sent on connect for every loaded deck, and after each load:
```ts
{ type: "deck_loaded", deck: number, track: Track, length: number, peaks: number[] /* 1024 values 0..255 */ }
```

**`deck_ejected`**: `{ type: "deck_ejected", deck: number }`

**`midi`** is sent for every incoming message except clock:
```ts
{
  type: "midi",
  t: number,                 // ms since server start
  raw: string,               // e.g. "9F 26 7F"
  desc: string,              // e.g. "note on ch16 38 vel 127"
  control: string | null,    // catalog name, e.g. "left.lit1"; null if unknown
  event: "press" | "release" | "value" | "delta" | null,
  value: number | null,      // 0..127 for value, ±n for delta
  action: string | null,     // mapping that fired, e.g. "deck.play_pause deck=1"
}
```

**`mappings`** is sent on connect and after every reload of `mappings.toml`:
```ts
{ type: "mappings", ok: boolean, error: string | null, count: number, path: string }
```

**`library_changed`**: `{ type: "library_changed", tracks: number }`. The client should refetch `/api/library`.

**`error`**: `{ type: "error", message: string }`. Something the user should see, such as a track failing to load.

## Client → server (WS or `POST /api/command`)

```ts
{ cmd: "load", deck: number, track_id: string }
{ cmd: "load_selected", deck?: number }          // defaults to the focused deck
{ cmd: "eject", deck: number }
{ cmd: "play" | "pause" | "play_pause", deck: number }
{ cmd: "cue", deck: number, pressed: boolean }    // send true on pointer down, false on pointer up
{ cmd: "seek", deck: number, fraction: number }   // 0..1 of the track
{ cmd: "nudge", deck: number, seconds: number }   // relative jump, ±
{ cmd: "rate", deck: number, rate: number }       // 0.5..2.0, 1.0 resets
{ cmd: "trim", deck: number, gain: number }
{ cmd: "focus", deck: number }
{ cmd: "browse", query: string }
{ cmd: "select", track_id: string }
{ cmd: "scroll", delta: number }                  // move the selection within the filtered list
{ cmd: "rescan" }
```
