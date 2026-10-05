/**
 * Fake X1 D. Four server for UI development: speaks docs/protocol.md on
 * http://127.0.0.1:7878 with made-up tracks, decks and MIDI, and serves
 * ui/dist when it exists. Not part of the production bundle.
 *
 *   bun mock/server.ts [--port 7878] [--tracks 48] [--empty]
 *                      [--device running|connecting|stalled|missing|error]
 *                      [--bad-mappings] [--glitches] [--quiet]
 *                      [--view explore|decks] [--band low|mid|high]
 *                      [--idle] [--analysis-seconds 4] [--section-seconds 12]
 *                      [--ticker] [--loop]
 *
 * Starts in the explore view like the real server (--view decks for the deck
 * view); --idle starts with nothing playing and the focus on empty deck 4, so
 * the explorer starts from the library selection, like the server.
 * --section-seconds 0 turns off the periodic "section" re-shuffles (steady
 * screenshots). --ticker turns the left jog every few seconds, moving the
 * library selection away from the aim so Explore shows its library ticker.
 * --loop starts deck 2 playing in an active 8-beat loop.
 *
 * Decks 1–3 start with beat sync on (deck 1 the master), so their different
 * tempos play at one tempo with bars lined up. GET /api/decks/{n}/wave serves
 * a fake three-band waveform that follows each track's beat grid: a 4/4 kick
 * in the lows, offbeat hats in the highs, phrase-level swells in the mids and
 * an 8-bar breakdown every 32 bars.
 */
import { existsSync, statSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type {
  AnalysisMsg,
  Band,
  BeatGrid,
  BrowserMsg,
  Command,
  DeckLoadedMsg,
  DeviceStateName,
  DeviceStatus,
  ExploreMsg,
  ExploreNode,
  ExploreReason,
  Mapping,
  MappingsMsg,
  MidiMsg,
  ServerMsg,
  StateMsg,
  Track,
  View,
  VizMsg,
} from '../src/lib/protocol';

const { values: opts } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string', default: '7878' },
    tracks: { type: 'string', default: '48' },
    empty: { type: 'boolean', default: false },
    device: { type: 'string', default: 'running' },
    'bad-mappings': { type: 'boolean', default: false },
    glitches: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    view: { type: 'string', default: 'explore' },
    band: { type: 'string', default: 'low' },
    idle: { type: 'boolean', default: false },
    'analysis-seconds': { type: 'string', default: '4' },
    'section-seconds': { type: 'string', default: '12' },
    ticker: { type: 'boolean', default: false },
    loop: { type: 'boolean', default: false },
  },
});

const PORT = Number(opts.port);
const DIST = resolve(import.meta.dir, '../dist');
/** Like the real server: `state` 60 times a second, and ~2 ms after every deck command. */
const TICK_HZ = 60;
const VIZ_HZ = 120;
const DECKS = 4;
const started = performance.now();
const uptimeMs = () => Math.round(performance.now() - started);
const log = (...args: unknown[]) => {
  if (!opts.quiet) console.log(...args);
};

// ---------------------------------------------------------------------------
// Deterministic fake data

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(0x5eed);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];

const ARTISTS = [
  'Halcyon Static', 'Delta Ferro', 'Lumen Grove', 'Tessellate', 'Arcadia North', 'Vanta Bloom',
  'Kiko Marsh', 'Selenite', 'Orrin Vale', 'Mira Okafor', 'Pale Harbour', 'Night Assembly',
];
const ADJ = ['Night', 'Glass', 'Velvet', 'Tidal', 'Silver', 'Hollow', 'Neon', 'Quiet', 'Paper', 'Solar', 'Amber', 'Static', 'Low', 'Northern'];
const NOUN = ['Signal', 'Drift', 'Garden', 'Motion', 'Rooms', 'Theory', 'Circuit', 'Bloom', 'Harbour', 'Pulse', 'Echo', 'Lines', 'Engine', 'Weather'];
const MIX = ['', '', '', ' (Extended Mix)', ' (Dub)', ' (Original Mix)', ' (Club Edit)', ' (Reprise)'];
const ALBUMS = ['Afterhours Vol. 2', 'Signals EP', 'Low Light', 'Coastal Systems', 'Parallel', 'Self-Titled'];

function makeTracks(count: number): Track[] {
  const out: Track[] = [];
  const used = new Set<string>();
  while (out.length < count) {
    const artist = pick(ARTISTS);
    const title = `${pick(ADJ)} ${pick(NOUN)}${pick(MIX)}`;
    if (used.has(artist + title)) continue;
    used.add(artist + title);
    const album = pick(ALBUMS);
    const n = String(1 + Math.floor(rnd() * 12)).padStart(2, '0');
    out.push({
      id: `${artist}/${album}/${n} ${title}.flac`,
      title,
      artist,
      album,
      bpm: rnd() < 0.12 ? null : Math.round((118 + rnd() * 16) * 100) / 100,
      duration: Math.round((190 + rnd() * 260) * 100) / 100,
    });
  }
  // A few awkward ones: very long title, no artist / tags, and one that fails to decode.
  out.push({
    id: 'Various/Long Titles/01 An Extremely Long Track Title That Will Not Fit In Any Column (Twelve Minute Version).mp3',
    title: 'An Extremely Long Track Title That Will Not Fit In Any Column (Twelve Minute Version)',
    artist: 'The Unnecessarily Verbose Orchestra',
    album: 'Long Titles',
    bpm: 122,
    duration: 724.2,
  });
  out.push({ id: 'unsorted/field-recording-04.wav', title: 'field-recording-04', artist: null, album: null, bpm: null, duration: 241.6 });
  out.push({ id: 'unsorted/Corrupt Upload.mp3', title: 'Corrupt Upload', artist: 'Broken Files', album: null, bpm: 128, duration: 300 });
  return out.sort(
    (a, b) => (a.artist ?? '￿').localeCompare(b.artist ?? '￿') || a.title.localeCompare(b.title),
  );
}

