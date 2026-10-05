// Wire types for the ginkodeck server. Mirrors docs/protocol.md exactly;
// decks are 0..3 on the wire and shown to people as 1–4.

export const DECK_COUNT = 4;

export type Track = {
  /** Path relative to the music folder; stable across rescans. */
  id: string;
  /** Falls back to the file name. */
  title: string;
  artist: string | null;
  album: string | null;
  /** From tags only. */
  bpm: number | null;
  /** Seconds, from tags. */
  duration: number | null;
};

export type DeckState = {
  track_id: string | null;
  /** A track is being decoded for this deck. */
  loading: boolean;
  playing: boolean;
  /** Seconds. */
  position: number;
  /** Seconds. */
  length: number;
  /** 1.0 = normal speed (varispeed: pitch follows). */
  rate: number;
  /** Seconds. */
  cue: number;
  /** Linear gain, 1.0 = unity. */
  trim: number;
};

export type DeviceStateName = 'connecting' | 'running' | 'stalled' | 'missing' | 'error';

export type DeviceStatus = {
  state: DeviceStateName;
  /** Human-readable detail for anything but running. */
  message: string | null;
  firmware: string | null;
  out_urbs: number;
  /** out_urbs × 80 frames / 48 kHz. */
  latency_ms: number;
  packets_out: number;
  /** Times the OUT queue ran dry (should stay 0). */
  underruns: number;
  urb_errors: number;
  /** Min OUT URBs still queued in the last second. */
  min_queued: number | null;
  /** Max gap between OUT completions in the last second. */
  max_gap_us: number | null;
};

export type StateMsg = {
  type: 'state';
  decks: DeckState[];
  /** Deck that "load selected" targets. */
  focused: number;
  device: DeviceStatus;
  /** From the mixer's MIDI clock (its BPM display). */
  bpm: number | null;
};

export type BrowserMsg = {
  type: 'browser';
  query: string;
  /** Filtered, ordered track list for `query`. */
  ids: string[];
  selected: string | null;
};

export type DeckLoadedMsg = {
  type: 'deck_loaded';
  deck: number;
  track: Track;
  length: number;
  /** 1024 values 0..255. */
  peaks: number[];
};

export type DeckEjectedMsg = { type: 'deck_ejected'; deck: number };

export type MidiEventKind = 'press' | 'release' | 'value' | 'delta';

export type MidiMsg = {
  type: 'midi';
  /** ms since server start. */
  t: number;
  /** e.g. "9F 26 7F". */
  raw: string;
  /** e.g. "note on ch16 38 vel 127". */
  desc: string;
  /** Catalog name, e.g. "left.lit1"; null if unknown. */
  control: string | null;
  event: MidiEventKind | null;
  /** 0..127 for value, ±n for delta. */
  value: number | null;
  /** Mapping that fired, e.g. "deck.play_pause deck=1". */
  action: string | null;
};

export type MappingsMsg = {
  type: 'mappings';
  ok: boolean;
  error: string | null;
  count: number;
  path: string;
};

export type LibraryChangedMsg = { type: 'library_changed'; tracks: number };

export type ErrorMsg = { type: 'error'; message: string };

export type ServerMsg =
  | StateMsg
  | BrowserMsg
  | DeckLoadedMsg
  | DeckEjectedMsg
  | MidiMsg
  | MappingsMsg
  | LibraryChangedMsg
  | ErrorMsg;

export type Command =
  | { cmd: 'load'; deck: number; track_id: string }
  /** `deck` defaults to the focused deck. */
  | { cmd: 'load_selected'; deck?: number }
  | { cmd: 'eject'; deck: number }
  | { cmd: 'play' | 'pause' | 'play_pause'; deck: number }
  /** true on pointer down, false on pointer up. */
  | { cmd: 'cue'; deck: number; pressed: boolean }
  /** 0..1 of the track. */
  | { cmd: 'seek'; deck: number; fraction: number }
  /** Relative jump, ±. */
  | { cmd: 'nudge'; deck: number; seconds: number }
  /** 0.5..2.0, 1.0 resets. */
  | { cmd: 'rate'; deck: number; rate: number }
  | { cmd: 'trim'; deck: number; gain: number }
  | { cmd: 'focus'; deck: number }
  | { cmd: 'browse'; query: string }
  | { cmd: 'select'; track_id: string }
  /** Move the selection within the filtered list. */
  | { cmd: 'scroll'; delta: number }
  | { cmd: 'rescan' };
