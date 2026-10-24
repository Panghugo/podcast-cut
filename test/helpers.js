import { makePlan, normalizeTranscript } from '../lib/plan.js';
export function fixture() {
  const p = { id: '11111111-1111-4111-8111-111111111111', tracks: [{ id: 'track-a', sha256: 'a'.repeat(64), durationUs: 10e6, offsetUs: 0, sampleRate: 48000, channels: 1, gainDb: 0 }] };
  p.transcript = normalizeTranscript({ sentences: [
    { id: 'A-1', speaker: 'A', text: '必要背景', startUs: 100000, endUs: 2e6 },
    { id: 'B-2', speaker: 'B', text: '这是一段没有增加信息的重复表述', startUs: 3e6, endUs: 4e6 },
    { id: 'B-3', speaker: 'B', text: '具体例子', startUs: 5e6, endUs: 9e6 }
  ] }, p);
  p.plan = makePlan(p); return p;
}