/** Plausible dance-track overview: intro, build, drop, breakdown, drop, outro. */
function makePeaks(seed: number): number[] {
  const r = mulberry32(seed);
  const shape: Array<[end: number, from: number, to: number]> = [
    [0.1, 0.42, 0.48],
    [0.24, 0.55, 0.72],
    [0.42, 0.86, 0.9],
    [0.5, 0.22, 0.48],
    [0.53, 0.55, 0.8],
    [0.8, 0.9, 0.94],
    [0.92, 0.6, 0.5],
    [1, 0.42, 0.05],
  ];
  const peaks: number[] = [];
  let start = 0;
  for (const [end, from, to] of shape) {
    const n0 = Math.round(start * 1024);
    const n1 = Math.round(end * 1024);
    for (let i = n0; i < n1; i++) {
      const p = (i - n0) / Math.max(1, n1 - n0);
      const level = from + (to - from) * p;
      const beat = 0.08 * Math.sin(i * 1.7) * Math.sin(i * 0.31);
      const v = level * (0.8 + 0.2 * r()) + beat;
      peaks.push(Math.round(Math.min(1, Math.max(0.02, v)) * 255));
    }
    start = end;
  }
  return peaks;
}

const WAVE_BLOCK_FRAMES = 480;
const WAVE_BLOCK_S = WAVE_BLOCK_FRAMES / 48_000;

/**
 * Fake detailed waveform, [low, mid, high] bytes per 10 ms block, following
 * the beat grid: a 4/4 kick plus a bassline in the lows, hats and shakers in
 * the highs, chord stabs and slow phrase swells in the mids. A 16-bar intro,
 * then every 32 bars an 8-bar breakdown (no kick, pads swell, a noise riser
 * into the drop), and a 16-bar outro. Each track gets its own kick, bass
 * style, hat type and stab rhythm, so overlaid decks look different.
 */
function makeWave(track: Track, grid: BeatGrid | null): Uint8Array {
  const length = track.duration ?? 0;
  const blocks = Math.ceil((length * 48_000) / WAVE_BLOCK_FRAMES);
  const out = new Uint8Array(blocks * 3);
  const r = mulberry32(hash(`wave${track.id}`));
  const bpm = grid?.bpm ?? 120;
  const first = grid?.first_beat ?? 0;
  const beat = 60 / bpm;
  const totalBars = Math.floor((length - first) / beat / 4);
  const c = mulberry32(hash(`mix${track.id}`));
  const kickDecay = 0.035 + 0.08 * c();
  const kickLevel = 0.7 + 0.3 * c();
  const bassStyle = Math.floor(c() * 3); // 0 offbeat sub, 1 rolling 16ths, 2 side-chained sustain
  const bassLevel = 0.3 + 0.25 * c();
  const hatDecay = c() < 0.5 ? 0.022 : 0.07; // closed or open hats
  const hatLevel = 0.45 + 0.45 * c();
  const shakerLevel = 0.3 * c();
  const midLevel = 0.55 + 0.4 * c();
  const swellBars = c() < 0.5 ? 8 : 16;
  // Chord stabs on a per-track set of 8th-note positions within the bar.
  const stabs = [0, 1, 2, 3, 4, 5, 6, 7].filter(() => c() < 0.32).map((e) => e / 2);
  if (!stabs.length) stabs.push(0);
  const decay = (dt: number, tau: number) => (dt >= 0 ? Math.exp(-dt / tau) : 0);
  const fade = (t: number) => Math.min(1, t / 0.4, (length - t) / 1.5);
  for (let i = 0; i < blocks; i++) {
    const t = (i + 0.5) * WAVE_BLOCK_S;
    const beats = (t - first) / beat;
    const bar = Math.floor(beats / 4);
    const inBar = ((beats % 4) + 4) % 4; // beats into the bar
    const inBeat = (beats - Math.floor(beats)) * beat; // seconds since the beat
    const inOff = ((((beats + 0.5) % 1) + 1) % 1) * beat; // seconds since the offbeat
    const in16 = ((((beats * 4) % 1) + 1) % 1) * (beat / 4);
    const phraseBar = bar >= 16 ? (bar - 16) % 32 : -1;
    const intro = bar < 16;
    const outro = bar >= totalBars - 16;
    const breakdown = !outro && phraseBar >= 24;
    const kickOn = beats >= 0 && !breakdown;

    const kick = kickOn ? Math.min(1, inBeat / 0.006) * decay(inBeat, kickDecay) * kickLevel : 0;
    let bass = 0;
    if (kickOn && !intro) {
      if (bassStyle === 0) bass = decay(inOff, 0.11);
      else if (bassStyle === 1) bass = inBeat < beat / 4 ? 0 : 0.8 * decay(in16, 0.06);
      else bass = 0.75 * (1 - decay(inBeat, 0.16));
    }
    const drone = breakdown ? 0.16 + 0.06 * Math.sin(t * 2.1) : 0.04;
    const low = Math.min(1, kick + bass * bassLevel + drone + 0.03 * r());

    const swell = 0.5 + 0.5 * Math.sin((2 * Math.PI * (beats / 4)) / swellBars - Math.PI / 2);
    let stab = 0;
    for (const at of stabs) stab = Math.max(stab, decay((inBar - at) * beat, 0.08));
    let mid = intro ? 0.1 + 0.2 * swell * (bar / 16) + 0.15 * stab * (bar / 16) : 0.18 + 0.3 * swell + 0.32 * stab;
    if (breakdown) mid = 0.35 + 0.5 * ((phraseBar - 24 + inBar / 4) / 8) + 0.08 * Math.sin(t * 5.3);
    if (outro) mid *= Math.max(0.15, (totalBars - bar) / 16);
    mid = Math.min(1, mid * midLevel + 0.04 * r());

    const hatsOn = bar >= 8 && !breakdown;
    const hat = hatsOn ? decay(inOff, hatDecay) * hatLevel : 0;
    const shaker = hatsOn && !intro ? decay(in16, 0.012) * shakerLevel : 0;
    const riser = breakdown && phraseBar >= 28 ? ((phraseBar - 28 + inBar / 4) / 4) ** 2 * 0.7 : 0;
    const high = Math.min(1, hat + shaker + riser * (0.7 + 0.3 * r()) + 0.05 + 0.04 * r());

    const g = beats < 0 ? 0.15 : fade(t);
    out[i * 3] = Math.round(low * g * 235);
    out[i * 3 + 1] = Math.round(mid * g * 190);
    out[i * 3 + 2] = Math.round(high * g * 160);
  }
  return out;
}

const waveCache = new Map<string, Uint8Array>();
function waveOf(d: MockDeck): Uint8Array | null {
  if (!d.track || !(d.track.duration ?? 0)) return null;
  let wave = waveCache.get(d.track.id);
  if (!wave) {
    wave = makeWave(d.track, d.grid);
    waveCache.set(d.track.id, wave);
  }
  return wave;
}

let tracks: Track[] = opts.empty ? [] : makeTracks(Number(opts.tracks));
const byId = () => new Map(tracks.map((t) => [t.id, t]));
let index = byId();

