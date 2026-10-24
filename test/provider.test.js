import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chat, decisionSchema, generateDecisions, splitSentences, validateSettings, validateResponse, reviewSchema } from '../lib/provider.js';
import { validatePlan } from '../lib/plan.js';
import { fixture } from './helpers.js';
import { makePlan, normalizeTranscript } from '../lib/plan.js';

const config = { baseUrl: 'http://127.0.0.1:1234/v1', model: 'test-model', format: 'schema', apiKey: 'local-test-secret' };
test('response validation reports precise fields before accepting JSON-mode output', () => {
  assert.throws(() => validateResponse({ summary: 'test', changes: [{ sentenceId: 'S-1', action: 'keep', reason: 'test', text: 'rewrite' }], reviewItems: [] }, reviewSchema), /\$\.changes\[0\].*text/);
  assert.throws(() => validateResponse({ summary: 'test', changes: [], reviewItems: [{ sentenceIds: 'S-1', reason: 'test' }] }, reviewSchema), /reviewItems\[0\]\.sentenceIds/);
});
test('protocol uses strict schema and rejects truncation, refusals and malformed JSON', async () => {
  let sent;
  const mock = async (url, options) => { sent = { url, ...options }; return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10 } })); };
  const result = await chat(config, [{ role: 'user', content: 'test JSON' }], { type: 'object' }, { fetchImpl: mock });
  assert.equal(result.result.ok, true); assert.equal(sent.url, `${config.baseUrl}/chat/completions`);
  assert.equal(sent.headers.Authorization, 'Bearer local-test-secret');
  assert.equal(JSON.parse(sent.body).response_format.json_schema.strict, true);
  for (const choice of [{ finish_reason: 'length', message: { content: '{}' } }, { finish_reason: 'stop', message: { refusal: 'no' } }, { finish_reason: 'stop', message: { content: 'not json' } }]) {
    await assert.rejects(chat(config, [], decisionSchema, { fetchImpl: async () => new Response(JSON.stringify({ choices: [choice] })) }));
  }
});
test('provider errors never echo key or request content', async () => {
  await assert.rejects(chat(config, [], {}, { fetchImpl: async () => new Response('echo secret local-test-secret', { status: 401 }) }), e => !e.message.includes('local-test-secret') && e.message.includes('401'));
});
test('DeepSeek JSON mode includes an explicit output schema/example and bounded non-thinking profile', async () => {
  let request;
  await chat({ ...config, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', format: 'json' },
    [{ role: 'system', content: '返回剪辑 JSON' }, { role: 'user', content: '{}' }], decisionSchema,
    { fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] })); } });
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.equal(request.thinking.type, 'disabled'); assert.equal(request.max_tokens, 8192);
  assert.match(request.messages[0].content, /JSON Schema/); assert.match(request.messages[0].content, /sentenceId/);
  assert.match(request.messages[0].content, /结构示例/); assert.equal(request.messages[1].content, '{}');
});
test('only HTTPS and local HTTP API endpoints are accepted', () => {
  assert.throws(() => validateSettings({ ...config, baseUrl: 'http://remote.example/v1' }));
  assert.throws(() => validateSettings({ ...config, baseUrl: 'https://user:password@example.com/v1' }));
  assert.doesNotThrow(() => validateSettings(config));
});
test('long interview chunking is bounded', () => {
  const chunks = splitSentences(Array.from({ length: 180 }, (_, i) => ({ id: String(i), text: '甲'.repeat(500) })));
  assert.ok(chunks.length > 3); assert.equal(chunks.flat().length, 180);
  assert.ok(chunks.every(c => c.length <= 60));
});
test('real local mock provider, checkpoint reuse and scoped revision', async t => {
  let count = 0;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const b of req) text += b;
    const body = JSON.parse(text), prompt = JSON.parse(body.messages[1].content); count++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'test-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: '保留背景与例子', decisions: prompt.sentences.map(s => ({ sentenceId: s.id, action: s.id === 'B-2' ? 'delete' : 'keep', reason: '测试用编辑判断' })) }) } }], usage: { prompt_tokens: 100, completion_tokens: 60 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const configLocal = { ...config, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, p = fixture(), saved = new Map();
  const checkpoint = { get: async k => saved.get(k), put: async (k, v) => saved.set(k, v) };
  const first = await generateDecisions(p, configLocal, { checkpoint }); validatePlan(first, p);
  assert.equal(first.decisions[1].action, 'delete');
  const second = await generateDecisions(p, configLocal, { checkpoint }); assert.equal(count, 1); assert.equal(second.generation.calls[0].reused, true);
  p.plan.contentReview = { coverage: 'full_transcript', summary: '旧方案已复核', reviewItems: [], changes: [] };
  const revised = await generateDecisions(p, configLocal, { scopeIds: ['B-2'], feedback: { text: '仅改第二句' } });
  assert.equal(revised.decisions[0].reason, p.plan.decisions[0].reason);
  assert.equal(revised.decisions[1].action, 'delete');
  assert.equal(revised.contentReview.coverage, 'prior_plan_only'); assert.equal(revised.contentReview.status, 'pending');
});

