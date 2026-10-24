"""Offline transcription and reversible rough-cut rendering. No enhancement models."""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
import soundfile as sf


def emit(**value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    if result.returncode:
        raise ValueError(f"{Path(args[0]).name} failed: {result.stderr[-1500:]}")
    return result.stdout


def hash_file(file):
    h = hashlib.sha256()
    with open(file, 'rb') as f:
        while part := f.read(4 << 20):
            h.update(part)
    return h.hexdigest()


def probe(file):
    value = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
                            '-show_streams', '-show_format', '-of', 'json', str(file)]))
    stream = value['streams'][0]
    duration = float(value.get('format', {}).get('duration') or stream.get('duration') or 0)
    sr = int(stream['sample_rate'])
    if not 0 < duration <= 86400 or not 1 <= int(stream['channels']) <= 8:
        raise ValueError('unsupported duration or channel count')
    try:
        info = sf.info(file)
        if info.samplerate == sr:
            duration = info.frames / sr
    except (RuntimeError, sf.LibsndfileError):
        pass
    return dict(durationUs=round(duration * 1e6), sampleRate=sr,
                channels=int(stream['channels']), codec=stream.get('codec_name'))


def source(project_root, track):
    file = project_root / track['path']
    actual = file.resolve(strict=True)
    if actual != file or project_root / 'sources' not in actual.parents:
        raise ValueError('source escapes project or uses symlink')
    if hash_file(actual) != track['sha256']:
        raise ValueError('source checksum changed')
    return actual