// ---------------------------------------------------------------------------
// Decks, browser, device

type MockDeck = {
  track: Track | null;
  peaks: number[];
  grid: BeatGrid | null;
  loading: boolean;
  playing: boolean;
  previewing: boolean;
  position: number;
  rate: number;
  cue: number;
  trim: number;
  sync: boolean;
  loop: { active: boolean; beats: number; start: number | null; end: number | null };
  /** Seconds of `jog` still to glide through. */
  jog: number;
};

const emptyDeck = (): MockDeck => ({
  track: null,
  peaks: [],
  grid: null,
  loading: false,
  playing: false,
  previewing: false,
  position: 0,
  rate: 1,
  cue: 0,
  trim: 1,
  sync: false,
  loop: { active: false, beats: 8, start: null, end: null },
  jog: 0,
});

const decks: MockDeck[] = Array.from({ length: DECKS }, emptyDeck);
let focused = opts.idle ? 3 : 1;

function put(deck: number, track: Track, patch: Partial<MockDeck> = {}) {
  // A reload keeps the deck's sync setting, like the real decks.
  const sync = decks[deck].sync;
  Object.assign(decks[deck], emptyDeck(), { track, peaks: makePeaks(hash(track.id)), grid: gridOf(track), sync }, patch);
}

/** Beat grid from the tags; tracks without a tempo tag have none. */
function gridOf(track: Track): BeatGrid | null {
  if (track.bpm == null) return null;
  const first = 0.1 + 0.4 * mulberry32(hash(`grid${track.id}`))();
  return { bpm: track.bpm, first_beat: Math.round(first * 1000) / 1000 };
}

if (tracks.length > 20) {
  const withGrid = tracks.filter((t) => t.bpm != null && (t.duration ?? 0) > 120);
  put(0, withGrid[3], { playing: !opts.idle, position: 62.4, cue: 0.5, rate: 1.0, sync: true });
  put(1, withGrid[10], { playing: opts.loop && !opts.idle, position: 96.2, cue: 16.2, rate: 1.012, sync: true });
  const t2 = withGrid[17];
  put(2, t2, { playing: !opts.idle, position: (t2.duration ?? 240) - 58, cue: 31.9, rate: 0.985, sync: true });
}

/** The deck synced decks follow: the first playing synced deck with a grid, else the first synced one. */
function masterDeck(): number | null {
  const synced = decks.map((d, i) => (d.sync && d.grid && d.track ? i : -1)).filter((i) => i >= 0);
  return synced.find((i) => decks[i].playing) ?? synced[0] ?? null;
}

/** Tempo of the master deck, or null. */
function masterTempo(): number | null {
  const m = masterDeck();
  const d = m == null ? null : decks[m];
  return d?.grid ? d.grid.bpm * d.rate : null;
}

/** Bars elapsed on a deck (fractional), by its grid. */
function barsAt(d: MockDeck): number {
  return d.grid ? ((d.position - d.grid.first_beat) * d.grid.bpm) / 60 / 4 : 0;
}

/** Sync a deck to the master: match its tempo and line its bars up with the master's. */
function align(deck: number) {
  const d = decks[deck];
  const m = masterDeck();
  if (!d.sync || !d.grid || m == null || m === deck) return;
  const tempo = masterTempo();
  if (tempo) d.rate = Math.min(2, Math.max(0.5, tempo / d.grid.bpm));
  const diff = barsAt(decks[m]) - barsAt(d);
  const shift = (diff - Math.round(diff)) * 4 * (60 / d.grid.bpm);
  d.position = Math.min(d.track?.duration ?? 0, Math.max(0, d.position + shift));
}

function loopAt(d: MockDeck, position: number) {
  if (!d.grid) return;
  const beat = 60 / d.grid.bpm;
  const start = d.grid.first_beat + Math.max(0, Math.round((position - d.grid.first_beat) / beat)) * beat;
  d.loop = { active: true, beats: d.loop.beats, start, end: start + d.loop.beats * beat };
}

for (let i = 0; i < DECKS; i++) align(i);
if (opts.loop && decks[1].track) loopAt(decks[1], decks[1].position);

const allIds = () => tracks.map((t) => t.id);
let browser: BrowserMsg = { type: 'browser', query: '', ids: allIds(), selected: tracks[5]?.id ?? tracks[0]?.id ?? null };

