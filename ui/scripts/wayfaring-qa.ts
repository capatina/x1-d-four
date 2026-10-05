/**
 * The Wayfaring: verification, latency and performance against the mock.
 *
 * Needs the mock on 7979 (`bun mock/server.ts --port 7979 --tracks 120 --loop
 * --section-seconds 0`) and a dedicated headless Chromium on CDP_PORT (default
 * 9239, its own --user-data-dir). Never connects to the live mixer server.
 * Run from the repository root: bun ui/scripts/wayfaring-qa.ts
 *
 *   WAYFARING_OUTPUT        screenshots and report (default docs/screenshots/wayfaring)
 *   WAYFARING_REPORT        report file name (default verification, or performance-<label>)
 *   WAYFARING_PERF_ONLY=1   only the performance checks (for the second GPU)
 *   WAYFARING_LABEL         name for the performance report (e.g. rtx-uncapped)
 *   WAYFARING_SOAK_SECONDS  continuous mix before the final measurement (default 180, 0 = skip)
 *   WAYFARING_PAGE          page origin (default the mock; the Vite dev server gives readable profiles)
 *   WAYFARING_EMPTY / WAYFARING_ANALYSIS  origins of fresh mocks (--empty; --idle --analysis-seconds 12)
 */
import { mkdir } from 'node:fs/promises';

const port = Number(process.env.CDP_PORT || 9239);
if (port === 7878) throw new Error('The live mixer port is forbidden');
const mock = 'http://127.0.0.1:7979';
const page = process.env.WAYFARING_PAGE || mock;
if (page.includes(':7878')) throw new Error('The live mixer server is forbidden');
const out = process.env.WAYFARING_OUTPUT || 'docs/screenshots/wayfaring';
const perfOnly = !!process.env.WAYFARING_PERF_ONLY;
const soakSeconds = Number(process.env.WAYFARING_SOAK_SECONDS ?? 180);
await mkdir(out, { recursive: true });

