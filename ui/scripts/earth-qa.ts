/** Production-bundle check. Requires the mock on 7979 and a dedicated headless
 * Chromium on CDP_PORT (default 9239). Never connects to the live mixer server.
 * Run from the repository root: bun ui/scripts/earth-qa.ts
 * Set EARTH_PERF_ONLY=1 for the second GPU; EARTH_PROGRESS_SECONDS=180 for growth.
 */
import { mkdir } from 'node:fs/promises';

const port = Number(process.env.CDP_PORT || 9239);
if (port === 7878) throw new Error('The live mixer port is forbidden');
const mock = 'http://127.0.0.1:7979';
const out = process.env.EARTH_OUTPUT || 'docs/screenshots/earth';
await mkdir(out, { recursive: true });
const tabs = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
  type: string;
  webSocketDebuggerUrl: string;
}[];
const tab = tabs.find((t) => t.type === 'page');
if (!tab) throw new Error('Start a dedicated headless Chromium page first');
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
      if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params));
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
const c = await connect(tab.webSocketDebuggerUrl);
const report: { gpu?: string; checks: string[]; measurements: unknown[]; progress: unknown[]; errors: string[] } = {
  checks: [],
  measurements: [],
  progress: [],
  errors: c.errors,
};
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
  report.checks.push(message);
};
async function evaluate(expression: string) {
  const r = await c.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function command(data: Record<string, unknown>) {
  const r = (await (
    await fetch(`${mock}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    })
  ).json()) as { ok: boolean; error?: string };
  if (!r.ok) throw new Error(r.error);
  await Bun.sleep(120);
  if (data.cmd === 'load' || data.cmd === 'load_selected') {
    for (let i = 0; i < 50; i++) {
      const state = (await (await fetch(`${mock}/api/state`)).json()) as any;
      if (!state.decks[Number(data.deck)].loading) return;
      await Bun.sleep(100);
    }
    throw new Error('Deck load timed out');
  }
}
async function key(key: string, text?: string) {
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key, text });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key });
  await Bun.sleep(250);
}
async function click(selector: string) {
  const r = await evaluate(
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...r });
  await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...r });
  await Bun.sleep(300);
}
async function screenshot(name: string) {
  // The optional diagnostic overlay is omitted from representative images.
  await evaluate(`document.querySelector('.stats')?.style.setProperty('visibility','hidden')`);
  const r = await c.call('Page.captureScreenshot', { format: 'webp', quality: 83 });
  await Bun.write(`${out}/${name}.webp`, Buffer.from(r.data, 'base64'));
  await evaluate(`document.querySelector('.stats')?.style.removeProperty('visibility')`);
}
async function size(width: number, height: number) {
  await c.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await Bun.sleep(1500);
}
async function measure(label: string) {
  const frames = await evaluate(
    `new Promise(resolve=>{const ds=[];let last=performance.now();const end=last+15000;function frame(now){ds.push(now-last);last=now;if(now<end)requestAnimationFrame(frame);else {ds.shift();ds.sort((a,b)=>a-b);resolve({frames:ds.length,fps:1000/(ds.reduce((a,b)=>a+b,0)/ds.length),p50:ds[Math.floor(ds.length*.5)],p95:ds[Math.floor(ds.length*.95)],p99:ds[Math.floor(ds.length*.99)],over25:ds.filter(n=>n>25).length});}}requestAnimationFrame(frame);})`,
  );
  const stats = await evaluate(`document.querySelector('.stats')?.innerText`);
  const record = { label, ...frames, stats };
  report.measurements.push(record);
  console.log(JSON.stringify(record));
}
/** Nonblocking WebGL timer queries around the world's ten draw calls. */
async function sampleGPU() {
  const gpuMs = await evaluate(`new Promise(resolve=>{
 const gl=document.querySelector('.stage canvas').getContext('webgl2');
 const ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
 if(!ext){resolve({gpuTimer:'unavailable'});return;}
 const oldClear=gl.clear,methods=['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced'];
 const originals=methods.map(k=>gl[k]);
 const calls=Number(document.querySelector('.stats').textContent.match(/(\\d+) calls/)[1]);
 let frame=0,draws=0,query=null,active=false;
 const samples=[];
 gl.clear=function(...args){
   if(active){gl.endQuery(ext.TIME_ELAPSED_EXT);active=false;}
   if(query && gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)){
     if(!gl.getParameter(ext.GPU_DISJOINT_EXT))samples.push(gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6);
     gl.deleteQuery(query);query=null;
   }
   if(!query && (++frame%15)===0){query=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,query);active=true;draws=0;}
   return oldClear.apply(this,args);
 };
 methods.forEach((k,i)=>gl[k]=function(...args){const r=originals[i].apply(this,args);if(active && ++draws===calls){gl.endQuery(ext.TIME_ELAPSED_EXT);active=false;}return r;});
 setTimeout(()=>{
   gl.clear=oldClear;methods.forEach((k,i)=>gl[k]=originals[i]);if(active)gl.endQuery(ext.TIME_ELAPSED_EXT);if(query)gl.deleteQuery(query);
   samples.sort((a,b)=>a-b);resolve({samples:samples.length,mean:samples.reduce((a,b)=>a+b,0)/samples.length,p50:samples[Math.floor(samples.length*.5)],p95:samples[Math.floor(samples.length*.95)],max:Math.max(...samples)});
 },15000);
})`);
  report.measurements.push({ label: 'World GPU time (ms)', gpuMs });
  console.log(JSON.stringify({ gpuMs }));
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
    'Synced deck bar ticks align within one CSS pixel',
  );
}

async function clearLabels() {
  const result = await evaluate(
    `(()=>{const labels=[...document.querySelectorAll('.xl')],footer=document.querySelector('.bottom').getBoundingClientRect();const r=labels.map(e=>e.getBoundingClientRect());return {count:labels.length,inside:r.every(a=>a.left>=0&&a.right<=innerWidth&&a.top>85&&a.bottom<footer.top),overlaps:r.some((a,i)=>r.some((b,j)=>j>i&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top))}})()`,
  );
  assert(
    result.count === 6 && result.inside && !result.overlaps,
    'Six readable candidate labels clear each other and the waveform',
  );
}
try {
  await c.call('Runtime.enable');
  await c.call('Log.enable');
  await c.call('Page.enable');
  await c.call('Network.enable');
  c.events.set('Network.requestWillBeSent', (e) => {
    if (e.request.url.startsWith('http') && !e.request.url.startsWith(mock + '/'))
      c.errors.push(`Unexpected request: ${e.request.url}`);
  });
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
    webSocketDebuggerUrl: string;
  };
  const browser = await connect(version.webSocketDebuggerUrl);
  const info = await browser.call('SystemInfo.getInfo');
  report.gpu = info.gpu.auxAttributes.glRenderer;
  browser.close();
  console.log(report.gpu);
  await size(1920, 1080);
  await c.call('Page.navigate', { url: `${mock}/?stats&adaptive=0` });
  await Bun.sleep(2500);
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
  await Bun.sleep(6000);
  await checkGrid();
  await measure('1920×1080 / four decks / low');
  await sampleGPU();
  if (!process.env.EARTH_PERF_ONLY) {
    await clearLabels();
    await screenshot('01-lowlands-1080');
    const old = await evaluate(`document.querySelector('.xl[data-kind="aimed"]').dataset.id`);
    await key('ArrowRight');
    const aimed = await evaluate(`document.querySelector('.xl[data-kind="aimed"]').dataset.id`);
    assert(aimed !== old, 'Aim control changes the selected path');
    await command({ cmd: 'load_selected', deck: 3 });
    const state = (await (await fetch(`${mock}/api/state`)).json()) as any;
    assert(state.decks[3].track_id === aimed, 'Load-selected loads the aimed track on deck 4');
    await command({ cmd: 'play', deck: 3 });
    await key('Enter');
    await Bun.sleep(3500);
    assert(await evaluate(`!!document.querySelector('.upstream')`), 'Dive exposes the upstream route and breadcrumb');
    await click('.band:nth-child(2)');
    await Bun.sleep(7000);
    assert(
      await evaluate(`document.querySelector('h1').textContent==='The river grove'`),
      'Band switch changes the place',
    );
    await key('Enter');
    await Bun.sleep(3500);
    await screenshot('02-grove-dive-1080');
    await click('.upstream');
    await Bun.sleep(3000);
    assert(await evaluate(`!document.querySelector('.upstream')`), 'Back returns to the root');
    await command({ cmd: 'loop', deck: 1 });
    await command({ cmd: 'loop_length', deck: 1, steps: 1 });
    await size(1280, 800);
    await clearLabels();
    assert(
      await evaluate(`!!document.querySelector('.deck:nth-child(2) .loop')`),
      'Loop and its length remain visible on deck 2',
    );
    await screenshot('03-loop-800');
    await measure('1280×800 / four decks / loop / mid');
    // Keyboard opens search, then real Chromium drag data is delivered to the deck.
    await key('a', 'a');
    assert(await evaluate(`!!document.querySelector('[role="dialog"] input')`), 'Typing anywhere opens search');
    await evaluate(
      `(()=>{const i=document.querySelector('input[type="search"]');i.value='Arcadia';i.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
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
    await c.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      buttons: 1,
      clickCount: 1,
      x: points.x,
      y: points.y,
    });
    await c.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      button: 'left',
      buttons: 1,
      x: points.x + 12,
      y: points.y + 12,
    });
    const drag = await dragEvent;
    for (const type of ['dragEnter', 'dragOver', 'drop'])
      await c.call('Input.dispatchDragEvent', { type, x: points.tx, y: points.ty, data: drag.data });
    await c.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      x: points.tx,
      y: points.ty,
    });
    await c.call('Input.setInterceptDrags', { enabled: false });
    await Bun.sleep(1500);
    assert(
      await evaluate(`document.querySelector('.deck:nth-child(4)').innerText.includes('Arcadia North')`),
      'A search result can be dragged onto deck 4',
    );
    await screenshot('04-search-drag-800');
    await key('Escape');
    await click('.band:nth-child(3)');
    await Bun.sleep(7000);
    await c.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await Bun.sleep(1500);
    await clearLabels();
    await screenshot('05-wetland-calm-800');
    assert(
      await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`),
      'Reduced motion switches on without reloading',
    );
    await c.call('Emulation.setEmulatedMedia', { features: [] });
    await size(1920, 1080);
    // Search can legitimately return an ungridded track. Use a gridded fixture for the loop soak.
    await command({ cmd: 'load', deck: 3, track_id: playable[9].id });
    await command({ cmd: 'sync', deck: 3, on: true });
    const seconds = Number(process.env.EARTH_PROGRESS_SECONDS || 180);
    // All four decks loop, so this is an actual uninterrupted mix, not a time jump.
    for (let deck = 0; deck < 4; deck++) {
      const st = (await (await fetch(`${mock}/api/state`)).json()) as any;
      if (!st.decks[deck].loop.active) await command({ cmd: 'loop', deck });
      await command({ cmd: 'play', deck });
    }
    await screenshot('06-water-before-growth-1080');
    for (let elapsed = 0; elapsed < seconds; elapsed += 30) {
      await Bun.sleep(Math.min(30, seconds - elapsed) * 1000);
      const progress = {
        elapsed: Math.min(seconds, elapsed + 30),
        stats: await evaluate(`document.querySelector('.stats').innerText`),
      };
      report.progress.push(progress);
      console.log(JSON.stringify(progress));
    }
    await clearLabels();
    await screenshot('07-water-after-growth-1080');
    await measure('1920×1080 / mature landscape / high');
  }
  assert(c.errors.length === 0, 'No browser errors or external network requests');
} finally {
  await Bun.write(
    `${out}/${process.env.EARTH_REPORT || (process.env.EARTH_PERF_ONLY ? 'performance-second-gpu' : 'verification')}.json`,
    JSON.stringify(report, null, 2) + '\n',
  );
  c.close();
}
