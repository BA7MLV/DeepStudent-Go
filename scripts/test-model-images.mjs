/** Offline regression: safety -> model preparation -> estimation -> wire. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { prepareImage, prepareModelImages, imagePolicy } from '../apps/api/src/agent/image-preparation.ts';
import { boundedRequest } from '../apps/api/src/agent/request-budget.ts';
import { ModelAdapter } from '../apps/api/src/agent/model-adapter.ts';
import { ModelGateway } from '../apps/api/src/agent/model-gateway.ts';
import { ModelTargetResolver } from '../apps/api/src/agent/model-target-resolver.ts';
import { chatOutputTokens } from '../apps/api/runtime/chat-output-budget.ts';
import { requestBody } from '@wangke/study-core/model/client';

const original = await sharp({ create: { width: 1087, height: 2560, channels: 3, background: '#123456' } }).png().toBuffer();
const url = `data:image/png;base64,${original.toString('base64')}`;
const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }, { type: 'text', text: '请讲解这道题' }] }];
const connection = protocol => ({ id: 'fixture', name: 'Fixture', protocol, catalogId: '', baseUrl: 'https://fixture.invalid/v1', apiKey: '', serves: ['chat', 'vision'] });
const target = (protocol = 'openai-chat', imageInput) => ({ ...connection(protocol), providerId: 'fixture', model: 'private-model', capabilities: { imageInput } });
const decode = dataUrl => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

test('1087×2560 study image is preserved byte-for-byte by default, without mutating history', async () => {
  const before = structuredClone(messages);
  const prepared = await prepareModelImages(messages, target());
  assert.deepEqual(messages, before);
  assert.equal(prepared[0].content[0].image_url.url, url);
  assert.equal(prepared[0].content[0].image_url.detail, 'high');
  assert.deepEqual((await prepareImage(original, target())).bytes, original);
});

test('exact-model high tier scales instead of rejecting; later original tier uses source again', async () => {
  const reduced = await prepareModelImages(messages, target('openai-chat', { quality: 'high' }));
  const meta = await sharp(decode(reduced[0].content[0].image_url.url)).metadata();
  assert.ok(meta.height >= 2047 && meta.height <= 2048); assert.ok(meta.width >= 869 && meta.width <= 870);
  assert.equal((await prepareModelImages(messages, target()))[0].content[0].image_url.url, url);
  assert.equal(messages[0].content[0].image_url.detail, undefined);
});

test('pixel, edge and byte policy apply independently; no needless upscaling', async () => {
  const result = await prepareImage(original, target('openai-chat', { maxEdge: 1200, maxPixels: 200000 }));
  assert.ok(result.width <= 1200 && result.height <= 1200 && result.width * result.height <= 200000);
  const tiny = await sharp({ create: { width: 24, height: 16, channels: 3, background: 'white' } }).jpeg().toBuffer();
  assert.deepEqual((await prepareImage(tiny, target())).bytes, tiny);
  const packed = await prepareImage(original, target('openai-chat', { maxBytes: 1024 }));
  assert.ok(packed.bytes.length <= 1024);
  assert.equal(imagePolicy(target('anthropic-messages')).maxBytes, 5 * 1024 * 1024);
  const narrow = await sharp({ create: { width: 1, height: 10000, channels: 3, background: 'white' } }).png().toBuffer();
  const bounded = await prepareImage(narrow, target('openai-chat', { maxPixels: 100 }));
  assert.ok(bounded.width * bounded.height <= 100, 'one-pixel floor cannot bypass the pixel budget');
});

test('orientation is normalized in derivative only; animated GIF becomes one raster frame', async () => {
  const jpeg = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'white' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const result = await prepareImage(jpeg, target());
  assert.equal(result.width, 20); assert.equal(result.height, 40);
  assert.equal((await sharp(result.bytes).metadata()).orientation, undefined);
  assert.equal((await sharp(jpeg).metadata()).orientation, 6);
  const gif = await sharp({ create: { width: 16, height: 32, channels: 3, background: 'white' } }).gif().toBuffer();
  assert.equal((await prepareImage(gif, target())).mime, 'image/png');
});

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
  test(`${protocol}: budget sees prepared wire dimensions; estimator never rewrites detail/bytes`, async () => {
    const t = target(protocol, { maxEdge: 1000 });
    const prepared = await prepareModelImages(messages, t);
    const options = { messages: prepared };
    const output = chatOutputTokens(t, options, { contextTokens: 64000, outputTokens: 8192 });
    const wire = requestBody(t, { ...options, max_tokens: output }, prepared, true);
    const before = structuredClone(wire);
    const estimate = boundedRequest(wire, protocol === 'openai-responses' ? 'responses' : protocol === 'anthropic-messages' ? 'messages' : 'chat/completions', 8192);
    assert.deepEqual(wire, before); assert.deepEqual(estimate.body, before);
    assert.ok(estimate.total <= 64000);
    const twice = await prepareModelImages(wire, t);
    assert.deepEqual(twice, wire, 'repeated model-boundary preparation is idempotent');
  });
}

test('budget accepts more than four images, preserves explicit detail and scales reservation with dimensions', async () => {
  const low = { model: 'fixture', messages: [{ role: 'user', content: Array.from({ length: 8 }, () => ({ type: 'image_url', image_url: { url, detail: 'low' } })) }] };
  const prepared = await prepareModelImages(low, target());
  const result = boundedRequest(prepared, 'chat/completions');
  assert.equal(result.body.messages[0].content[0].image_url.detail, 'low');
  assert.ok(result.input > 8 * 16384);
  const large = await sharp({ create: { width: 4000, height: 2500, channels: 3, background: 'white' } }).png().toBuffer();
  const wire = { model: 'fixture', input: [{ type: 'input_image', image_url: `data:image/png;base64,${large.toString('base64')}` }] };
  assert.ok(boundedRequest(wire, 'responses').input > boundedRequest({ model: 'fixture', input: [{ type: 'input_image', image_url: url }] }, 'responses').input);
});

test('invalid bytes, forged dimensions, unsafe policy, remote URLs and cancellation fail before dispatch', async () => {
  await assert.rejects(prepareImage(Buffer.from('corrupt'), target()), /model_image_invalid/);
  const forged = Buffer.from(original); forged.writeUInt32BE(100000, 16);
  await assert.rejects(prepareImage(forged, target()), /model_image_invalid/);
  await assert.rejects(prepareImage(original.subarray(0, 100), target()), /model_image_invalid/);
  assert.throws(() => imagePolicy(target('openai-chat', { maxEdge: -1 })), /invalid_model_image_policy/);
  await assert.rejects(prepareModelImages([{ type: 'input_image', image_url: 'https://private.invalid/image' }], target()), /model_image_remote/);
  await assert.rejects(prepareModelImages(messages, target(), AbortSignal.abort()), { name: 'AbortError' });
  const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
  const blocks = Array.from({ length: 65 }, () => ({ type: 'input_image', image_url: `data:image/png;base64,${tiny.toString('base64')}` }));
  await assert.rejects(prepareModelImages(blocks, target()), /model_image_count_exceeded/);
});

test('canonical Gateway prepares exact-model policy before capacity/reservation and preserves original', async () => {
  const c = connection('openai-chat');
  const config = { providers: [c], llmModel: { providerId: c.id, model: 'private-model' }, visionModel: { providerId: c.id, model: 'private-model' } };
  const reserved = []; let sent = 0;
  const ledger = { model: () => ({ contextTokens: 64000, outputTokens: 4096 }), limits: () => ({ contextTokens: 64000 }), reserve(_a, _n, tokens) { reserved.push(tokens); return 'id'; }, settle() { return false; }, checkAdmission() {} };
  const gateway = new ModelGateway(new ModelTargetResolver(() => config, () => ({ imageInput: { maxEdge: 1000 } })), ledger, async (_url, init) => {
    sent++;
    const body = JSON.parse(init.body), image = body.messages[0].content[0].image_url;
    const meta = await sharp(decode(image.url)).metadata();
    assert.ok(meta.height >= 999 && meta.height <= 1000);
    assert.equal(reserved.at(-1), boundedRequest(body, 'chat/completions').total);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '已读图' } }] });
  });
  await gateway.request({ owner: 'fixture', purpose: 'vision', messages: [{ role: 'user', content: '讲解' }], image: { mime: 'image/png', data: original.toString('base64') }, signal: new AbortController().signal });
  assert.equal(sent, 1);
  await assert.rejects(gateway.request({ owner: 'fixture', purpose: 'vision', messages: [{ role: 'user', content: '讲解' }], image: { mime: 'image/png', data: Buffer.from('corrupt').toString('base64') }, signal: new AbortController().signal }), { code: 'model_image_invalid_or_too_large' });
  assert.equal(sent, 1); assert.equal(reserved.length, 1);
  assert.deepEqual(decode(url), original);
});

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
  test(`${protocol}: native Gateway applies selected policy and rejects corrupt input without retry`, async () => {
    const c = connection(protocol), config = { providers: [c], llmModel: { providerId: c.id, model: 'private-model' }, visionModel: { providerId: '', model: '' } };
    const reserves = []; let sent = 0;
    const ledger = { model: () => ({ contextTokens: 64000, outputTokens: 4096 }), limits: () => ({ contextTokens: 64000 }), reserve(_a, _n, tokens) { reserves.push(tokens); return 'id'; }, settle() { return false; }, checkAdmission() {} };
    const gateway = new ModelGateway(new ModelTargetResolver(() => config, () => ({ imageInput: { maxEdge: 1000 } })), ledger, async (_url, init) => {
      sent++;
      const body = JSON.parse(init.body);
      const part = protocol === 'openai-responses' ? body.input[0].content[0] : body.messages[0].content[0];
      const bytes = protocol === 'anthropic-messages' ? Buffer.from(part.source.data, 'base64') : decode(protocol === 'openai-responses' ? part.image_url : part.image_url.url);
      const meta = await sharp(bytes).metadata(); assert.ok(meta.height >= 999 && meta.height <= 1000);
      assert.equal(reserves.at(-1), boundedRequest(body, protocol === 'openai-responses' ? 'responses' : protocol === 'anthropic-messages' ? 'messages' : 'chat/completions').total);
      return Response.json({ usage: { input_tokens: 10, output_tokens: 2 } });
    });
    const adapter = new ModelAdapter(c, 'private-model');
    const forward = data => {
      const wire = adapter.encode({ messages: [{ role: 'user', content: '讲解' }], image: { mime: 'image/png', data } });
      return gateway.forward({ owner: 'fixture', purpose: 'chat', modelRef: { providerId: c.id, model: 'private-model' }, endpoint: wire.path, body: JSON.stringify(wire.body), attribution: { run: 'fixture' }, signal: new AbortController().signal });
    };
    await (await forward(original.toString('base64'))).text();
    await assert.rejects(forward(Buffer.from('corrupt').toString('base64')), /model_image_invalid_or_too_large/);
    assert.equal(sent, 1); assert.equal(reserves.length, 1);
  });
}
