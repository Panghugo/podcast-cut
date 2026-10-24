import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createStore, atomic, validId } from './lib/store.js';
import { makePlan, normalizeTranscript, validatePlan, compileTimeline, proposedMarkdown, sourceFingerprint, integer, guardShortDeletions, guardOverlappingDeletions, markReviewStale } from './lib/plan.js';
import { generateDecisions, validateSettings, splitSentences } from './lib/provider.js';

const APP = path.dirname(fileURLToPath(import.meta.url));
const publicTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

function redact(value, secret) {
  if (typeof value === 'string') return secret ? value.replaceAll(secret, '[redacted]') : value;
  if (Array.isArray(value)) return value.map(item => redact(item, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [redact(key, secret), /^(authorization|api[_-]?key|access[_-]?token|password)$/i.test(key) ? '[redacted]' : redact(item, secret)]));
  return value;
}

export function createApp(options = {}) {
  const data = path.resolve(options.data || process.env.CUT_DATA_DIR || path.join(APP, 'data'));
  const python = options.python || process.env.CUT_PYTHON || 'python3.12';
  const store = createStore(data), jobs = new Map(), waiting = [];
  let active = false;
  const configuredBase = process.env.CUT_API_BASE_URL || 'https://api.openai.com/v1';
  let settings = { baseUrl: configuredBase, model: process.env.CUT_API_MODEL || '',
    apiKey: process.env.CUT_API_KEY || (new URL(configuredBase).hostname === 'api.deepseek.com' ? process.env.DEEPSEEK_API_KEY : '') || '',
    format: process.env.CUT_API_FORMAT || 'schema' };
  const safeSettings = () => ({ baseUrl: settings.baseUrl, model: settings.model, format: settings.format, hasKey: Boolean(settings.apiKey) });
  const publicJob = job => ({ id: job.id, projectId: job.projectId, type: job.type, status: job.status,
    message: job.message, projectRevision: job.projectRevision, createdAt: job.createdAt, files: job.files || [], result: job.result || null, retry: job.retry || null });
  const jobDir = job => path.join(store.directory(job.projectId), 'jobs', job.id);
  const saveJob = job => atomic(path.join(jobDir(job), 'job.json'), publicJob(job));
  const progress = async (job, message) => { job.message = message; await saveJob(job); };
  function launch(args, job) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, HF_HUB_OFFLINE: '1', PYTHONUNBUFFERED: '1' };
      // The offline audio worker never receives API credentials.
      delete env.CUT_API_KEY; delete env.OPENAI_API_KEY; delete env.ANTHROPIC_API_KEY; delete env.DEEPSEEK_API_KEY;
      const child = spawn(python, [path.join(APP, 'worker/audio.py'), ...args], { cwd: APP, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      if (job) job.child = child;
      let buffer = '', stderr = '', result, error, writes = Promise.resolve();
      child.stdout.on('data', part => {
        buffer += part.toString();
        for (;;) {
          const edge = buffer.indexOf('\n'); if (edge < 0) break;
          const line = buffer.slice(0, edge); buffer = buffer.slice(edge + 1);
          try { const value = JSON.parse(line); if (value.result) result = value.result; if (value.error) error = value.error;
            if (job && value.message) writes = writes.then(() => progress(job, value.message)); } catch {}
        }
        if (buffer.length > 16e6) { child.kill(); error = '音频处理输出异常'; }
      });
      child.stderr.on('data', part => { stderr = (stderr + part.toString()).slice(-2000); });
      child.on('error', e => reject(Error(`无法启动 Python 音频环境：${e.code || 'unknown'}`)));
      child.on('close', async code => {
        try { await writes; if (code !== 0 || !result) reject(Error(error || `音频任务失败（${code}）：${stderr}`)); else resolve(result); }
        catch (e) { reject(e); }
      });
    });
  }
  async function execute(job) {
    job.status = 'running'; await saveJob(job);
    try {
      if (job.controller.signal.aborted) throw Error('任务已取消');
      const project = job.snapshot;
      if ((await store.get(project.id)).revision !== project.revision) throw Error('排队期间工程已变化，请重新提交');
      for (const track of project.tracks) {
        const full = await store.source(project.id, track.path, track.sha256), hash = createHash('sha256');
        for await (const part of fs.createReadStream(full)) {
          if (job.controller.signal.aborted) throw Error('任务已取消');
          hash.update(part);
        }
        if (hash.digest('hex') !== track.sha256) throw Error('源文件已变化，不能使用旧转录或方案');
      }
      if (job.type === 'plan' || job.type === 'revise') {
        const rawPlan = await generateDecisions(project, job.config, { signal: job.controller.signal,
          checkpoint: store.checkpoint(project.id), progress: message => { job.message = message; },
          onRejected: async diagnostic => {
            await atomic(path.join(jobDir(job), 'model_rejection.json'), redact(diagnostic, job.config.apiKey));
            job.files = ['model_rejection.json'];
          },
          feedback: job.feedback, scopeIds: job.scopeIds });
        validatePlan(rawPlan, project, { previous: project.plan, model: true });
        await atomic(path.join(jobDir(job), 'model_edit.json'), rawPlan);
        const plan = guardOverlappingDeletions(project, guardShortDeletions(project, rawPlan));
        compileTimeline(project, plan);
        await atomic(path.join(jobDir(job), 'proposed_edit.json'), plan);
        await fsp.writeFile(path.join(jobDir(job), 'transcript_proposed.md'), proposedMarkdown(project, plan));
        job.files = ['model_edit.json', 'proposed_edit.json', 'transcript_proposed.md'];
        if (job.controller.signal.aborted) throw Error('任务已取消；候选保留，未应用');
        await store.update(project.id, project.revision, current => ({ ...current, plan }));
        job.result = { generation: plan.generation };
      } else {
        const request = { type: job.type, project, projectRoot: store.directory(project.id), outputDir: jobDir(job),
          modelPath: process.env.CUT_WHISPER_MODEL || '', ...(job.type === 'render' ? { timeline: compileTimeline(project, project.plan) } : {}) };
        if (job.type === 'render') await fsp.writeFile(path.join(jobDir(job), 'transcript_proposed.md'), proposedMarkdown(project, project.plan));
        await atomic(path.join(jobDir(job), 'request.json'), request);
        const result = await launch(['--request', path.join(jobDir(job), 'request.json')], job);
        if (job.controller.signal.aborted) throw Error('任务已取消');
        job.files = result.files;
        if (job.type === 'transcribe') {
          await store.update(project.id, project.revision, current => {
            const transcript = normalizeTranscript(result.transcript, current);
            const next = { ...current, transcript }; return { ...next, plan: makePlan(next) };
          });
        } else {
          job.result = { durationUs: result.timeline.durationUs, rollbacks: result.timeline.rollbacks, audioFiles: result.audioFiles, listeningStatus: 'pending' };
        }
      }
      job.status = 'succeeded'; job.message = '完成；请审阅内容与实际声音';
    } catch (e) {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.message = String(e.message).replaceAll(job.config?.apiKey || '\u0000', '[redacted]').slice(0, 2000);
    } finally { delete job.snapshot; delete job.config; delete job.child; await saveJob(job); }
  }
  async function drain() {
    if (active) return; active = true;
    try { while (waiting.length) { const job = waiting.shift(); if (job.status === 'queued') await execute(job); } }
    finally { active = false; }
  }
  async function loadJobs(id) {
    const folder = path.join(store.directory(id), 'jobs');
    let entries; try { entries = await fsp.readdir(folder); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const result = [];
    for (const jid of entries.filter(validId)) {
      if (jobs.has(jid)) { result.push(publicJob(jobs.get(jid))); continue; }
      try {
        const file = path.join(folder, jid, 'job.json'), saved = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (['queued', 'running'].includes(saved.status)) { saved.status = 'interrupted'; saved.message = '服务重启中断任务，可重新提交；已完成模型步骤会复用'; await atomic(file, saved); }
        result.push(saved);
      } catch {}
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function submit(project, input) {
    if (!['plan', 'revise', 'render', 'transcribe'].includes(input.type)) throw Error('未知任务类型');
    if (input.revision !== project.revision) throw Error('工程已更新，请刷新');
    if (!project.tracks.length) throw Error('请先导入音频');
    if ([...jobs.values()].some(j => j.projectId === project.id && ['queued', 'running'].includes(j.status))) throw Error('本工程已有任务，请等待或取消');
    if (input.type !== 'transcribe' && !project.plan) throw Error('请先生成或导入转录');
    if (input.type === 'transcribe' && project.tracks.length !== 1) throw Error('本轮多轨请导入已核对说话人与共同时间码的转录');
    if (input.type === 'render' && project.plan.status !== 'approved') throw Error('请先批准当前方案');
    if (input.type === 'render' && project.tracks.length > 1 && project.tracks.some(t => t.alignment !== 'declared')) throw Error('多轨必须先确认共同时间轴');
    const config = ['plan', 'revise'].includes(input.type) ? validateSettings(settings) : null;
    let feedback, scopeIds;
    if (input.type === 'revise') {
      feedback = project.feedback.find(n => n.id === input.feedbackId);
      if (!feedback) throw Error('找不到审听意见');
      if (!['local', 'all'].includes(input.scope)) throw Error('请指定只改本段或检查全片');
      if (input.scope === 'local') scopeIds = feedback.sentenceIds;
    }
    const job = { id: randomUUID(), projectId: project.id, projectRevision: project.revision, type: input.type,
      status: 'queued', message: '等待执行', createdAt: new Date().toISOString(), snapshot: project,
      config, controller: new AbortController(), feedback, scopeIds,
      retry: config ? { type: input.type, ...(feedback ? { feedbackId: feedback.id, scope: input.scope } : {}) } : null };
    await fsp.mkdir(jobDir(job), { recursive: true }); await saveJob(job);
    jobs.set(job.id, job); waiting.push(job); setImmediate(() => drain().catch(() => {}));
    return publicJob(job);
  }
  const json = (res, code, value, type = 'application/json; charset=utf-8') => {
    const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body);
  };
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw Error('请求必须使用 JSON');
    const chunks = []; let n = 0;
    for await (const part of req) { n += part.length; if (n > 32e6) throw Error('请求超过32MB'); chunks.push(part); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async function file(req, res, full, download = false) {
    const stat = await fsp.stat(full); let start = 0, end = stat.size - 1, code = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416); res.end(); return; }
      start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (!Number.isSafeInteger(start) || start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
      code = 206;
    }
    res.writeHead(code, { 'Content-Type': publicTypes[path.extname(full)] || 'application/octet-stream', 'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(code === 206 ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
      ...(download ? { 'Content-Disposition': `attachment; filename="${path.basename(full)}"` } : {}) });
    await pipeline(fs.createReadStream(full, { start, end }), res);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${req.socket.localPort}`;
      if (!['127.0.0.1', 'localhost'].some(host => req.headers.host === `${host}:${req.socket.localPort}`)) return json(res, 403, { error: '只允许本机访问' });
      if (req.headers.origin && ![origin, origin.replace('127.0.0.1', 'localhost')].includes(req.headers.origin)) return json(res, 403, { error: '拒绝外部网页请求' });
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      const url = new URL(req.url, origin), route = url.pathname;
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(route)) return await file(req, res, path.join(APP, 'public', route === '/' ? 'index.html' : route.slice(1)));
      if (route === '/api/health') return json(res, 200, { version: '0.1.0-alpha.1', localOnly: true });
      if (route === '/api/settings' && req.method === 'GET') return json(res, 200, safeSettings());
      if (route === '/api/settings' && req.method === 'POST') {
        const input = await body(req);
        // Retain a blank field only for the identical API base. Never carry an
        // existing credential to a different service, port or API path.
        const sameBase = new URL(input.baseUrl).toString().replace(/\/$/, '') === new URL(settings.baseUrl).toString().replace(/\/$/, '');
        settings = validateSettings({ ...input, apiKey: input.apiKey || (sameBase ? settings.apiKey : '') }); return json(res, 200, safeSettings());
      }
      if (route === '/api/projects' && req.method === 'GET') return json(res, 200, await store.list());
      if (route === '/api/projects' && req.method === 'POST') return json(res, 201, await store.create((await body(req)).name));
      const match = /^\/api\/projects\/([a-f0-9-]{36})(?:\/(.*))?$/.exec(route);
      if (!match) return json(res, 404, { error: '未找到接口' });
      const [, id, action = ''] = match, project = await store.get(id);
      if (!action && req.method === 'GET') return json(res, 200, project);
      if (action === 'audio' && req.method === 'POST') {
        const extension = path.extname(url.searchParams.get('name') || '').toLowerCase();
        if (!['.wav', '.mp3', '.m4a', '.flac', '.ogg'].includes(extension)) throw Error('支持 WAV、MP3、M4A、FLAC、OGG');
        if (project.tracks.length >= 12) throw Error('最多12轨');
        const tid = randomUUID(), relative = `sources/${tid}${extension}`, full = path.join(store.directory(id), relative);
        const hash = createHash('sha256'); let size = 0;
        try {
          const meter = new Transform({ transform(chunk, encoding, cb) { size += chunk.length; if (size > 10 * 1024 ** 3) return cb(Error('单文件超过10GB')); hash.update(chunk); cb(null, chunk); } });
          await pipeline(req, meter, fs.createWriteStream(full, { flags: 'wx', mode: 0o600 }));
          const info = await launch(['--probe', full]);
          const next = await store.update(id, Number(url.searchParams.get('revision')), current => {
            if (current.transcript) throw Error('绑定转录后不能再添加轨道，请新建工程以免时间码串用');
            current.tracks.push({ id: tid, path: relative, originalName: path.basename(url.searchParams.get('name')), sha256: hash.digest('hex'), bytes: size,
              ...info, offsetUs: 0, gainDb: 0, alignment: current.tracks.length === 0 ? 'reference' : 'unverified' });
            return current;
          });
          return json(res, 201, next);
        } catch (e) { await fsp.rm(full, { force: true }); throw e; }
      }
      if (action === 'tracks' && req.method === 'POST') {
        const input = await body(req);
        return json(res, 200, await store.update(id, input.revision, current => {
          if (current.transcript) throw Error('绑定转录后不可修改源偏移，请新建工程');
          if (!Array.isArray(input.tracks) || input.tracks.length !== current.tracks.length) throw Error('轨道列表不完整');
          for (const track of current.tracks) {
            const update = input.tracks.find(t => t.id === track.id);
            if (!update || !integer(update.offsetUs) || update.offsetUs > 86400e6) throw Error('轨道偏移必须为非负整数微秒；请把最早轨设为零点');
            if (update.alignment !== 'declared') throw Error('须明确声明各轨已同步');
            track.offsetUs = update.offsetUs; track.alignment = 'declared';
          }
          return current;
        }));
      }
      if (action.startsWith('audio/') && req.method === 'GET') {
        const track = project.tracks.find(t => t.id === action.slice(6)); if (!track) throw Error('未找到轨道');
        return await file(req, res, await store.source(id, track.path, track.sha256));
      }
      if (action === 'transcript' && req.method === 'POST') {
        const input = await body(req); if (input.confirmBinding !== true) throw Error('请确认转录与当前共同时间轴对应');
        return json(res, 200, await store.update(id, input.revision, current => {
          if (current.transcript) throw Error('本轮不覆盖已有转录；请新建工程绑定新版本');
          const transcript = normalizeTranscript(input.document, current), next = { ...current, transcript };
          return { ...next, plan: makePlan(next, input.editorial) };
        }));
      }
      if (action === 'plan' && req.method === 'POST') {
        const input = await body(req);
        return json(res, 200, await store.update(id, input.revision, current => {
          let plan = { ...input.plan, id: current.plan.id, revision: current.plan.revision + 1, status: 'draft' };
          if (JSON.stringify([plan.order, plan.decisions, plan.editorial]) !== JSON.stringify([current.plan.order, current.plan.decisions, current.plan.editorial])) {
            plan = markReviewStale(plan, '方案已由用户或外部工具修改；此前全文复核不代表当前方案已复核。');
          }
          validatePlan(plan, current); compileTimeline(current, plan); return { ...current, plan };
        }));
      }
      if (action === 'approve' && req.method === 'POST') {
        const input = await body(req);
        return json(res, 200, await store.update(id, input.revision, current => {
          validatePlan(current.plan, current); compileTimeline(current, current.plan);
          return { ...current, plan: { ...current.plan, status: 'approved', approvedAt: new Date().toISOString() } };
        }));
      }
      if (action === 'estimate' && req.method === 'GET') {
        if (!project.transcript) throw Error('请先绑定转录');
        const sentences = project.transcript.sentences;
        const count = splitSentences(sentences.map(({ id, speaker, text, startUs, endUs }) => ({ id, speaker, text, startUs, endUs }))).length;
        return json(res, 200, { characters: sentences.reduce((n, s) => n + s.text.length, 0), chunks: count,
          requests: count === 1 ? 1 : count * 2 + 2, note: '估算含全片复核；全文超过输入上限时复核会跳过并明确标记。实际 token 用量随模型而变，不提供未经定价核对的金额' });
      }
      if (action === 'export' && req.method === 'GET') {
        validatePlan(project.plan, project);
        const bundle = { schemaVersion: 'podcast-handoff/1', project: { ...project, feedback: [] }, plan: project.plan, timeline: compileTimeline(project, project.plan) };
        res.setHeader('Content-Disposition', 'attachment; filename="podcast-handoff.json"'); return json(res, 200, bundle);
      }
      if (action === 'jobs' && req.method === 'GET') return json(res, 200, await loadJobs(id));
      if (action === 'jobs' && req.method === 'POST') return json(res, 202, await submit(project, await body(req)));
      const cancel = /^jobs\/([a-f0-9-]{36})\/cancel$/.exec(action);
      if (cancel && req.method === 'POST') {
        await body(req);
        const job = jobs.get(cancel[1]); if (!job || job.projectId !== id || !['queued', 'running'].includes(job.status)) throw Error('任务未在运行');
        job.controller.abort(); job.status = 'cancelled'; job.message = '已取消';
        if (job.child?.pid) { try { process.platform === 'win32' ? job.child.kill() : process.kill(-job.child.pid, 'SIGTERM'); } catch {} }
        await saveJob(job); return json(res, 200, publicJob(job));
      }
      const artifact = /^jobs\/([a-f0-9-]{36})\/files\/([\w.-]+)$/.exec(action);
      if (artifact && req.method === 'GET') {
        const job = (await loadJobs(id)).find(j => j.id === artifact[1]);
        if (!job?.files.includes(artifact[2])) throw Error('文件未列入任务产物');
        return await file(req, res, path.join(store.directory(id), 'jobs', artifact[1], artifact[2]), url.searchParams.get('download') === '1');
      }
      if (action === 'feedback' && req.method === 'POST') {
        const input = await body(req);
        return json(res, 200, await store.update(id, input.revision, async current => {
          if (!['待处理', '待复听', '已解决'].includes(input.status) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000) throw Error('意见或状态无效');
          if (input.id) {
            const note = current.feedback.find(n => n.id === input.id); if (!note) throw Error('意见不存在');
            note.text = input.text; note.status = input.status; note.updatedAt = new Date().toISOString(); return current;
          }
          const job = (await loadJobs(id)).find(j => j.id === input.jobId && j.type === 'render' && j.status === 'succeeded');
          if (!job || !integer(input.startUs) || !integer(input.endUs, input.startUs + 1)) throw Error('意见须绑定已完成粗剪的有效时间区间');
          const timeline = JSON.parse(await fsp.readFile(path.join(store.directory(id), 'jobs', job.id, 'timeline.json'), 'utf8'));
          if (timeline.sourceFingerprint !== sourceFingerprint(current) || input.endUs > timeline.durationUs) throw Error('音频绑定或时间范围不一致');
          const manifest = JSON.parse(await fsp.readFile(path.join(store.directory(id), 'jobs', job.id, 'manifest.json'), 'utf8'));
          const audioFile = input.audioFile || (job.files.includes('candidate.wav') ? 'candidate.wav' : null);
          if (!audioFile || !job.files.includes(audioFile) || !/^(candidate|stem-\d+)\.wav$/.test(audioFile)) throw Error('请指定正在审听的粗剪音轨');
          const audio = manifest.files.find(f => f.path === audioFile);
          if (!audio?.sha256) throw Error('音轨缺少版本校验和');
          const hash = createHash('sha256');
          for await (const part of fs.createReadStream(path.join(store.directory(id), 'jobs', job.id, audioFile))) hash.update(part);
          if (hash.digest('hex') !== audio.sha256) throw Error('粗剪音频已变化，不能使用旧版本批注');
          const intervals = timeline.blocks.filter(b => input.startUs < b.outputEndUs && input.endUs > b.outputStartUs)
            .map(b => ({ startUs: b.sourceStartUs + Math.max(input.startUs, b.outputStartUs) - b.outputStartUs,
              endUs: b.sourceStartUs + Math.min(input.endUs, b.outputEndUs) - b.outputStartUs }));
          const sentenceIds = current.transcript.sentences.filter(s => intervals.some(r => s.startUs < r.endUs && s.endUs > r.startUs)).map(s => s.id);
          current.feedback.push({ id: randomUUID(), jobId: job.id, planRevision: timeline.planRevision,
            audioFile, audioSha256: audio.sha256,
            sourceFingerprint: timeline.sourceFingerprint, startUs: input.startUs, endUs: input.endUs,
            intervals, sentenceIds, text: input.text, status: input.status, createdAt: new Date().toISOString() });
          return current;
        }));
      }
      if (action === 'history' && req.method === 'GET') return json(res, 200, (await fsp.readdir(path.join(store.directory(id), 'history'))).filter(f => /^\d{6}\.json$/.test(f)).sort().reverse());
      if (action === 'restore' && req.method === 'POST') {
        const input = await body(req);
        if (!/^\d{6}\.json$/.test(input.version)) throw Error('版本编号无效');
        const old = JSON.parse(await fsp.readFile(path.join(store.directory(id), 'history', input.version), 'utf8'));
        if (!old.plan) throw Error('这个版本还没有剪辑方案');
        return json(res, 200, await store.update(id, input.revision, current => {
          const plan = { ...old.plan, revision: current.plan.revision + 1, status: 'draft' };
          validatePlan(plan, current); return { ...current, plan };
        }));
      }
      return json(res, 404, { error: '未找到接口' });
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      return json(res, e.code === 'ENOENT' ? 404 : 400, { error: String(e.message).replaceAll(settings.apiKey || '\u0000', '[redacted]').slice(0, 2000) });
    }
  });
  return { server, store, jobs, close: async () => {
    for (const job of jobs.values()) { job.controller.abort(); if (job.child?.pid) { try { process.kill(-job.child.pid, 'SIGTERM'); } catch {} } }
    await new Promise(resolve => server.close(resolve));
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.server.listen(Number(process.env.CUT_PORT || 8770), '127.0.0.1', () => console.log(`PodCut · http://127.0.0.1:${app.server.address().port}`));
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