function filter(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return allIds();
  return tracks
    .filter((t) => {
      const hay = `${t.title} ${t.artist ?? ''} ${t.album ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map((t) => t.id);
}

function setBrowser(query: string, selected: string | null) {
  const ids = filter(query);
  browser = { type: 'browser', query, ids, selected: selected && ids.includes(selected) ? selected : (ids[0] ?? null) };
  broadcast(browser);
}

const CLOCK_BPM = 126;
let view: View = opts.view === 'decks' ? 'decks' : 'explore';

const deviceState = opts.device as DeviceStateName;
const DEVICE_MESSAGES: Record<DeviceStateName, string | null> = {
  running: null,
  connecting: 'Waiting for snd-usb-ozzy to release the device',
  stalled: 'No OUT completions for 1.2 s',
  missing: 'No Xone:4D on USB',
  error: 'EP5 OUT failed: EPROTO (-71)',
};
const device: DeviceStatus = {
  state: deviceState,
  message: DEVICE_MESSAGES[deviceState] ?? null,
  firmware: deviceState === 'missing' ? null : '1.4.1',
  out_urbs: 4,
  latency_ms: (4 * 80) / 48,
  packets_out: 0,
  underruns: opts.glitches ? 3 : 0,
  urb_errors: opts.glitches ? 1 : 0,
  min_queued: deviceState === 'running' ? 3 : null,
  max_gap_us: deviceState === 'running' ? 1020 : null,
};

function stateMsg(): StateMsg {
  return {
    type: 'state',
    decks: decks.map((d, i) => ({
      // Like the real server: the current track stays (and keeps playing)
      // until the new one has decoded.
      track_id: d.track?.id ?? null,
      loading: d.loading,
      playing: d.playing,
      position: d.position,
      length: d.track?.duration ?? 0,
      rate: d.rate,
      cue: d.cue,
      trim: d.trim,
      sync: d.sync,
      master: i === masterDeck(),
      bpm: d.grid ? Math.round(d.grid.bpm * d.rate * 100) / 100 : null,
      loop: { ...d.loop },
    })),
    focused,
    device,
    bpm: deviceState === 'running' ? CLOCK_BPM : null,
    view,
  };
}

function deckLoaded(deck: number): DeckLoadedMsg | null {
  const d = decks[deck];
  if (!d.track) return null;
  const length = d.track.duration ?? 0;
  return {
    type: 'deck_loaded',
    deck,
    track: d.track,
    length,
    peaks: d.peaks,
    grid: d.grid,
    wave: length > 0 ? { block_frames: WAVE_BLOCK_FRAMES, blocks: Math.ceil((length * 48_000) / WAVE_BLOCK_FRAMES) } : null,
  };
}

/** The default config/mappings.toml, as GET /api/mappings lists it. */
const perDeck = (control: (n: number) => string, action: string, extra: Partial<Mapping> = {}): Mapping[] =>
  [1, 2, 3, 4].map((n) => ({ control: control(n), action, deck: n, ...extra }));
const MAPPINGS: Mapping[] = [
  ...perDeck((n) => `left.lit${n}`, 'deck.load_selected', { led: 'deck.loaded' }),
  ...perDeck((n) => `right.lit${n}`, 'deck.play_pause', { led: 'deck.playing' }),
  { control: 'left.jog', action: 'deck.jog', amount: 5 },
  { control: 'xfader', action: 'explore.band_crossfader' },
  { control: 'left.browse', action: 'deck.focus_step' },
  { control: 'left.browse.push', action: 'explore.root' },
  { control: 'left.button.A', action: 'explore.band', amount: 0 },
  { control: 'left.button.B', action: 'explore.band', amount: 1 },
  { control: 'left.button.C', action: 'explore.band', amount: 2 },
  { control: 'left.button.E', action: 'explore.follow' },
  ...perDeck((n) => `left.encoder${n}`, 'deck.loop_length'),
  ...perDeck((n) => `left.encoder${n}.push`, 'deck.loop'),
  ...perDeck((n) => `left.fader${n}`, 'deck.rate'),
  { control: 'right.jog', action: 'deck.shift', amount: 2 },
  { control: 'right.browse', action: 'explore.aim' },
  { control: 'right.browse.push', action: 'deck.sync_reset' },
  { control: 'right.button.M', action: 'explore.dive' },
  ...perDeck((n) => `right.encoder${n}`, 'deck.nudge', { amount: 2.0 }),
  ...perDeck((n) => `right.encoder${n}.push`, 'deck.sync'),
];

const mappings: MappingsMsg = opts['bad-mappings']
  ? {
      type: 'mappings',
      ok: false,
      error: 'line 14, column 9: unknown action "deck.ply"\n  left.lit1 = "deck.ply deck=1"\n          ^ did you mean "deck.play"?',
      count: 0,
      path: 'config/mappings.toml',
    }
  : { type: 'mappings', ok: true, error: null, count: MAPPINGS.length, path: 'config/mappings.toml' };

// ---------------------------------------------------------------------------
// Commands

const loadTimers = new Map<number, ReturnType<typeof setTimeout>>();

function load(deck: number, id: string): string | null {
  const track = index.get(id);
  if (!track) return `No such track: ${id}`;
  const d = decks[deck];
  clearTimeout(loadTimers.get(deck));
  d.loading = true;
  loadTimers.set(
    deck,
    setTimeout(() => {
      d.loading = false;
      if (id.includes('Corrupt')) {
        broadcast({ type: 'error', message: `Couldn't load "${track.title}" on deck ${deck + 1}: decoder error: unexpected end of stream` });
        return;
      }
      put(deck, track);
      const msg = deckLoaded(deck);
      if (msg) broadcast(msg);
    }, 450 + rnd() * 400),
  );
  return null;
}

