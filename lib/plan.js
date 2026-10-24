import { createHash, randomUUID } from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const fail = message => { throw new Error(message); };
export const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
export const clock = us => new Date(Math.floor(us / 1000)).toISOString().slice(11, 23);

export function sourceFingerprint(project) {
  return digest(project.tracks.map(({ id, sha256, offsetUs, gainDb, durationUs, sampleRate, channels }) =>
    ({ id, sha256, offsetUs, gainDb, durationUs, sampleRate, channels })));
}

export function normalizeTranscript(document, project) {
  if (!document || typeof document !== 'object') fail('转录必须为 JSON 对象');
  const raw = document.sentences || document.segments;
  if (!Array.isArray(raw) || !raw.length || raw.length > 100000) fail('转录须包含 1–100000 句');
  const duration = Math.max(...project.tracks.map(t => t.durationUs + t.offsetUs));
  const ids = new Set();
  const sentences = raw.map((s, i) => {
    const id = s.id ?? `S-${String(i + 1).padStart(6, '0')}`;
    if (typeof id !== 'string' || !/^[\p{L}\p{N}_:-]{1,100}$/u.test(id) || ids.has(id)) fail('句编号无效或重复');
    ids.add(id);
    const startUs = s.startUs ?? (s.startMs !== undefined ? Math.round(s.startMs * 1000) : Math.round(s.start * 1e6));
    const endUs = s.endUs ?? (s.endMs !== undefined ? Math.round(s.endMs * 1000) : Math.round(s.end * 1e6));
    if (!integer(startUs) || !integer(endUs, startUs + 1) || endUs > duration) fail(`句子时间超出音频：${id}`);
    if (typeof s.text !== 'string' || !s.text.trim() || s.text.length > 20000) fail(`句子文字无效：${id}`);
    const trackId = s.trackId ?? (project.tracks.length === 1 ? project.tracks[0].id : null);
    if (!project.tracks.some(t => t.id === trackId)) fail(`请为多轨句子指定 trackId：${id}`);
    const track = project.tracks.find(t => t.id === trackId);
    if (startUs < track.offsetUs || endUs > track.offsetUs + track.durationUs) fail(`句子超出对应轨道覆盖范围：${id}`);
    return { id, speaker: String(s.speaker ?? '待核').slice(0, 80), text: s.text,
      startUs, endUs, trackId, timingStatus: 'locator_unverified',
      ...(s.words ? { words: s.words } : {}) };
  });
  if (sentences.some((s, i) => i && s.startUs < sentences[i - 1].startUs)) fail('转录必须按源时间排列，稳定编号不得重新排序');
  return { schemaVersion: 'podcast-transcript/1', sha256: digest(sentences), sentences,
    sourceFingerprint: sourceFingerprint(project), importedAt: new Date().toISOString() };
}

export function makePlan(project, editorial = {}) {
  return { schemaVersion: 'podcast-edit/1', id: randomUUID(), revision: 1,
    projectId: project.id, sourceFingerprint: sourceFingerprint(project), transcriptSha256: project.transcript.sha256,
    status: 'draft', editorial: { brief: '', allowReorder: false, ...editorial },
    summary: '', chapters: [], order: project.transcript.sentences.map(s => s.id),
    decisions: project.transcript.sentences.map(s => ({ sentenceId: s.id, action: 'keep', reason: '尚未剪辑', locked: false })),
    createdAt: new Date().toISOString() };
}

export function validatePlan(plan, project, { previous, model = false } = {}) {
  if (!plan || plan.schemaVersion !== 'podcast-edit/1' || plan.projectId !== project.id) fail('剪辑方案格式或工程绑定不匹配');
  if (!integer(plan.revision, 1)) fail('方案修订号无效');
  if (plan.sourceFingerprint !== sourceFingerprint(project) || plan.transcriptSha256 !== project.transcript?.sha256) fail('素材或转录版本已变化，不能套用旧方案');
  const ids = project.transcript.sentences.map(s => s.id), known = new Set(ids);
  if (!Array.isArray(plan.order) || plan.order.length !== ids.length || new Set(plan.order).size !== ids.length || plan.order.some(id => !known.has(id))) fail('播放顺序必须恰好包含全部句编号一次');
  if (!Array.isArray(plan.decisions) || plan.decisions.length !== ids.length || new Set(plan.decisions.map(d => d.sentenceId)).size !== ids.length) fail('每个句子必须恰好有一项决定');
  for (const d of plan.decisions) {
    if (!known.has(d.sentenceId) || !['keep', 'delete'].includes(d.action) || typeof d.reason !== 'string' || !d.reason.trim() || d.reason.length > 4000 || typeof d.locked !== 'boolean') fail('剪辑决定包含未知句子、无效操作或缺少理由');
    if (Object.keys(d).some(k => !['sentenceId', 'action', 'reason', 'locked'].includes(k))) fail('首版只支持整句决定，不能通过方案注入源时间或改写原话');
  }
  if (!plan.decisions.some(d => d.action === 'keep')) fail('不能删除全部内容');
  if (typeof plan.editorial?.allowReorder !== 'boolean') fail('缺少段落移动设置');
  if (typeof plan.editorial.brief !== 'string' || plan.editorial.brief.length > 12000) fail('剪辑要求须为不超过12000字的文字');
  if (!plan.editorial.allowReorder && ids.some((id, i) => plan.order[i] !== id)) fail('当前剪辑要求不允许移动段落');
  if (model && previous) {
    for (const old of previous.decisions.filter(d => d.locked)) {
      const next = plan.decisions.find(d => d.sentenceId === old.sentenceId);
      if (next.action !== old.action || !next.locked) fail(`模型修改了用户锁定决定：${old.sentenceId}`);
    }
  }
  return plan;
}

