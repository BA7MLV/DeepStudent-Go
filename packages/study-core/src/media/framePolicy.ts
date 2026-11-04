/** Pure selection policy. Both browser Canvas and server native ports supply pixels. */
export function frameDiff(a: Uint8Array, b: Uint8Array): number {
  let sum=0;
  for(let i=0;i<a.length;i++) sum+=Math.abs(a[i]-b[i]);
  return sum/a.length;
}
export function frameTimes(duration: number, interval=20): number[] {
  const out:number[]=[];
  for(let t=Math.min(2,duration*.02);t<duration-1;t+=interval) out.push(t);
  return out;
}
export function coverTimes(duration: number): number[] {
  const start=Math.min(3,duration*.02),end=Math.max(start,Math.min(duration-.2,start+Math.min(duration*.4,120)));
  return Array.from({length:5},(_,i)=>Math.max(0,Math.round((start+(end-start)*i/4)*100)/100));
}
export function grayPixels(data: Uint8Array | Uint8ClampedArray): Uint8Array {
  const gray=new Uint8Array(data.length/4);
  for(let i=0;i<gray.length;i++) gray[i]=(data[i*4]*299+data[i*4+1]*587+data[i*4+2]*114)/1000;
  return gray;
}
export function probeStats(gray: Uint8Array,w:number,h:number) {
  let sum=0,sum2=0,n=0;
  for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++) {
    const i=y*w+x,v=gray[i-w]+gray[i+w]+gray[i-1]+gray[i+1]-4*gray[i];sum+=v;sum2+=v*v;n++;
  }
  return {mean:gray.reduce((a,b)=>a+b,0)/gray.length/255,lap:n?sum2/n-(sum/n)**2:0};
}
export function bestCover<T extends {mean:number;lap:number;stab:number}>(raws:T[]):T {
  if(!raws.length) throw new Error('无法从视频中取到任何一帧');
  const min=Math.min(...raws.map(r=>r.lap)),span=Math.max(...raws.map(r=>r.lap))-min;
  let best=raws[0],score=-1;
  for(const r of raws) {
    const light=r.mean<.15?r.mean/.15:r.mean>.85?(1-r.mean)/.15:1;
    const current=light*(.55*(span>1e-6?(r.lap-min)/span:1)+.45*r.stab);
    if(current>score+1e-9) {score=current;best=r;}
  }
  return best;
}
export function frameCaption(text:string) {
  return {isSlide:!text.includes('类型：无')&&text.length>8,caption:text.replace(/^类型：.*$/m,'').trim().slice(0,120)||'课程画面'};
}
/** Existing 4-bit RGB quantization, excluding near-black/white backgrounds. */
export function dominantColor(data:Uint8Array|Uint8ClampedArray):string|undefined {
  const buckets=new Map<number,{r:number;g:number;b:number;n:number}>();
  for(let i=0;i<data.length;i+=4) {
    const [r,g,b,a]=data.subarray(i,i+4);
    if(a<128||Math.max(r,g,b)<24||Math.min(r,g,b)>232)continue;
    const key=((r>>4)<<8)|((g>>4)<<4)|(b>>4),hit=buckets.get(key);
    if(hit){hit.r+=r;hit.g+=g;hit.b+=b;hit.n++;}else buckets.set(key,{r,g,b,n:1});
  }
  let best:{r:number;g:number;b:number;score:number}|undefined;
  for(const b of buckets.values()) {
    const r=b.r/b.n,g=b.g/b.n,blue=b.b/b.n,max=Math.max(r,g,blue)/255,min=Math.min(r,g,blue)/255,l=(max+min)/2,d=max-min;
    const s=d===0?0:d/(l>.5?2-max-min:max+min),score=b.n*(.35+s)*(l<.12||l>.92?.25:1);
    if(!best||score>best.score)best={r,g,b:blue,score};
  }
  return best?'#'+[best.r,best.g,best.b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join(''):undefined;
}
