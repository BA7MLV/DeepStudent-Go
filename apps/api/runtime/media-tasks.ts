import { Readable } from 'node:stream';
import fs from 'node:fs';
import { buildHandoutDocx } from '@wangke/study-core/handout/docx';
import { sessionSkills } from './skills.js';
import { chatOnce, textOf } from '@wangke/study-core/model/client';
import { PROMPTS } from '@wangke/study-core/prompts';
import { parseSectionBlocks, collectFigureTimestamps, salvageBlocks, type Block } from '@wangke/study-core/handout/ir';
import { frameTimes, frameDiff, coverTimes, bestCover, frameCaption } from '@wangke/study-core/media/frame-policy';
import { fmtTime } from '@wangke/study-core/text/vtt';
import { commitTask, newRecordId, recordMutation, taskCourseFile, taskFile, taskRows, type TaskContext } from '../src/cloud/execution.js';
import { receiveFile } from '../src/cloud/files.js';
import { ffmpeg, pdfPage, mediaProcess } from './media-process.js';
import { gatewayTaskTarget, gatewayTaskFetch } from '../src/agent/model-gateway-runtime.js';
import { createModelGateway } from '../src/agent/model-gateway-factory.js';
import { importBilibiliSubtitles } from './bilibili-subtitles.js';
import { imageProcess, imageStats, videoInfo, videoFrame } from './frame-port.js';

