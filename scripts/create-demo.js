// A deterministic signal fixture, NOT a speech-quality or editorial benchmark.
import fs from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(process.argv[2] || '.local/demo');
await fs.mkdir(directory, { recursive: true });
const samples = 48000 * 8, wave = Buffer.alloc(44 + samples * 2);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(96000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) {
  const seconds = i / 48000, frequency = seconds < 2 ? 330 : seconds < 5 ? 440 : 550;
  const envelope = Math.min(1, (i % 48000) / 500) * Math.min(1, (48000 - i % 48000) / 500);
  wave.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * seconds) * 5000 * envelope), 44 + i * 2);
}
await fs.writeFile(path.join(directory, 'synthetic-signal.wav'), wave, { flag: 'wx' });
await fs.copyFile(new URL('../examples/synthetic-transcript.json', import.meta.url), path.join(directory, 'synthetic-transcript.json'));
console.log(`Created synthetic test signals in ${directory}. No recorded speech is included.`);
