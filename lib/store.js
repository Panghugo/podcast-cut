import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { integer } from './plan.js';

export const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
export async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, file);
}
export function createStore(root) {
  const locks = new Map();
  function directory(id) { if (!validId(id)) throw Error('工程编号无效'); return path.join(root, id); }
  async function get(id) { return JSON.parse(await fs.readFile(path.join(directory(id), 'project.json'), 'utf8')); }
  async function update(id, revision, transform) {
    const before = locks.get(id) || Promise.resolve();
    let release; const next = new Promise(resolve => { release = resolve; }); locks.set(id, next);
    await before;
    try {
      const current = await get(id);
      if (!integer(revision, 1) || current.revision !== revision) throw Error('工程已更新，请刷新后重试');
      const result = await transform(structuredClone(current));
      const project = { ...result, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      await atomic(path.join(directory(id), 'history', `${String(project.revision).padStart(6, '0')}.json`), project);
      await atomic(path.join(directory(id), 'project.json'), project);
      return project;
    } finally { release(); if (locks.get(id) === next) locks.delete(id); }
  }
  async function create(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw Error('请填写节目名称');
    const id = randomUUID(), now = new Date().toISOString();
    const project = { schemaVersion: 'podcast-project/1', id, name: name.trim(), revision: 1, tracks: [],
      transcript: null, plan: null, feedback: [], createdAt: now, updatedAt: now };
    await fs.mkdir(path.join(directory(id), 'sources'), { recursive: true });
    await atomic(path.join(directory(id), 'history', '000001.json'), project);
    await atomic(path.join(directory(id), 'project.json'), project);
    return project;
  }
  async function list() {
    await fs.mkdir(root, { recursive: true });
    const projects = [];
    for (const entry of await fs.readdir(root)) if (validId(entry)) {
      try { const p = await get(entry); projects.push({ id: p.id, name: p.name, revision: p.revision, updatedAt: p.updatedAt }); } catch {}
    }
    return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  function checkpoint(id) {
    const folder = path.join(directory(id), 'checkpoints');
    return {
      async get(key) { try { return JSON.parse(await fs.readFile(path.join(folder, `${key}.json`), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
      async put(key, output) { await atomic(path.join(folder, `${key}.json`), output); },
      async remove(key) { await fs.rm(path.join(folder, `${key}.json`), { force: true }); }
    };
  }
  async function source(id, relative, expected) {
    if (typeof relative !== 'string' || !/^sources\/[a-f0-9-]{36}\.(wav|mp3|m4a|flac|ogg)$/.test(relative)) throw Error('素材路径无效');
    const dir = await fs.realpath(directory(id));
    const full = path.join(dir, relative), real = await fs.realpath(full);
    if (real !== full || !(await fs.lstat(full)).isFile()) throw Error('不支持素材符号链接');
    if (expected) {
      // Streamed hashing is used by the server for large inputs; this helper resolves only.
      if (!/^[a-f0-9]{64}$/.test(expected)) throw Error('素材校验和无效');
    }
    return full;
  }
  return { root, directory, get, update, create, list, checkpoint, source };
}
