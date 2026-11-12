/** Uploaded originals -> production task runtime -> wire payload -> persisted
 * messages -> next turn/retry/continuation. The provider transport is offline. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner, taskDto } from '../apps/api/src/cloud/tasks.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';
import { normalizeChatAttachments } from '../apps/api/runtime/chat-attachments.ts';

const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/var/tmp', 'opencode', 'server-chat-attachments-'));
const filesDir = path.join(directory, 'files');
fs.mkdirSync(filesDir);
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const records = new CloudRecords(store);
const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const owner = crypto.randomUUID(), other = crypto.randomUUID(), timestamp = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, timestamp);
configuration.save(owner, { ...configuration.get(owner),
  providers: [{ id: 'offline', name: 'Offline', protocol: 'openai-chat', catalogId: '', baseUrl: 'https://offline.invalid/v1', apiKey: 'fixture', serves: ['chat'] }],
  llmModel: { providerId: 'offline', model: 'gpt-4.1' },
});
const put = (table, key, after) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after }]);
const rows = sid => store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='chats' AND value IS NOT NULL").all(owner)
  .map(row => JSON.parse(row.value)).filter(row => row.sessionId === sid);
const session = sid => put('chatSessions', sid, { id: sid, videoId: '__library_assistant__', title: '新会话', createdAt: Date.now() });
let script = [], requests = 0;
const runner = new CloudTaskRunner(store, { records, configuration, filesDir, fetch: async (url, init) => {
  requests++;
  assert.equal(url, 'https://offline.invalid/v1/chat/completions');
  assert.ok(script.length, 'unexpected model request');
  await script.shift()(JSON.parse(init.body));
  return Response.json({ choices: [{ message: { role: 'assistant', content: '已读取附件。' }, finish_reason: 'stop' }] });
} });

async function run(sid, input, error) {
  const id = crypto.randomUUID();
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, owner, id, 'chat', `session:${sid}`, JSON.stringify({ sessionId: sid, ...input }), 'queued', timestamp, timestamp);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const task = taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      assert.equal(task.status, error ? 'failed' : 'completed', JSON.stringify(task));
      if (error) assert.match(task.error, error);
      assert.equal(script.length, 0);
      return task;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for attachment task');
}
async function upload(name, mime, bytes, parsed, account = owner) {
  const saved = await receiveFile(store, filesDir, account, Readable.from([bytes]), name, mime, 1024 * 1024);
  return { id: crypto.randomUUID(), serverId: saved.id, name, mimeType: mime, size: bytes.length, ...parsed };
}
const png = await sharp({ create: { width: 1087, height: 2560, channels: 3, background: '#345678' } }).png().toBuffer();
try {
  const attachments = [
    await upload('notes.txt', 'text/plain', Buffer.from('TXT_MARKER'), { text: 'TXT_MARKER' }),
    // The composer extracts PDF/DOCX before upload; this test starts at the
    // server boundary and asserts their extracted text is not discarded.
    await upload('questions.pdf', 'application/pdf', Buffer.from('%PDF fixture'), { text: 'PDF_QUESTION_MARKER', truncated: true }),
    await upload('notes.docx', 'application/octet-stream', Buffer.from('docx fixture'), { text: 'DOCX_MARKER' }),
    await upload('diagram.png', 'image/png', png, { dataUrl: `data:image/png;base64,${png.toString('base64')}` }),
  ];
  const image = attachments[3].dataUrl;
  const persistedAttachments = normalizeChatAttachments(store, owner, attachments);
  const checkAll = body => {
    const payload = JSON.stringify(body.messages);
    for (const marker of ['TXT_MARKER', 'PDF_QUESTION_MARKER', 'DOCX_MARKER', '仅包含前 12000 字', image]) assert.ok(payload.includes(marker), `missing attachment ${marker.slice(0, 40)}`);
    assert.ok(body.messages.some(message => message.role === 'user' && Array.isArray(message.content)
      && message.content.some(part => part.type === 'image_url' && part.image_url.url === image)), 'image must be an image part, not plain text');
  };
  runner.start('http://127.0.0.1:1');
  session(10);
  script = [body => { checkAll(body); assert.ok(JSON.stringify(body.messages).includes('请分析这些附件。')); }];
  const first = await run(10, { attachments }); // attachments only
  const user = records.get(owner, 'chats', first.result.userRowId);
  assert.deepEqual(user.attachments, persistedAttachments);
  assert.equal(user.content, '请分析这些附件。');
  assert.ok(JSON.stringify(user.modelTrace).includes(`attachment-file:${attachments[3].serverId}`));
  assert.ok(!JSON.stringify(user).includes('data:image/'));
  assert.equal(rows(10).length, 2);

  script = [checkAll];
  await run(10, { text: '继续分析附件里的第二题' }); // trace replay
  const legacy = { ...user };
  delete legacy.modelTrace;
  put('chats', user.id, legacy);
  script = [checkAll];
  await run(10, { text: '再次引用之前的附件' }); // rows without model traces

  const answer = records.get(owner, 'chats', first.result.rowId);
  put('chats', answer.id, { ...answer, interrupted: true });
  const before = rows(10).length;
  script = [checkAll];
  await run(10, { action: 'continue', rowId: answer.id });
  assert.equal(rows(10).length, before, 'continuation must not duplicate the attachment turn');
  assert.deepEqual(records.get(owner, 'chats', user.id).attachments, persistedAttachments);

  session(20);
  script = [checkAll];
  await run(20, { text: user.content, attachments: user.attachments }); // retry/fork payload
  assert.deepEqual(rows(20).find(row => row.role === 'user').attachments, persistedAttachments);

  session(30);
  const foreign = await upload('private.txt', 'text/plain', Buffer.from('private'), { text: 'PRIVATE' }, other);
  const cases = [
    [{ ...attachments[0], serverId: undefined }, /尚未上传成功/],
    [{ ...attachments[0], serverId: crypto.randomUUID() }, /不存在或无权访问/],
    [foreign, /不存在或无权访问/],
    [{ ...attachments[3], serverId: 'https://internal.invalid/image.png' }, /不存在或无权访问/],
    [{ ...attachments[0], text: 'x'.repeat(12001) }, /正文或描述无效/],
    [{ ...attachments[0], text: '' }, /没有可读取的内容/],
  ];
  const count = requests;
  for (const [file, error] of cases) await run(30, { text: 'test', attachments: [file] }, error);
  await run(30, { text: 'test', attachments: Array(9).fill(attachments[0]) }, /数量超过上限/);
  await run(30, { text: 'test', attachments: [attachments[0], attachments[0]] }, /附件标识无效/);
  assert.equal(requests, count, 'invalid attachments must fail before invoking the model');
  assert.equal(rows(30).length, 0);

  session(40);
  script = [body => assert.ok(JSON.stringify(body.messages).includes('普通文字消息'))];
  await run(40, { text: '普通文字消息' });
  assert.equal(rows(40).find(row => row.role === 'user').attachments, undefined);
  // Per-model derivative must never replace the original or the persisted trace.
  put('preferences', 'savedModels', { id: 'savedModels', value: [{ providerId: 'offline', model: 'gpt-4.1', imageInput: { maxEdge: 1000 } }] });
  session(50);
  script = [async body => {
    const part = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(p => p.type === 'image_url');
    assert.notEqual(part.image_url.url, image);
    const meta = await sharp(Buffer.from(part.image_url.url.split(',')[1], 'base64')).metadata();
    assert.ok(meta.height >= 999 && meta.height <= 1000);
  }];
  const reduced = await run(50, { text: '高清读取', attachments: user.attachments });
  const reducedUser = records.get(owner, 'chats', reduced.result.userRowId);
  assert.deepEqual(reducedUser.attachments, persistedAttachments);
  assert.ok(JSON.stringify(reducedUser.modelTrace).includes(`attachment-file:${attachments[3].serverId}`));
  assert.ok(!JSON.stringify(reducedUser).includes('data:image/'));
  const stored = store.db.prepare('SELECT storage_name FROM files WHERE id=?').get(attachments[3].serverId);
  assert.deepEqual(fs.readFileSync(path.join(filesDir, stored.storage_name)), png);
  console.log('PASS: server Chat attachments — mixed text/PDF/DOCX/images, attachment-only, persistence, trace + legacy history, continuation, retry, ownership and invalid payload guards, plain text regression');
} finally {
  await runner.close();
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