async function storeImage(context: TaskContext, bytes: Buffer) {
  const file = await receiveFile(context.store, context.filesDir, context.owner, Readable.from([bytes]), 'frame.jpg', 'image/jpeg', 4 * 1024 * 1024);
  return { $file: file.id };
}
function course(context: TaskContext) {
  const id = String(context.task.input.videoId), row = context.records.get(context.owner, 'videos', id);
  if (!row || row.fileDeleted) throw new Error('course_file_unavailable');
  return { id, row };
}
function patchCourse(context: TaskContext, patch: Record<string, unknown>) {
  const { id, row } = course(context);
  commitTask(context, [recordMutation('videos', id, row, { ...row, ...patch })]);
}
export async function serverCover(context: TaskContext, force=false) {
  const id=String(context.task.input.videoId),row=context.records.get(context.owner,'videos',id);
  if(!row)throw new Error('course_file_unavailable');
  const old=context.records.get(context.owner,'covers',id);
  if(old?.source==='user'||old&&!force&&!(context.task.input.options as any)?.force){patchCourse(context,{coverState:'done'});return false;}
  if(row.fileDeleted){commitTask(context,[recordMutation('videos',id,row,{...row,coverState:'skipped'})]);return false;}
  const file = taskCourseFile(context, id);
  if(!file)throw new Error('course_file_unavailable');
  try {
    let bytes:Buffer,ts=1,source='auto';
    if(row.kind==='material') {
      if(!['pdf','md'].includes(row.materialFormat)){file.assertCurrent();patchCourse(context,{coverState:'done'});return false;}
      if(row.materialFormat==='pdf'){bytes=await imageProcess(context,await pdfPage(context,file.fd,1),'cover');source='material-page';}
      else {bytes=await mediaProcess(context,process.execPath,['--max-old-space-size=128',new URL('./image-process.mjs',import.meta.url).pathname,'markdown',String(row.name??'')],file.fd,4*1024*1024);source='material-title';}
    }else {
      const slides=taskRows(context,'frames','videoId',id).filter(f=>f.kind==='slide'&&f.blob).sort((a,b)=>a.ts-b.ts);
      let reused:Buffer|undefined;
      for(const slide of slides) {
        try {const fd=fs.openSync(taskFile(context,slide.blob),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
          try{reused=await mediaProcess(context,process.execPath,['--max-old-space-size=128',new URL('./image-process.mjs',import.meta.url).pathname,'cover'],fd,4*1024*1024);}finally{fs.closeSync(fd);}
          ts=slide.ts;source='slide';break;
        }catch(error){context.checkActive();}
      }
      if(reused)bytes=reused;
      else {
        const {duration}=await videoInfo(context,file.fd),raws:Array<{ts:number;mean:number;lap:number;stab:number}>=[];
        for(const t of coverTimes(duration)) {
          try {
            const stats=await imageStats(context,await videoFrame(context,file.fd,t,64));let stab=1;
            if(t+.35<duration-.05)try{const after=await imageStats(context,await videoFrame(context,file.fd,t+.35,64));stab=1-Math.min(1,frameDiff(Uint8Array.from(stats.gray),Uint8Array.from(after.gray))/40);}catch{context.checkActive();}
            raws.push({ts:t,...stats,stab});
          }catch{context.checkActive();}
        }
        ts=bestCover(raws).ts;bytes=await imageProcess(context,await videoFrame(context,file.fd,ts,480),'cover');
      }
    }
    const stats=await imageStats(context,bytes);
    const blob = await storeImage(context, bytes);
    file.assertCurrent();
    const current = context.records.get(context.owner, 'covers', id);
    if (current?.source === 'user') return false;
    const latest=context.records.get(context.owner,'videos',id);
    commitTask(context, [recordMutation('covers', id, old, { id, videoId: id, blob,w:stats.width,h:stats.height,ts,source,createdAt:Date.now() }),recordMutation('videos',id,latest,{...latest,coverState:'done',dominantColor:stats.color})]);
    return true;
  } finally { file.close(); }
}

/** Bounded decode plus original Silero VAD. Checkpoints are keyed by exact timeline,
 * not just index; a new plan never silently discards completed old segments. */
export async function serverTranscribe(context: TaskContext) {
  const { id, row: video } = course(context);
  const existing = taskRows(context, 'segments', 'videoId', id).sort((a,b) => a.idx-b.idx);
  if (existing.length && existing.every(s => s.status === 1 && s.text)) { patchCourse(context, { status: 'transcribed' }); return; }
  if (!existing.length && context.task.input.skipBiliSubtitles !== true && await importBilibiliSubtitles(context, id, video.biliSource)) { patchCourse(context, { status: 'transcribed' }); return; }
  const file = taskCourseFile(context, id);
  if (!file) throw new Error('course_file_unavailable');
  try {
    context.report({ phase: 'extract', done: 0, total: 1, message: '服务器抽取音频及语音端点…' });
    const worker = new URL('./audio-process.mjs', import.meta.url);
    const ranges: Array<{start:number;end:number}> = JSON.parse((await mediaProcess(context, process.execPath, ['--max-old-space-size=128', worker.pathname], file.fd, 1024 * 1024)).toString('utf8'));
    if (!ranges.length) throw new Error('未检测到语音内容');
    const mismatched = existing.some(s => !ranges[s.idx] || Math.abs(s.start-ranges[s.idx].start) > .25 || Math.abs(s.end-ranges[s.idx].end) > .25);
    if (mismatched) throw new Error('transcription_plan_conflict: 保留旧字幕，请核对后显式清理再重新提交');
    const rows = ranges.map((range, idx) => existing.find(s => s.idx === idx) ?? { id: newRecordId(), videoId: id, idx, ...range, text: '', status: 0 });
    file.assertCurrent();
    commitTask(context, rows.filter(r => !existing.some(s => s.id === r.id)).map(r => recordMutation('segments', r.id, null, r)));
    patchCourse(context, { status: 'transcribing', transcriptionPaused: false });
    const gateway = createModelGateway(context.store, context.configuration, context.fetch);
    for (const row of rows) {
      context.checkActive();
      if (row.status === 1 && row.text) continue;
      const wav = await ffmpeg(context, file.fd, ['-ss', String(row.start), '-t', String(row.end-row.start), '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'], 2 * 1024 * 1024);
      const result = await gateway.request({ owner: context.owner, task: context.task.id, purpose: 'asr', audio: { data: wav.toString('base64'), mime: 'audio/wav', filename: `segment-${row.idx}.wav` }, signal: AbortSignal.any([context.signal, AbortSignal.timeout(300000)]) });
      const text = result.response.text.trim();
      if (!text) throw new Error('asr_empty_result');
      file.assertCurrent();
      const before = context.records.get(context.owner, 'segments', row.id);
      if (!before || JSON.stringify(before)!==JSON.stringify(row)) throw new Error('transcription_checkpoint_conflict');
      const cues = result.response.segments?.map(c => ({ start: Math.max(row.start, row.start+c.start), end: Math.min(row.end, row.start+c.end), text: c.text })).filter(c => c.end>c.start);
      commitTask(context, [recordMutation('segments', row.id, before, { ...before, text, status: 1, ...(cues?.length ? {cues} : {}) })]);
      context.report({ phase: 'asr', done: row.idx+1, total: rows.length, message: `转写 ${row.idx+1}/${rows.length}` });
    }
    patchCourse(context, { status: 'transcribed' });
  } finally { file.close(); }
}

const seconds = (value: string) => value.split(':').reduce((n, p) => n*60+Number(p), 0);
export async function serverHandout(context: TaskContext) {
  const { id, row } = course(context), file = taskCourseFile(context, id);
  if (!file) throw new Error('course_file_unavailable');
  const segments = taskRows(context, 'segments', 'videoId', id).filter(s => s.status === 1 && s.text).sort((a,b) => a.idx-b.idx);
  const oldFrames=taskRows(context,'frames','videoId',id);
  if (!segments.length) { file.close(); throw new Error('course_content_not_indexed'); }
  const target = gatewayTaskTarget(context), fetcher = gatewayTaskFetch(context);
  const vision = gatewayTaskTarget(context, { purpose: 'vision' }), visionFetch = gatewayTaskFetch(context, 'vision');
  const skills = sessionSkills(context, {}, (context.task.input.options as { skillIds?: number[] } | undefined)?.skillIds ?? context.task.input.skillIds ?? []);
  const call = async (prompt: string, images: Buffer[] = []) => textOf(await chatOnce(images.length ? vision : target, { signal: context.signal, max_tokens: 4000, messages: [...skills.messages, {role:'user',content: images.length ? [{ type:'text', text: prompt }, ...images.map(image => ({ type:'image_url' as const, image_url:{url:`data:image/jpeg;base64,${image.toString('base64')}`} }))] : prompt }] }, images.length ? visionFetch : fetcher));
  try {
    const {duration} = await videoInfo(context,file.fd);
    const frames: Array<{ ts:number; bytes:Buffer; caption:string; blob:{$file:string};width:number;height:number }> = [];
    let previous:Uint8Array|undefined,retained=0;
    const times=frameTimes(duration,25);
    for (const [index,ts] of times.entries()) {
      context.report({ phase:'frames', done:index, total:times.length, message:'服务器抽帧与理解画面…' });
      const bytes=await videoFrame(context,file.fd,ts,640,5),stats=await imageStats(context,bytes),gray=Uint8Array.from(stats.gray);
      if(previous&&frameDiff(previous,gray)<16)continue;
      previous=gray;retained++;
      let caption='课程画面',isSlide=true;
      try {({caption,isSlide}=frameCaption(await call(PROMPTS.frameCaption,[bytes])));}catch{context.checkActive();}
      if(isSlide)frames.push({ts,bytes,caption,blob:await storeImage(context,bytes),width:stats.width,height:stats.height});
      if(retained>=60)break;
    }
    let transcript = segments.map(s => `[${fmtTime(s.start)}] ${s.text}`).join('\n');
    if (transcript.length > 12000) {
      const summaries: string[] = [];
      for (let i=0;i<transcript.length;i+=6000) summaries.push(await call(PROMPTS.chunkSummary(transcript.slice(i,i+6000))));
      transcript = summaries.join('\n');
    }
    const raw = (await call(PROMPTS.outline(transcript, String(row.name)))).replace(/```(?:json)?/g,'').trim();
    const outline = JSON.parse(raw.slice(raw.indexOf('{'),raw.lastIndexOf('}')+1));
    if (!Array.isArray(outline.sections) || !outline.sections.length || outline.sections.length>12) throw new Error('invalid_handout_outline');
    const sections: Array<{heading:string;blocks:Block[]}> = [];
    for (const sec of outline.sections) {
      const startSec=seconds(String(sec.start)), endSec=seconds(String(sec.end));
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec<startSec) throw new Error('invalid_handout_range');
      const source = segments.filter(s=>s.start>=startSec-5&&s.start<=endSec+5).map(s=>s.text).join('\n');
      const selected=frames.filter(f=>f.ts>=startSec-10&&f.ts<=endSec+10);
      const notes=selected.map(f=>`- ${fmtTime(f.ts)}：${f.caption}`).join('\n');
       let blocks:Block[]|undefined,raw='';
       for(let attempt=0;attempt<2&&!blocks;attempt++) {
         raw=await call(PROMPTS.section(String(sec.heading),sec.points??[],source||transcript.slice(0,3000),notes,{title:outline.title,summary:outline.summary,skillBlock:''}));
         try{blocks=parseSectionBlocks(raw,{startSec:Math.max(0,startSec-10),endSec:endSec+10});}catch{context.checkActive();}
       }
       blocks??=salvageBlocks(raw);
       sections.push({heading:String(sec.heading),blocks});
      context.report({phase:'writing',done:sections.length,total:outline.sections.length,message:'生成分节讲义…'});
    }
    const images=new Map(frames.map(f=>[Math.floor(f.ts),{data:f.bytes,width:f.width,height:f.height,caption:f.caption}]));
    for(const ts of collectFigureTimestamps(sections)) {
      try {const bytes=await videoFrame(context,file.fd,Math.min(Math.max(0,ts),Math.max(0,duration-.1)),1600,2);images.set(ts,{data:bytes,...jpegDimensions(bytes),caption:images.get(ts)?.caption??'课程画面'});}catch{context.checkActive();}
    }
    const document=await buildHandoutDocx({title:String(outline.title??row.name),courseName:String(row.name),date:new Date().toISOString().slice(0,10),summary:String(outline.summary??''),sections,images});
    const bytes=Buffer.from(await document.arrayBuffer());
    const stored=await receiveFile(context.store,context.filesDir,context.owner,Readable.from([bytes]),'handout.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',32*1024*1024);
    file.assertCurrent();
    const handoutId=newRecordId();
    if(JSON.stringify(taskRows(context,'frames','videoId',id))!==JSON.stringify(oldFrames))throw new Error('handout_frames_conflict');
    commitTask(context,[...frames.map(f=>{const frameId=newRecordId();return recordMutation('frames',frameId,null,{id:frameId,videoId:id,ts:f.ts,blob:f.blob,kind:'slide',caption:f.caption});}),...oldFrames.map(f=>recordMutation('frames',f.id,f,null)),recordMutation('handouts',handoutId,null,{id:handoutId,videoId:id,title:String(outline.title??row.name),createdAt:Date.now(),blob:{$file:stored.id},outlineJson:JSON.stringify(outline),sectionsJson:JSON.stringify(sections),usedSkills:skills.ids})]);
    try{await serverCover(context,true);}catch{context.checkActive();}
    return {handoutId,fileId:stored.id,frames:frames.length};
  } finally { file.close(); }
}

function jpegDimensions(bytes: Buffer) {
  for (let p = 2; p + 8 < bytes.length;) {
    if (bytes[p] !== 0xff) break;
    const marker = bytes[p+1], length = bytes.readUInt16BE(p+2);
    if ([0xc0,0xc1,0xc2].includes(marker)) return {width:bytes.readUInt16BE(p+7),height:bytes.readUInt16BE(p+5)};
    if (length < 2) break;
    p += 2+length;
  }
  throw new Error('invalid_frame_dimensions');
}
