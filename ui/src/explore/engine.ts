import * as THREE from 'three';
import { fmtBpm, idToName } from '../lib/format';
import type { ExploreMsg, ExploreNode, Track } from '../lib/protocol';
import type { VizFrame } from '../lib/viz';
import { groundHeight, makeGrass, makeLand, makeLife, makePlaces, makeShared, makeSky, makeTrees, makeWater } from './meshes';

export type EngineStats = { fps: number; calls: number; triangles: number; dpr: number; frameMs: number; growth: number; day: number };
export type EngineOptions = {
  canvas: HTMLCanvasElement; labels: HTMLElement; viz: VizFrame;
  track: (id: string) => Track | undefined;
  onAim: (id: string) => void; onDive: (id: string) => void; onAimDelta: (delta: number) => void;
  reducedMotion: boolean; onStats?: (stats: EngineStats) => void;
};
type Place = {
  id: string; node: ExploreNode; parent: string | null; child: boolean; aimed: boolean;
  labelHeight: number; x: number; z: number; tx: number; tz: number; sx: number; sy: number;
  label: HTMLButtonElement | null; title: HTMLElement | null; artist: HTMLElement | null; meta: HTMLElement | null;
};
const FOV=52;
const CAPACITY=96;

/** A single forward render pass. All vegetation motion happens on the GPU. */
export class ExploreEngine {
  readonly #o: EngineOptions;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene=new THREE.Scene();
  readonly #camera=new THREE.PerspectiveCamera(FOV,1,.2,650);
  readonly #shared=makeShared();
  readonly #placesMesh=makePlaces(this.#shared,CAPACITY);
  readonly #places=new Map<string,Place>();
  readonly #resize: ResizeObserver;
  readonly #point=new THREE.Vector3();
  readonly #matrix=new THREE.Matrix4();
  readonly #rotation=new THREE.Quaternion();
  readonly #scale=new THREE.Vector3();
  readonly #position=new THREE.Vector3();
  #msg: ExploreMsg | null=null;
  #hint='';
  #raf=0;
  #last=0;
  #time=0;
  #musicTime=0;
  #width=1;
  #height=1;
  #bottomInset=300;
  #dpr=1;
  #maxDpr=1;
  #reduced=false;
  #disposed=false;
  #placeTarget=0;
  #bandTarget=0;
  #travel=0;
  #travelDir=1;
  #labelAt=0;
  #statsAt=0;
  #frameEma=16.67;
  #drawEma=0;
  #slow=0;
  #adaptive=true;
  #wheel=0;
  #wheelAt=0;
  #levels=new Float32Array(3);
  #onsets=0;
  #gust=0;

