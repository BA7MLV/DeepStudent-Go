/** No filenames or URLs from a task: bytes only through an owned fd. */
import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { drawTextCover } from '@wangke/study-core/media/text-cover';
import { grayPixels, dominantColor, probeStats } from '@wangke/study-core/media/frame-policy';
import { mdCoverText, readMdText } from '@wangke/study-core/materials/markdown';
const mode=process.argv[2];
if(fs.fstatSync(3).size>32*1024*1024)throw new Error('image_input_limit');
const bytes=fs.readFileSync(3);
if(mode==='text'||mode==='markdown') {
  const canvas=createCanvas(480,270);
  const input=mode==='text'?JSON.parse(bytes.toString('utf8')):mdCoverText(await readMdText(new Blob([bytes])));
  drawTextCover(canvas.getContext('2d') as unknown as CanvasRenderingContext2D,{title:input.title??process.argv[3]??'',preview:input.preview});
  process.stdout.write(await canvas.encode('jpeg',82));
} else {
  const image=await loadImage(bytes);
  if(image.width*image.height>40_000_000)throw new Error('image_pixel_limit');
  if(mode==='cover') {
    const scale=Math.min(1,480/Math.max(image.width,image.height));
    const canvas=createCanvas(Math.max(1,Math.round(image.width*scale)),Math.max(1,Math.round(image.height*scale)));
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    process.stdout.write(await canvas.encode('jpeg',80));
  } else {
    const canvas=createCanvas(64,Math.max(1,Math.round(64*image.height/image.width))),ctx=canvas.getContext('2d');
    ctx.drawImage(image,0,0,canvas.width,canvas.height);
    const stats=probeStats(grayPixels(ctx.getImageData(0,0,canvas.width,canvas.height).data),canvas.width,canvas.height);
    const small=createCanvas(16,16),sc=small.getContext('2d');sc.drawImage(image,0,0,16,16);
    const color=createCanvas(48,48),cc=color.getContext('2d');cc.drawImage(image,0,0,48,48);
    process.stdout.write(JSON.stringify({...stats,gray:Array.from(grayPixels(sc.getImageData(0,0,16,16).data)),color:dominantColor(cc.getImageData(0,0,48,48).data),width:image.width,height:image.height}));
  }
}
