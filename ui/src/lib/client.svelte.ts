import {
  DECK_COUNT,
  type AnalysisMsg,
  type BeatGrid,
  type BrowserMsg,
  type Command,
  type DeckLoadedMsg,
  type ExploreMsg,
  type Mapping,
  type MappingsMsg,
  type MappingsResponse,
  type MidiMsg,
  type ServerMsg,
  type StateMsg,
  type Track,
  type View,
  type WaveInfo,
} from './protocol';
import { applyViz } from './viz';
import { waves } from './waves';

export type WsStatus = 'connecting' | 'open' | 'closed';
export type LibraryStatus = 'loading' | 'ready' | 'error';
export type DeckInfo = { track: Track; length: number; peaks: number[]; grid: BeatGrid | null; wave: WaveInfo | null };
export type MidiEntry = MidiMsg & { key: number };
export type Toast = { id: number; kind: 'error' | 'info'; message: string; count: number };

const MIDI_KEEP = 50;
const MAX_TOASTS = 4;
const INFO_TOAST_MS = 4000;
const RESCAN_TIMEOUT_MS = 120_000;
const BACKOFF_MS = [250, 500, 1000, 2000, 3000, 5000];
const FOCUS_INTENT_MS = 500;
const CONNECT_TIMEOUT_MS = 5000;

const emptyDecks = (): (DeckInfo | null)[] => Array.from({ length: DECK_COUNT }, () => null);

/**
 * Single connection to the X1 D. Four server plus everything the UI renders.
 *
 * The 30 Hz `state` stream is coalesced to one update per animation frame and
 * lives in its own signal, so components that don't read it (the library
 * table) never re-render on deck ticks. The 60 Hz `viz` stream never touches
 * reactivity at all: it lands in the plain `viz` object (lib/viz.ts).
 */
class Client {
  /** Latest `state` message (deck positions, device, clock). Updated once per frame. */
  state = $state.raw<StateMsg | null>(null);
  /** Focused deck as its own signal, so readers only update when it changes. */
  focused = $derived(this.state?.focused ?? 0);
  /**
   * Server-owned view (the mixer can switch it too). Explore is the main
   * view, so that's what shows until the first `state` says otherwise.
   */
  view = $derived<View>(this.state?.view === 'decks' ? 'decks' : 'explore');

  /** Similarity tree for the explore view; null until the server sends one. */
  explore = $state.raw<ExploreMsg | null>(null);
  /** Library analysis progress. */
  analysis = $state.raw<AnalysisMsg | null>(null);

  browser = $state.raw<BrowserMsg>({ type: 'browser', query: '', ids: [], selected: null });
  library = $state.raw<Map<string, Track>>(new Map());
  libraryStatus = $state<LibraryStatus>('loading');
  rescanning = $state(false);

  /** Track + peaks per deck, from `deck_loaded` / `deck_ejected`. */
  deckInfo = $state.raw<(DeckInfo | null)[]>(emptyDecks());

  /** Newest first. */
  midi = $state.raw<MidiEntry[]>([]);
  mappings = $state.raw<MappingsMsg | null>(null);
  /** The mapping table itself (GET /api/mappings), refetched on every `mappings` message. */
  mixer = $state.raw<Mapping[]>([]);

  ws = $state<WsStatus>('connecting');
  everConnected = $state(false);
  /** performance.now() of the next reconnect attempt while closed. */
  retryAt = $state<number | null>(null);

  toasts = $state.raw<Toast[]>([]);

  #sock: WebSocket | null = null;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingState: StateMsg | null = null;
  #stateFrame = 0;
  #libSeq = 0;
  #mapSeq = 0;
  #midiSeq = 0;
  #toastSeq = 0;
  #rescanTimer: ReturnType<typeof setTimeout> | undefined;
  #focusIntent: { deck: number; until: number } | null = null;

