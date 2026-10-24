import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chat, decisionSchema, generateDecisions, splitSentences, validateSettings } from '../lib/provider.js';
import { validatePlan } from '../lib/plan.js';
import { fixture } from './helpers.js';
import { makePlan, normalizeTranscript } from '../lib/plan.js';

const config = { baseUrl: 'http://127.0.0.1:1234/v1', model: 'test-model', format: 'schema', apiKey: 'local-test-secret' };
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
  const revised = await generateDecisions(p, configLocal, { scopeIds: ['B-2'], feedback: { text: '仅改第二句' } });
  assert.equal(revised.decisions[0].reason, p.plan.decisions[0].reason);
  assert.equal(revised.decisions[1].action, 'delete');
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
});
