import { assertPluginAvailable } from '../plugins/availability';
import { runCloudTask } from '../cloud/tasks';
import { cloudTransaction } from '../cloud/transactions';
import { db, type HandoutRow } from '../store/db';
import { cloud } from '../cloud/state';
import type { HandoutSection } from '../handout/docx';
import type { Block } from '../handout/ir';

export function blockToText(b: Block): string {
  switch (b.type) {
    case 'lead': case 'para': case 'note': case 'h2': return b.text;
    case 'list': return b.items.join('；');
    case 'table': return [b.caption, ...b.header].filter(Boolean).join(' ');
    case 'figure': return b.caption ? `配图：${b.caption}` : '配图';
  }
}
export async function rewriteBlockWithLLM(original: Block, instruction: string,
  ctx: { title: string; heading?: string; prev?: string; next?: string }): Promise<Block> {
  await assertPluginAvailable('material-tools');
  return runCloudTask('handoutEdit', crypto.randomUUID(), { original, instruction, ctx });
}

interface Baseline { sectionsJson: string; outlineJson: string; blob: { $file: string } }
interface EditSequence { chain: Promise<void>; baseline: Promise<Baseline>; error?: unknown }
const sequences = new WeakMap<object, WeakMap<HandoutRow, EditSequence>>();

/** Capture the editor's original row, never replace its CAS with a fresh DB read.
 * Each successful task receipt advances this sequence's baseline; a conflict
 * blocks subsequent saves and keeps the newest local draft for explicit review. */
export function persistHandoutEdit(original: HandoutRow, sections: HandoutSection[], summary: string): Promise<void> {
  const database = db, owner = cloud.userId, handoutId = original.id!;
  const guard = () => { if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed'); };
  let map = sequences.get(database);
  if (!map) { map = new WeakMap(); sequences.set(database, map); }
  let sequence = map.get(original);
  if (!sequence) {
    sequence = { chain: Promise.resolve(), baseline: (async () => {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await original.blob.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
      guard();
      const known = await database.table('_cloudBlobs').get(hash);
      guard();
      if (!known?.id) throw new Error('讲义原始文件引用尚未同步，请刷新后重新打开编辑。');
      return { sectionsJson: original.sectionsJson ?? '', outlineJson: original.outlineJson, blob: { $file: known.id } };
    })() };
    // The queued save observes this rejection after preserving its draft.
    void sequence.baseline.catch(() => {});
    map.set(original, sequence);
  }
  const st = sequence;
  const draftId = `handout-edit-draft:${handoutId}`, intent = crypto.randomUUID();
  const saveDraft = database.table('_cloudMeta').put({ id: draftId, value: { intent, owner, handoutId, sections, summary, original, status: 'pending' } });
  const run = st.chain.then(async () => {
    await saveDraft; guard();
    if (st.error) throw st.error;
    const expected = await st.baseline; guard();
    const result = await runCloudTask<{ handoutId: number; fileId: string; sectionsJson: string; outlineJson: string }>('handoutEdit', `handout:${handoutId}`,
      { action: 'persist', videoId: original.videoId, handoutId, sections, summary, expected });
    guard();
    st.baseline = Promise.resolve({ sectionsJson: result.sectionsJson, outlineJson: result.outlineJson, blob: { $file: result.fileId } });
    await cloudTransaction(database, [database.table('_cloudMeta')], async () => {
      const draft = await database.table('_cloudMeta').get(draftId);
      if (draft?.value.intent === intent) await database.table('_cloudMeta').delete(draftId);
    });
  });
  st.chain = run.catch(async error => {
    st.error = error;
    if (database === db && owner === cloud.userId) await database.table('_cloudMeta').update(draftId, { 'value.status': 'conflict', 'value.error': String(error) });
  });
  return run;
}