function handle(cmd: Command): string | null {
  const deckOk = (n: number) => Number.isInteger(n) && n >= 0 && n < DECKS;
  if ('deck' in cmd && cmd.deck !== undefined && !deckOk(cmd.deck)) return `Bad deck: ${cmd.deck}`;
  switch (cmd.cmd) {
    case 'load':
      return load(cmd.deck, cmd.track_id);
    case 'load_selected': {
      if (!browser.selected) return 'Nothing selected';
      const id = browser.selected;
      const error = load(cmd.deck ?? focused, id);
      // Like the server: loading the aimed track takes its route.
      if (!error) commit(id);
      return error;
    }
    case 'eject': {
      clearTimeout(loadTimers.get(cmd.deck));
      decks[cmd.deck] = emptyDeck();
      broadcast({ type: 'deck_ejected', deck: cmd.deck });
      return null;
    }
    case 'play':
    case 'pause':
    case 'play_pause': {
      const d = decks[cmd.deck];
      if (!d.track) return `Deck ${cmd.deck + 1} is empty`;
      const was = d.playing;
      d.playing = cmd.cmd === 'play' ? true : cmd.cmd === 'pause' ? false : !d.playing;
      d.previewing = false;
      if (d.playing && !was) align(cmd.deck);
      return null;
    }
    case 'cue': {
      // CDJ-style: playing → back to cue and stop; paused at cue → preview
      // while held; paused elsewhere → set the cue point here.
      const d = decks[cmd.deck];
      if (!d.track) return null;
      if (cmd.pressed) {
        if (d.playing) {
          d.playing = false;
          d.position = d.cue;
        } else if (Math.abs(d.position - d.cue) < 0.05) {
          d.previewing = true;
          d.playing = true;
        } else {
          d.cue = d.position;
        }
      } else if (d.previewing) {
        d.previewing = false;
        d.playing = false;
        d.position = d.cue;
      }
      return null;
    }
    case 'seek': {
      const d = decks[cmd.deck];
      d.position = Math.min(1, Math.max(0, cmd.fraction)) * (d.track?.duration ?? 0);
      return null;
    }
    case 'nudge': {
      const d = decks[cmd.deck];
      d.position = Math.min(d.track?.duration ?? 0, Math.max(0, d.position + cmd.seconds));
      return null;
    }
    case 'rate':
      decks[cmd.deck].rate = Math.min(2, Math.max(0.5, cmd.rate));
      return null;
    case 'jog': {
      const d = decks[cmd.deck];
      if (!d.track) return null;
      d.position = Math.min(d.track.duration ?? 0, Math.max(0, d.position + (Number(cmd.ms) || 0) / 1000));
      return null;
    }
    case 'shift': {
      const d = decks[cmd.deck];
      if (!d.track) return null;
      d.jog += (Number(cmd.ms) || 0) / 1000;
      return null;
    }
    case 'sync': {
      const d = decks[cmd.deck];
      d.sync = cmd.on ?? !d.sync;
      align(cmd.deck);
      return null;
    }
    case 'loop': {
      const d = decks[cmd.deck];
      if (!d.track) return `Deck ${cmd.deck + 1} is empty`;
      if (d.loop.active) {
        d.loop = { ...d.loop, active: false, start: null, end: null };
        return null;
      }
      if (!d.grid) return `Deck ${cmd.deck + 1} has no beat grid`;
      loopAt(d, d.position);
      return null;
    }
    case 'loop_length': {
      const d = decks[cmd.deck];
      const steps = Math.trunc(Number(cmd.steps) || 0);
      d.loop.beats = Math.min(32, Math.max(1 / 8, d.loop.beats * 2 ** steps));
      if (d.loop.active && d.loop.start != null && d.grid) {
        d.loop.end = d.loop.start + d.loop.beats * (60 / d.grid.bpm);
        if (d.position >= d.loop.end) d.position = d.loop.start + ((d.position - d.loop.start) % (d.loop.end - d.loop.start));
      }
      return null;
    }
    case 'trim':
      decks[cmd.deck].trim = Math.max(0, cmd.gain);
      return null;
    case 'focus':
      focused = cmd.deck;
      return null;
    case 'browse':
      setBrowser(cmd.query, browser.selected);
      return null;
    case 'select':
      if (!browser.ids.includes(cmd.track_id)) return 'Track is not in the current list';
      browser = { ...browser, selected: cmd.track_id };
      broadcast(browser);
      aimFromSelection();
      return null;
    case 'scroll': {
      if (!browser.ids.length) return null;
      const i = browser.selected ? browser.ids.indexOf(browser.selected) : -1;
      const next = Math.min(browser.ids.length - 1, Math.max(0, i + Math.trunc(cmd.delta)));
      browser = { ...browser, selected: browser.ids[next] };
      broadcast(browser);
      aimFromSelection();
      return null;
    }
    case 'rescan':
      void rescan();
      return null;
    case 'midi_out':
      return null;
    case 'view':
      if (cmd.view !== 'decks' && cmd.view !== 'explore') return `Bad view: ${String(cmd.view)}`;
      view = cmd.view;
      broadcast(stateMsg());
      return null;
    case 'explore_band':
      if (!BANDS.includes(cmd.band)) return `Bad band: ${String(cmd.band)}`;
      setBand(cmd.band);
      return null;
    case 'explore_cycle_band':
      setBand(BANDS[(BANDS.indexOf(ex.band) + 1) % BANDS.length]);
      return null;
    case 'explore_aim':
      return 'id' in cmd ? aimAt(cmd.id) : aimBy(cmd.delta);
    case 'explore_dive':
      return dive(cmd.id);
    case 'explore_back':
      return back();
    case 'explore_follow':
      ex.follow = !!cmd.follow;
      if (ex.follow) followPlaying('follow', true);
      else broadcastExplore('follow');
      return null;
    case 'explore_root': {
      if (!index.has(cmd.id)) return `No such track: ${cmd.id}`;
      ex.follow = false;
      const deck = decks.findIndex((d) => d.track?.id === cmd.id);
      reroot(cmd.id, deck >= 0 ? deck : null, 'root');
      return null;
    }
    case 'explore_root_selected': {
      const id = browser.selected;
      if (!id || !index.has(id)) return 'Nothing selected';
      ex.follow = false;
      const deck = decks.findIndex((d) => d.track?.id === id);
      reroot(id, deck >= 0 ? deck : null, 'root');
      return null;
    }
    default:
      return `Unknown command: ${JSON.stringify(cmd)}`;
  }
}

async function rescan(): Promise<number> {
  await Bun.sleep(900);
  if (opts.empty && tracks.length === 0) {
    // Simulate the user having dropped files into ~/Music in the meantime.
    tracks = makeTracks(12);
  }
  index = byId();
  broadcast({ type: 'library_changed', tracks: tracks.length });
  setBrowser(browser.query, browser.selected);
  startAnalysis();
  return tracks.length;
}

// ---------------------------------------------------------------------------
// Explore: fake per-band features, a similarity tree, analysis, viz

const BANDS: readonly Band[] = ['low', 'mid', 'high'];
const FEATURE_DIM = 8;
const CLUSTERS = 5;
const CHILDREN = 6;
const GRANDCHILDREN = 4;
const ANALYSIS_MS = Math.max(0.5, Number(opts['analysis-seconds'])) * 1000;
const SECTION_MS = Number(opts['section-seconds']) * 1000;

const ex = {
  band: (BANDS.includes(opts.band as Band) ? opts.band : 'low') as Band,
  follow: true,
  root: null as string | null,
  rootDeck: null as number | null,
  path: [] as string[],
  aim: null as string | null,
  nodes: [] as ExploreNode[],
  /** Changes on every fake "section" of the root track; nudges similarities. */
  section: 0,
};

/** Deterministic feature vector per track and band: clustered, so neighbours make sense. */
const featureCache = new Map<string, number[]>();
function features(id: string, band: Band): number[] {
  const key = `${band}|${id}`;
  let f = featureCache.get(key);
  if (f) return f;
  const r = mulberry32(hash(key));
  const cluster = Math.floor(r() * CLUSTERS);
  const c = mulberry32(hash(`${band}#${cluster}`));
  f = Array.from({ length: FEATURE_DIM }, () => (c() * 2 - 1) * 0.9 + (r() * 2 - 1) * 0.55);
  const len = Math.hypot(...f) || 1;
  f = f.map((v) => v / len);
  featureCache.set(key, f);
  return f;
}

function similarity(a: string, b: string): number {
  const fa = features(a, ex.band);
  const fb = features(b, ex.band);
  let dot = 0;
  for (let i = 0; i < FEATURE_DIM; i++) dot += fa[i] * fb[i];
  // Sections shift what the root sounds like for a while.
  const jitter = (mulberry32(hash(`${ex.section}|${a}|${b}`))() - 0.5) * 0.12;
  return Math.min(0.98, Math.max(0.05, 0.1 + 0.88 * ((dot + 1) / 2) ** 1.6 + jitter));
}

/** Tracks analysed so far, in analysis order. */
let analysed = new Set<string>();
let analysisOrder: string[] = [];
let analysisStarted = 0;
let analysisRunning = false;
let lastAnalysisMsg = 0;

function startAnalysis() {
  const r = mulberry32(hash(`order${tracks.length}`));
  analysisOrder = tracks.map((t) => t.id).sort(() => r() - 0.5);
  analysed = new Set();
  analysisStarted = performance.now();
  analysisRunning = analysisOrder.length > 0;
  broadcast(analysisMsg());
}

