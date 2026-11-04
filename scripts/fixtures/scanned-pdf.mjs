import {createCanvas} from '@napi-rs/canvas';
/** Real raster-only pages: pdftotext has no embedded question text. */
export async function scannedPdf(count=2) {
  const objects=[null,null];
  const pages=[];
  for(let i=1;i<=count;i++) {
    const canvas=createCanvas(640,360),ctx=canvas.getContext('2d');
    ctx.fillStyle='white';ctx.fillRect(0,0,640,360);ctx.fillStyle='#193763';ctx.font='24px sans-serif';ctx.fillText(`${i}. Original question? A / B. Answer: A.`,24,80);ctx.fillRect(60,120,160,80);
    const jpeg=await canvas.encode('jpeg',90);
    const pageId=objects.length+1,imageId=pageId+1,contentId=pageId+2;pages.push(pageId);
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 360] /Resources << /XObject << /Im ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
    objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 640 /Height 360 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,Buffer.from('\nendstream')]));
    const content='q 640 0 0 360 0 0 cm /Im Do Q';objects.push(Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  }
  objects[0]=Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');objects[1]=Buffer.from(`<< /Type /Pages /Kids [${pages.map(p=>`${p} 0 R`).join(' ')}] /Count ${count} >>`);
  const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[0];let length=chunks[0].length;
  objects.forEach((object,i)=>{offsets.push(length);const chunk=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),object,Buffer.from('\nendobj\n')]);chunks.push(chunk);length+=chunk.length;});
  chunks.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