test('interrupted long-interview analysis resumes completed model steps without repeating them', async t => {
  let editCalls = 0, failSecondEdit = true;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const prompt = JSON.parse(JSON.parse(raw).messages[1].content);
    let value = { summary: '按全片主线保留条件与问答关系' };
    if (prompt.currentDecisions) {
      editCalls++;
      if (failSecondEdit && editCalls === 2) { failSecondEdit = false; res.writeHead(503); res.end('temporary test failure'); return; }
      value.decisions = prompt.sentences.map(s => ({ sentenceId: s.id, action: 'keep', reason: '保留完整语境' }));
    }
    if (prompt.proposedDecisions) value = { summary: '全片问答对应', changes: [], reviewItems: [] };
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 10 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const p = fixture(); p.tracks[0].durationUs = 100e6;
  p.transcript = normalizeTranscript({ sentences: Array.from({ length: 70 }, (_, i) => ({ id: `S-${i}`, text: '用于模拟长访谈的完整限定语境'.repeat(25), startUs: i * 1e6, endUs: i * 1e6 + 900000 })) }, p);
  p.plan = makePlan(p);
  const saved = new Map(), checkpoint = { get: async k => saved.get(k), put: async (k, v) => saved.set(k, v) };
  const configLocal = { ...config, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  await assert.rejects(generateDecisions(p, configLocal, { checkpoint }), /503/);
  const next = await generateDecisions(p, configLocal, { checkpoint });
  validatePlan(next, p); assert.ok(next.generation.calls.filter(c => c.reused).length >= 3);
  assert.equal(next.decisions.length, 70);
  assert.equal(next.contentReview.coverage, 'full_transcript');
});

test('full-transcript review restores a normal answer bundled with equipment chatter', async t => {
  let reviewedIds = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const prompt = JSON.parse(JSON.parse(raw).messages[1].content);
    let value = { summary: '两段完整主题' };
    if (prompt.currentDecisions) value = { summary: '初步方案', decisions: prompt.sentences.map(s => ({ sentenceId: s.id, action: s.id === 'S-0' ? 'delete' : 'keep', reason: '初步判断' })) };
    if (prompt.proposedDecisions) {
      reviewedIds = prompt.transcript.map(s => s.id);
      value = { summary: '保留带正常开头的混合分段', changes: [{ sentenceId: 'S-0', action: 'keep', reason: '不能把回答前提与设备确认一起删除' }], reviewItems: [{ sentenceIds: ['S-0'], reason: '混合分段待后续细剪' }] };
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: {} }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const p = fixture(); p.tracks[0].durationUs = 100e6;
  p.transcript = normalizeTranscript({ sentences: Array.from({ length: 61 }, (_, i) => ({ id: `S-${i}`, text: i === 0 ? '这个问题分两方面说，喂能听到吗' : '这里有完整的观点和限定条件', startUs: i * 1e6, endUs: i * 1e6 + 900000 })) }, p); p.plan = makePlan(p);
  const result = await generateDecisions(p, { ...config, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  validatePlan(result, p); assert.equal(reviewedIds.length, 61); assert.equal(result.decisions[0].action, 'keep');
  assert.equal(result.contentReview.changes[0].previousAction, 'delete'); assert.equal(result.contentReview.reviewItems.length, 1);
});

test('rejected full-review patches preserve successful checkpoints and identify unknown IDs, fields and locked changes', async t => {
  const p = fixture(); p.tracks[0].durationUs = 100e6;
  p.transcript = normalizeTranscript({ sentences: Array.from({ length: 61 }, (_, i) => ({ id: `S-${i}`, text: '用于模拟全片依赖的完整语句', startUs: i * 1e6, endUs: i * 1e6 + 900000 })) }, p);
  p.plan = makePlan(p); p.plan.decisions[0].locked = true;
  const original = structuredClone(p.plan), saved = new Map(), rejected = []; let mode = 0, calls = 0;
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const prompt = JSON.parse(JSON.parse(raw).messages[1].content); calls++;
    let value = { summary: '模拟摘要' };
    if (prompt.currentDecisions) value.decisions = prompt.sentences.map(s => ({ sentenceId: s.id, action: 'keep', reason: '完整语境' }));
    if (prompt.proposedDecisions) value = { summary: '模拟复核', changes: mode === 0 ? [{ sentenceId: 'invented', action: 'keep', reason: '测试编号' }]
      : mode === 1 ? [{ sentenceId: 'S-1', action: 'keep', reason: '测试字段', rewrite: '新文字' }]
      : mode === 2 ? [{ sentenceId: 'S-0', action: 'delete', reason: '测试锁定' }] : [], reviewItems: [] };
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve)); t.after(() => mock.close());
  const options = { checkpoint: { get: async k => saved.get(k), put: async (k, v) => saved.set(k, v) }, onRejected: async d => rejected.push(d) };
  const local = { ...config, baseUrl: `http://127.0.0.1:${mock.address().port}/v1` };
  for (const error of [/句编号不存在.*invented/, /changes\[0\].*rewrite/, /锁定决定.*S-0/]) {
    await assert.rejects(generateDecisions(p, local, options), error);
    assert.deepEqual(p.plan, original); assert.equal(saved.size, 5); mode++;
  }
  const result = await generateDecisions(p, local, options);
  assert.equal(calls, 9, 'five valid steps run once; only the four explicit review attempts call the mock again');
  assert.equal(result.generation.calls.filter(c => c.reused).length, 5);
  assert.equal(rejected.length, 3); assert.ok(rejected.every(d => d.applied === false && d.step.includes('全片')));
});