function analysisMsg(): AnalysisMsg {
  return { type: 'analysis', done: analysed.size, total: tracks.length, running: analysisRunning, error: null };
}

function stepAnalysis() {
  if (!analysisRunning) return;
  const now = performance.now();
  const want = Math.min(analysisOrder.length, Math.floor(((now - analysisStarted) / ANALYSIS_MS) * analysisOrder.length));
  let changed = false;
  while (analysed.size < want) {
    analysed.add(analysisOrder[analysed.size]);
    changed = true;
  }
  if (analysed.size >= analysisOrder.length) analysisRunning = false;
  if (changed || !analysisRunning || now - lastAnalysisMsg > 1000) {
    if (!analysisRunning || now - lastAnalysisMsg > 1000) {
      lastAnalysisMsg = now;
      broadcast(analysisMsg());
    }
  }
  if (changed) rebuild('section');
}

function topSimilar(of: string, k: number, used: Set<string>): Array<{ id: string; sim: number }> {
  if (!analysed.has(of)) return [];
  const out: Array<{ id: string; sim: number }> = [];
  for (const id of analysed) {
    if (used.has(id) || id === of) continue;
    out.push({ id, sim: similarity(of, id) });
  }
  return out.sort((a, b) => b.sim - a.sim).slice(0, k);
}

/**
 * Rebuild `nodes` for the current band/root/path: each path node's children
 * (so the minimap shows where you came from) plus current's grandchildren.
 * Every track appears at most once.
 */
function buildTree() {
  ex.nodes = [];
  if (!ex.root) {
    ex.path = [];
    ex.aim = null;
    return;
  }
  if (ex.path[0] !== ex.root) ex.path = [ex.root];
  const used = new Set(ex.path);
  ex.nodes.push({ id: ex.root, parent: null, depth: 0, sim: 1, tempo: tempoOf(ex.root) });
  for (let i = 0; i < ex.path.length; i++) {
    const node = ex.path[i];
    const next = ex.path[i + 1];
    const kids = topSimilar(node, next ? CHILDREN - 1 : CHILDREN, used);
    if (next) {
      kids.push({ id: next, sim: similarity(node, next) });
      kids.sort((a, b) => b.sim - a.sim);
    }
    for (const kid of kids) {
      used.add(kid.id);
      if (kid.id !== next) ex.nodes.push({ id: kid.id, parent: node, depth: i + 1, sim: kid.sim, tempo: tempoOf(kid.id) });
    }
    if (next) ex.nodes.push({ id: next, parent: node, depth: i + 1, sim: similarity(node, next), tempo: tempoOf(next) });
  }
  // Keep each level in similarity order (the order explore_aim rotates through).
  const current = ex.path[ex.path.length - 1];
  const depth = ex.path.length;
  const children = ex.nodes.filter((n) => n.parent === current).sort((a, b) => b.sim - a.sim);
  ex.nodes = ex.nodes.filter((n) => n.parent !== current).concat(children);
  for (const child of children) {
    for (const g of topSimilar(child.id, GRANDCHILDREN, used)) {
      used.add(g.id);
      ex.nodes.push({ id: g.id, parent: child.id, depth: depth + 1, sim: g.sim, tempo: tempoOf(g.id) });
    }
  }
  if (!ex.aim || !children.some((c) => c.id === ex.aim)) ex.aim = children[0]?.id ?? null;
}

function tempoOf(id: string): number | null {
  if (!analysed.has(id)) return null;
  const t = index.get(id);
  const r = mulberry32(hash(`tempo${id}`))();
  // Analysis mostly agrees with the tags, sometimes finds a tempo they lack.
  return Math.round(((t?.bpm ?? 118 + r * 14) + (r - 0.5) * 0.4) * 10) / 10;
}

function childrenOfCurrent(): ExploreNode[] {
  const current = ex.path[ex.path.length - 1];
  return ex.nodes.filter((n) => n.parent === current);
}

function exploreMsg(reason: ExploreReason): ExploreMsg {
  return {
    type: 'explore',
    band: ex.band,
    follow: ex.follow,
    root: ex.root,
    root_deck: ex.rootDeck,
    path: ex.path.slice(),
    current: ex.path[ex.path.length - 1] ?? null,
    aim: ex.aim,
    nodes: ex.nodes,
    reason,
  };
}

/** Last aim pushed into the library selection (the aim *is* the selection). */
let syncedAim: string | null = null;
function broadcastExplore(reason: ExploreReason) {
  broadcast(exploreMsg(reason));
  if (ex.aim === syncedAim) return;
  syncedAim = ex.aim;
  if (!ex.aim || ex.aim === browser.selected) return;
  if (browser.ids.includes(ex.aim)) {
    browser = { ...browser, selected: ex.aim };
    broadcast(browser);
  } else {
    setBrowser('', ex.aim);
  }
}

function rebuild(reason: ExploreReason) {
  const before = JSON.stringify([ex.nodes, ex.aim, ex.path]);
  buildTree();
  if (reason === 'section' && JSON.stringify([ex.nodes, ex.aim, ex.path]) === before) return;
  broadcastExplore(reason);
}

function reroot(id: string | null, deck: number | null, reason: ExploreReason) {
  ex.root = id;
  ex.rootDeck = deck;
  ex.path = id ? [id] : [];
  ex.aim = null;
  rebuild(reason);
}

function setBand(band: Band) {
  ex.band = band;
  // A new band is a new tree: start over from the root.
  ex.path = ex.root ? [ex.root] : [];
  ex.aim = null;
  rebuild('band');
}

function aimBy(delta: number): string | null {
  const kids = childrenOfCurrent();
  if (!kids.length) return 'Nothing to aim at';
  const i = Math.max(0, kids.findIndex((k) => k.id === ex.aim));
  const n = kids.length;
  ex.aim = kids[(((i + Math.trunc(delta)) % n) + n) % n].id;
  broadcastExplore('aim');
  return null;
}

function aimAt(id: string): string | null {
  if (!childrenOfCurrent().some((k) => k.id === id)) return 'Not a child of the current node';
  if (ex.aim !== id) {
    ex.aim = id;
    broadcastExplore('aim');
  }
  return null;
}

function aimFromSelection() {
  const sel = browser.selected;
  if (sel && sel !== ex.aim && childrenOfCurrent().some((k) => k.id === sel)) {
    ex.aim = sel;
    syncedAim = sel;
    broadcast(exploreMsg('aim'));
  }
}

