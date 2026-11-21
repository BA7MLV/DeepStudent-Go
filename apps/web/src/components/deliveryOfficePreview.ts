import { unzipSync } from 'fflate';
import { readDocxUnits } from '../materials/docx';

const MAX_XML_BYTES = 4 * 1024 * 1024;
const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/;
const PRESENTATION = 'ppt/presentation.xml';
const PRESENTATION_RELS = 'ppt/_rels/presentation.xml.rels';
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STRICT_DRAWING = 'http://purl.oclc.org/ooxml/drawingml/main';
const STRICT_RELATIONSHIPS = 'http://purl.oclc.org/ooxml/officeDocument/relationships';

export function readDeliveryWord(blob: Blob) {
  return readDocxUnits(blob, MAX_XML_BYTES);
}

export async function readDeliverySlides(blob: Blob): Promise<string[]> {
  let total = 0;
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()), { filter: entry => {
    if (!SLIDE_PATH.test(entry.name) && entry.name !== PRESENTATION && entry.name !== PRESENTATION_RELS) return false;
    total += entry.originalSize;
    if (total > MAX_XML_BYTES) throw new Error('preview_xml_too_large');
    return true;
  } });
  const parser = new DOMParser();
  const decoder = new TextDecoder();
  const xml = (path: string) => {
    const file = files[path];
    if (!file) throw new Error('missing_presentation_part');
    const doc = parser.parseFromString(decoder.decode(file), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('invalid_presentation_xml');
    return doc;
  };

  // 按演示文稿里的实际顺序，而不是 ZIP 顺序或 slideN.xml 的数字。
  const targets = new Map<string, string>();
  for (const rel of xml(PRESENTATION_RELS).getElementsByTagNameNS('*', 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target')?.replace(/^\/ppt\//, '').replace(/^\.\//, '');
    if (id && target && rel.getAttribute('TargetMode') !== 'External' && SLIDE_PATH.test(`ppt/${target}`)) targets.set(id, `ppt/${target}`);
  }
  const list = xml(PRESENTATION).getElementsByTagNameNS('*', 'sldIdLst')[0];
  if (!list) return [];
  return Array.from(list.getElementsByTagNameNS('*', 'sldId'), slide => {
    const id = slide.getAttributeNS(RELATIONSHIPS, 'id') ?? slide.getAttributeNS(STRICT_RELATIONSHIPS, 'id');
    const path = id && targets.get(id);
    if (!path) throw new Error('missing_presentation_slide');
    return Array.from(xml(path).getElementsByTagNameNS('*', 'p')).filter(p => p.namespaceURI === DRAWING || p.namespaceURI === STRICT_DRAWING)
      .map(p => Array.from(p.getElementsByTagNameNS(p.namespaceURI, 't'), text => text.textContent).join('')).filter(Boolean).join('\n');
  });
}
