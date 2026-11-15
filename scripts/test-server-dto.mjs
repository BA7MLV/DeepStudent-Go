import assert from 'node:assert/strict';
import test from 'node:test';
import { validateApprovalDto, validateFileDto, validateSession, validateThreadQuestionDto, validateThreadRunDto } from '../packages/contracts/src/server-dto.ts';

/** 信任边界校验器:合法形状原样通过,坏数据在边界处抛 server_contract_violation。 */
test('server DTO validators accept well-formed payloads and reject drift', () => {
  const session = { authenticated: true, user: { id: 'u1', name: 'alice' } };
  assert.deepEqual(validateSession(session), session);
  assert.deepEqual(validateSession({ authenticated: false, user: null }), { authenticated: false, user: null });
  assert.throws(() => validateSession({ authenticated: 'yes', user: null }), /server_contract_violation/);
  assert.throws(() => validateSession(null), /server_contract_violation/);

  const file = { id: 'f1', originalName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'x', createdAt: '2024-01-01T00:00:00Z', width: 3 };
  assert.equal(validateFileDto(file).width, 3);
  assert.throws(() => validateFileDto({ ...file, sizeBytes: 'big' }), /server_contract_violation/);

  const approval = { id: 'a1', messageId: 'm1', threadId: 't1', runId: null, status: 'pending', createdAt: 'c', resolvedAt: null, resolution: null };
  assert.equal(validateApprovalDto(approval).status, 'pending');
  assert.throws(() => validateApprovalDto({ ...approval, status: 'maybe' }), /server_contract_violation/);

  const question = { id: 'q1', runId: 'r1', messageId: 'm1', status: 'answered', createdAt: 'c', answeredAt: 'a', answerMessageId: 'm2' };
  assert.equal(validateThreadQuestionDto(question).answerMessageId, 'm2');
  assert.throws(() => validateThreadQuestionDto({ ...question, status: 'lost' }), /server_contract_violation/);

  const run = { id: 'run1', status: 'running', errorCode: null, wakeAt: null };
  assert.equal(validateThreadRunDto(run).status, 'running');
  assert.throws(() => validateThreadRunDto({ ...run, id: 7 }), /server_contract_violation/);
});