function dive(id?: string): string | null {
  const target = id ?? ex.aim;
  if (!target) return 'Nothing to dive into';
  if (!childrenOfCurrent().some((k) => k.id === target)) return 'Not a child of the current node';
  ex.path = [...ex.path, target];
  ex.aim = null;
  rebuild('dive');
  return null;
}

/** Loading the aimed track commits to its route (reason "commit"); anything else leaves the tree. */
function commit(id: string) {
  if (!childrenOfCurrent().some((k) => k.id === id)) return;
  ex.path = [...ex.path, id];
  ex.aim = null;
  rebuild('commit');
}

function back(): string | null {
  if (ex.path.length < 2) return null;
  const from = ex.path[ex.path.length - 1];
  ex.path = ex.path.slice(0, -1);
  ex.aim = from;
  rebuild('back');
  return null;
}

let lastSection = performance.now();

/**
 * Like the server's explore_tick: the tree grows from the focused deck's track
 * (playing or not); a new root *track* starts it over, so a commit stays put.
 * With nothing focused and no root yet, it starts from the library selection.
 */
function followPlaying(reason: ExploreReason, force = false) {
  const deck = decks[focused].track ? focused : null;
  const id = deck != null ? decks[deck].track!.id : null;
  if (id && (ex.follow || !ex.root)) {
    if (id !== ex.root) return reroot(id, deck, reason);
    ex.rootDeck = deck;
  } else if (!ex.root && browser.selected && analysed.has(browser.selected)) {
    return reroot(browser.selected, null, 'init');
  }
  if (force) broadcastExplore(reason);
}

let prevPhase = 0;
function vizMsg(): VizMsg {
  const t = uptimeMs();
  const bpm = deviceState === 'running' ? CLOCK_BPM : null;
  const beats = (t / 1000) * (CLOCK_BPM / 60);
  const phase = beats % 1;
  const bar = Math.floor(beats / 4);
  const deckLevels = decks.map((d) => {
    if (!d.playing || !d.track) return 0;
    const len = d.track.duration || 1;
    const peak = d.peaks[Math.min(1023, Math.floor((d.position / len) * 1024))] ?? 128;
    return Math.min(1, (peak / 255) * d.trim);
  });
  const energy = Math.min(1, deckLevels.reduce((a, b) => a + b, 0));
  const playing = energy > 0.01;
  const kick = playing ? Math.exp(-phase * 7) : 0;
  const offbeat = (phase + 0.5) % 1;
  const hat = playing ? Math.exp(-offbeat * 16) * 0.8 + Math.exp(-((beats * 4) % 1) * 22) * 0.35 : 0;
  const chord = mulberry32(hash(`chord${Math.floor(bar / 2)}`));
  const notes = [chord(), chord(), chord()].map((v) => 14 + Math.floor(v * 24));
  const swell = 0.55 + 0.45 * Math.sin(t / 900);
  const r = mulberry32(t);
  const spectrum = Array.from({ length: 64 }, (_, i) => {
    let v = 0;
    // Sub + kick, then a bassline, a few chord partials, and hats/air up top.
    v += Math.exp(-(((i - 3) / 3.2) ** 2)) * (0.35 + 0.65 * kick);
    v += Math.exp(-(((i - 9) / 3) ** 2)) * 0.45 * (0.6 + 0.4 * Math.sin(beats * Math.PI));
    for (const n of notes) v += Math.exp(-(((i - n) / 1.6) ** 2)) * 0.42 * swell;
    v += Math.max(0, (i - 34) / 30) * (0.15 + hat * 0.85) * (0.75 + 0.25 * r());
    v += 0.05 * r();
    return Math.round(Math.min(1, v * energy * 1.1) * 255);
  });
  const low = playing ? Math.min(1, energy * (0.3 + 0.7 * kick)) : 0;
  const mid = playing ? Math.min(1, energy * 0.55 * swell + 0.1) : 0;
  const high = playing ? Math.min(1, energy * (0.15 + 0.75 * hat)) : 0;
  const onset = playing && phase < prevPhase;
  prevPhase = phase;
  return {
    type: 'viz',
    t,
    spectrum,
    bands: [low, mid, high],
    decks: deckLevels.map((lvl) => [lvl * (0.3 + 0.7 * kick), lvl * 0.55 * swell, lvl * (0.15 + 0.75 * hat)]),
    onset,
    beat: bpm != null ? phase : null,
    bpm,
  };
}

function tickExplore() {
  followPlaying('root');
  stepAnalysis();
  const rootPlaying = ex.rootDeck != null && decks[ex.rootDeck].playing;
  const now = performance.now();
  if (rootPlaying && SECTION_MS > 0 && now - lastSection > SECTION_MS) {
    lastSection = now;
    ex.section++;
    rebuild('section');
  } else if (!rootPlaying) {
    lastSection = now;
  }
}

// ---------------------------------------------------------------------------
// Fake MIDI

const midiLog: MidiMsg[] = [];

function midi(m: Omit<MidiMsg, 'type' | 't'>) {
  const msg: MidiMsg = { type: 'midi', t: uptimeMs(), ...m };
  midiLog.push(msg);
  if (midiLog.length > 200) midiLog.shift();
  broadcast(msg);
}

function fakeMidi() {
  const roll = rnd();
  if (roll < 0.35) {
    const delta = rnd() < 0.7 ? 1 : -1;
    // Leave the aim alone in the explore view (keeps screenshots stable).
    jog(delta, view === 'decks');
  } else if (roll < 0.55) {
    const lit = 1 + Math.floor(rnd() * 4);
    const note = (0x23 + lit).toString(16).toUpperCase();
    const action = `deck.load_selected deck=${lit}`;
    midi({ raw: `9F ${note} 7F`, desc: `note on ch16 ${0x23 + lit} vel 127`, control: `left.lit${lit}`, event: 'press', value: null, action });
    setTimeout(
      () => midi({ raw: `8F ${note} 00`, desc: `note off ch16 ${0x23 + lit}`, control: `left.lit${lit}`, event: 'release', value: null, action: null }),
      140,
    );
  } else if (roll < 0.8) {
    const v = Math.floor(rnd() * 128);
    midi({
      raw: `BF 04 ${v.toString(16).toUpperCase().padStart(2, '0')}`,
      desc: `cc ch16 4 = ${v}`,
      control: 'left.upper1',
      event: 'value',
      value: v,
      action: null,
    });
  } else {
    const note = 0x40 + Math.floor(rnd() * 16);
    midi({ raw: `9F ${note.toString(16).toUpperCase()} 7F`, desc: `note on ch16 ${note} vel 127`, control: null, event: null, value: null, action: null });
  }
}

