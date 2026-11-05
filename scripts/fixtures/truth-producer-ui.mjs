import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { waitForProbe } from './wait-for-probe.mjs';

/** Real mounted producers and DOM clicks; only initial server facts are seeded.
 * Read-only projection remains installed throughout. No model requests needed. */
export async function verifyTruthProducerUI(page, { records, store, owner, directory }) {
  const cases = [];
  const existingCommands = await page.evaluate(async () => (await probe.commands()).map(row => row.operationId));
  const sqlRows = table => store.db.prepare('SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND value IS NOT NULL').all(owner, table).map(row => JSON.parse(row.value));
  const changed = (table, key, after) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after }]);
  const waitServer = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error(`Producer UI server assertion timed out: ${label}`);
  };
  try {
    await page.evaluate(() => probe.locale('zh-CN'));
    changed('chatSessions', 301, { id: 301, videoId: 'fixture-course', title: 'UI original', createdAt: Date.now() });
    for (const [id, role, content] of [[302, 'user', 'UI original question'], [303, 'assistant', 'UI original answer']]) {
      changed('chats', id, { id, videoId: 'fixture-course', sessionId: 301, role, content, createdAt: id });
    }
    await page.evaluate(async () => { await probe.flush(); await probe.showProducer('chat'); });
    await page.getByText('UI original answer', { exact: true }).waitFor();
    await page.getByTestId('chat-fork-message').last().click();
    const fork = await waitServer(() => sqlRows('chatSessions').find(row => row.title === 'UI original · 分支'), 'fork session');
    await waitServer(() => sqlRows('chats').filter(row => row.sessionId === fork.id).length === 2, 'fork messages atomic');
    const copied = sqlRows('chats').filter(row => row.sessionId === fork.id);
    assert.deepEqual(copied.map(row => row.content).sort(), ['UI original answer', 'UI original question']);
    assert.equal(sqlRows('chats').filter(row => row.sessionId === 301).length, 2, 'original unchanged');
    await page.locator(`[data-chat-session-id="${fork.id}"]`).waitFor();
    await page.getByTestId('chat-delete-message').last().click();
    await page.getByTestId('message-delete-popconfirm').getByTestId('popconfirm-confirm').click();
    await waitServer(() => sqlRows('chats').filter(row => row.sessionId === fork.id).length === 1, 'delete answer');
    assert.equal(records.get(owner, 'chats', 303).content, 'UI original answer');
    await page.getByTestId('chat-delete-session').click();
    await page.getByTestId('session-delete-popconfirm').getByTestId('popconfirm-confirm').click();
    await waitServer(() => records.get(owner, 'chatSessions', fork.id) === null, 'delete fork session');
    assert.equal(sqlRows('chats').filter(row => row.sessionId === fork.id).length, 0);
    assert.equal(records.get(owner, 'chatSessions', 301).title, 'UI original');
    await page.screenshot({ path: path.join(directory, 'producer-chat.png'), fullPage: true });
    cases.push('ChatPanel fork two messages / delete message / delete session preserves original');

    await page.evaluate(() => probe.showProducer('skills'));
    await page.getByTestId('btn-skill-new').click();
    await page.getByTestId('skill-name').locator('input').fill('UI skill');
    await page.getByTestId('skill-desc').locator('input').fill('UI description');
    await page.getByTestId('skill-body').locator('textarea').fill('UI skill body');
    await page.locator('input[type=file][multiple]').last().setInputFiles({ name: 'ui-reference.md', mimeType: 'text/markdown', buffer: Buffer.from('UI support bytes') });
    await page.getByText('references/ui-reference.md', { exact: true }).waitFor();
    await page.getByTestId('skill-save').click();
    await page.getByTestId('skill-dialog').waitFor({ state: 'hidden' });
    const skill = await waitServer(() => sqlRows('skills').find(row => row.name === 'UI skill'), 'create skill');
    assert.equal(sqlRows('skillRefs').find(row => row.skillId === skill.id).body, 'UI support bytes');
    let row = page.getByTestId('skill-row').filter({ hasText: 'UI skill' });
    await row.getByTestId('skill-toggle').click();
    await waitServer(() => records.get(owner, 'skills', skill.id).enabled === 0, 'disable skill');
    await row.getByTestId('skill-edit').click();
    await page.getByTestId('skill-body').locator('textarea').fill('UI edited body');
    await page.getByTestId('skill-save').click();
    await page.getByTestId('skill-dialog').waitFor({ state: 'hidden' });
    await waitServer(() => records.get(owner, 'skills', skill.id).body === 'UI edited body', 'edit skill');
    assert.equal(sqlRows('skillRefs').filter(row => row.skillId === skill.id).length, 1);
    await page.screenshot({ path: path.join(directory, 'producer-skills.png'), fullPage: true });
    await row.getByTestId('skill-delete').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await waitServer(() => records.get(owner, 'skills', skill.id) === null, 'delete skill');
    assert.equal(sqlRows('skillRefs').filter(row => row.skillId === skill.id).length, 0);
    cases.push('SkillsCard create with support file / toggle / edit / atomic delete');

    changed('cards', 81, { ...records.get(owner, 'cards', 81), q: 'UI card question', a: 'UI card answer', status: 0 });
    await page.evaluate(async () => { await probe.flush(); await probe.showProducer('cards'); });
    await page.getByTestId('swipe-keep').click();
    await waitServer(() => records.get(owner, 'cards', 81).status === 1, 'keep card');
    await page.getByTestId('cards-undo').click();
    await waitServer(() => records.get(owner, 'cards', 81).status === 0, 'undo card');
    await page.getByTestId('swipe-drop').click();
    await waitServer(() => records.get(owner, 'cards', 81).status === 2, 'discard card');
    await waitForProbe(page, async ids => !(await probe.commands()).some(row => !ids.includes(row.operationId)), existingCommands);
    assert.equal(await page.evaluate(() => probe.get('cards', 81).then(row => row.status)), 2, 'confirmed projection includes final review');
    await page.screenshot({ path: path.join(directory, 'producer-cards.png'), fullPage: true });
    cases.push('CardsPanel keep / undo / discard confirmed by server');
    fs.writeFileSync(path.join(directory, 'producer-ui.json'), JSON.stringify({ passed: true, cases }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(directory, 'producer-ui.json'), JSON.stringify({ passed: false, cases, error: error.stack }, null, 2));
    await page.screenshot({ path: path.join(directory, 'producer-ui-failure.png'), fullPage: true });
    fs.writeFileSync(path.join(directory, 'producer-ui-failure.html'), await page.content());
    throw error;
  }
}