type Pending = { resolve: (v: any) => void; reject: (e: unknown) => void };
async function connect(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = reject;
  });
  let seq = 0;
  const pending = new Map<number, Pending>();
  const events = new Map<string, (v: any) => void>();
  const errors: string[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.reject(m.error);
      else p?.resolve(m.result);
    } else {
      events.get(m.method)?.(m.params);
      if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params).slice(0, 2000));
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    }
  };
  return {
    errors,
    events,
    call: (method: string, params: object = {}) =>
      new Promise<any>((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}

const tabs = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
const tab = tabs.find((t) => t.type === 'page');
if (!tab) throw new Error('Start a dedicated headless Chromium page first');
const c = await connect(tab.webSocketDebuggerUrl);

type Report = {
  gpu?: string;
  checks: string[];
  latency: Record<string, unknown>;
  measurements: unknown[];
  progress: unknown[];
  allocations?: unknown;
  errors: string[];
};
const report: Report = { checks: [], latency: {}, measurements: [], progress: [], errors: c.errors };
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(`FAILED: ${message}`);
  report.checks.push(message);
  console.log(`✓ ${message}`);
};
async function evaluate<T = any>(expression: string): Promise<T> {
  const r = await c.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value as T;
}
async function command(data: Record<string, unknown>, settle = 120) {
  const r = (await (
    await fetch(`${mock}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  ).json()) as { ok: boolean; error?: string };
  if (!r.ok) throw new Error(`${JSON.stringify(data)}: ${r.error}`);
  await Bun.sleep(settle);
  if (data.cmd === 'load' || data.cmd === 'load_selected') {
    for (let i = 0; i < 50; i++) {
      const state = (await (await fetch(`${mock}/api/state`)).json()) as any;
      if (!state.decks[Number(data.deck)].loading) return;
      await Bun.sleep(100);
    }
    throw new Error('Deck load timed out');
  }
}
async function key(k: string, text?: string, settle = 250) {
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: k });
  await Bun.sleep(settle);
}
async function click(selector: string) {
  const r = await evaluate(
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...r });
  await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...r });
  await Bun.sleep(300);
}
/** WebP, modest: full frames at q72, sequences at half size. */
async function screenshot(name: string, opts: { half?: boolean; clip?: { x: number; y: number; width: number; height: number } } = {}) {
  await evaluate(`document.querySelector('.stats')?.style.setProperty('visibility','hidden')`);
  const metrics = await evaluate<{ w: number; h: number }>(`({w: innerWidth, h: innerHeight})`);
  const clip = opts.clip ?? (opts.half ? { x: 0, y: 0, width: metrics.w, height: metrics.h } : undefined);
  const r = await c.call('Page.captureScreenshot', {
    format: 'webp',
    quality: opts.half ? 70 : 72,
    ...(clip ? { clip: { ...clip, scale: opts.half ? 0.5 : 1 } } : {}),
  });
  await Bun.write(`${out}/${name}.webp`, Buffer.from(r.data, 'base64'));
  await evaluate(`document.querySelector('.stats')?.style.removeProperty('visibility')`);
}
async function size(width: number, height: number) {
  await c.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await Bun.sleep(1500);
}
const qa = (expr: string) => evaluate(`__wayfaring.${expr}`);
const pct = (xs: number[], q: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * q))] : NaN);
const round = (v: number) => Math.round(v * 100) / 100;
function summary(xs: number[]) {
  const s = xs.slice().sort((a, b) => a - b);
  return { n: s.length, p50: round(pct(s, 0.5)), p95: round(pct(s, 0.95)), p99: round(pct(s, 0.99)), max: round(s[s.length - 1] ?? NaN) };
}

/** Frame pacing over `seconds` of rAF, plus GPU (timer queries) and per-frame CPU (world, strip). */
async function measure(label: string, seconds = 15) {
  await qa('gpuMark()');
  await qa('cpuMark()');
  await evaluate(`window.__waveCpu?.fill(-1)`);
  const frames = await evaluate(`new Promise(resolve=>{const ds=[];let last=performance.now();const end=last+${seconds * 1000};
    function f(now){ds.push(now-last);last=now;if(now<end)requestAnimationFrame(f);else{ds.shift();resolve(ds);}}requestAnimationFrame(f);})`);
  const gpu: number[] = await qa('gpu.slice()');
  const cpu: number[] = await qa('cpuSamples()');
  const wave: number[] = await evaluate(`Array.from(window.__waveCpu ?? []).filter(v=>v>=0)`);
  const state = await qa('state()');
  const f = summary(frames as number[]);
  const record = {
    label,
    fps: round(1000 / ((frames as number[]).reduce((a, b) => a + b, 0) / (frames as number[]).length)),
    frameInterval: f,
    over25ms: (frames as number[]).filter((n) => n > 25).length,
    gpuMs: summary(gpu),
    worldCpuMs: summary(cpu),
    stripCpuMs: summary(wave),
    calls: state.calls,
    triangles: state.triangles,
  };
  report.measurements.push(record);
  console.log(JSON.stringify(record));
  return record;
}

async function clearLabels(where: string) {
  const r = await evaluate(`(()=>{const labels=[...document.querySelectorAll('.xl:not(.xl-leaving)')],footer=document.querySelector('.bottom').getBoundingClientRect();
    const r=labels.map(e=>e.getBoundingClientRect());
    const full=labels.every(e=>e.querySelector('.xl-t').textContent.trim()&&e.querySelector('.xl-a').textContent.trim()&&/\\d+% similar/.test(e.querySelector('.xl-m').textContent)&&/BPM/.test(e.querySelector('.xl-m').textContent));
    return {count:labels.length,full,inside:r.every(a=>a.left>=0&&a.right<=innerWidth&&a.top>85&&a.bottom<footer.top),
      overlaps:r.some((a,i)=>r.some((b,j)=>j>i&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top))}})()`);
  assert(r.count === 6 && r.full && r.inside && !r.overlaps, `${where}: six labels (title, artist, BPM, similarity) clear each other and the footer`);
}

async function checkGrid() {
  const positions = (await evaluate(`new Promise(resolve => {
    const canvas=document.querySelector('.strip canvas'), ctx=canvas.getContext('2d'), original=ctx.fillRect;
    const lane=Math.min(6,Math.max(4,canvas.clientHeight*.04)), xs=[[],[],[],[]];
    ctx.fillRect=function(x,y,w,h) {
      if(Math.abs(w-2.5)<.001) for(let i=0;i<4;i++) if(Math.abs(y-(2+i*lane))<.001) xs[i].push(x);
      return original.call(this,x,y,w,h);
    };
    requestAnimationFrame(()=>{ctx.fillRect=original;resolve(xs);});
  })`)) as number[][];
  assert(
    positions.every((xs) => xs.length > 2 && xs.every((x) => positions[0].some((y) => Math.abs(x - y) <= 1))),
    'Synced deck bar ticks align within one CSS pixel (the waveform timing is untouched)',
  );
}

/** Message → first animation frame, from the engine's records (label text and lit route checked in that frame). */
function latencyOf(records: any[], reason: string) {
  const rs = records.filter((r) => r.reason === reason);
  return {
    samples: rs.length,
    toFirstFrameMs: summary(rs.map((r) => r.frame - r.recv)),
    toRafTimestampMs: summary(rs.map((r) => Math.max(0, r.raf - r.recv))),
    handlerMs: summary(rs.map((r) => r.handled - r.recv)),
    firstFrameComplete: rs.filter((r) => r.labelOk && r.routeOk).length,
  };
}

async function setupDecks() {
  const library = (await (await fetch(`${mock}/api/library`)).json()) as { id: string; bpm: number | null }[];
  const playable = library.filter((t) => t.bpm && !t.id.includes('Corrupt') && !t.id.includes('Long Titles'));
  for (let deck = 0; deck < 4; deck++) {
    await command({ cmd: 'load', deck, track_id: playable[deck * 3].id });
    await command({ cmd: 'seek', deck, fraction: 0.3 });
    await command({ cmd: 'sync', deck, on: true });
    await command({ cmd: 'play', deck });
  }
  await command({ cmd: 'focus', deck: 0 });
  await command({ cmd: 'explore_follow', follow: true });
  await command({ cmd: 'explore_band', band: 'low' });
  return playable;
}

/** Sampled JS allocations while the world renders: who allocates per frame. */
async function allocations(seconds = 6) {
  await c.call('HeapProfiler.enable');
  await c.call('HeapProfiler.collectGarbage');
  // Count garbage too (by default only objects still alive at the end are reported).
  await c.call('HeapProfiler.startSampling', {
    samplingInterval: 256,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await Bun.sleep(seconds * 1000);
  const { profile } = await c.call('HeapProfiler.stopSampling');
  await c.call('HeapProfiler.disable');
  // Attribute allocations under the engine's frame (#frame → #tick → …, including three.js
  // draw calls) and under the strip's frame, by their innermost two frames.
  const sites = new Map<string, number>();
  const totals = { all: 0, engineFrame: 0, stripFrame: 0 };
  const walk = (node: any, path: string[]) => {
    const fn = node.callFrame.functionName || '(anonymous)';
    const file = (node.callFrame.url as string).split('/').pop()?.split('?')[0] ?? '';
    const p = [...path, `${fn} (${file}:${node.callFrame.lineNumber + 1})`];
    if (node.selfSize) {
      totals.all += node.selfSize;
      const engine = p.findIndex((n) => n.startsWith('#frame (engine') || n.startsWith('#tick (engine'));
      const strip = p.findIndex((n) => n.startsWith('#frame (waveRender'));
      if (engine >= 0 || strip >= 0) {
        if (engine >= 0) totals.engineFrame += node.selfSize;
        else totals.stripFrame += node.selfSize;
        const site = p.slice(-2).join(' ← ');
        sites.set(site, (sites.get(site) ?? 0) + node.selfSize);
      }
    }
    for (const ch of node.children) walk(ch, p);
  };
  walk(profile.head, []);
  const perSecond = (b: number) => Math.round(b / seconds);
  return {
    seconds,
    bytesPerSecond: { page: perSecond(totals.all), engineFrameLoop: perSecond(totals.engineFrame), stripFrameLoop: perSecond(totals.stripFrame) },
    frameLoopSites: [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([site, b]) => ({ site, bytesPerSecond: perSecond(b) })),
    note: 'sampled every 256 bytes, garbage included; function names need the unminified dev server (WAYFARING_PAGE)',
  };
}

try {
  await c.call('Runtime.enable');
  await c.call('Log.enable');
  await c.call('Page.enable');
  await c.call('Network.enable');
  await Bun.sleep(100);
  c.errors.length = 0;
  c.events.set('Network.requestWillBeSent', (e) => {
    const url = e.request.url as string;
    const local = [mock, page, process.env.WAYFARING_EMPTY, process.env.WAYFARING_ANALYSIS].filter(Boolean).map((o) => `${o}/`);
    if (url.startsWith('http') && !local.some((o) => url.startsWith(o))) c.errors.push(`Unexpected request: ${url}`);
  });
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const browser = await connect(version.webSocketDebuggerUrl);
  const info = await browser.call('SystemInfo.getInfo');
  report.gpu = info.gpu.auxAttributes.glRenderer;
  browser.close();
  console.log(report.gpu);
  assert(!/swiftshader|llvmpipe/i.test(report.gpu ?? ''), `Hardware GPU in use (${report.gpu})`);

  await size(1920, 1080);
  await c.call('Page.navigate', { url: `${page}/?stats&adaptive=0&qa` });
  await Bun.sleep(3000);
  const playable = await setupDecks();
  await Bun.sleep(6000);
  const state0 = await qa('state()');
  assert(state0.calls <= 18 && state0.triangles <= 270_000, `Budget: ${state0.calls} draw calls (≤ 18), ${Math.round(state0.triangles / 1000)}k triangles (≤ 270k)`);

  if (!perfOnly) {
    await checkGrid();
    await clearLabels('1920×1080');
    // Travel: the world streams on its own while the decks play.
    const c1 = (await qa('state()')).course;
    await screenshot('01-lowmarch-travel-1080');
    await Bun.sleep(4000);
    const c2 = (await qa('state()')).course;
    await screenshot('02-lowmarch-travel-later-1080');
    assert(c2 - c1 > 6, `Travel: ${round(c2 - c1)} units of course in 4 s, clocked to the tempo`);

    // Aim cycling: only the lit route and label change; nothing moves to the front.
    const rects = `[...document.querySelectorAll('.xl:not(.xl-leaving)')].map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.id,kind:e.dataset.kind,x:Math.round(r.left),w:Math.round(r.width),b:Math.round(r.bottom)}})`;
    const before = await evaluate<any[]>(rects);
    const anchors0 = (await qa('state()')).anchors;
    const aims: string[] = [];
    for (let i = 0; i < 3; i++) {
      await key('ArrowRight', undefined, 300);
      const now = await evaluate<any[]>(rects);
      aims.push(now.find((r) => r.kind === 'aimed')?.id);
      assert(
        now.every((r, j) => r.id === before[j].id && r.x === before[j].x && r.w === before[j].w && r.b === before[j].b),
        `Aim ${i + 1}: every label keeps its place (the aimed one only grows upward)`,
      );
    }
    assert(new Set(aims).size === 3, 'Aim moves along the routes');
    assert(JSON.stringify((await qa('state()')).anchors) === JSON.stringify(anchors0), 'Aim moves no spire or gate');
    await screenshot('03-aim-cycling-1080');

    // Latency: message (or key) → first animation frame, with the label text and lit route already there.
    const committedIds = new Set<string>();
    const aimedId = () => evaluate<string>(`document.querySelector('.xl[data-kind="aimed"]')?.dataset.id ?? ''`);
    const from: number = await qa('records.length');
    for (let i = 0; i < 20; i++) await key('ArrowRight', undefined, 120);
    for (let i = 0; i < 20; i++) await command({ cmd: 'explore_aim', delta: 1 }, 140);
    for (const band of ['mid', 'high', 'low', 'mid', 'high', 'low']) await command({ cmd: 'explore_band', band }, 700);
    for (let i = 0; i < 6; i++) {
      committedIds.add(await aimedId());
      await command({ cmd: 'load_selected', deck: 2 }, 700);
      await command({ cmd: 'explore_back' }, 600);
    }
    const records: any[] = (await qa('records')).slice(from);
    report.latency = {
      localAimKey: latencyOf(records, 'local-aim'),
      aimFromServer: latencyOf(records, 'aim'),
      band: latencyOf(records, 'band'),
      commitFromMixerLoad: latencyOf(records, 'commit'),
      back: latencyOf(records, 'back'),
      note: 'ms from message arrival (or keydown handling) to the first rAF callback; photons follow one display frame later',
    };
    console.log(JSON.stringify(report.latency, null, 1));
    for (const k of ['localAimKey', 'aimFromServer', 'band', 'commitFromMixerLoad']) {
      const l = report.latency[k] as ReturnType<typeof latencyOf>;
      assert(l.samples > 0 && l.firstFrameComplete === l.samples, `${k}: label text and lit route present in the first frame (${l.samples}/${l.samples})`);
    }

    // The commit passage, frame by frame (frozen clock; CSS animations step with it).
    await key('ArrowRight', undefined, 400);
    committedIds.add(await aimedId());
    await qa('freeze()');
    await command({ cmd: 'load_selected', deck: 2 }, 350);
    let at = 0;
    for (const t of [0, 60, 110, 160, 230, 300]) {
      await qa(`advance(${t - at})`);
      at = t;
      await Bun.sleep(80);
      await screenshot(`04-commit-${String(t).padStart(3, '0')}ms`, { half: true });
    }
    await qa('resume()');
    await Bun.sleep(600);
    await command({ cmd: 'explore_back' }, 800);

    // Scouting: M walks a route without a deck; a load claims it. Pick a route no deck has taken.
    const taken = new Set<string>(
      ((await (await fetch(`${mock}/api/decks`)).json()) as { track: { id: string } }[]).map((d) => d.track.id),
    );
    for (const id of committedIds) taken.add(id);
    for (let i = 0; i < 6 && taken.has(await evaluate(`document.querySelector('.xl[data-kind="aimed"]')?.dataset.id ?? ''`)); i++)
      await key('ArrowRight', undefined, 250);
    await key('Enter', undefined, 1400);
    assert((await evaluate(`document.querySelector('.crumbs')?.innerText ?? ''`)).includes('scouting · 1 ahead'), 'Dive (M) is a scout: the breadcrumb says so and the land is misted');
    assert((await qa('state()')).mist > 0.99, 'Scouting mists the land beyond');
    await screenshot('05-scout-1080');
    await command({ cmd: 'load_selected', deck: 3 }, 1200);
    assert(!(await evaluate(`document.querySelector('.crumbs')?.innerText ?? ''`)).includes('scouting'), 'A load claims the scouted route: the mist lifts');
    await command({ cmd: 'load', deck: 3, track_id: playable[9].id });
    await command({ cmd: 'sync', deck: 3, on: true });
    await command({ cmd: 'play', deck: 3 });
    await command({ cmd: 'explore_back' }, 300);
    await command({ cmd: 'explore_back' }, 1200);

    // Realms.
    await click('.band:nth-child(2)');
    await Bun.sleep(1500);
    assert((await evaluate(`document.querySelector('.realm h1').textContent`)) === 'The Greenwold', 'Band mid is the Greenwold');
    await screenshot('06-greenwold-1080');
    await size(1280, 800);
    await click('.band:nth-child(3)');
    await Bun.sleep(1500);
    assert((await evaluate(`document.querySelector('.realm h1').textContent`)) === 'The Highreach', 'Band high is the Highreach');
    await clearLabels('1280×800');
    await screenshot('07-highreach-800');
    await click('.band:nth-child(1)');
    await Bun.sleep(1200);

    // A loop: a rune ring by its Keeper; the HUD keeps the length.
    await command({ cmd: 'loop', deck: 1 });
    await command({ cmd: 'loop_length', deck: 1, steps: 1 });
    await Bun.sleep(1200);
    assert(await evaluate(`!!document.querySelector('.deck:nth-child(2) .loop')`), 'Loop and its length show on deck 2');
    await clearLabels('1280×800 with a loop');
    await screenshot('08-loop-800');
    await measure('1280×800 / four decks / loop / low', 10);

    // Search by typing anywhere; real Chromium drag data dropped on a deck.
    await key('a', 'a');
    assert(await evaluate(`!!document.querySelector('[role="dialog"] input')`), 'Typing anywhere opens search');
    await evaluate(`(()=>{const i=document.querySelector('input[type="search"]');i.value='Arcadia';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await Bun.sleep(400);
    const dragEvent = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Drag did not start')), 5000);
      c.events.set('Input.dragIntercepted', (e) => {
        clearTimeout(timer);
        resolve(e);
      });
    });
    await c.call('Input.setInterceptDrags', { enabled: true });
    const points = await evaluate(
      `(()=>{const a=document.querySelector('.results .row').getBoundingClientRect(),b=document.querySelector('.deck:nth-child(4)').getBoundingClientRect();return {x:a.x+80,y:a.y+a.height/2,tx:b.x+b.width/2,ty:b.y+b.height/2}})()`,
    );
    await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.x, y: points.y });
    await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: points.x, y: points.y });
    await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: points.x + 12, y: points.y + 12 });
    const drag = await dragEvent;
    for (const type of ['dragEnter', 'dragOver', 'drop']) await c.call('Input.dispatchDragEvent', { type, x: points.tx, y: points.ty, data: drag.data });
    await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: points.tx, y: points.ty });
    await c.call('Input.setInterceptDrags', { enabled: false });
    await Bun.sleep(1500);
    assert(await evaluate(`document.querySelector('.deck:nth-child(4)').innerText.includes('Arcadia North')`), 'A search result can be dragged onto deck 4');
    assert(
      await evaluate(`document.querySelectorAll('.results .row').length>0 && [...document.querySelectorAll('.results .artist')].every(e=>e.textContent==='Arcadia North')`),
      'Search keeps its typed filter after a drop',
    );
    await screenshot('09-search-drag-800');
    await key('Escape');
    await command({ cmd: 'load', deck: 3, track_id: playable[9].id });
    await command({ cmd: 'sync', deck: 3, on: true });
    await command({ cmd: 'play', deck: 3 });

    // Vigil: nothing playing.
    await size(1920, 1080);
    for (let deck = 0; deck < 4; deck++) await command({ cmd: 'pause', deck }, 20);
    await Bun.sleep(2600);
    const vigil = await qa('state()');
    assert(vigil.vigil > 0.99 && vigil.speed < 0.15, `Vigil: travel drifts to a stop (${round(vigil.speed)} u/s) and the realm keeps watch`);
    await screenshot('10-vigil-1080');
    for (let deck = 0; deck < 4; deck++) await command({ cmd: 'play', deck }, 20);
    await Bun.sleep(1200);

    // Ages of the mix.
    for (const [name, minutes] of [['dawn', 2], ['day', 25], ['dusk', 55], ['night', 110]] as const) {
      await qa(`setMinutes(${minutes})`);
      await Bun.sleep(2200);
      await screenshot(`11-age-${name}-1080`);
    }
    await qa('setMinutes(25)');

    // The dragon: shadow first, body second; and its far form at the horizon.
    await qa('freeze()');
    await qa(`dragon('flyover')`);
    await qa('advance(3200)');
    await Bun.sleep(100);
    await screenshot('12-dragon-shadow-1080');
    await qa('advance(5600)');
    await Bun.sleep(100);
    await screenshot('13-dragon-flyover-1080');
    await qa('resume()');
    await Bun.sleep(9000);
    await qa(`dragon('far')`);
    await Bun.sleep(2500);
    await screenshot('14-dragon-far-1080');

    // Reduced motion: the course holds, no swing, no flyover (a perch instead).
    await c.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await Bun.sleep(1000);
    assert(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), 'Reduced motion switches on without reloading');
    const r1 = (await qa('state()')).course;
    await key('ArrowRight', undefined, 300);
    await command({ cmd: 'load_selected', deck: 2 }, 60);
    let maxYaw = 0;
    for (let i = 0; i < 6; i++) {
      maxYaw = Math.max(maxYaw, Math.abs((await qa('state()')).yaw));
      await Bun.sleep(50);
    }
    await Bun.sleep(1500);
    const r2 = (await qa('state()')).course;
    assert(r2 === r1 && maxYaw === 0, 'Reduced motion: the course holds and the heading never swings');
    await qa(`dragon('drop')`);
    await Bun.sleep(400);
    assert((await qa('state()')).dragon === 3, 'Reduced motion: an earned drop perches the dragon instead of a flyover');
    await size(1280, 800);
    await screenshot('15-reduced-perch-800');
    await c.call('Emulation.setEmulatedMedia', { features: [] });
    await command({ cmd: 'explore_back' }, 800);
    await size(1920, 1080);
    await screenshot('16-current-strip-1080', { clip: { x: 0, y: 700, width: 1920, height: 380 } });

    // Fresh fixtures: the empty prompt and analysis progress.
    if (process.env.WAYFARING_EMPTY) {
      await size(1280, 800);
      await c.call('Page.navigate', { url: `${process.env.WAYFARING_EMPTY}/?qa` });
      await Bun.sleep(2500);
      assert((await evaluate(`document.querySelector('.center .big')?.textContent ?? ''`)).includes('Load a track'), 'Empty library: the no-root prompt');
      await screenshot('17-empty-800');
    }
    if (process.env.WAYFARING_ANALYSIS) {
      await size(1280, 800);
      // A rescan starts the fixture's analysis over, so there is progress to see.
      await fetch(`${process.env.WAYFARING_ANALYSIS}/api/library/rescan`, { method: 'POST' });
      await c.call('Page.navigate', { url: `${process.env.WAYFARING_ANALYSIS}/?qa` });
      await Bun.sleep(3000);
      assert(await evaluate(`!!document.querySelector('.chip.analysis, .realm .analysis')`), 'Analysis progress shows while the library is analysed');
      await screenshot('18-analysis-800');
    }
    if (process.env.WAYFARING_EMPTY || process.env.WAYFARING_ANALYSIS) {
      await size(1920, 1080);
      await c.call('Page.navigate', { url: `${page}/?stats&adaptive=0&qa` });
      await Bun.sleep(3000);
      await setupDecks();
      await Bun.sleep(4000);
    }
  }

  // Performance: pacing, GPU and CPU per frame; allocations in the frame loop.
  await measure('1920×1080 / four decks / low');
  if (perfOnly) {
    await size(2560, 1440);
    await measure('2560×1440 / four decks / low');
    await size(1920, 1080);
  }
  report.allocations = await allocations(8);
  console.log(JSON.stringify(report.allocations, null, 1));

  if (soakSeconds > 0) {
    for (let deck = 0; deck < 4; deck++) {
      const st = (await (await fetch(`${mock}/api/state`)).json()) as any;
      if (!st.decks[deck].loop.active) await command({ cmd: 'loop', deck });
      await command({ cmd: 'play', deck });
    }
    for (let elapsed = 0; elapsed < soakSeconds; elapsed += 30) {
      await Bun.sleep(Math.min(30, soakSeconds - elapsed) * 1000);
      const s = await qa('state()');
      const p = { elapsed: Math.min(soakSeconds, elapsed + 30), course: round(s.course), gpuMs: round(s.gpuMs), cpuMs: round(s.cpuMs), stats: await evaluate(`document.querySelector('.stats')?.innerText`) };
      report.progress.push(p);
      console.log(JSON.stringify(p));
    }
    await measure(`1920×1080 / after a ${soakSeconds} s soak`);
  }
  assert(c.errors.length === 0, 'No browser errors or external network requests');
} finally {
  const name = process.env.WAYFARING_REPORT || (perfOnly ? `performance-${process.env.WAYFARING_LABEL || 'second-gpu'}` : 'verification');
  await Bun.write(`${out}/${name}.json`, JSON.stringify(report, null, 2) + '\n');
  c.close();
}
