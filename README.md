# PodCut

面向中文长访谈的本地 AI 粗剪工具。接入自己的模型 API，生成内容删改方案，再输出可回听、可撤销的粗剪。降噪、神经增强与音质搜索不在本项目范围内。

状态：`0.1.0-alpha.1`，实验版。先读 [完整使用教程](docs/quickstart.md)，或用 [公开中文语音小样](examples/public-speech/) 试用。当前实现与验证边界见 [开发状态](docs/development.md)。

## 当前流程

导入录音 → 本地转录或绑定已有稿 → 填写剪辑要求 → API 自动生成完整删改方案 → 手动审阅、锁定或恢复 → 批准 → 导出粗剪 → 审听批注 → 根据意见再次生成方案。

- 单轨：输出 48 kHz PCM24 WAV、192 kbps MP3、源时间映射、粗剪时间码稿、剪辑日志与校验和清单。
- 多轨：当前导出采用共同时间线的独立分轨 WAV，不自动选麦或混音。需要用户明确声明同步，并导入带 `trackId` 的共同时间轴转录。
- 自动方案当前保留原对话顺序；可启用手动移句。只有整句删留，没有句内精剪。
- 自动方案不会以最低60分钟、删减比例或固定成品时长为目标。原话、条件、有效追问和上下文优先。
- 所有产物都是审阅候选。数值校验和模型判断不能代替实际审听。

## 安装与启动

需要 Node.js 22+、Python **3.12**、FFmpeg/FFprobe（包含 libmp3lame）。目前在 macOS 完成开发验证；其他系统尚未验证。

```sh
git clone https://github.com/Panghugo/podcast-cut.git
cd podcast-cut
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --require-hashes -r requirements.txt
cp .env.example .env
npm run doctor
npm start
```

不需要安装 npm 依赖。先在 `.env` 中配置 `CUT_PYTHON`，再运行 `npm run doctor` 检查基础环境。检查不会请求模型API或下载权重；未配置离线模型也能导入已有稿使用。打开 <http://127.0.0.1:8770>。服务只监听本机，不能作为公开网站部署。

编辑本地 `.env`，把 `CUT_PYTHON` 指向自己的 Python 3.12 虚拟环境解释器。模型 API 地址、密钥和模型名称也可以在界面配置；界面密钥只保留在服务内存，重启后需重新配置。`.env`、录音、转录、任务和缓存均不会进入 Git。

