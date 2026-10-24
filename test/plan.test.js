import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, normalizeTranscript, compileTimeline, validatePlan, guardShortDeletions } from '../lib/plan.js';

import { fixture } from './helpers.js';
test('keep-all preserves full audio duration and pauses', () => {
  const p = fixture(), t = compileTimeline(p, p.plan);
  assert.equal(t.blocks.length, 1); assert.equal(t.durationUs, 10e6);
});
test('deletion has traceable non-destructive timeline and stable IDs', () => {
  const p = fixture(); p.plan.decisions[1].action = 'delete';
  const t = compileTimeline(p, p.plan);
  assert.equal(t.blocks.length, 2); assert.equal(t.blocks[0].sourceEndUs, 2060000);
  assert.equal(t.blocks[1].sourceStartUs, 4940000); assert.equal(t.durationUs, 7120000);
  assert.deepEqual(p.transcript.sentences.map(s => s.id), ['A-1', 'B-2', 'B-3']);
});
test('rejects duplicate/missing/unknown IDs, rewritten text, empty and stale plans', () => {
  const p = fixture();
  for (const mutate of [
    x => { x.order[0] = x.order[1]; }, x => { x.decisions.pop(); },
    x => { x.decisions[0].sentenceId = 'invented'; }, x => { x.decisions[0].text = 'new words'; },
    x => { x.decisions.forEach(d => { d.action = 'delete'; }); }, x => { x.transcriptSha256 = 'stale'; },
    x => { x.decisions[0].action = 'rewrite'; }
  ]) { const plan = structuredClone(p.plan); mutate(plan); assert.throws(() => validatePlan(plan, p)); }
  p.tracks[0].offsetUs = 1000; assert.throws(() => validatePlan(p.plan, p), /版本/);
});
test('locked user decisions cannot be reversed by model', () => {
  const p = fixture(); p.plan.decisions[0].locked = true;
  const next = structuredClone(p.plan); next.decisions[0].action = 'delete';
  assert.throws(() => validatePlan(next, p, { previous: p.plan, model: true }), /锁定/);
});
test('reordering is explicit and rejects overlapping duplicated source ranges', () => {
  const p = fixture(); [p.plan.order[0], p.plan.order[1]] = [p.plan.order[1], p.plan.order[0]];
  assert.throws(() => validatePlan(p.plan, p), /不允许/);
  p.plan.editorial.allowReorder = true;
  assert.doesNotThrow(() => compileTimeline(p, p.plan));
  p.transcript.sentences[1].startUs = 1e6;
  assert.throws(() => compileTimeline(p, p.plan), /重叠/);
});
test('retains deleted overlapping speech with explicit rollback notice', () => {
  const p = fixture(); p.transcript.sentences[1].startUs = 1.5e6; p.transcript.sentences[1].endUs = 1.8e6;
  p.plan.decisions[1].action = 'delete';
  assert.equal(compileTimeline(p, p.plan).rollbacks[0].sentenceId, 'B-2');
});
test('transcript import rejects bad time, duplicate IDs and ambiguous multitrack attribution', () => {
  const p = fixture(), doc = { sentences: [{ id: 'x', text: 'a', startUs: 1, endUs: 12e6 }] };
  assert.throws(() => normalizeTranscript(doc, p), /超出/);
  doc.sentences[0].endUs = 1e6; doc.sentences.push(doc.sentences[0]);
  assert.throws(() => normalizeTranscript(doc, p), /重复/);
  p.tracks.push({ ...p.tracks[0], id: 'track-b' }); doc.sentences.pop();
  assert.throws(() => normalizeTranscript(doc, p), /trackId/);
});

test('short-only model deletions are restored with original reason, while locked and whole-discussion deletions remain', () => {
  const p = fixture(); p.transcript.sentences[1].text = '这种'; p.plan.decisions[1].action = 'delete';
  const guarded = guardShortDeletions(p, p.plan);
  assert.equal(guarded.decisions[1].action, 'keep'); assert.equal(guarded.reviewFlags[0].originalAction, 'delete');
  assert.equal(p.plan.decisions[1].action, 'delete', 'raw decision must be preserved');
  p.plan.decisions[1].locked = true; assert.equal(guardShortDeletions(p, p.plan).decisions[1].action, 'delete');
  p.plan.decisions[1].locked = false; p.plan.decisions[0].action = 'delete'; p.transcript.sentences[0].text = '先确认一下录音备份和设备';
  assert.equal(guardShortDeletions(p, p.plan).decisions[1].action, 'delete', 'short response in a larger discarded discussion remains part of that decision');
});
