import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mediaProcess, ffmpeg, inheritedInput, formats } from './media-process.js';
import type { TaskContext } from '../src/cloud/execution.js';

/** The server owns both path and descriptor. Unlink immediately; cancellation
 * leaves no named temporary images or path supplied by a model/user. */
export async function imageProcess(context:TaskContext,bytes:Buffer,mode:'text'|'probe'|'cover') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-image-'));
  const name=path.join(dir,'input');let fd:number|undefined;
  try {
    fd=fs.openSync(name,'wx+',0o600);fs.unlinkSync(name);fs.writeSync(fd,bytes,0,bytes.length,0);
    return await mediaProcess(context,process.execPath,['--max-old-space-size=128',new URL('./image-process.mjs',import.meta.url).pathname,mode],fd,4*1024*1024);
  }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmdirSync(dir);}
}
export async function imageStats(context:TaskContext,bytes:Buffer):Promise<{width:number;height:number;gray:number[];mean:number;lap:number;color?:string}> {
  return JSON.parse((await imageProcess(context,bytes,'probe')).toString('utf8'));
}
export async function videoInfo(context:TaskContext,fd:number):Promise<{duration:number;width:number;height:number}> {
  const raw=JSON.parse((await mediaProcess(context,'ffprobe',['-v','error','-max_alloc','134217728','-protocol_whitelist','file,pipe','-format_whitelist',formats,'-show_entries','format=duration:stream=codec_type,width,height','-of','json',inheritedInput],fd,1024*1024)).toString('utf8'));
  const stream=raw.streams?.find((s:any)=>s.codec_type==='video');
  const duration=Number(raw.format?.duration);
  if(!stream||!Number.isFinite(duration)||duration<=0||duration>14400)throw new Error('invalid_video_metadata');
  return {duration,width:stream.width,height:stream.height};
}
export function videoFrame(context:TaskContext,fd:number,ts:number,width:number,quality=3) {
  return ffmpeg(context,fd,['-ss',String(ts),'-frames:v','1','-vf',`scale=min(iw\\,${width}):-1`,'-q:v',String(quality),'-f','image2pipe','-vcodec','mjpeg','pipe:1'],4*1024*1024);
}
