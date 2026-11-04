/** Silero legacy / vad-web NonRealTimeVAD settings used by the local pipeline. */
export const VAD_OPTIONS = { minSpeechMs: 200, redemptionMs: 300 };
export interface VadSegment {start:number;end:number}
export function mergeSegments(raw:VadSegment[]):VadSegment[] {
  const out:VadSegment[]=[];
  for(const seg of raw) {
    const last=out.at(-1);
    if(last&&seg.start-last.end<.4&&seg.end-last.start<=8)last.end=seg.end;
    else out.push({...seg});
  }
  const merged:VadSegment[]=[];
  for(const seg of out) {
    const last=merged.at(-1);
    if(seg.end-seg.start<.5&&last&&last.end-last.start+(seg.end-seg.start)<=8)last.end=seg.end;
    else merged.push({...seg});
  }
  return merged;
}
/** Timestamp-only equivalent of vad-web's legacy FrameProcessor+run. No PCM
 * buffering (SpeechEnd.audio was never used by our callers). 1536 samples/frame,
 * positive .3 / negative .25, minSpeech 200ms, redemption 300ms; same floor and
 * start/end rounding, including discarding the incomplete final model frame. */
export class SileroTimeline {
  private index=0; private start=0; private count=0; private redemption=0; private speaking=false;
  readonly ranges:VadSegment[]=[];
  accept(probability:number) {
    const isSpeech=probability>=.3;
    if(isSpeech){this.count++;this.redemption=0;}
    if(isSpeech&&!this.speaking){this.speaking=true;this.start=this.index*1536/16000;}
    if(probability<.25&&this.speaking&&++this.redemption>=Math.floor(VAD_OPTIONS.redemptionMs/96)) {
      if(this.count>=Math.floor(VAD_OPTIONS.minSpeechMs/96))this.ranges.push({start:this.start,end:(this.index+1)*1536/16000});
      this.speaking=false;this.count=0;this.redemption=0;
    }
    if(!this.speaking)this.count=0;
    this.index++;
  }
  finish() {
    if(this.speaking&&this.count>=Math.floor(VAD_OPTIONS.minSpeechMs/96))this.ranges.push({start:this.start,end:this.index*1536/16000});
    return mergeSegments(this.ranges);
  }
}
