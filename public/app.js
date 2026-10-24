const $ = id => document.getElementById(id);
let project, draft, dirty = false, candidateJob, seenJobs = '', polling = false;
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = us => new Date(Math.floor(us / 1000)).toISOString().slice(11, 23);
const base = () => `/api/projects/${project.id}`;
async function api(route, body, method) {
  const response = await fetch(route, body === undefined ? {} : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw Error(value.error || '请求失败'); return value;
}
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function action(id, fn) { $(id).addEventListener('click', async () => { const button = $(id); button.disabled = true; try { await fn(); } catch (e) { notice(e.message, true); } finally { button.disabled = false; } }); }
async function projects(selected) {
  const list = await api('/api/projects'); $('projects').innerHTML = '<option value="">选择节目…</option>' + list.map(p => `<option value="${p.id}">${escape(p.name)}</option>`).join('');
  if (selected) $('projects').value = selected;
}
function accept(p) { project = p; draft = p.plan ? structuredClone(p.plan) : null; dirty = false; window.history.replaceState(null, '', `?project=${p.id}`); draw(); }
function draw() {
  $('workspace').hidden = false; $('projectVersion').textContent = `工程版本 ${project.revision}`;
  $('tracks').innerHTML = project.tracks.map(t => `<div class="track"><strong>${escape(t.originalName)}</strong> <span class="muted">${time(t.durationUs)} · ${t.sampleRate} Hz · ${t.channels} 声道</span><p class="muted">轨道 ID：${t.id} · 同步：${escape(t.alignment)}</p><button data-track="${t.id}">回听原声</button> <label class="inline">共同时间轴起点（秒）<input type="number" min="0" step="0.001" data-offset="${t.id}" value="${t.offsetUs / 1e6}" ${project.transcript ? 'disabled' : ''}></label></div>`).join('');
  $('saveTracks').hidden = project.tracks.length < 2 || Boolean(project.transcript);
  $('planStatus').textContent = draft ? `方案 ${draft.revision} · ${draft.status === 'approved' ? '已批准' : '待审阅'}` : '等待转录';
  $('brief').value = draft?.editorial.brief || ''; $('allowReorder').checked = draft?.editorial.allowReorder || false;
  $('planSummary').textContent = draft?.summary || '';
  const restored = (draft?.reviewFlags || []).filter(f => draft.decisions.find(d => d.sentenceId === f.sentenceId)?.action === 'keep');
  $('reviewFlagStatus').hidden = !restored.length;
  $('reviewFlagStatus').textContent = `系统已保守恢复 ${restored.length} 处短回应或转录断片，需回听确认。对应句子保留模型原始理由供对照。`;
  $('exportPlan').href = `${base()}/export`;
  for (const id of ['saveBrief', 'generate', 'estimate', 'savePlan', 'approve', 'render', 'importPlan', 'history']) $(id).disabled = !draft;
  $('render').disabled = draft?.status !== 'approved';
  drawSentences(); drawNotes();
}
function drawSentences() {
  if (!draft) { $('sentences').innerHTML = '<p class="muted">绑定转录后显示原话和剪辑决定。</p>'; return; }
  const byId = new Map(project.transcript.sentences.map(s => [s.id, s])), decisions = new Map(draft.decisions.map(d => [d.sentenceId, d]));
  const query = $('search').value.trim().toLowerCase();
  $('sentences').innerHTML = draft.order.filter(id => JSON.stringify(byId.get(id)).toLowerCase().includes(query)).map(id => {
    const s = byId.get(id), d = decisions.get(id);
    return `<div class="sentence ${d.action === 'delete' ? 'deleted' : ''}"><div class="meta"><button data-seek="${id}">${time(s.startUs)}</button><p>${escape(s.speaker)} · ${escape(id)}</p></div><div><p class="words">${escape(s.text)}</p><p class="reason">${escape(d.reason)}</p><div class="actions"><button data-toggle="${id}">${d.action === 'keep' ? '删除' : '恢复'}</button><label class="check"><input type="checkbox" data-lock="${id}" ${d.locked ? 'checked' : ''}>锁定决定</label>${draft.editorial.allowReorder ? `<button data-move="${id}" data-direction="-1">上移</button><button data-move="${id}" data-direction="1">下移</button>` : ''}</div></div></div>`;
  }).join('');
}
function drawNotes() {
  $('notes').innerHTML = project.feedback.map(n => `<div class="note"><strong>${time(n.startUs)}–${time(n.endUs)}</strong> <span class="pill">${escape(n.status)}</span><p>${escape(n.text)}</p><p class="muted">绑定粗剪版本：${n.jobId.slice(0, 8)} · 方案 ${n.planRevision} · 定位 ${n.sentenceIds.length} 句</p><div class="actions"><button data-listen-note="${n.id}">回听原版本</button><button data-revise="${n.id}" data-scope="local">API 只改本段</button><button data-revise="${n.id}" data-scope="all">API 检查全片</button><button data-status="${n.id}" data-value="待复听">待复听</button><button data-status="${n.id}" data-value="已解决">已解决</button></div></div>`).join('');
}
async function saveDraft() {
  if (!draft) throw Error('请先绑定转录');
  draft.editorial.brief = $('brief').value; draft.editorial.allowReorder = $('allowReorder').checked;
  const saved = await api(`${base()}/plan`, { revision: project.revision, plan: draft }); accept(saved); notice('方案已保存，原始音频未修改。');
}
async function refreshProject() { accept(await api(base())); }
async function start(type, extra = {}) {
  if (dirty) throw Error('请先保存当前修改');
  const job = await api(`${base()}/jobs`, { type, revision: project.revision, ...extra });
  notice(`任务已提交：${job.type}。可以继续回听；修改工程会使进行中的模型结果无法覆盖当前方案。`); seenJobs = ''; await poll();
}
async function poll() {
  if (!project || polling) return; polling = true;
  try {
    const id = project.id, list = await api(`${base()}/jobs`); if (project.id !== id) return;
    const signature = JSON.stringify(list.map(j => [j.id, j.status, j.message]));
    $('jobs').innerHTML = list.map(j => `<div class="job"><strong>${escape(({ plan: '自动剪辑方案', revise: '按意见修改', transcribe: '本地转录', render: '粗剪导出' })[j.type])}</strong> <span class="pill">${escape(j.status)}</span><p>${escape(j.message)}</p><p class="muted">工程版本 ${j.projectRevision} · ${j.createdAt.replace('T', ' ').slice(0, 19)} UTC</p><div class="actions">${['queued', 'running'].includes(j.status) ? `<button data-cancel="${j.id}">取消任务</button>` : ''}${j.files.map(f => `<a class="button" href="${base()}/jobs/${j.id}/files/${encodeURIComponent(f)}?download=1">${escape(f)}</a>`).join('')}${j.status === 'succeeded' && j.type === 'render' ? `<button data-listen="${j.id}" data-file="${j.files.includes('candidate.wav') ? 'candidate.wav' : 'stem-1.wav'}">审听这个版本</button>` : ''}</div>${j.result?.generation ? `<p class="muted">调用 ${j.result.generation.calls.filter(c => !c.reused).length} 次；复用 ${j.result.generation.calls.filter(c => c.reused).length} 步；输入 token ${j.result.generation.calls.reduce((n, c) => n + (c.prompt_tokens || 0), 0)}；输出 token ${j.result.generation.calls.reduce((n, c) => n + (c.completion_tokens || 0), 0)}（复用项含历史用量）</p>` : ''}</div>`).join('') || '<p class="muted">尚无任务。</p>';
    if (signature !== seenJobs) {
      const latest = await api(base());
      if (!dirty && latest.revision !== project.revision) accept(latest);
      else if (dirty && latest.revision !== project.revision) notice('后台已有新结果。请先导出或复制当前修改，再刷新工程；不会自动覆盖你的未保存内容。', true);
      seenJobs = signature;
    }
  } catch (e) { notice(e.message, true); } finally { polling = false; }
}
function listen(jobId, filename = 'candidate.wav', start = 0) {
  candidateJob = jobId; const player = $('candidatePlayer');
  player.src = `${base()}/jobs/${jobId}/files/${filename}`;
  player.addEventListener('loadedmetadata', () => { player.currentTime = start; }, { once: true });
  $('candidateLabel').textContent = `正在审听粗剪 ${jobId.slice(0, 8)} · ${filename}；批注将绑定这个版本`;
  $('listening').scrollIntoView({ behavior: 'smooth' });
}
action('showSettings', () => { $('settings').hidden = !$('settings').hidden; });
action('saveSettings', async () => {
  const saved = await api('/api/settings', { baseUrl: $('apiBase').value, model: $('apiModel').value, apiKey: $('apiKey').value, format: $('apiFormat').value });
  $('apiKey').value = ''; $('settingsState').textContent = saved.hasKey ? '已配置密钥（不会回传）' : '未配置密钥，仅适用于无需鉴权的本机服务'; notice('模型设置已更新。首次调用前可查看调用规模。');
});
action('createProject', async () => { const p = await api('/api/projects', { name: $('projectName').value }); accept(p); candidateJob = null; $('candidatePlayer').removeAttribute('src'); await projects(p.id); notice('节目已建立，请导入素材。'); });
$('projects').addEventListener('change', async () => {
  if (!$('projects').value) return;
  if (dirty && !window.confirm('当前修改未保存，切换节目会丢弃这些未保存修改。继续？')) { $('projects').value = project.id; return; }
  try { accept(await api(`/api/projects/${$('projects').value}`)); candidateJob = null; $('sourcePlayer').removeAttribute('src'); $('candidatePlayer').removeAttribute('src'); seenJobs = ''; await poll(); } catch (e) { notice(e.message, true); }
});
action('uploadAudio', async () => {
  const files = [...$('audioFiles').files]; if (!files.length) throw Error('请选择录音');
  for (const file of files) {
    notice(`正在复制 ${file.name}…`);
    const response = await fetch(`${base()}/audio?name=${encodeURIComponent(file.name)}&revision=${project.revision}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const value = await response.json(); if (!response.ok) throw Error(value.error); accept(value);
  }
  $('audioFiles').value = ''; notice('录音已复制并绑定校验和。');
});
action('saveTracks', async () => {
  accept(await api(`${base()}/tracks`, { revision: project.revision, tracks: project.tracks.map(t => ({ id: t.id, offsetUs: Math.round(Number(document.querySelector(`[data-offset="${t.id}"]`).value) * 1e6), alignment: 'declared' })) }));
  notice('已记录手动同步声明；这不代表系统已独立测量漂移。');
});
action('importTranscript', async () => {
  const file = $('transcriptFile').files[0]; if (!file) throw Error('请选择转录 JSON');
  accept(await api(`${base()}/transcript`, { revision: project.revision, confirmBinding: $('binding').checked,
    document: JSON.parse(await file.text()) })); notice('转录已绑定。可填写剪辑要求并生成自动方案。');
});
action('transcribe', () => start('transcribe'));
action('saveBrief', saveDraft); action('savePlan', saveDraft);
action('generate', async () => { await saveDraft(); await start('plan'); });
action('estimate', async () => { const value = await api(`${base()}/estimate`); $('estimateText').textContent = `${value.characters} 字，${value.chunks} 段，首次约 ${value.requests} 次请求。${value.note}`; });
action('approve', async () => { if (dirty) await saveDraft(); accept(await api(`${base()}/approve`, { revision: project.revision })); notice('已批准当前完整方案，可生成粗剪审阅音频。'); });
action('render', () => start('render'));
action('importPlan', async () => { const file = $('externalPlan').files[0]; if (!file) throw Error('请选择外部方案文件'); const value = JSON.parse(await file.text());
  accept(await api(`${base()}/plan`, { revision: project.revision, plan: value.plan || value })); notice('外部方案已校验导入，待批准。'); });
action('history', async () => { const versions = await api(`${base()}/history`); $('historyList').innerHTML = versions.map(v => `<button data-restore="${v}">恢复 ${v.replace('.json', '')} 的方案</button>`).join(' '); });
action('mark', () => { const p = $('candidatePlayer'); if (!candidateJob) throw Error('请先选择粗剪版本'); p.pause(); $('noteStart').value = p.currentTime.toFixed(3); $('noteEnd').value = Math.min(p.duration, p.currentTime + 3).toFixed(3); $('noteText').focus(); });
action('saveNote', async () => {
  if (!candidateJob) throw Error('请先选择粗剪版本'); if (dirty) throw Error('请先保存文字方案修改');
  accept(await api(`${base()}/feedback`, { revision: project.revision, jobId: candidateJob,
    startUs: Math.round(Number($('noteStart').value) * 1e6), endUs: Math.round(Number($('noteEnd').value) * 1e6), text: $('noteText').value, status: '待处理' }));
  $('noteText').value = ''; notice('意见已绑定当前音频版本和原始源区间。');
});
$('search').addEventListener('input', drawSentences);
for (const id of ['brief', 'allowReorder']) $(id).addEventListener('input', () => { dirty = true; if (draft) { draft.editorial.allowReorder = $('allowReorder').checked; drawSentences(); } });
document.addEventListener('change', e => { if (e.target.dataset.lock) { draft.decisions.find(d => d.sentenceId === e.target.dataset.lock).locked = e.target.checked; dirty = true; } });
document.addEventListener('click', async e => {
  const element = e.target.closest('button'); if (!element) return;
  const d = element.dataset;
  try {
    if (d.track) { $('sourcePlayer').src = `${base()}/audio/${d.track}`; await $('sourcePlayer').play(); }
    if (d.seek) {
      const s = project.transcript.sentences.find(s => s.id === d.seek), t = project.tracks.find(t => t.id === s.trackId), player = $('sourcePlayer');
      const src = `${base()}/audio/${t.id}`;
      if (!player.src.endsWith(src)) { player.src = src; await new Promise(resolve => player.addEventListener('loadedmetadata', resolve, { once: true })); }
      player.currentTime = (s.startUs - t.offsetUs) / 1e6; await player.play();
    }
    if (d.toggle) { const decision = draft.decisions.find(x => x.sentenceId === d.toggle); decision.action = decision.action === 'keep' ? 'delete' : 'keep'; decision.reason = '用户手动修改'; decision.locked = true; dirty = true; drawSentences(); }
    if (d.move) { const i = draft.order.indexOf(d.move), next = i + Number(d.direction); if (next >= 0 && next < draft.order.length) { [draft.order[i], draft.order[next]] = [draft.order[next], draft.order[i]]; dirty = true; drawSentences(); } }
    if (d.cancel) { await api(`${base()}/jobs/${d.cancel}/cancel`, {}); seenJobs = ''; await poll(); }
    if (d.listen) listen(d.listen, d.file);
    if (d.listenNote) { const n = project.feedback.find(n => n.id === d.listenNote); const list = await api(`${base()}/jobs`), j = list.find(j => j.id === n.jobId); listen(n.jobId, j.files.includes('candidate.wav') ? 'candidate.wav' : 'stem-1.wav', n.startUs / 1e6); }
    if (d.revise) await start('revise', { feedbackId: d.revise, scope: d.scope });
    if (d.status) { if (dirty) throw Error('请先保存文字方案'); const n = project.feedback.find(n => n.id === d.status); accept(await api(`${base()}/feedback`, { revision: project.revision, id: n.id, text: n.text, status: d.value })); }
    if (d.restore) { if (dirty) throw Error('请先保存当前修改'); accept(await api(`${base()}/restore`, { revision: project.revision, version: d.restore })); notice('历史方案已恢复为新的草稿版本，其他意见与素材保留。'); }
  } catch (error) { notice(error.message, true); }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
try {
  const settings = await api('/api/settings'); $('apiBase').value = settings.baseUrl; $('apiModel').value = settings.model; $('apiFormat').value = settings.format;
  const selected = new URL(window.location.href).searchParams.get('project');
  await projects(selected); if (selected) { accept(await api(`/api/projects/${selected}`)); await poll(); }
}
catch (e) { notice(e.message, true); }
setInterval(poll, 2000);