  connect(): void {
    clearTimeout(this.#retryTimer);
    this.retryAt = null;
    if (this.#sock) {
      const old = this.#sock;
      this.#sock = null;
      old.close();
    }
    this.ws = 'connecting';

    const url = new URL('/ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#sock = sock;
    // A server that accepts the TCP connection but never upgrades would leave
    // us "connecting" forever; give up and go through the normal backoff.
    const openTimer = setTimeout(() => {
      if (sock.readyState === WebSocket.CONNECTING) sock.close();
    }, CONNECT_TIMEOUT_MS);

    sock.onopen = () => {
      clearTimeout(openTimer);
      if (this.#sock !== sock) return;
      this.ws = 'open';
      this.everConnected = true;
      this.#attempt = 0;
      // The server re-sends browser / deck_loaded / mappings right after this;
      // forget deck tracks so a deck ejected while we were away doesn't linger.
      this.deckInfo = emptyDecks();
      // MIDI times restart with the server, so start the log over from its history.
      this.midi = [];
      void this.refreshLibrary();
      void this.#loadRecentMidi();
    };
    sock.onmessage = (ev) => {
      if (this.#sock !== sock || typeof ev.data !== 'string') return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      this.#handle(msg);
    };
    sock.onclose = () => {
      clearTimeout(openTimer);
      if (this.#sock !== sock) return;
      this.#sock = null;
      this.ws = 'closed';
      this.#scheduleReconnect();
    };
  }

  /** Send a command over the socket. Returns false (and drops it) while disconnected. */
  send(cmd: Command): boolean {
    const sock = this.#sock;
    if (!sock || sock.readyState !== WebSocket.OPEN) return false;
    sock.send(JSON.stringify(cmd));
    return true;
  }

  /** Ask the server to switch views; the UI follows `state.view` when it does. */
  setView(view: View): void {
    this.send({ cmd: 'view', view });
  }

  toggleView(): void {
    this.setView(this.view === 'explore' ? 'decks' : 'explore');
  }

  /** Focus a deck. Remembered briefly so shortcuts right after it target the new deck. */
  focus(deck: number): void {
    if (this.send({ cmd: 'focus', deck })) this.#focusIntent = { deck, until: performance.now() + FOCUS_INTENT_MS };
  }

  /**
   * Deck that "focused deck" shortcuts act on: a focus we just asked for wins
   * until the next state ticks confirm it, so "3 then Space" plays deck 3.
   */
  targetDeck(): number {
    const intent = this.#focusIntent;
    if (intent && performance.now() < intent.until && this.focused !== intent.deck) return intent.deck;
    this.#focusIntent = null;
    return this.focused;
  }

  rescan(): void {
    if (!this.send({ cmd: 'rescan' })) return;
    this.rescanning = true;
    clearTimeout(this.#rescanTimer);
    this.#rescanTimer = setTimeout(() => (this.rescanning = false), RESCAN_TIMEOUT_MS);
  }

  async refreshLibrary(): Promise<void> {
    const seq = ++this.#libSeq;
    if (this.libraryStatus !== 'ready') this.libraryStatus = 'loading';
    try {
      const res = await fetch('/api/library');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tracks = (await res.json()) as Track[];
      if (seq !== this.#libSeq) return;
      this.library = new Map(tracks.map((t) => [t.id, t]));
      this.libraryStatus = 'ready';
    } catch (err) {
      if (seq !== this.#libSeq) return;
      if (this.libraryStatus !== 'ready') this.libraryStatus = 'error';
      this.toast(`Couldn't load the library (${errorText(err)})`);
    }
  }

  clearMidi(): void {
    this.midi = [];
  }

  toast(message: string, kind: Toast['kind'] = 'error'): void {
    const existing = this.toasts.find((t) => t.message === message && t.kind === kind);
    if (existing) {
      this.toasts = this.toasts.map((t) => (t === existing ? { ...t, count: t.count + 1 } : t));
      return;
    }
    const toast: Toast = { id: ++this.#toastSeq, kind, message, count: 1 };
    this.toasts = [...this.toasts, toast].slice(-MAX_TOASTS);
    if (kind === 'info') setTimeout(() => this.dismiss(toast.id), INFO_TOAST_MS);
  }

  dismiss(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  #handle(msg: ServerMsg): void {
    switch (msg.type) {
      case 'state':
        // The waveform strip dead-reckons from the arrival time, so note it now.
        waves.noteState(msg, performance.now());
        // Coalesce: keep only the newest tick and apply it on the next frame.
        this.#pendingState = msg;
        if (!this.#stateFrame) {
          this.#stateFrame = requestAnimationFrame(() => {
            this.#stateFrame = 0;
            if (this.#pendingState) this.state = this.#pendingState;
            this.#pendingState = null;
          });
        }
        break;
      case 'browser':
        this.browser = msg;
        break;
      case 'deck_loaded':
        this.#setDeck(msg.deck, deckInfoFrom(msg));
        waves.load(msg.deck, msg.track.id, msg.wave);
        break;
      case 'deck_ejected':
        this.#setDeck(msg.deck, null);
        waves.drop(msg.deck);
        break;
      case 'midi':
        this.midi = [{ ...msg, key: ++this.#midiSeq }, ...this.midi].slice(0, MIDI_KEEP);
        break;
      case 'mappings':
        this.mappings = msg;
        void this.#loadMappings();
        break;
      case 'library_changed':
        clearTimeout(this.#rescanTimer);
        if (this.rescanning) {
          this.rescanning = false;
          this.toast(`Library rescanned: ${msg.tracks} ${msg.tracks === 1 ? 'track' : 'tracks'}`, 'info');
        }
        void this.refreshLibrary();
        break;
      case 'error':
        this.toast(msg.message);
        break;
      case 'explore':
        this.explore = msg;
        break;
      case 'analysis':
        this.analysis = msg;
        break;
      case 'viz':
        applyViz(msg);
        break;
    }
  }

  #setDeck(deck: number, info: DeckInfo | null): void {
    if (!Number.isInteger(deck) || deck < 0 || deck >= DECK_COUNT) return;
    const next = this.deckInfo.slice();
    next[deck] = info;
    this.deckInfo = next;
  }

  async #loadMappings(): Promise<void> {
    const seq = ++this.#mapSeq;
    try {
      const res = await fetch('/api/mappings');
      if (!res.ok) return;
      const body = (await res.json()) as MappingsResponse;
      if (seq !== this.#mapSeq) return;
      this.mixer = Array.isArray(body.mappings) ? body.mappings : [];
    } catch {
      // Keep the last table; the next `mappings` message tries again.
    }
  }

  async #loadRecentMidi(): Promise<void> {
    try {
      const res = await fetch('/api/midi/recent');
      if (!res.ok) return;
      const recent = (await res.json()) as MidiMsg[];
      // Merge with anything that arrived live meanwhile; same (t, raw) = same message.
      const seen = new Set(this.midi.map((m) => `${m.t}|${m.raw}`));
      const older = recent
        .slice(-MIDI_KEEP)
        .reverse()
        .filter((m) => !seen.has(`${m.t}|${m.raw}`))
        .map((m) => ({ ...m, key: ++this.#midiSeq }));
      this.midi = [...this.midi, ...older].sort((a, b) => b.t - a.t).slice(0, MIDI_KEEP);
    } catch {
      // History is a nicety; live messages still arrive.
    }
  }

  #scheduleReconnect(): void {
    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)];
    this.#attempt++;
    this.retryAt = performance.now() + delay;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => this.connect(), delay);
  }
}

function deckInfoFrom(msg: DeckLoadedMsg): DeckInfo {
  return { track: msg.track, length: msg.length, peaks: msg.peaks, grid: msg.grid ?? null, wave: msg.wave ?? null };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const client = new Client();