def transcribe(request, output, project_root):
    if len(request['project']['tracks']) != 1:
        raise ValueError('multi-track transcription requires an imported, speaker-verified transcript in this milestone')
    track = request['project']['tracks'][0]
    file = source(project_root, track)
    configured = request.get('modelPath')
    if not configured or not Path(configured).is_dir():
        raise ValueError('CUT_WHISPER_MODEL must be an explicit existing local faster-whisper model directory')
    os.environ['HF_HUB_OFFLINE'] = '1'
    from faster_whisper import WhisperModel
    model = WhisperModel(configured, device='cpu', compute_type='int8', local_files_only=True)
    segments, _ = model.transcribe(str(file), language='zh', initial_prompt='嗯，呃，这个，那个，就是，然后，对。',
                                   word_timestamps=True, temperature=0.0)
    sentences = []
    for i, s in enumerate(segments):
        if not s.text.strip():
            continue
        sentences.append(dict(id=f'S-{i + 1:06d}', speaker='待核', trackId=track['id'], text=s.text.strip(),
                              startUs=round(s.start * 1e6) + track['offsetUs'], endUs=round(s.end * 1e6) + track['offsetUs'],
                              avgLogprob=s.avg_logprob, words=[dict(text=w.word, startUs=round(w.start * 1e6),
                              endUs=round(w.end * 1e6), probability=w.probability) for w in (s.words or [])]))
        emit(message=f'转录至 {s.end:.0f} 秒')
    result = dict(sentences=sentences, backend='faster-whisper', version=importlib.metadata.version('faster-whisper'),
                  modelPath=str(configured), computeType='int8', language='zh', reviewStatus='ASR_unverified')
    (output / 'transcript.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return dict(transcript=result, files=['transcript.json'])


def render(request, output, project_root):
    project, timeline = request['project'], request['timeline']
    tracks = project['tracks']
    sr = 48000
    for track in tracks:
        if len(tracks) > 1 and track.get('alignment') != 'declared':
            raise ValueError('all multi-track sources must have explicitly declared common-clock alignment')
    mapped = []
    cursor = 0
    for b in timeline['blocks']:
        left, right = round(b['sourceStartUs'] * sr / 1e6), round(b['sourceEndUs'] * sr / 1e6)
        if right <= left:
            raise ValueError('empty cut after sample conversion')
        mapped.append(dict(b, sourceStartSample=left, sourceEndSample=right,
                           requestedSourceStartUs=b['sourceStartUs'], requestedSourceEndUs=b['sourceEndUs'],
                           sourceStartUs=round(left * 1e6 / sr), sourceEndUs=round(right * 1e6 / sr),
                           outputStartUs=round(cursor * 1e6 / sr), outputEndUs=round((cursor + right - left) * 1e6 / sr),
                           outputStartSample=cursor, outputEndSample=cursor + right - left))
        cursor += right - left
    files, decoded, stem_paths = [], [], []
    for index, track in enumerate(tracks):
        file = source(project_root, track)
        temp = output / f'decoded-{index}.wav'
        run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(file), '-ar', str(sr), '-c:a', 'pcm_f32le', '-n', str(temp)])
        decoded.append(temp)
        target = output / ('candidate.wav' if len(tracks) == 1 else f'stem-{index + 1}.wav')
        with sf.SoundFile(temp) as src, sf.SoundFile(target, 'w', samplerate=sr, channels=src.channels, subtype='PCM_24') as dest:
            offset = round(track['offsetUs'] * sr / 1e6)
            peak = 0.0
            for block_index, b in enumerate(mapped):
                count = b['sourceEndSample'] - b['sourceStartSample']
                left = b['sourceStartSample'] - offset
                for chunk_start in range(0, count, sr * 10):
                    n = min(sr * 10, count - chunk_start)
                    buffer = np.zeros((n, src.channels), dtype=np.float32)
                    start = left + chunk_start
                    read_start, read_end = max(0, start), min(src.frames, start + n)
                    if read_end > read_start:
                        src.seek(read_start)
                        data = src.read(read_end - read_start, dtype='float32', always_2d=True)
                        buffer[read_start - start:read_start - start + len(data)] = data
                    # Fade only at actual new joins. No fade or shortening on keep-all audio.
                    fade = min(480, count // 4)
                    position = np.arange(chunk_start, chunk_start + n)
                    envelope = np.ones(n, dtype=np.float32)
                    if block_index > 0 and fade:
                        envelope *= np.minimum(1, position / fade)
                    if block_index < len(mapped) - 1 and fade:
                        envelope *= np.minimum(1, (count - 1 - position) / fade)
                    buffer *= envelope[:, None]
                    peak = max(peak, float(np.max(np.abs(buffer))))
                    if peak >= 1.0:
                        raise ValueError('source or cut contains full-scale samples; output requires review, not silent clipping')
                    dest.write(buffer)
            emit(message=f'已导出轨道 {index + 1}/{len(tracks)}')
        info = sf.info(target)
        if info.frames != cursor or info.samplerate != sr or info.subtype != 'PCM_24':
            raise ValueError('independent WAV format/sample validation failed')
        # Full FFmpeg decode, independently of libsndfile.
        run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(target), '-f', 'null', '-'])
        files.append(target.name)
        stem_paths.append(target)
    if len(tracks) == 1:
        run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(stem_paths[0]), '-c:a', 'libmp3lame', '-b:a', '192k', '-n', str(output / 'candidate.mp3')])
        run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(output / 'candidate.mp3'), '-f', 'null', '-'])
        if abs(probe(output / 'candidate.mp3')['durationUs'] - round(cursor * 1e6 / sr)) > 100000:
            raise ValueError('MP3 duration mismatch')
        files.append('candidate.mp3')
    actual = dict(timeline, sampleRate=sr, blocks=mapped, durationSamples=cursor, durationUs=round(cursor * 1e6 / sr),
                  formatStatus='PCM24_full_decode_passed', listeningStatus='pending',
                  warnings=['ASR和接缝尚需实际审听；60ms扩边不证明切点安全', '不做降噪、音色增强、自动选麦或母带响度处理'])
    (output / 'timeline.json').write_text(json.dumps(actual, ensure_ascii=False, indent=2) + '\n')
    files.append('timeline.json')
    transcript = []
    for b in mapped:
        for sentence in project['transcript']['sentences']:
            left = max(round(sentence['startUs'] * sr / 1e6), b['sourceStartSample'])
            right = min(round(sentence['endUs'] * sr / 1e6), b['sourceEndSample'])
            if left >= right:
                continue
            full = left == round(sentence['startUs'] * sr / 1e6) and right == round(sentence['endUs'] * sr / 1e6)
            transcript.append(dict(sentenceId=sentence['id'], speaker=sentence['speaker'], trackId=sentence['trackId'],
                text=sentence['text'] if full else '[仅保留原句部分音频，需回听]',
                originalReferenceText=sentence['text'], sourceStartSample=left, sourceEndSample=right,
                outputStartSample=b['outputStartSample'] + left - b['sourceStartSample'],
                outputEndSample=b['outputStartSample'] + right - b['sourceStartSample'],
                textStatus='source_mapped_ASR_unverified' if full else 'partial_audio_text_pending'))
    (output / 'transcript_final.json').write_text(json.dumps(dict(sampleRate=sr, sentences=transcript,
        status='source_mapping_not_final_ASR_or_listening_verified'), ensure_ascii=False, indent=2) + '\n')
    lines = ['# 粗剪时间码稿', '', '按实际源区间重建；未重新识别或核准文字，部分保留原句需回听。', '']
    for s in transcript:
        milliseconds = round(s['outputStartSample'] * 1000 / sr)
        stamp = f'{milliseconds // 3600000:02}:{milliseconds // 60000 % 60:02}:{milliseconds // 1000 % 60:02}.{milliseconds % 1000:03}'
        lines.append(f"[{s['sentenceId']}] {stamp} {s['speaker']}：{s['text']}\n")
    (output / 'transcript_final.md').write_text('\n'.join(lines) + '\n')
    with (output / 'edit_log.csv').open('w', encoding='utf-8-sig', newline='') as file:
        writer = csv.writer(file)
        writer.writerow(['edit_id', 'source_start_sample', 'source_end_sample', 'output_start_sample', 'output_end_sample', 'sentence_ids', 'plan_revision', 'listening'])
        for b in mapped:
            writer.writerow([b['id'], b['sourceStartSample'], b['sourceEndSample'], b['outputStartSample'], b['outputEndSample'], ' '.join(b['sentenceIds']), timeline['planRevision'], 'pending'])
    files.extend(['transcript_final.json', 'transcript_final.md', 'edit_log.csv'])
    report = f"结果：粗剪审阅候选，尚未通过听感验收\n时长：{cursor / sr:.3f} 秒\n切点：{max(0, len(mapped) - 1)}\n保守回退：{len(timeline['rollbacks'])} 项\n\n"
    report += '保留原始录音，接缝、问答关系、弱语音和转录错误需要回听。\n'
    if len(tracks) > 1:
        report += '本轮只导出共同时间线的独立分轨，不提供自动选麦或混音；请在后续音频工作站中混合。\n'
    (output / 'report.txt').write_text(report)
    files.append('report.txt')
    if (output / 'transcript_proposed.md').is_file():
        files.append('transcript_proposed.md')
    manifest = dict(schemaVersion='podcast-render/1', sourceFingerprint=timeline['sourceFingerprint'],
                    planId=timeline['planId'], planRevision=timeline['planRevision'], timeline=actual,
                    files=[dict(path=f, sha256=hash_file(output / f)) for f in files], status='review_candidate_listening_pending')
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    files.append('manifest.json')
    for temp in decoded:
        temp.unlink()
    return dict(files=files, timeline=actual)


def main():
    if sys.version_info[:2] != (3, 12):
        raise ValueError('Python 3.12 is required')
    parser = argparse.ArgumentParser()
    parser.add_argument('--probe')
    parser.add_argument('--request')
    args = parser.parse_args()
    if args.probe:
        emit(result=probe(Path(args.probe)))
        return
    request = json.loads(Path(args.request).read_text())
    project_root = Path(request['projectRoot']).resolve(strict=True)
    output = Path(request['outputDir']).resolve(strict=True)
    if project_root / 'jobs' not in output.parents:
        raise ValueError('output must be in project jobs')
    os.environ.update(TMPDIR=str(output), HF_HUB_OFFLINE='1')
    result = transcribe(request, output, project_root) if request['type'] == 'transcribe' else render(request, output, project_root)
    emit(result=result)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit(error=str(error))
        sys.exit(1)