/** The left jog: one library row per tick, like the real mapping. */
function jog(delta: number, scroll = true) {
  midi({
    raw: `BF 10 ${delta > 0 ? '01' : '7F'}`,
    desc: `cc ch16 16 = ${delta > 0 ? 1 : 127}`,
    control: 'left.jog',
    event: 'delta',
    value: delta,
    action: 'library.scroll',
  });
  if (scroll) handle({ cmd: 'scroll', delta });
}

// --ticker: every few seconds, a short burst of left-jog ticks.
if (opts.ticker) {
  (function scheduleTicker() {
    setTimeout(
      () => {
        const dir = rnd() < 0.5 ? -1 : 1;
        const ticks = 1 + Math.floor(rnd() * 4);
        for (let i = 0; i < ticks; i++) setTimeout(() => jog(dir), i * 130);
        scheduleTicker();
      },
      2500 + rnd() * 2500,
    );
  })();
}

// ---------------------------------------------------------------------------
// Server

const server = Bun.serve<undefined>({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const json = (body: unknown, status = 200) => Response.json(body, { status });

    if (url.pathname === '/ws') {
      return srv.upgrade(req) ? undefined : new Response('Expected a WebSocket', { status: 426 });
    }
    if (url.pathname.startsWith('/api/')) {
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /api/library':
          return json(tracks);
        case 'POST /api/library/rescan':
          return json({ tracks: await rescan() });
        case 'GET /api/state':
          return json(stateMsg());
        case 'GET /api/decks':
          return json(decks.map((_, i) => deckLoaded(i)).filter(Boolean));
        default: {
          const m = /^GET \/api\/decks\/(\d+)\/wave$/.exec(route);
          const d = m ? decks[Number(m[1])] : undefined;
          if (!m) break;
          const wave = d ? waveOf(d) : null;
          if (!wave) return json({ error: 'deck is empty' }, 404);
          return new Response(wave, { headers: { 'content-type': 'application/octet-stream' } });
        }
        case 'GET /api/midi/recent':
          return json(midiLog);
        case 'GET /api/controls':
          return json([
            { name: 'left.lit1', kind: 'button', midi: 'note ch16 36', led: true },
            { name: 'left.browse', kind: 'encoder', midi: 'cc ch16 14', led: false },
            { name: 'left.upper1', kind: 'knob', midi: 'cc ch16 4', led: false },
          ]);
        case 'GET /api/mappings':
          return json({ ok: mappings.ok, error: mappings.error, path: mappings.path, mappings: mappings.ok ? MAPPINGS : null });
        case 'POST /api/command': {
          const cmd = (await req.json()) as Command;
          const error = handle(cmd);
          kickState();
          return json(error ? { ok: false, error } : { ok: true });
        }
      }
      return json({ error: 'not found' }, 404);
    }
    return serveStatic(url.pathname);
  },
  websocket: {
    open(ws) {
      ws.subscribe('all');
      send(ws, browser);
      for (let i = 0; i < DECKS; i++) {
        const msg = deckLoaded(i);
        if (msg) send(ws, msg);
      }
      send(ws, mappings);
      send(ws, stateMsg());
      send(ws, exploreMsg('init'));
      send(ws, analysisMsg());
      log('[ws] client connected');
    },
    message(ws, data) {
      let cmd: Command;
      try {
        cmd = JSON.parse(String(data)) as Command;
      } catch {
        send(ws, { type: 'error', message: 'Bad JSON' });
        return;
      }
      log(`[cmd +${uptimeMs()}ms]`, JSON.stringify(cmd));
      const error = handle(cmd);
      kickState();
      if (error) send(ws, { type: 'error', message: error });
    },
    close() {
      log('[ws] client disconnected');
    },
  },
});

function send(ws: { send(data: string): unknown }, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMsg) {
  server.publish('all', JSON.stringify(msg));
}

function serveStatic(pathname: string): Response {
  if (!existsSync(DIST)) {
    return new Response('ui/dist not built. Run `bun run build`, or use `bun run dev` and open the Vite URL.', {
      status: 404,
    });
  }
  const rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
  const path = resolve(DIST, rel || 'index.html');
  if (!path.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
  return new Response(Bun.file(isFile(path) ? path : resolve(DIST, 'index.html')));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Seed some history so /api/midi/recent has something.
for (let i = 0; i < 6; i++) fakeMidi();

(function scheduleMidi() {
  setTimeout(() => {
    fakeMidi();
    scheduleMidi();
  }, 1200 + rnd() * 1800);
})();

/** Push `state` about 2 ms after a command, so a jog, play or loop shows at once. */
let kick: ReturnType<typeof setTimeout> | undefined;
function kickState() {
  kick ??= setTimeout(() => {
    kick = undefined;
    tick();
  }, 2);
}

// State ticks with real elapsed time.
let last = performance.now();
function tick() {
  const t = performance.now();
  const dt = (t - last) / 1000;
  last = t;
  const tempo = masterTempo();
  const master = masterDeck();
  decks.forEach((d, i) => {
    if (!d.track) return;
    const length = d.track.duration ?? 0;
    // Synced decks follow the master's tempo.
    if (d.sync && d.grid && tempo && i !== master) d.rate = Math.min(2, Math.max(0.5, tempo / d.grid.bpm));
    // Jog: glide through what's left (a brief speed bend while playing).
    if (d.jog !== 0) {
      const step = Math.abs(d.jog) < 0.0005 ? d.jog : d.jog * (1 - Math.exp(-dt / 0.08));
      d.jog -= step;
      d.position = Math.min(length, Math.max(0, d.position + step));
    }
    if (!d.playing) return;
    d.position += dt * d.rate;
    const { active, start, end } = d.loop;
    if (active && start != null && end != null && end > start && d.position >= end) {
      d.position = start + ((d.position - start) % (end - start));
    }
    if (d.position >= length) {
      d.position = length;
      d.playing = false;
    }
  });
  if (device.state === 'running') device.packets_out += Math.round(dt * 600);
  if (device.state === 'running') device.max_gap_us = 980 + Math.round(rnd() * 120);
  broadcast(stateMsg());
  tickExplore();
}
setInterval(tick, 1000 / TICK_HZ);

// 120 Hz viz, only while the explore view is up.
setInterval(() => {
  if (view === 'explore') broadcast(vizMsg());
}, 1000 / VIZ_HZ);

followPlaying('init');
startAnalysis();

console.log(
  `X1 D. Four mock on http://127.0.0.1:${server.port} (${tracks.length} tracks, device ${device.state}, view ${view}, band ${ex.band})`,
);