API适配器使用 Chat Completions 兼容协议，支持严格 JSON Schema、JSON 模式、提示词约定 JSON 三种输出方式。不同服务商兼容程度不同，失败时明确报错，不自动切换模型或重试付费请求。格式依据 [官方 Chat Completions 文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) 与 [Structured Outputs 文档](https://developers.openai.com/api/docs/guides/structured-outputs)。

模型的效果和费用由用户选择的服务决定。调用规模按钮显示原文字数与预计请求次数；完成后显示服务返回的 token 用量。尚未实现金额预算或费用上限。

长稿先分段理解、组织主线、逐段决定，再用全文与全部决定做一次模型复核。超过全文复核输入上限会明确标为未完成，不把摘要当成全文检查。返回未知句编号、额外字段或修改锁定决定时，拒绝应用，并提供本地 `model_rejection.json` 诊断。诊断含模型返回内容，属于私人项目数据。成功步骤保留检查点；用户主动重试时可复用一致输入，未完成步骤可能再次调用收费API，不会自动重试。

切换API地址时清除内存中旧密钥；相同地址留空则沿用已有密钥。

### DeepSeek

本轮核对官方文档后的配置：API地址 `https://api.deepseek.com`，模型 `deepseek-flash`，输出格式选 **JSON模式**。可使用已有 `DEEPSEEK_API_KEY` 环境变量；只有API域名为 `api.deepseek.com` 时才读取该变量，不会把它发送给其他提供商。密钥不写入工程或Git。

JSON模式/提示词模式会同时发送结构约束与示例，再做本地编号与决定校验。DeepSeek适配器明确关闭思考模式，单次最多8192输出token，作为本轮可复现的粗剪基线；这个默认值不是效果保证。设置依据 [官方接口说明](https://api-docs.deepseek.com/)、[JSON输出](https://api-docs.deepseek.com/guides/json_mode/) 与 [思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。模型名称和服务能力可能变化，请以当前官方文档为准。

## 本地转录

模型权重不随仓库提供，不会在点击时自动下载。将 `CUT_WHISPER_MODEL` 配置为一个已有的 **faster-whisper large-v3 本地目录**，不是模型名。调用使用 `device="cpu"`、`compute_type="int8"`、`local_files_only=True` 和 `HF_HUB_OFFLINE=1`。

转录保留词时间、分段平均对数概率、模型位置、后端版本与参数。说话人默认“待核”；中文专名、数字、否定和低置信度文字需要回听。转录中断本轮尚不能从音频分块检查点继续。可以先导入已有转录使用其他功能。

## 导入转录

支持 `sentences` 或 Whisper 风格的 `segments` JSON。时间接受整数 `startUs/endUs`、毫秒 `startMs/endMs` 或秒 `start/end`。按原时间排列，句编号稳定且唯一。导入时必须明确确认时间轴与当前录音一致，不能把原录音转录直接套到已剪短音频。

```json
{"sentences":[
  {"id":"A-0001","speaker":"主持人","text":"原录音中的一句话。","startUs":0,"endUs":2000000},
  {"id":"B-0002","speaker":"嘉宾","text":"原录音中的回答。","startUs":2500000,"endUs":6000000}
]}
```

多轨须为每句填写工程实际的 `trackId`；界面展示每轨 ID。偏移只支持非负整数微秒，最早轨设为共同零点。导入转录后素材与偏移固定，避免时间码串用。

## 批注与版本

先在任务中选择一个已完成粗剪版本，播放、暂停打点、填写意见。多轨可逐轨选择审听，切换同一版本音轨时保留播放位置。意见绑定该次渲染、具体音轨文件、音频SHA-256及原始源区间，保存前校验音频未变。后续剪辑不会改变旧意见位置。可以选择“只改本段”或“检查全片”，重新生成草案、审阅批准、再次渲染。意见不会因模型任务成功自动变成“已解决”。本轮尚未提供旧意见在新版本上的自动迁移视图；未绑定具体音轨的历史批注须从原任务手动核对音轨。

“锁定决定”会保护用户明确保留/删除的句子；模型违反锁定要求时拒绝整份结果。历史方案恢复会新建修订，不覆盖源录音、旧候选或审听意见。

首轮真实接口测试发现，模型可能把短回应或ASR断词当作废话。自动方案会保守恢复由不超过6个非标点字符短句组成的整组删除；设备调试等包含完整长句的整段删除不受此规则影响。用户已锁定删除的决定仍保留。模型原始方案、恢复理由和推荐方案分别留痕；这只是保守保护，不等于听辨确认。

若拟删句仍与保留的源区间重叠，自动方案会恢复该句并注明原因，避免文字显示删除、音频却仍保留的矛盾。锁定删除与复杂重叠仍会在时间线中列出回退项，供回听检查。

## 外部工具接入

通过界面导出接入包，或使用 [CLI 与协议](docs/protocol.md)。Codex、Claude 和自写程序都可以读取同一份转录与 `podcast-edit/1` 方案，修改后导入校验。项目不内置这些代理的专用运行器。

## 开发与验证

```sh
source .venv/bin/activate
npm test
npm run check
```

集成测试使用本机模拟模型服务、确定性合成信号和随仓库提供的公有领域短语音，实际执行 FFmpeg 切片、WAV/MP3 输出、独立完整解码、校验和验证、多轨同步剪辑及意见返修。不会调用付费 API，不会使用节目私有素材。这些测试不评价真实访谈的内容取舍或听感。

可以生成纯测试信号检查界面导入；它没有人声，稿件只是接口占位文字：

```sh
node scripts/create-demo.js
```

## 示例、许可与参与开发

- [公开中文语音小样](examples/public-speech/)：约12秒的公有领域普通话朗读，附来源、校验和和未经听辨核准的ASR稿。
- `npm run demo`：生成8秒合成测试信号和占位稿，不需要权重或API。
- [MIT许可证](LICENSE)、[第三方依赖与素材来源](docs/third-party.md)、[参与开发](CONTRIBUTING.md)、[更新记录](CHANGELOG.md)。

已用私有连续25分钟片段完成真实API方案与粗剪导出；本机干净虚拟环境通过安装和工程测试。私人节目、项目数据、密钥和模型权重均不进入仓库。整期长音频质量、复杂重叠与实际听感仍需更多验证；自动检查不能代替人工审听。
