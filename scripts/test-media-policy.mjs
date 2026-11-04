import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {SileroTimeline,mergeSegments,VAD_OPTIONS} from '@wangke/study-core/media/vad';
import {bestCover,coverTimes,frameTimes,frameDiff,frameCaption} from '@wangke/study-core/media/frame-policy';
const require=createRequire(import.meta.url);
const {FrameProcessor,defaultFrameProcessorOptions}=require('@ricky0123/vad-web/dist/frame-processor.js');
const {Message}=require('@ricky0123/vad-web/dist/messages.js');
// Compare to the installed original library's real state machine, not a second
// copy of our implementation, including misfires, threshold gaps and EOF.
let seed=17;
for(let test=0;test<100;test++) {
  const timeline=new SileroTimeline(),ranges=[];let start=0,index=0,probability=0;
  const processor=new FrameProcessor(async()=>({isSpeech:probability,notSpeech:1-probability}),()=>{}, {...defaultFrameProcessorOptions,...VAD_OPTIONS},96);processor.resume();
  const event=e=>{if(e.msg===Message.SpeechStart)start=index*.096;if(e.msg===Message.SpeechEnd)ranges.push({start,end:(index+1)*.096});};
  for(index=0;index<200;index++) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;probability=[0,.24,.26,.29,.3,.9][seed%6];
    timeline.accept(probability);await processor.process(new Float32Array(1536),event);
  }
  processor.endSegment(e=>{if(e.msg===Message.SpeechEnd)ranges.push({start,end:index*.096});});
  const round=rows=>rows.map(r=>[r.start.toFixed(6),r.end.toFixed(6)]);
  assert.deepEqual(round(timeline.finish()),round(mergeSegments(ranges)));
}
assert.deepEqual(coverTimes(100),[2,12,22,32,42]);
assert.deepEqual(frameTimes(60,25),[1.2,26.2,51.2]);
assert.equal(bestCover([{mean:0,lap:999,stab:1},{mean:.5,lap:100,stab:1}]).mean,.5);
assert.equal(frameDiff(new Uint8Array(256),new Uint8Array(256)),0);
assert.equal(frameCaption('类型：无\n这不是课件画面').isSlide,false);
console.log('PASS original vad-web FrameProcessor parity (20,000 probabilities), cover black-frame rejection, sampling, dedup and no-slide policy.');
