# 第三方依赖与示例来源

PodCut 自有代码和文档采用 [MIT](../LICENSE)。第三方依赖和示例素材保留各自许可。仓库不分发 Python wheel、FFmpeg 二进制、模型权重或服务商 SDK。

## Python 运行依赖

下表来自2026-10-24干净 macOS arm64 / Python 3.12 安装的包元数据。完整版本与分发文件哈希见 [requirements.txt](../requirements.txt)，机器可读记录见 [dependencies.json](dependencies.json)。平台条件依赖以锁文件为准。

| 包 | 版本 | 包元数据声明的许可 |
|---|---|---|
| [anyio](https://pypi.org/project/anyio/4.15.1/) | 4.15.1 | MIT |
| [av](https://pypi.org/project/av/19.0.2/) | 19.0.2 | BSD-3-Clause |
| [cffi](https://pypi.org/project/cffi/2.1.1/) | 2.1.1 | MIT-0 |
| [click](https://pypi.org/project/click/8.5.0/) | 8.5.0 | BSD-3-Clause |
| [ctranslate2](https://pypi.org/project/ctranslate2/4.8.3/) | 4.8.3 | MIT |
| [faster-whisper](https://pypi.org/project/faster-whisper/1.2.1/) | 1.2.1 | MIT License |
| [filelock](https://pypi.org/project/filelock/4.2.4/) | 4.2.4 | MIT |
| [flatbuffers](https://pypi.org/project/flatbuffers/25.12.19/) | 25.12.19 | Apache Software License |
| [fsspec](https://pypi.org/project/fsspec/2026.9.0/) | 2026.9.0 | BSD-3-Clause |
| [h11](https://pypi.org/project/h11/0.16.0/) | 0.16.0 | MIT License |
| [hf-xet](https://pypi.org/project/hf-xet/1.7.0/) | 1.7.0 | Apache-2.0 |
| [httpcore2](https://pypi.org/project/httpcore2/2.16.0/) | 2.16.0 | BSD-3-Clause |
| [httpx2](https://pypi.org/project/httpx2/2.16.0/) | 2.16.0 | BSD-3-Clause |
| [huggingface_hub](https://pypi.org/project/huggingface_hub/2.3.0/) | 2.3.0 | Apache Software License |
| [idna](https://pypi.org/project/idna/3.20/) | 3.20 | BSD-3-Clause |
| [numpy](https://pypi.org/project/numpy/2.5.4/) | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| [onnxruntime](https://pypi.org/project/onnxruntime/1.31.0/) | 1.31.0 | MIT License |
| [packaging](https://pypi.org/project/packaging/26.3/) | 26.3 | Apache-2.0 OR BSD-2-Clause |
| [protobuf](https://pypi.org/project/protobuf/7.36.2/) | 7.36.2 | 3-Clause BSD License |
| [pycparser](https://pypi.org/project/pycparser/3.12/) | 3.12 | BSD-3-Clause |
| [PyYAML](https://pypi.org/project/PyYAML/6.0.3/) | 6.0.3 | MIT License |
| [soundfile](https://pypi.org/project/soundfile/0.14.0/) | 0.14.0 | BSD License |
| [tokenizers](https://pypi.org/project/tokenizers/0.23.3/) | 0.23.3 | Apache Software License |
| [tqdm](https://pypi.org/project/tqdm/4.70.1/) | 4.70.1 | MPL-2.0 AND MIT |
| [truststore](https://pypi.org/project/truststore/0.10.5/) | 0.10.5 | MIT |
| [typing_extensions](https://pypi.org/project/typing_extensions/4.16.0/) | 4.16.0 | PSF-2.0 |

## 原生组件与外部程序

SoundFile 的 wheel 可能包含 libsndfile，PyAV 的 wheel 可能包含 FFmpeg 组件；其许可不因 Python 包许可而改变，须保留安装包中的原始通知。系统 FFmpeg/FFprobe 由用户另行安装，许可随构建配置而变。项目通过子进程调用，不在仓库分发二进制。

## 本地转录模型

可选使用 faster-whisper large-v3。模型不随仓库提供，不会自动下载。权重的许可和模型卡以[模型仓库](https://huggingface.co/Systran/faster-whisper-large-v3)为准。降噪和神经音质增强模型不在本项目范围。

## 公开语音示例

[examples/public-speech](../examples/public-speech/) 的原始 OGG 由 Supernaturalist 录制；[Wikimedia Commons 文件页](https://commons.wikimedia.org/wiki/File:Chinese-lesson-7-dialogue-1.ogg)记录了作者的全球公有领域声明及无条件再利用许可。录音保持原样，来源和SHA-256见 source.json。配套转录由本地ASR生成，未经听辨确认。此素材不改标为项目MIT代码。

## 其他

Node.js 运行时无第三方 npm 依赖。模型API通过标准HTTP协议调用，使用者自行选择服务商并遵循相应服务条款。GitHub Actions 使用 GitHub 官方 actions，并固定到发布时核对的提交。
