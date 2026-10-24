#!/usr/bin/env node
import fs from 'node:fs/promises';
const [command, projectId, file] = process.argv.slice(2);
const base = process.env.CUT_LOCAL_URL || 'http://127.0.0.1:8770';
const url = new URL(base);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('CLI只连接本机工作台');
async function api(route, body) {
  const response = await fetch(base + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const value = await response.json(); if (!response.ok) throw Error(value.error); return value;
}
try {
  if (command === 'list') console.log(JSON.stringify(await api('/api/projects'), null, 2));
  else if (['export', 'import', 'approve', 'plan', 'render', 'jobs'].includes(command)) {
    if (!/^[a-f0-9-]{36}$/.test(projectId || '')) throw Error('需要工程UUID');
    const prefix = `/api/projects/${projectId}`, project = await api(prefix);
    let result;
    if (command === 'export') {
      result = await api(`${prefix}/export`);
      if (file) { await fs.writeFile(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); result = { written: file }; }
    } else if (command === 'import') {
      if (!file) throw Error('需要外部方案文件路径');
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      result = await api(`${prefix}/plan`, { revision: project.revision, plan: value.plan || value });
    } else if (command === 'approve') result = await api(`${prefix}/approve`, { revision: project.revision });
    else if (command === 'jobs') result = await api(`${prefix}/jobs`);
    else result = await api(`${prefix}/jobs`, { revision: project.revision, type: command });
    console.log(JSON.stringify(result, null, 2));
  } else console.log('Usage: node cli.js list | export <project-id> [file] | import <project-id> <file> | approve <project-id> | plan <project-id> | render <project-id> | jobs <project-id>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
