import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createApp } from '../server.js';

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha = b => createHash('sha256').update(b).digest('hex');
function wav(frequency = 440) {
  const frames = 48000 * 4, buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(48000, 24); buffer.writeUInt32LE(96000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) buffer.writeInt16LE(Math.round(Math.sin(i / 48000 * frequency * Math.PI * 2) * 7000), 44 + i * 2);
  return buffer;
}
function pcm24(buffer, index) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32LE(offset + 4);
    if (buffer.toString('ascii', offset, offset + 4) === 'data') return buffer.readIntLE(offset + 8 + index * 3, 3);
    offset += 8 + size + (size % 2);
  }
  throw Error('WAV data chunk missing');
}
async function setup(t) {
  const folder = path.join(APP, '.local', 'test'); await fs.mkdir(folder, { recursive: true });
  const root = await fs.mkdtemp(path.join(folder, 'run-'));
  const app = createApp({ data: root });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (url, body) => {
    const response = await fetch(base + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result = await response.json(); assert.ok(response.ok, result.error); return result;
  };
  const project = await api('/api/projects', { name: '合成信号验证，非真人节目' });
  const upload = async (project, freq = 440) => {
    const response = await fetch(`${base}/api/projects/${project.id}/audio?name=test.wav&revision=${project.revision}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: wav(freq) });
    const result = await response.json(); assert.ok(response.ok, result.error); return result;
  };
  const until = async (url, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const jobs = await api(url), job = jobs[0];
      if (job && !['queued', 'running'].includes(job.status)) return job;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw Error('job timed out');
  };
  return { ...app, root, base, api, project, upload, until };
}
const sentences = [{ id: 'A-1', text: '合成测试的第一句占位文字', startUs: 0, endUs: 800000 },
  { id: 'B-2', text: '需要删除的重复占位文字', startUs: 1200000, endUs: 1800000 },
  { id: 'B-3', text: '合成测试的第三句占位文字', startUs: 2200000, endUs: 3800000 }];

test('end to end: import → mock API plan → approval → real audio render → bound feedback → revision → history', { timeout: 60000 }, async t => {
  const s = await setup(t); let p = await s.upload(s.project); const prefix = `/api/projects/${p.id}`;
  const originalHash = sha(await fs.readFile(path.join(s.store.directory(p.id), p.tracks[0].path)));
  p = await s.api(`${prefix}/transcript`, { revision: p.revision, confirmBinding: true, document: { sentences } });
  const mock = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const prompt = JSON.parse(JSON.parse(body).messages[1].content);
    const decisions = prompt.sentences.map(x => ({ sentenceId: x.id, action: x.id === 'B-2' ? 'delete' : 'keep', reason: '本机模拟服务验证' }));
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: '测试粗剪方案', decisions }) } }], usage: { prompt_tokens: 100, completion_tokens: 70 } }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve)); t.after(() => mock.close());
  const key = 'test-only-do-not-persist';
  const config = await s.api('/api/settings', { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: key, model: 'mock', format: 'schema' });
  assert.equal(config.hasKey, true); assert.equal(config.apiKey, undefined);
  await s.api(`${prefix}/jobs`, { revision: p.revision, type: 'plan' });
  let job = await s.until(`${prefix}/jobs`); assert.equal(job.status, 'succeeded', job.message);
  p = await s.api(prefix); assert.equal(p.plan.decisions[1].action, 'delete');
  assert.equal(p.plan.status, 'draft');
  p = await s.api(`${prefix}/approve`, { revision: p.revision });
  await s.api(`${prefix}/jobs`, { revision: p.revision, type: 'render' });
  job = await s.until(`${prefix}/jobs`); assert.equal(job.status, 'succeeded', job.message);
  assert.equal(job.result.durationUs, 2720000); assert.ok(job.files.includes('candidate.mp3'));
  const manifest = await s.api(`${prefix}/jobs/${job.id}/files/manifest.json`);
  assert.equal(manifest.timeline.durationSamples, 130560); assert.equal(manifest.timeline.listeningStatus, 'pending');
  const candidate = Buffer.from(await (await fetch(`${s.base}${prefix}/jobs/${job.id}/files/candidate.wav`)).arrayBuffer());
  const sourceBytes = wav();
  for (const b of manifest.timeline.blocks) {
    for (const at of [2000, 7000, 12000]) {
      const before = sourceBytes.readInt16LE(44 + (b.sourceStartSample + at) * 2) * 256;
      assert.equal(pcm24(candidate, b.outputStartSample + at), before, 'retained samples must keep their source positions and gain away from fades');
    }
  }
  for (const item of manifest.files) {
    const bytes = Buffer.from(await (await fetch(`${s.base}${prefix}/jobs/${job.id}/files/${item.path}`)).arrayBuffer());
    assert.equal(sha(bytes), item.sha256);
  }
  const range = await fetch(`${s.base}${prefix}/jobs/${job.id}/files/candidate.wav`, { headers: { Range: 'bytes=0-43' } }); assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 44);
  const blocked = await fetch(`${s.base}${prefix}/jobs/${job.id}/files/request.json`); assert.equal(blocked.status, 400);
  p = await s.api(`${prefix}/feedback`, { revision: p.revision, jobId: job.id, startUs: 1000000, endUs: 2000000, text: '核对这一段', status: '待处理' });
  assert.deepEqual(p.feedback[0].sentenceIds, ['B-3']); assert.equal(p.feedback[0].jobId, job.id);
  assert.equal(p.feedback[0].audioFile, 'candidate.wav'); assert.equal(p.feedback[0].audioSha256, sha(candidate));
  const oldRender = job.id;
  await s.api(`${prefix}/jobs`, { revision: p.revision, type: 'revise', feedbackId: p.feedback[0].id, scope: 'local' });
  job = await s.until(`${prefix}/jobs`); assert.equal(job.status, 'succeeded', job.message);
  p = await s.api(prefix); assert.equal(p.plan.status, 'draft'); assert.equal(p.feedback[0].jobId, oldRender);
  const history = await s.api(`${prefix}/history`); assert.ok(history.length >= 5);
  p = await s.api(`${prefix}/restore`, { revision: p.revision, version: '000003.json' });
  assert.equal(p.plan.decisions[1].action, 'keep'); assert.equal(p.feedback.length, 1);
  const bundle = await s.api(`${prefix}/export`); assert.equal(bundle.schemaVersion, 'podcast-handoff/1');
  assert.equal(JSON.stringify(bundle).includes(key), false);
  assert.equal(sha(await fs.readFile(path.join(s.store.directory(p.id), p.tracks[0].path))), originalHash);
  for (const name of await fs.readdir(path.join(s.store.directory(p.id), 'jobs'))) {
    const file = await fs.readFile(path.join(s.store.directory(p.id), 'jobs', name, 'job.json'), 'utf8'); assert.equal(file.includes(key), false);
  }
});

test('multi-track stems share a timeline and ambiguous transcripts are rejected', { timeout: 60000 }, async t => {
  const s = await setup(t); let p = await s.upload(s.project); p = await s.upload(p, 880); const prefix = `/api/projects/${p.id}`;
  let response = await fetch(`${s.base}${prefix}/transcript`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: p.revision, confirmBinding: true, document: { sentences } }) });
  assert.equal(response.status, 400);
  p = await s.api(`${prefix}/tracks`, { revision: p.revision, tracks: p.tracks.map(t => ({ id: t.id, offsetUs: 0, alignment: 'declared' })) });
  p = await s.api(`${prefix}/transcript`, { revision: p.revision, confirmBinding: true, document: { sentences: sentences.map((x, i) => ({ ...x, trackId: p.tracks[i % 2].id })) } });
  p.plan.decisions[1].action = 'delete';
  p = await s.api(`${prefix}/plan`, { revision: p.revision, plan: p.plan }); p = await s.api(`${prefix}/approve`, { revision: p.revision });
  await s.api(`${prefix}/jobs`, { revision: p.revision, type: 'render' });
  const job = await s.until(`${prefix}/jobs`); assert.equal(job.status, 'succeeded', job.message);
  assert.ok(job.files.includes('stem-1.wav')); assert.ok(job.files.includes('stem-2.wav')); assert.ok(!job.files.includes('candidate.wav'));
  const manifest = await s.api(`${prefix}/jobs/${job.id}/files/manifest.json`); assert.equal(manifest.timeline.durationSamples, 130560);
  const first = await fs.stat(path.join(s.store.directory(p.id), 'jobs', job.id, 'stem-1.wav'));
  const second = await fs.stat(path.join(s.store.directory(p.id), 'jobs', job.id, 'stem-2.wav')); assert.equal(first.size, second.size);
  assert.equal(job.result.audioFiles[1].trackId, p.tracks[1].id);
  const noteInput = { revision: p.revision, jobId: job.id, startUs: 1000000, endUs: 2000000, text: '第二轨核对', status: '待处理' };
  response = await fetch(`${s.base}${prefix}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noteInput) });
  assert.equal(response.status, 400, 'multi-track feedback must specify which stem was heard');
  p = await s.api(`${prefix}/feedback`, { ...noteInput, audioFile: 'stem-2.wav' });
  assert.equal(p.feedback[0].audioFile, 'stem-2.wav');
  assert.equal(p.feedback[0].audioSha256, manifest.audioFiles[1].sha256);
  await fs.appendFile(path.join(s.store.directory(p.id), 'jobs', job.id, 'stem-2.wav'), 'tampered');
  response = await fetch(`${s.base}${prefix}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...noteInput, revision: p.revision, audioFile: 'stem-2.wav' }) });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /音频已变化/);
});

test('invalid model output yields redacted diagnostics without changing the plan; explicit retry succeeds', { timeout: 20000 }, async t => {
  const s = await setup(t); let p = await s.upload(s.project); const prefix = `/api/projects/${p.id}`;
  p = await s.api(`${prefix}/transcript`, { revision: p.revision, confirmBinding: true, document: { sentences } });
  const before = structuredClone(p), secret = 'diagnostic-test-secret'; let malformed = true, calls = 0;
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const prompt = JSON.parse(JSON.parse(raw).messages[1].content); calls++;
    const result = { summary: '模拟返回', decisions: prompt.sentences.map(x => ({ sentenceId: x.id, action: 'keep', reason: '保留语境' })) };
    if (malformed) result.decisions[0].unexpected = secret;
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve)); t.after(() => mock.close());
  await s.api('/api/settings', { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: secret, model: 'mock', format: 'json' });
  await s.api(`${prefix}/jobs`, { revision: p.revision, type: 'plan' });
  const failed = await s.until(`${prefix}/jobs`); assert.equal(failed.status, 'failed'); assert.equal(calls, 1);
  assert.match(failed.message, /decisions\[0\].*unexpected/);
  const diagnostic = await s.api(`${prefix}/jobs/${failed.id}/files/model_rejection.json`);
  assert.equal(diagnostic.applied, false); assert.equal(diagnostic.response.decisions[0].unexpected, '[redacted]');
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  assert.deepEqual((await s.api(prefix)).plan, before.plan); assert.equal((await s.api(prefix)).revision, before.revision);
  malformed = false;
  await s.api(`${prefix}/jobs`, { ...failed.retry, revision: p.revision });
  const passed = await s.until(`${prefix}/jobs`); assert.equal(passed.status, 'succeeded', passed.message); assert.equal(calls, 2);
});

test('changing the API base clears an existing in-memory credential', async t => {
  const s = await setup(t);
  const settings = { baseUrl: 'https://provider.example/v1', apiKey: 'routing-test-secret', model: 'mock', format: 'json' };
  assert.equal((await s.api('/api/settings', settings)).hasKey, true);
  assert.equal((await s.api('/api/settings', { ...settings, apiKey: '' })).hasKey, true);
  assert.equal((await s.api('/api/settings', { ...settings, baseUrl: 'https://provider.example/another', apiKey: '' })).hasKey, false);
});

test('aborted audio streaming and missing artifacts do not crash the local service', { timeout: 20000 }, async t => {
  const s = await setup(t); const p = await s.upload(s.project), prefix = `/api/projects/${p.id}`;
  // A large local artifact makes aborting during an active transfer deterministic.
  const id = '00000000-0000-4000-8000-000000000001', folder = path.join(s.store.directory(p.id), 'jobs', id);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'job.json'), JSON.stringify({ id, projectId: p.id, type: 'render', status: 'succeeded', createdAt: new Date().toISOString(), files: ['candidate.wav', 'missing.wav'] }));
  const handle = await fs.open(path.join(folder, 'candidate.wav'), 'w'); await handle.truncate(32 * 1024 * 1024); await handle.close();
  const url = `${s.base}${prefix}/jobs/${id}/files`;
  await new Promise((resolve, reject) => {
    const request = http.get(`${url}/candidate.wav`, res => { res.once('data', () => { res.destroy(); resolve(); }); res.on('error', () => {}); });
    request.on('error', reject);
  });
  assert.equal((await s.api('/api/health')).localOnly, true);
  const missing = await fetch(`${url}/missing.wav`); assert.equal(missing.status, 404);
  assert.equal((await s.api('/api/health')).localOnly, true);
});

test('changed source checksum prevents use of stale transcript without overwriting it', { timeout: 20000 }, async t => {
  const s = await setup(t); let p = await s.upload(s.project); const prefix = `/api/projects/${p.id}`;
  p = await s.api(`${prefix}/transcript`, { revision: p.revision, confirmBinding: true, document: { sentences } });
  p = await s.api(`${prefix}/approve`, { revision: p.revision });
  await fs.writeFile(path.join(s.store.directory(p.id), p.tracks[0].path), wav(550));
  await s.api(`${prefix}/jobs`, { revision: p.revision, type: 'render' });
  const job = await s.until(`${prefix}/jobs`); assert.equal(job.status, 'failed'); assert.match(job.message, /源文件已变化/);
  assert.equal((await s.api(prefix)).revision, p.revision);
});

test('cancel aborts an in-flight model call and leaves the current plan intact', { timeout: 20000 }, async t => {
  const s = await setup(t); let p = await s.upload(s.project); const prefix = `/api/projects/${p.id}`;
  p = await s.api(`${prefix}/transcript`, { revision: p.revision, confirmBinding: true, document: { sentences } });
  let started; const ready = new Promise(resolve => { started = resolve; });
  const mock = http.createServer(async req => { for await (const b of req) {} started(); });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve)); t.after(() => { mock.closeAllConnections(); mock.close(); });
  await s.api('/api/settings', { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: '', model: 'mock', format: 'schema' });
  const job = await s.api(`${prefix}/jobs`, { revision: p.revision, type: 'plan' }); await ready;
  await s.api(`${prefix}/jobs/${job.id}/cancel`, {});
  const ended = await s.until(`${prefix}/jobs`); assert.equal(ended.status, 'cancelled');
  assert.equal((await s.api(prefix)).revision, p.revision);
});

test('local access, revision conflicts and foreign origins cannot mutate an engineering project', async t => {
  const s = await setup(t), prefix = `/api/projects/${s.project.id}`;
  const blocked = await fetch(`${s.base}/api/projects`, { method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'blocked' }) });
  assert.equal(blocked.status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${s.base}/api/settings`, { headers: { Host: 'foreign.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  const p = await s.upload(s.project);
  const invalid = await fetch(`${s.base}${prefix}/transcript`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 1, confirmBinding: true, document: { sentences } }) });
  assert.equal(invalid.status, 400); assert.equal((await s.api(prefix)).revision, p.revision);
});

test('DeepSeek environment credential is selected only for its exact official API hostname', async t => {
  const keys = ['CUT_API_BASE_URL', 'CUT_API_KEY', 'DEEPSEEK_API_KEY'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } });
  delete process.env.CUT_API_KEY; process.env.DEEPSEEK_API_KEY = 'fake-provider-routing-key';
  process.env.CUT_API_BASE_URL = 'https://api.deepseek.com';
  const official = await setup(t); const configured = await official.api('/api/settings');
  assert.equal(configured.hasKey, true); assert.equal(JSON.stringify(configured).includes('fake-provider-routing-key'), false);
  process.env.CUT_API_BASE_URL = 'https://api.deepseek.com.example.org';
  const other = await setup(t); assert.equal((await other.api('/api/settings')).hasKey, false);
});