  constructor(o: EngineOptions) {
    this.#o=o;
    this.#reduced=o.reducedMotion;
    const params=new URLSearchParams(location.search);
    this.#renderer=new THREE.WebGLRenderer({canvas:o.canvas,antialias:true,alpha:false,stencil:false,powerPreference:'high-performance'});
    this.#renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.#maxDpr=Math.min(1.5,Math.max(.75,Number(params.get('dpr')) || window.devicePixelRatio || 1));
    this.#dpr=this.#maxDpr;
    this.#adaptive=params.get('adaptive')!=='0';
    const s=this.#shared;
    this.#scene.add(makeSky(s),makeLand(s),makeWater(s),makeGrass(s),...makeTrees(s),makeLife(s,false),makeLife(s,true),this.#placesMesh.paths,this.#placesMesh.stones);
    this.#camera.position.set(0,8,27);
    this.#camera.lookAt(0,3,-65);
    this.#resize=new ResizeObserver(this.#onResize);
    this.#resize.observe(o.canvas.parentElement ?? o.canvas);
    this.#onResize();
    o.canvas.addEventListener('click',this.#click);
    o.canvas.addEventListener('dblclick',this.#doubleClick);
    o.canvas.addEventListener('wheel',this.#onWheel,{passive:false});
    o.labels.addEventListener('click',this.#labelClick);
    o.labels.addEventListener('dblclick',this.#labelDoubleClick);
    document.addEventListener('visibilitychange',this.#visibility);
    this.#start();
  }

  setExplore(msg: ExploreMsg | null) {
    const prev=this.#msg;
    this.#msg=msg;
    this.#bandTarget=msg?.band==='mid' ? 1 : msg?.band==='high' ? 2 : 0;
    if (msg?.current) this.#placeTarget=hash(msg.current)*26+this.#bandTarget*7;
    if (!prev) this.#shared.uPlace.value=this.#placeTarget;
    if (prev && msg && (msg.reason==='dive' || msg.reason==='back')) {
      this.#travel=this.#reduced ? 0 : 1;
      this.#travelDir=msg.reason==='back' ? -1 : 1;
    }
    this.#layout();
  }
  setBottomInset(pixels: number) { this.#bottomInset=pixels; }
  setHint(text: string) { this.#hint=text; this.refreshLabels(); }
  setReducedMotion(reduced: boolean) { this.#reduced=reduced; if(reduced) this.#travel=0; }
  refreshLabels() {
    for (const p of this.#places.values()) this.#fillLabel(p);
  }

  #layout() {
    const msg=this.#msg;
    const children=msg?.current ? msg.nodes.filter(n=>n.parent===msg.current) : [];
    const wanted=new Set<string>();
    const aimed=children.find(n=>n.id===msg?.aim) ?? children[0];
    const siblings=children.filter(n=>n!==aimed);
    const aspect=this.#width/this.#height;
    const tan=Math.tan(FOV*Math.PI/360);
    const place=(node: ExploreNode,x: number,z: number,child: boolean,isAim: boolean) => {
      if(wanted.has(node.id) || wanted.size>=CAPACITY) return;
      wanted.add(node.id);
      let p=this.#places.get(node.id);
      if(!p) {
        p={id:node.id,node,labelHeight:100,parent:node.parent,child,aimed:isAim,x,z,tx:x,tz:z,sx:0,sy:0,label:null,title:null,artist:null,meta:null};
        this.#places.set(node.id,p);
      }
      p.node=node; p.parent=node.parent; p.child=child; p.aimed=isAim; p.tx=x;p.tz=z;
      if(child && !p.label) {
        p.label=document.createElement('button'); p.label.type='button';p.label.className='xl';p.label.dataset.id=p.id;
        p.title=document.createElement('span');p.title.className='xl-t';
        p.artist=document.createElement('span');p.artist.className='xl-a';
        p.meta=document.createElement('span');p.meta.className='xl-m';
        p.label.append(p.title,p.artist,p.meta);this.#o.labels.append(p.label);
      }
      if(!child && p.label) {p.label.remove();p.label=null;p.title=null;p.artist=null;p.meta=null;}
      this.#fillLabel(p);
    };
    if(aimed) place(aimed,0,-1,true,true);
    siblings.forEach((node,i)=>{
      const f=siblings.length===1 ? .26 : .10+i*.80/Math.max(1,siblings.length-1);
      const d=44+(1-Math.abs(f-.5)*2)*48;
      place(node,(f-.5)*2*d*tan*aspect,27-d,true,false);
    });
    // The next generation is visible as smaller cairns along forked paths.
    for(const child of children) {
      const parent=this.#places.get(child.id);
      if(!parent) continue;
      const grands=msg?.nodes.filter(n=>n.parent===child.id) ?? [];
      grands.forEach((n,j)=>place(n,parent.tx+(j-(grands.length-1)/2)*2.8,parent.tz-12-Math.abs(j-(grands.length-1)/2)*2,false,false));
    }
    for(const [id,p] of this.#places) if(!wanted.has(id)){p.label?.remove();this.#places.delete(id);}
  }

  #fillLabel(p: Place) {
    if(!p.label || !p.title || !p.artist || !p.meta) return;
    const track=this.#o.track(p.id);
    const title=track?.title ?? idToName(p.id);
    const artist=track?.artist ?? 'Unknown artist';
    const bpm=fmtBpm(p.node.tempo ?? track?.bpm ?? null) || '—';
    p.label.style.width=`${Math.round(p.aimed ? Math.min(390,this.#width*.32) : Math.min(220,this.#width*.165))}px`;
    p.label.dataset.kind=p.aimed ? 'aimed' : 'child';
    p.label.setAttribute('aria-pressed',String(p.aimed));
    p.label.title=`${title} — ${artist} · ${bpm} BPM · ${Math.round(p.node.sim*100)}% similar${p.aimed && this.#hint ? ` · ${this.#hint}` : ''}`;
    p.title.textContent=title;p.artist.textContent=artist;
    p.meta.textContent=`${Math.round(p.node.sim*100)}% similar  ·  ${bpm} BPM`;
    p.labelHeight=p.label.offsetHeight;
  }

  #start() { if(this.#disposed || document.hidden) return;this.#last=performance.now();this.#raf=requestAnimationFrame(this.#frame); }
  #visibility=()=>{cancelAnimationFrame(this.#raf);if(!document.hidden)this.#start();};
  #frame=(now: number)=>{
    if(this.#disposed) return;
    this.#raf=requestAnimationFrame(this.#frame);
    const raw=now-this.#last;
    const dt=Math.min(.05,Math.max(0,raw/1000));this.#last=now;this.#time+=dt;
    const begin=performance.now();
    const live=this.#o.viz.at>0 && now-this.#o.viz.at<500;
    const viz=this.#o.viz,s=this.#shared;
    const k=1-Math.exp(-dt/1.4);
    let energy=0;
    for(let i=0;i<3;i++){this.#levels[i]+=((live?viz.bands[i]:0)-this.#levels[i])*k;energy+=this.#levels[i]/3;}
    if(live && energy>.015)this.#musicTime+=dt*(.3+energy*.7);
    if(viz.onsets!==this.#onsets){this.#onsets=viz.onsets;if(live)this.#gust=Math.min(1,this.#gust+.08);}
    this.#gust*=Math.exp(-dt/1.8);
    for(let i=0;i<64;i++)s.uSpectrum.value[i]+=((live?viz.spectrum[i]:0)-s.uSpectrum.value[i])*k;
    for(let i=0;i<4;i++){
      const d=live ? viz.decks[i] : undefined;
      const target=d ? (d[0]+d[1]+d[2])/3 : 0;
      s.uDecks.value.setComponent(i,s.uDecks.value.getComponent(i)+(target-s.uDecks.value.getComponent(i))*k);
    }
    s.uTime.value=this.#time;
    s.uMotion.value=this.#reduced ? 0 : 1;
    s.uWind.value+=((energy+this.#gust*.15)-s.uWind.value)*k;
    s.uGrowth.value=1-Math.exp(-this.#musicTime/100);
    s.uDay.value=(1-Math.cos(this.#musicTime/150))*.42;
    s.uLife.value+=(Math.min(1,energy*.85+s.uGrowth.value*.7)-s.uLife.value)*(1-Math.exp(-dt/8));
    s.uPlace.value+=(this.#placeTarget-s.uPlace.value)*(1-Math.exp(-dt/(this.#reduced?3:1.5)));
    s.uBand.value+=(this.#bandTarget-s.uBand.value)*(1-Math.exp(-dt/2.5));
    this.#travel=Math.max(0,this.#travel-dt*.44);
    const travel=Math.sin(this.#travel*Math.PI)*this.#travelDir;
    this.#camera.position.set(0,8,27-travel*9);
    this.#camera.lookAt(0,3,-65);
    this.#camera.updateMatrixWorld();
    const settling=1-Math.exp(-dt*4);
    for(const p of this.#places.values()){p.x+=(p.tx-p.x)*settling;p.z+=(p.tz-p.z)*settling;}
    // Geometry and DOM only need 20 Hz; wind and water still render at display cadence.
    if(now-this.#labelAt>50){this.#updatePlaces();this.#labelAt=now;}
    this.#renderer.render(this.#scene,this.#camera);
    this.#drawEma+=(performance.now()-begin-this.#drawEma)*.05;
    if(raw>0)this.#frameEma+=(raw-this.#frameEma)*.025;
    if(this.#adaptive && this.#time>8 && this.#frameEma>19){
      this.#slow+=dt;
      if(this.#slow>3 && this.#dpr>.75){this.#dpr=Math.max(.75,this.#dpr-.15);this.#applySize();this.#slow=0;}
    } else this.#slow=0;
    if(now-this.#statsAt>500){
      const info=this.#renderer.info.render;
      const fps=Math.round(1000/this.#frameEma);
      this.#o.onStats?.({fps,calls:info.calls,triangles:info.triangles,dpr:this.#dpr,frameMs:this.#drawEma,growth:s.uGrowth.value,day:s.uDay.value});
      this.#statsAt=now;
    }
  };

  #updatePlaces() {
    const {stones,paths,positions,strengths}=this.#placesMesh;
    let stone=0,vertex=0;
    for(const p of this.#places.values()) {
      const size=p.aimed ? 1.1 : p.child ? .7 : .24;
      for(let j=0;j<3;j++){
        this.#position.set(p.x,j*size*.4+.25,p.z);
        this.#scale.set(size*(1-j*.22),size*.3,size*(.72-j*.12));
        this.#matrix.compose(this.#position,this.#rotation,this.#scale);stones.setMatrixAt(stone++,this.#matrix);
      }
      const parent=p.child ? undefined : this.#places.get(p.parent ?? '');
      const x0=parent?.x ?? 0,z0=parent?.z ?? 14;
      const width=p.aimed ? .45 : p.child ? .22 : .09;
      for(let j=0;j<24;j++) {
        const t0=j/24,t1=(j+1)/24;
        const ax=x0+(p.x-x0)*t0*t0,az=z0+(p.z-z0)*t0;
        const bx=x0+(p.x-x0)*t1*t1,bz=z0+(p.z-z0)*t1;
        // Two triangles; no temporary arrays in this update path.
        for(let v=0;v<6;v++){
          const end=v===2 || v===4 || v===5;
          const right=v===1 || v===4 || v===5;
          positions[vertex*3]=(end?bx:ax)+(right?width:-width);
          positions[vertex*3+1]=0;positions[vertex*3+2]=end?bz:az;
          strengths[vertex]=p.aimed?1:p.child?.35:.12;vertex++;
        }
      }
      if(p.label){
        this.#point.set(p.x,groundHeight(p.x,p.z,this.#shared.uPlace.value)+size*1.5,p.z).project(this.#camera);
        p.sx=(this.#point.x*.5+.5)*this.#width;p.sy=(-this.#point.y*.5+.5)*this.#height;
        // Keep the labels comfortably in the scene at both booth display sizes.
        const labelWidth=p.aimed ? Math.min(390,this.#width*.32) : Math.min(220,this.#width*.165);
        const x=Math.max(labelWidth/2+12,Math.min(this.#width-labelWidth/2-12,p.sx));
        const aimHeight=this.#places.get(this.#msg?.aim ?? '')?.labelHeight ?? 150;
        const bottom=this.#height-this.#bottomInset-20;
        const limit=p.aimed ? bottom : bottom-aimHeight-24;
        const y=Math.max(220,Math.min(limit,p.sy-18));
        p.label.style.width=`${Math.round(labelWidth)}px`;
        p.label.style.transform=`translate(${Math.round(x)}px,${Math.round(y)}px) translate(-50%,-100%)`;
      }
    }
    stones.count=stone;stones.instanceMatrix.needsUpdate=true;
    paths.geometry.setDrawRange(0,vertex);
    paths.geometry.attributes.position.needsUpdate=true;paths.geometry.attributes.aStrength.needsUpdate=true;
  }

  #onResize=()=>{
    const el=this.#o.canvas.parentElement ?? this.#o.canvas;
    this.#width=Math.max(1,el.clientWidth);this.#height=Math.max(1,el.clientHeight);
    this.#applySize();this.#layout();
  };
  #applySize(){this.#renderer.setPixelRatio(this.#dpr);this.#renderer.setSize(this.#width,this.#height,false);this.#camera.aspect=this.#width/this.#height;this.#camera.updateProjectionMatrix();}
  #pick(e: MouseEvent){
    const rect=this.#o.canvas.getBoundingClientRect();let best: Place | null=null;let distance=45;
    for(const p of this.#places.values())if(p.child){const d=Math.hypot(e.clientX-rect.left-p.sx,e.clientY-rect.top-p.sy);if(d<distance){distance=d;best=p;}}
    return best?.id;
  }
  #click=(e: MouseEvent)=>{const id=this.#pick(e);if(id)this.#o.onAim(id);};
  #doubleClick=(e: MouseEvent)=>{const id=this.#pick(e);if(id)this.#o.onDive(id);};
  #labelClick=(e: MouseEvent)=>{const id=(e.target as HTMLElement)?.closest<HTMLElement>('.xl')?.dataset.id;if(id)this.#o.onAim(id);};
  #labelDoubleClick=(e: MouseEvent)=>{const id=(e.target as HTMLElement)?.closest<HTMLElement>('.xl')?.dataset.id;if(id)this.#o.onDive(id);};
  #onWheel=(e: WheelEvent)=>{
    e.preventDefault();const now=performance.now();if(now-this.#wheelAt>400)this.#wheel=0;this.#wheelAt=now;
    this.#wheel+=Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.deltaY;
    if(Math.abs(this.#wheel)>=(e.deltaMode===1?3:80)){this.#o.onAimDelta(Math.sign(this.#wheel));this.#wheel=0;}
  };
  dispose(){
    this.#disposed=true;cancelAnimationFrame(this.#raf);this.#resize.disconnect();
    document.removeEventListener('visibilitychange',this.#visibility);
    this.#o.canvas.removeEventListener('click',this.#click);this.#o.canvas.removeEventListener('dblclick',this.#doubleClick);this.#o.canvas.removeEventListener('wheel',this.#onWheel);
    this.#o.labels.removeEventListener('click',this.#labelClick);this.#o.labels.removeEventListener('dblclick',this.#labelDoubleClick);
    for(const p of this.#places.values())p.label?.remove();
    this.#scene.traverse(obj=>{if(obj instanceof THREE.Mesh){obj.geometry.dispose();if(Array.isArray(obj.material))obj.material.forEach(m=>m.dispose());else obj.material.dispose();}});
    this.#renderer.dispose();
  }
}
export function createExploreEngine(o: EngineOptions){return new ExploreEngine(o);}
function hash(s: string){let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return(h>>>0)/4294967296;}
