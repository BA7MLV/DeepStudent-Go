import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { unzipSync, strFromU8 } from 'fflate';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner, taskDto } from '../apps/api/src/cloud/tasks.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';
import { mediaProcess } from '../apps/api/runtime/media-process.ts';
import { encodeMessage, fieldBytes, utf8 } from '@wangke/study-core/bilibili/wire';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {createRequire} from 'node:module';
import {mergeSegments,VAD_OPTIONS} from '@wangke/study-core/media/vad';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'server-media-'));
const store=new DatabaseStore(path.join(directory,'db.sqlite')), records=new CloudRecords(store), configuration=new CloudConfiguration(store,path.join(directory,'config'));
const filesDir=path.join(directory,'files');fs.mkdirSync(filesDir);
const owner=crypto.randomUUID(),other=crypto.randomUUID(), now=new Date().toISOString();
for(const id of [owner,other])store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id,id,now);
configuration.save(owner,{...configuration.get(owner),providers:[{id:'mock',name:'Mock',protocol:'openai-chat',apiKey:'mock-only',baseUrl:'https://model.invalid/v1',catalogId:'',serves:['chat','asr','vision']}],llmModel:{providerId:'mock',model:'mock'},asrModel:{providerId:'mock',model:'mock'},visionModel:{providerId:'mock',model:'mock'}});
let requests=0, subtitleRequests=0,noSlides=false,visionCalls=0,failOutline=false,onOutline;
const fetcher=async(url,init)=>{
  if (String(url).endsWith('/DmView')) {
    subtitleRequests++;
    const item=(lan,url)=>encodeMessage([fieldBytes(2,utf8(lan)),fieldBytes(3,utf8(lan)),fieldBytes(4,utf8(lan)),fieldBytes(5,utf8(url))]);
    const message=encodeMessage([fieldBytes(3,encodeMessage([fieldBytes(3,item('zh-Hans','https://aisubtitle.hdslb.com/bfs/test-zh.json')),fieldBytes(3,item('en','https://aisubtitle.hdslb.com/bfs/test-en.json'))]))]);
    const frame=Buffer.alloc(5+message.length);frame.writeUInt32BE(message.length,1);frame.set(message,5);return new Response(frame);
  }
  if (String(url).startsWith('https://aisubtitle.hdslb.com/bfs/')) return Response.json({body:[{from:0,to:2,content:String(url).includes('-zh')?'B站原字幕优先':'Original subtitles'}]});
  requests++;
  if(String(url).endsWith('/audio/transcriptions')) return Response.json({text:'服务器字幕，无需浏览器。',segments:[{start:-1,end:99,text:'句级字幕'},{start:2,end:1,text:'无效区间'}]});
  const body=JSON.parse(init.body), prompt=JSON.stringify(body.messages);
  if(prompt.includes('sections')) {onOutline?.();if(failOutline)return Response.json({choices:[{message:{role:'assistant',content:'invalid outline'},finish_reason:'stop'}]});}
  const content=prompt.includes('blocks') ? JSON.stringify({blocks:[{type:'lead',text:'服务器生成的完整讲义。'},{type:'para',text:'来源像素和字幕均已读取。'},{type:'figure',time:'00:00',caption:'真实来源画面'}]})
    : prompt.includes('sections') ? JSON.stringify({title:'服务器讲义',summary:'测试讲义',sections:[{heading:'第一节',start:'00:00',end:'00:02',points:['测试']}]}) : (++visionCalls,noSlides?'类型：无\n这不是有效的课程课件画面':'类型：课件\n真实课程画面');
  return Response.json({choices:[{message:{role:'assistant',content},finish_reason:'stop'}]});
};
let runner=new CloudTaskRunner(store,{records,configuration,filesDir,fetch:fetcher});
const put=(table,key,value,account=owner)=>records.apply(account,[{id:crypto.randomUUID(),table,key,before:records.get(account,table,key),after:value}]);
function enqueue(kind,input,executor='node',status='queued',account=owner){const id=crypto.randomUUID();store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,account,id,kind,`${kind}:${input.videoId}`,JSON.stringify(input),status,executor,now,now);return id;}
const get=id=>taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
async function until(predicate){const deadline=Date.now()+15000;while(Date.now()<deadline){if(predicate())return;await new Promise(r=>setTimeout(r,20));}throw new Error('server media timeout');}
async function complete(id){await until(()=>['completed','failed','interrupted'].includes(get(id).status));assert.equal(get(id).status,'completed',JSON.stringify(get(id)));return get(id);}
async function upload(id,name,bytes,format){const file=await receiveFile(store,filesDir,owner,Readable.from([bytes]),name,'application/octet-stream',bytes.length,bytes.length);put('videos',id,{id,name,duration:2,...(format?{kind:'material',materialFormat:format}:{})});put('courseFiles',id,{id,fileId:file.id});return file;}
try{
  assert.equal(typeof window,'undefined','no browser realm exists');
  const video=path.join(directory,'fixture.mp4');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=320x180:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','mpeg4','-c:a','aac','-shortest',video]);
  await upload('video','fixture.mp4',fs.readFileSync(video));
  const parityFd=fs.openSync(video,'r');
  try {
    const pcm=execFileSync('ffmpeg',['-v','error','-i',video,'-vn','-ac','1','-ar','16000','-af','aresample=async=1:first_pts=0','-f','s16le','pipe:1']);
    const float=new Float32Array(pcm.length/2);for(let i=0;i<float.length;i++)float[i]=pcm.readInt16LE(i*2)/32768;
    const {NonRealTimeVAD}=createRequire(import.meta.url)('@ricky0123/vad-web/dist/non-real-time-vad.js');
    const vad=await NonRealTimeVAD.new({...VAD_OPTIONS,modelFetcher:async()=>{const model=fs.readFileSync(new URL(import.meta.resolve('@wangke/study-core/vad/model')));return model.buffer.slice(model.byteOffset,model.byteOffset+model.length);},ortConfig:ort=>{ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;}});
    const original=[];for await(const segment of vad.run(float,16000))original.push({start:segment.start/1000,end:segment.end/1000});
    const actual=JSON.parse(execFileSync(process.execPath,['apps/api/dist/apps/api/runtime/audio-process.mjs'],{stdio:['ignore','pipe','pipe',parityFd]}));
    const rounded=rows=>rows.map(r=>[r.start.toFixed(6),r.end.toFixed(6)]);assert.deepEqual(rounded(actual),rounded(mergeSegments(original)),'real original NonRealTimeVAD and server ONNX worker use identical timestamps');
  }finally{fs.closeSync(parityFd);}
  await upload('md','<script>alert(1)</script>.md',Buffer.from('# 标题卡正文'),'md');
  await upload('html','fixture.html',Buffer.from('<html><body><main><h1>真实材料</h1><p>服务器保留正文<script>fetch("http://127.0.0.1/unsafe")</script></p><iframe src="http://127.0.0.1/unsafe"></iframe></main></body></html>'),'html');
  // Small valid, binary PDF fixture with a real text stream and xref offsets.
  let pdf='%PDF-1.4\n';const offsets=[0];const stream='BT /F1 18 Tf 40 100 Td (Real PDF source text for server parsing.) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await upload('pdf','fixture.pdf',Buffer.from(pdf),'pdf');
  const legacy=enqueue('cover',{videoId:'video'},'browser');
  const uncertain=enqueue('handout',{videoId:'video'},'browser','running');
  store.db.prepare('UPDATE cloud_tasks SET progress=? WHERE id=?').run('{"checkpoint":"preserve"}',uncertain);
  runner.start('http://127.0.0.1:1');
  await complete(legacy);assert.equal(get(legacy).executor,'node');
  assert.equal(get(uncertain).status,'interrupted');assert.deepEqual(get(uncertain).progress,{checkpoint:'preserve'});
  const cover=records.get(owner,'covers','video');assert.ok(cover.blob.$file);assert.equal(records.get(other,'covers','video'),null);
  await complete(enqueue('transcribe',{videoId:'video'}));
  put('videos','bili',{id:'bili',name:'B站课程',biliSource:{aid:1,cid:2}});
  const beforeSubtitles=requests;await complete(enqueue('transcribe',{videoId:'bili'}));
  assert.equal(requests,beforeSubtitles,'original subtitles avoid paid ASR');assert.equal(subtitleRequests,1);
  const tracks=store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='subtitleTracks' AND value IS NOT NULL").all(owner).map(r=>JSON.parse(r.value));assert.equal(tracks.length,2);assert.equal(tracks.find(t=>t.primary===1).lang,'zh-Hans');
  const segments=store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='segments' AND value IS NOT NULL").all(owner).map(r=>JSON.parse(r.value));assert.ok(segments.some(s=>s.status===1&&s.text.includes('服务器字幕')));
  const cueSegment=segments.find(s=>s.videoId==='video');assert.equal(cueSegment.cues.length,1);assert.equal(cueSegment.cues[0].start,cueSegment.start);assert.equal(cueSegment.cues[0].end,cueSegment.end);
  const count=requests;await complete(enqueue('transcribe',{videoId:'video'}));assert.equal(requests,count,'completed checkpoint never retranscribes');
  const handout=await complete(enqueue('handout',{videoId:'video'}));
  const stored=store.db.prepare('SELECT storage_name FROM files WHERE id=? AND owner_id=?').get(handout.result.fileId,owner);const zip=unzipSync(fs.readFileSync(path.join(filesDir,stored.storage_name)));
  assert.ok(Object.entries(zip).some(([key,bytes])=>key.startsWith('word/media/')&&bytes[0]===0xff&&bytes[1]===0xd8),'DOCX contains real binary source JPEG image');assert.ok(strFromU8(zip['word/document.xml']).includes('服务器生成'));
  const rows=(table,id)=>store.db.prepare('SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND value IS NOT NULL').all(owner,table).map(r=>JSON.parse(r.value)).filter(r=>r.videoId===id);
  const originalFrames=rows('frames','video');await complete(enqueue('handout',{videoId:'video'}));assert.equal(rows('frames','video').length,originalFrames.length,'regeneration replaces frames instead of appending');assert.ok(fs.existsSync(path.join(filesDir,stored.storage_name)),'old illustrated DOCX kept intact');
  const preservedFrames=rows('frames','video');failOutline=true;const failed=enqueue('handout',{videoId:'video'});await until(()=>get(failed).status==='failed');failOutline=false;assert.deepEqual(rows('frames','video'),preservedFrames,'model failure preserves old frame IDs, captions and image references');
  onOutline=()=>{const frame=preservedFrames[0];put('frames',frame.id,{...frame,caption:'用户并发修改'});};const conflict=enqueue('handout',{videoId:'video'});await until(()=>get(conflict).status==='failed');onOutline=undefined;assert.match(get(conflict).error,/handout_frames_conflict/);assert.equal(rows('frames','video')[0].caption,'用户并发修改','frame CAS preserves concurrent edit');
  const quality=path.join(directory,'quality.mp4');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=1280x720:r=1:d=4','-f','lavfi','-i','color=c=blue:s=1280x720:r=1:d=56','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-c:v','mpeg4',quality]);
  await upload('quality','quality.mp4',fs.readFileSync(quality));
  await complete(enqueue('cover',{videoId:'quality'}));const chosen=records.get(owner,'covers','quality');assert.ok(chosen.ts>=4,'multi-point score avoids black first candidate');assert.equal(chosen.w,480);assert.equal(chosen.h,270);assert.ok(records.get(owner,'videos','quality').dominantColor);
  put('segments',999,{id:999,videoId:'quality',idx:0,start:0,end:60,text:'测试画面差分。',status:1});
  const beforeVision=visionCalls;const qualityHandout=await complete(enqueue('handout',{videoId:'quality'}));assert.equal(visionCalls-beforeVision,2,'duplicate static blue frame is filtered');assert.equal(rows('frames','quality').length,2);
  assert.equal(records.get(owner,'covers','quality').source,'slide','handout refresh reuses slide');
  const qualityStored=store.db.prepare('SELECT storage_name FROM files WHERE id=?').get(qualityHandout.result.fileId),qualityZip=unzipSync(fs.readFileSync(path.join(filesDir,qualityStored.storage_name)));
  const figure=await loadImage(Buffer.from(Object.entries(qualityZip).find(([key,bytes])=>key.startsWith('word/media/')&&bytes.length>0)[1]));assert.equal(figure.width,1280,'figure uses requested-time high-resolution extraction, not 640px sampling');
  noSlides=true;await complete(enqueue('handout',{videoId:'quality'}));assert.equal(rows('frames','quality').length,0,'类型无 is not persisted as a slide');noSlides=false;
  await complete(enqueue('material',{videoId:'pdf',format:'pdf'}));await complete(enqueue('cover',{videoId:'pdf'}));
  await complete(enqueue('material',{videoId:'html',format:'html'}));
  await complete(enqueue('cover',{videoId:'md'}));assert.equal(records.get(owner,'covers','md').source,'material-title');
  const controller=new AbortController(),context={signal:controller.signal,checkActive(){controller.signal.throwIfAborted();}},fd=fs.openSync(video,'r');
  try {
    await assert.rejects(mediaProcess(context,process.execPath,['-e','process.stdout.write(Buffer.alloc(4096))'],fd,1024),/media_output_limit/);
    await assert.rejects(mediaProcess(context,process.execPath,['-e','setInterval(()=>{},1000)'],fd,1024,50),/media_process_timeout/);
    const pending=mediaProcess(context,process.execPath,['-e','setInterval(()=>{},1000)'],fd);setTimeout(()=>controller.abort(),50);await assert.rejects(pending,{name:'AbortError'});
  }finally{fs.closeSync(fd);}
  const blocks=store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='materialBlocks' AND value IS NOT NULL").all(owner).map(r=>JSON.parse(r.value));assert.ok(blocks.some(b=>b.materialId==='pdf'&&b.text.includes('Real PDF source')));assert.ok(blocks.some(b=>b.materialId==='html'&&b.text.includes('服务器保留正文')&&!b.text.includes('fetch(')));
  put('covers','video',{...records.get(owner,'covers','video'),source:'user'});await complete(enqueue('cover',{videoId:'video',options:{force:true}}));assert.equal(records.get(owner,'covers','video').source,'user');
  const denied=enqueue('cover',{videoId:'video'},'node','queued',other);await until(()=>get(denied).status==='failed');assert.equal(get(denied).error,'course_file_unavailable');
  await runner.close();runner=new CloudTaskRunner(store,{records,configuration,filesDir,fetch:fetcher});runner.start('http://127.0.0.1:1');assert.equal(get(uncertain).status,'interrupted');assert.ok(records.get(owner,'handouts',handout.result.handoutId));
  console.log('PASS real FFmpeg video cover/transcribe/illustrated DOCX, Poppler PDF parse/cover, inert HTML, owner isolation, manual cover, checkpoint reuse, restart and safe legacy migration (no browser).');
}finally{await runner.close();store.close();fs.rmSync(directory,{recursive:true,force:true});}
