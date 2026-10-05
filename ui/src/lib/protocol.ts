// Wire types for the X1 D. Four server. Mirrors docs/protocol.md exactly;
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
  /** Beat sync on: tempo and phase follow the master deck. */
  sync?: boolean;
  /** The deck synced decks follow. */
  master?: boolean;
  /** Playing tempo (beat-grid tempo × rate); null without a grid. */
  bpm?: number | null;
  /** Loop state; `beats` is the length (the next loop's when not active). */
  loop?: { active: boolean; beats: number };
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

export type View = 'decks' | 'explore';

export type StateMsg = {
  type: 'state';
  decks: DeckState[];
  /** Deck that "load selected" targets. */
  focused: number;
  device: DeviceStatus;
  /** From the mixer's MIDI clock (its BPM display). */
  bpm: number | null;
  /** Which view is up. The mixer can switch it, so the UI follows this. */
  view: View;
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

/** One `[[map]]` entry of mappings.toml, as `GET /api/mappings` lists it. */
export type Mapping = {
  /** Catalog name, e.g. "left.lit1", "right.browse.push", "shift.left.jog". */
  control: string;
  /** e.g. "deck.play_pause", "explore.aim", "view.explore". */
  action: string;
  /** 1-4 (as printed on the mixer); absent = the focused deck. */
  deck?: number;
  /** Step size or range; meaning depends on the action. */
  amount?: number;
  /** LED feedback rule, e.g. "deck.playing". */
  led?: string;
};

/** `GET /api/mappings`. `mappings` is null when no mappings file has loaded. */
export type MappingsResponse = {
  ok: boolean;
  error: string | null;
  path: string;
  mappings: Mapping[] | null;
};

export type LibraryChangedMsg = { type: 'library_changed'; tracks: number };

export type ErrorMsg = { type: 'error'; message: string };

// --- Explore (similarity tunnel) -------------------------------------------

/** Frequency band the similarity tree is built in. */
export type Band = 'low' | 'mid' | 'high';

export const BANDS: readonly Band[] = ['low', 'mid', 'high'];

export type ExploreReason = 'init' | 'band' | 'root' | 'section' | 'dive' | 'back' | 'aim' | 'follow';

export type ExploreNode = {
  id: string;
  /** null only for the root. */
  parent: string | null;
  /** 0 = root. */
  depth: number;
  /** Similarity to parent in the active band, 0..1. */
  sim: number;
  /** Analysed BPM. */
  tempo: number | null;
};

export type ExploreMsg = {
  type: 'explore';
  band: Band;
  /** Root follows the focused deck's track. */
  follow: boolean;
  /** Track id at depth 0. */
  root: string | null;
  /** Deck playing the root, if any. */
  root_deck: number | null;
  /** Ids from root to current, inclusive (path[0] = root). */
  path: string[];
  /** Node whose children are shown ahead. */
  current: string | null;
  /** Aimed child of current (= library selection). */
  aim: string | null;
  /** Always contains current's children and grandchildren. */
  nodes: ExploreNode[];
  reason: ExploreReason;
};

export type AnalysisMsg = {
  type: 'analysis';
  done: number;
  total: number;
  running: boolean;
  error: string | null;
};

/** About 60 per second, only while `state.view == "explore"`. */
export type VizMsg = {
  type: 'viz';
  /** ms since server start. */
  t: number;
  /** 64 log-spaced bins, 0..255, of what the decks are sending. */
  spectrum: number[];
  /** Overall low/mid/high level, 0..1. */
  bands: [number, number, number];
  /** Per deck low/mid/high, 0..1. */
  decks: Array<[number, number, number]>;
  /** A transient (kick) in this frame. */
  onset: boolean;
  /** 0..1 phase within the beat, from the mixer's MIDI clock. */
  beat: number | null;
  bpm: number | null;
};

export type ServerMsg =
  | StateMsg
  | BrowserMsg
  | DeckLoadedMsg
  | DeckEjectedMsg
  | MidiMsg
  | MappingsMsg
  | LibraryChangedMsg
  | ErrorMsg
  | ExploreMsg
  | AnalysisMsg
  | VizMsg;

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
  | { cmd: 'rescan' }
  | { cmd: 'sync'; deck: number; on?: boolean }
  | { cmd: 'loop'; deck: number }
  | { cmd: 'loop_length'; deck: number; steps: number }
  /** 1-3 raw bytes to the mixer (LED tests). */
  | { cmd: 'midi_out'; bytes: number[] }
  | { cmd: 'view'; view: View }
  | { cmd: 'explore_band'; band: Band }
  /** low → mid → high → low. */
  | { cmd: 'explore_cycle_band' }
  /** Rotate the aim among current's children. */
  | { cmd: 'explore_aim'; delta: number }
  /** Aim at a specific child (click on a portal). */
  | { cmd: 'explore_aim'; id: string }
  /** Dive into the aimed (or given) child. */
  | { cmd: 'explore_dive'; id?: string }
  /** Climb one step back up the path. */
  | { cmd: 'explore_back' }
  | { cmd: 'explore_follow'; follow: boolean }
  /** Re-root on any library track (follow turns off). */
  | { cmd: 'explore_root'; id: string }
  /** Re-root on the library selection (follow turns off). */
  | { cmd: 'explore_root_selected' };
