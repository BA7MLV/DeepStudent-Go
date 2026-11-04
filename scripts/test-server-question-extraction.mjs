import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner, taskDto } from '../apps/api/src/cloud/tasks.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';
import { ResourceFiles } from '../apps/api/src/projects/resources.ts';
import { PluginService } from '../apps/api/src/plugins/service.ts';
import { readLearningMarkdown } from '../apps/api/src/plugins/learning-files.ts';
import { reconcilePracticeExtractions } from '../apps/api/src/plugins/practice-extraction.ts';
import { scannedPdf } from './fixtures/scanned-pdf.mjs';
import {taskCourseFile} from '../apps/api/src/cloud/execution.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-question-extraction-'));
const filesDir = path.join(directory, 'files'); fs.mkdirSync(filesDir);
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const records = new CloudRecords(store), configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const owner = crypto.randomUUID(), other = crypto.randomUUID();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, new Date().toISOString());
configuration.save(owner, { ...configuration.get(owner), providers: [{ id: 'mock', name: 'Mock', protocol: 'openai-chat', baseUrl: 'https://model.invalid/v1', apiKey: 'mock-only', serves: ['chat', 'vision'] }], llmModel: { providerId: 'mock', model: 'mock' }, visionModel: { providerId: 'mock', model: 'mock' }, policy: { ...configuration.get(owner).policy, read: 'allow', write: 'ask' } });
const projects = new ProjectRepository(store, path.join(filesDir, 'projects')), resources = new ResourceFiles(projects, filesDir);
let mode = 'valid', calls = 0;
const fetcher=async (url, init) => {
  assert.equal(String(url), 'https://model.invalid/v1/chat/completions');
  assert.ok(JSON.parse(init.body).messages); calls++;
  const content = mode === 'invalid' ? '模型自称已保存' : '```quiz\n' + JSON.stringify({ questions: [{ stem: '原题', options: ['甲', '乙'], answer: 0, explanation: '原文答案', answerSource: 'original', source: { courseId: 'a', name: '原题材料', page: 1 } }] }) + '\n```';
  return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
};
let runner = new CloudTaskRunner(store, { records, configuration, filesDir, fetch:fetcher });
let service = new PluginService(store, undefined, runner, { filesDir, resources }); runner.pluginService = service;
const put = (table, key, after) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after }]);
const get = id => taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
async function until(predicate) { const end = Date.now() + 15000; while (Date.now() < end) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('extraction timeout'); }
const pending = id => store.db.prepare("SELECT * FROM cloud_permissions WHERE task_id=? AND status='pending'").get(id);
async function waiting(id) { await until(() => pending(id) || ['failed', 'cancelled'].includes(get(id).status)); assert.ok(pending(id), JSON.stringify(get(id))); return pending(id); }
async function ended(id, status, error) { await until(() => ['completed', 'failed', 'cancelled'].includes(get(id).status)); assert.equal(get(id).status, status, JSON.stringify(get(id))); if (error) assert.match(get(id).error, error); }
const bank = () => records.get(owner, 'videos', '__course_questions__a') ? readLearningMarkdown(store, filesDir, owner, '__course_questions__a', resources) : null;
const invoke = nonce => service.invokeNamed(owner, 'practice', 'extract-a', 1, 'extract', { materialId: 'a', clientNonce: nonce });
const decide = (id, status) => store.db.prepare('UPDATE cloud_permissions SET status=? WHERE id=? AND owner_id=?').run(status, id, owner);
try {
  const bytes = Buffer.from('# 原文\n\n1. 原题：甲还是乙？答案：甲。');
  const file = await receiveFile(store, filesDir, owner, Readable.from([bytes]), 'a.md', 'text/markdown', bytes.length, bytes.length);
  put('videos', 'a', { id: 'a', name: '原题材料', kind: 'material', materialFormat: 'md' });
  put('files', 'a', { id: 'a', blob: { $file: file.id } });
  put('materialBlocks', 1, { id: 1, materialId: 'a', idx: 0, text: bytes.toString() });
  resources.migrate(owner);
  const layout = service.files.layout(owner), parsed = JSON.parse(layout.content);
  parsed.instances.push({ id: 'extract-a', pluginId: 'practice', scope: { kind: 'material', id: 'a' } });
  service.files.save(owner, layout.path, JSON.stringify(parsed), layout.content, layout.revision);
  runner.start('http://127.0.0.1:1');

  const rejected = invoke('rejected'); decide((await waiting(rejected.id)).id, 'rejected');
  await ended(rejected.id, 'failed', /write_permission_rejected/); assert.equal(bank(), null);

  const cancelled = invoke('cancelled'); await waiting(cancelled.id);
  store.db.prepare("UPDATE cloud_tasks SET status='cancelled' WHERE id=?").run(cancelled.id); await runner.cancel(cancelled.id);
  await ended(cancelled.id, 'cancelled'); assert.equal(bank(), null); assert.equal(pending(cancelled.id), undefined);

  const revoked = invoke('revoked'); await waiting(revoked.id);
  configuration.save(owner, { ...configuration.get(owner), policy: { ...configuration.get(owner).policy, write: 'deny' } });
  await ended(revoked.id, 'failed', /write_permission/); assert.equal(bank(), null);
  configuration.save(owner, { ...configuration.get(owner), policy: { ...configuration.get(owner).policy, write: 'ask' } });

  mode = 'invalid'; const invalid = invoke('invalid'); await ended(invalid.id, 'failed', /extraction_invalid_model_result|quiz/); assert.equal(bank(), null); mode = 'valid';

  const success = invoke('success'), approval = await waiting(success.id);
  assert.equal(bank(), null, 'approval wait cannot save');
  assert.equal(store.db.prepare('UPDATE cloud_permissions SET status=? WHERE id=? AND owner_id=?').run('approved', approval.id, other).changes, 0);
  decide(approval.id, 'approved'); await ended(success.id, 'completed');
  assert.match(bank().text, /原题/); assert.equal(get(success.id).progress.questionBankSaved, true);
  reconcilePracticeExtractions(service);
  const receipt = store.db.prepare('SELECT artifacts FROM plugin_learning_receipts WHERE task_id=?').get(success.id);
  assert.ok(receipt, 'real runner save has a durable domain receipt');
  const beforeCalls = calls; assert.equal(invoke('success').id, success.id); assert.equal(calls, beforeCalls, 'lost-response replay never reruns');
  const beforeRetry=bank().text;const retry=invoke('new-nonce-same-source');await ended(retry.id,'completed');assert.equal(bank().text,beforeRetry);assert.equal(calls,beforeCalls,'explicit retry of saved source page does not append duplicates');

  put('materialBlocks',1,{id:1,materialId:'a',idx:0,text:'更新原题版本二'});
  const conflict = invoke('conflict'); await waiting(conflict.id);
  const original = bank(); resources.saveMarkdown(owner, { courseId: '__course_questions__a', text: original.text + '\n用户并行修改\n', expected: original.text });
  const preserved = bank().text; decide(pending(conflict.id).id, 'approved');
  await ended(conflict.id, 'failed', /conflict|changed|inspect original draft/); assert.equal(bank().text, preserved);

  const stale = invoke('stale-source'); await waiting(stale.id);
  put('videos', 'a', { ...records.get(owner, 'videos', 'a'), fileDeleted: true }); decide(pending(stale.id).id, 'approved');
  await ended(stale.id, 'failed', /unavailable|changed/); assert.equal(bank().text, preserved, 'source removed during approval cannot save');
  const scan=await scannedPdf(),scanFile=await receiveFile(store,filesDir,owner,Readable.from([scan]),'scan.pdf','application/pdf',scan.length,scan.length);
  put('videos','scan',{id:'scan',name:'扫描题库',kind:'material',materialFormat:'pdf'});put('files','scan',{id:'scan',blob:{$file:scanFile.id}});resources.migrate(owner);
  const scanLayout=service.files.layout(owner),scanParsed=JSON.parse(scanLayout.content);scanParsed.instances.push({id:'extract-scan',pluginId:'practice',scope:{kind:'material',id:'scan'}});service.files.save(owner,scanLayout.path,JSON.stringify(scanParsed),scanLayout.content,scanLayout.revision);
  const scanInvoke=nonce=>service.invokeNamed(owner,'practice','extract-scan',1,'extract',{materialId:'scan',clientNonce:nonce});
  const scanBank=()=>readLearningMarkdown(store,filesDir,owner,'__course_questions__scan',resources);
  const partial=scanInvoke('partial');decide((await waiting(partial.id)).id,'approved');await until(()=>get(partial.id).progress?.covered===1&&pending(partial.id));
  const pageOne=scanBank().text;assert.match(pageOne,/#source-image\/scan\/page-1/);assert.equal((pageOne.match(/wangke-source-page:/g)||[]).length,1);
  await runner.close();await service.close();runner=new CloudTaskRunner(store,{records,configuration,filesDir,fetch:fetcher});service=new PluginService(store,undefined,runner,{filesDir,resources});runner.pluginService=service;runner.start('http://127.0.0.1:1');
  assert.equal(scanInvoke('partial').id,partial.id,'original command cannot restart an interrupted save');assert.equal(scanBank().text,pageOne);
  const callsBeforeResume=calls,resumed=scanInvoke('resume');decide((await waiting(resumed.id)).id,'approved');await ended(resumed.id,'completed');assert.equal(calls-callsBeforeResume,1,'resume skips page 1 from exact-source marker');
  assert.equal((scanBank().text.match(/wangke-source-page:/g)||[]).length,2);assert.match(scanBank().text,/#source-image\/scan\/page-2/);
  const mapping=store.db.prepare('SELECT project_id,path FROM resource_files WHERE owner_id=? AND course_id=?').get(owner,'scan');
  fs.appendFileSync(path.join(filesDir,'projects',mapping.project_id,mapping.path),'\n% next source revision\n');
  const preservedScan=scanBank().text,archived=scanInvoke('archive-during-approval');await waiting(archived.id);
  store.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(mapping.project_id);decide(pending(archived.id).id,'approved');await ended(archived.id,'failed',/archived/);
  store.db.prepare('UPDATE projects SET archived=0 WHERE id=?').run(mapping.project_id);assert.equal(scanBank().text,preservedScan,'archive while waiting preserves the existing edited bank');
  const agent=crypto.randomUUID(),thread=crypto.randomUUID(),run=crypto.randomUUID(),at=new Date().toISOString();
  store.db.prepare("INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,'grant fixture','assistant','',?,?)").run(agent,owner,at,at);
  projects.grant(owner,mapping.project_id,agent,'read');
  store.db.prepare("INSERT INTO threads(id,owner_id,mode,title,created_at,updated_at,agent_id) VALUES(?,?,'bot','grant test',?,?,?)").run(thread,owner,at,at,agent);
  store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,'bot','running',?)").run(run,thread,at);
  const grantRevoked=scanInvoke('grant-revoked-during-approval');await waiting(grantRevoked.id);
  store.db.prepare('UPDATE cloud_tasks SET parent_run_id=? WHERE id=?').run(run,grantRevoked.id);
  const pinned=taskCourseFile({task:get(grantRevoked.id),owner,store,records,filesDir,checkActive(){}},'scan');assert.ok(pinned);
  const oldRole=projects.get(owner,mapping.project_id).grants.find(g=>g.agentId===agent).role;
  projects.grant(owner,mapping.project_id,agent,null);assert.throws(()=>pinned.assertCurrent(),/access_denied/);pinned.close();
  assert.throws(()=>taskCourseFile({task:get(grantRevoked.id),owner,store,records,filesDir,checkActive(){}},'scan'),/access_denied/);
  decide(pending(grantRevoked.id).id,'approved');await ended(grantRevoked.id,'failed',/scope_denied/);
  projects.grant(owner,mapping.project_id,agent,oldRole);assert.equal(scanBank().text,preservedScan,'revoked agent cannot save even with a pending owner approval');
  console.log('PASS actual server extraction: approval rejection/cancel/revocation, invalid output, owner scope, real resource receipt, nonce replay, bank CAS and source deletion during approval.');
} finally { await runner.close(); await service.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