// A short ASR segment may be a response, a split word, or part of a longer turn.
// Preserve short-only deletion runs unless a human explicitly locked that deletion.
// A larger discarded conversation (e.g. equipment setup) is left as a whole decision.
export function guardShortDeletions(project, plan) {
  validatePlan(plan, project);
  const guarded = structuredClone(plan), byId = new Map(guarded.decisions.map(d => [d.sentenceId, d]));
  const flags = [], runs = []; let run = [];
  for (const sentence of project.transcript.sentences) {
    if (byId.get(sentence.id).action === 'delete') run.push(sentence);
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  for (const group of runs) {
    if (!group.every(s => [...s.text.replace(/[\p{P}\p{Z}\p{S}\s]/gu, '')].length <= 6)) continue;
    for (const sentence of group) {
      const decision = byId.get(sentence.id); if (decision.locked) continue;
      flags.push({ sentenceId: sentence.id, rule: 'short_only_deletion_run', thresholdCharacters: 6,
        originalAction: 'delete', originalReason: decision.reason, appliedAction: 'keep', status: 'listening_pending' });
      decision.action = 'keep'; decision.reason = `保守恢复：短回应或转录断片不能仅凭字数判断无效，需回听。原模型理由：${decision.reason}`;
    }
  }
  guarded.reviewFlags = [...new Map([...(guarded.reviewFlags || []), ...flags].map(f => [`${f.rule}:${f.sentenceId}`, f])).values()];
  return guarded;
}

// One timeline for all tracks. Consecutive retained sentences keep their natural pauses.
// Overlapping groups cannot be reordered into duplicated source samples.
export function compileTimeline(project, plan) {
  validatePlan(plan, project);
  const list = project.transcript.sentences, byId = new Map(list.map(s => [s.id, s]));
  const positions = new Map(list.map((s, i) => [s.id, i]));
  const deleted = new Set(plan.decisions.filter(d => d.action === 'delete').map(d => d.sentenceId));
  const duration = Math.max(...project.tracks.map(t => t.offsetUs + t.durationUs));
  const blocks = [];
  for (const id of plan.order.filter(id => !deleted.has(id))) {
    const s = byId.get(id), last = blocks.at(-1);
    const startUs = positions.get(id) === 0 ? 0 : Math.max(0, s.startUs - 60000);
    const endUs = positions.get(id) === list.length - 1 ? duration : Math.min(duration, s.endUs + 60000);
    const consecutive = last && positions.get(id) === positions.get(last.sentenceIds.at(-1)) + 1;
    const overlap = last && startUs < last.sourceEndUs && endUs > last.sourceStartUs;
    if (last && (consecutive || overlap)) {
      if (startUs < last.sourceStartUs) fail('重叠的发言必须保留原顺序');
      last.sourceEndUs = Math.max(last.sourceEndUs, endUs); last.sentenceIds.push(id);
    } else blocks.push({ id: `E-${blocks.length + 1}`, sourceStartUs: startUs, sourceEndUs: endUs, sentenceIds: [id] });
  }
  const sorted = [...blocks].sort((a, b) => a.sourceStartUs - b.sourceStartUs);
  if (sorted.some((b, i) => i && b.sourceStartUs < sorted[i - 1].sourceEndUs)) fail('段落移动导致重复源区间，请将重叠组一起移动');
  let output = 0;
  const mapped = blocks.map(b => {
    const result = { ...b, outputStartUs: output, outputEndUs: output + b.sourceEndUs - b.sourceStartUs };
    output = result.outputEndUs; return result;
  });
  const rollbacks = list.filter(s => deleted.has(s.id)).flatMap(s => mapped.filter(b => s.startUs < b.sourceEndUs && s.endUs > b.sourceStartUs)
    .map(b => ({ sentenceId: s.id, blockId: b.id, reason: '重叠发言或保守扩边仍保留部分/全部原声，需复听' })));
  return { schemaVersion: 'podcast-timeline/1', planId: plan.id, planRevision: plan.revision,
    sourceFingerprint: sourceFingerprint(project), durationUs: output, blocks: mapped,
    rollbacks, listeningStatus: 'pending', boundaryStatus: 'sentence_locator_with_60ms_padding_not_listening_verified' };
}

export function proposedMarkdown(project, plan) {
  const timeline = compileTimeline(project, plan), byId = new Map(project.transcript.sentences.map(s => [s.id, s]));
  return `# ${project.name} · 粗剪方案\n\n${plan.summary || '尚未生成内容分析'}\n\n预计时长 ${clock(timeline.durationUs)}；接缝和内容需要审听。\n\n` +
    timeline.blocks.map(b => b.sentenceIds.map(id => {
      const s = byId.get(id); return `[${id}] ${clock(b.outputStartUs + s.startUs - b.sourceStartUs)} ${s.speaker}（源 ${clock(s.startUs)}）：${s.text}`;
    }).join('\n\n')).join('\n\n') + '\n\n## 删除决定\n\n' + plan.decisions.filter(d => d.action === 'delete').map(d => `- [${d.sentenceId}] ${d.reason}`).join('\n') +
    '\n\n## 保守回退\n\n' + (timeline.rollbacks.map(r => `- [${r.sentenceId}] ${r.reason}`).join('\n') || '无') +
    '\n\n## 自动恢复的短回应或转录断片\n\n' + ((plan.reviewFlags || []).map(f => `- [${f.sentenceId}] 已保守恢复为保留，需回听。原模型理由：${f.originalReason}`).join('\n') || '无') + '\n';
}
