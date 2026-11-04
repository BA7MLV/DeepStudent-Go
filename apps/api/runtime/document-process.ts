/** Separate process: inert HTML parsing and bounded DOCX decompression cannot
 * monopolize the API event loop. linkedom never fetches/executes source HTML. */
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { readDocxUnits } from '@wangke/study-core/materials/docx';
import { extractMdUnits, readMdText } from '@wangke/study-core/materials/markdown';
async function parse() {
const stat = fs.fstatSync(3);
if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('document_input_limit');
const bytes = fs.readFileSync(3), format = process.argv[2];
let units;
if (format === 'html') {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('html_input_limit');
  const { document } = parseHTML(bytes.toString('utf8'));
  for (const node of document.querySelectorAll('script,style,iframe,object,embed,svg,template,nav,footer')) node.remove();
  const root = document.querySelector('article,main') ?? document.body;
  const text = root?.textContent ?? document.documentElement.textContent ?? '';
  units = text.split(/\n\s*\n/).map((text, i) => ({ unit: i + 1, text: text.trim() })).filter(u => u.text);
} else {
  const blob = new Blob([bytes]);
  units = format === 'md' ? extractMdUnits(await readMdText(blob)) : await readDocxUnits(blob, 32 * 1024 * 1024);
}
const result = JSON.stringify(units);
if (Buffer.byteLength(result) > 16 * 1024 * 1024) throw new Error('document_output_limit');
process.stdout.write(result);
}
try { await parse(); }
catch (error) {
  // Only public validation diagnostics cross the subprocess boundary.
  const message = error instanceof Error && error.message.includes('Word 正文过大') ? 'Word 正文过大，请拆分后重新导入' : 'document_parse_failed';
  process.stdout.write(JSON.stringify({ error: message }));
}
