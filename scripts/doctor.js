import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
const add = (name, status, detail) => results.push({ name, status, detail });
const env = { ...process.env, HF_HUB_OFFLINE: '1' };
for (const key of ['CUT_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete env[key];
const run = (command, args) => spawnSync(command, args, { cwd: app, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });

add('Node.js', Number(process.versions.node.split('.')[0]) >= 22 ? 'pass' : 'fail', process.versions.node + '（要求22及以上）');
const python = process.env.CUT_PYTHON || 'python3.12';
const probe = run(python, ['-c', `import sys,json,importlib,importlib.metadata
packages={}
for name,module in [('numpy','numpy'),('soundfile','soundfile'),('faster-whisper','faster_whisper')]:
    try:
        importlib.import_module(module)
        packages[name]={'ok':True,'version':importlib.metadata.version(name)}
    except Exception as error:
        packages[name]={'ok':False,'error':type(error).__name__}
print(json.dumps({'version':list(sys.version_info[:3]),'venv':sys.prefix!=sys.base_prefix,'packages':packages}))`]);
if (probe.status !== 0) add('Python', 'fail', '无法运行 CUT_PYTHON 指定的解释器；请设置Python 3.12虚拟环境路径');
else {
  try {
    const info = JSON.parse(probe.stdout);
    add('Python', info.version[0] === 3 && info.version[1] === 12 && info.venv ? 'pass' : 'fail', `${info.version.join('.')} · ${info.venv ? '虚拟环境' : '需要使用虚拟环境'}`);
    for (const [name, entry] of Object.entries(info.packages)) add(name, entry.ok ? 'pass' : name === 'faster-whisper' ? 'optional' : 'fail', entry.ok ? entry.version : '无法导入；运行当前虚拟环境的 pip install -r requirements.txt');
  } catch { add('Python依赖', 'fail', '解释器返回无法识别的检查结果'); }
}
for (const tool of ['ffmpeg', 'ffprobe']) {
  const result = run(tool, ['-version']);
  add(tool, result.status === 0 ? 'pass' : 'fail', result.status === 0 ? result.stdout.split('\n')[0] : '未找到可运行的程序');
}
const codecs = run('ffmpeg', ['-hide_banner', '-encoders']);
add('MP3编码器', codecs.status === 0 && /\blibmp3lame\b/.test(codecs.stdout) ? 'pass' : 'fail', '单轨MP3导出需要libmp3lame');
const model = process.env.CUT_WHISPER_MODEL;
if (!model) add('离线转录模型', 'optional', '未配置 CUT_WHISPER_MODEL；仍可导入已有转录进行剪辑');
else {
  try {
    for (const file of ['model.bin', 'config.json', 'tokenizer.json']) await fs.access(path.join(model, file));
    add('离线转录模型', 'pass', '模型必要文件存在；未执行推理或下载，模型身份仍须自行核对');
  } catch { add('离线转录模型', 'optional', '目录缺少模型必要文件；可先导入已有转录'); }
}
const data = path.resolve(process.env.CUT_DATA_DIR || path.join(app, 'data'));
let probeFile;
try {
  await fs.mkdir(data, { recursive: true });
  probeFile = path.join(data, `.doctor-${process.pid}`);
  await fs.writeFile(probeFile, 'local write check', { flag: 'wx', mode: 0o600 });
  await fs.rm(probeFile); probeFile = null;
  add('工程数据目录', 'pass', '可写入并删除临时检查文件');
} catch { add('工程数据目录', 'fail', '无法写入 CUT_DATA_DIR；请检查目录权限'); }
finally { if (probeFile) await fs.rm(probeFile, { force: true }).catch(() => {}); }

const failed = results.some(r => r.status === 'fail');
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ ok: !failed, networkRequests: 0, results }, null, 2) + '\n');
else {
  for (const r of results) process.stdout.write(`${({ pass: '通过', fail: '失败', optional: '可选' })[r.status]} · ${r.name}：${r.detail}\n`);
  process.stdout.write(failed ? '\n基础环境尚未就绪，请修复失败项后重跑。\n' : '\n基础环境就绪。检查未调用模型API、未下载权重，也不代表已完成实际转录或审听。\n');
}
process.exitCode = failed ? 1 : 0;
