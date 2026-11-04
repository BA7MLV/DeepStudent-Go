/** Local Silero legacy model in a bounded disposable process. Stream PCM with
 * backpressure; neither API nor VAD retains the full decoded recording. */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import * as ort from 'onnxruntime-web';
import { SileroTimeline } from '@wangke/study-core/media/vad';
import { inheritedInput, ffmpegInputArgs } from './media-process.js';

ort.env.wasm.numThreads=1;
ort.env.wasm.proxy=false;
const session=await ort.InferenceSession.create(fs.readFileSync(new URL(import.meta.resolve('@wangke/study-core/vad/model'))),{executionProviders:['wasm']});
let h:ort.Tensor=new ort.Tensor('float32',new Float32Array(128),[2,1,64]);
let c:ort.Tensor=new ort.Tensor('float32',new Float32Array(128),[2,1,64]);
const sr=new ort.Tensor('int64',BigInt64Array.from([16000n]));
const limits=process.platform==='linux'?['--as=1073741824','--cpu=120','--nofile=64','--','ffmpeg']:[];
const decoder=spawn(process.platform==='linux'?'prlimit':'ffmpeg',[...limits,...ffmpegInputArgs,'-i',inheritedInput,'-vn','-t','14400','-ac','1','-ar','16000','-af','aresample=async=1:first_pts=0','-f','s16le','pipe:1'],{stdio:['ignore','pipe','ignore',3]});
const done=new Promise<number|null>((resolve,reject)=>{decoder.on('error',reject);decoder.on('close',resolve);});
const timeline=new SileroTimeline();
let pending=Buffer.alloc(0),samples=0;
try {
  for await(const chunk of decoder.stdout!) {
    const data=pending.length?Buffer.concat([pending,chunk]):chunk as Buffer;
    let p=0;
    for(;p+3072<=data.length;p+=3072) {
      const frame=new Float32Array(1536);
      for(let i=0;i<frame.length;i++)frame[i]=data.readInt16LE(p+i*2)/32768;
      const input=new ort.Tensor('float32',frame,[1,1536]);
      const out=await session.run({input,h,c,sr});
      h.dispose();c.dispose();input.dispose();h=out.hn;c=out.cn;
      timeline.accept(Number(out.output.data[0]));out.output.dispose();samples+=1536;
    }
    pending=Buffer.from(data.subarray(p));
  }
  if(await done!==0||samples/16000>=14400)throw new Error('audio_decode_failed');
  process.stdout.write(JSON.stringify(timeline.finish()));
} finally {decoder.kill('SIGKILL');await session.release();h.dispose();c.dispose();sr.dispose();}
