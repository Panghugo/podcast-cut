# 参与开发

先阅读 [使用教程](docs/quickstart.md)、[开发边界](docs/development.md) 和 [数据协议](docs/protocol.md)。

使用Python 3.12虚拟环境，安装带哈希的 `requirements.txt` 后运行：

```sh
npm run doctor
npm run check
npm test
```

测试使用本机模拟API、合成信号和仓库内的公有领域短语音，不调用付费模型，不需要转录权重。涉及音频的改动须验证源文件不变、共同时间线、完整解码与保留样本；涉及意见或方案的改动须验证版本绑定和锁定决定。

更新Python依赖时，修改 `requirements.in`，用 `uv pip compile requirements.in --python-version 3.12 --universal --generate-hashes -o requirements.txt` 重新锁定，并在干净虚拟环境运行测试。更新相应依赖来源记录。

提交问题时请提供可公开的小样或合成复现、系统与运行时版本、脱敏错误、预期行为。不要提交API密钥、私人录音、转录、项目数据或包含访谈内容的诊断文件。需要人工回听才能确认的结果应标为待核，自动数值检查不能写成听感验收。

首版集中于转录、API内容方案、可撤销粗剪与审听反馈；降噪、神经增强和母带处理暂不纳入。新增外部代理可通过现有JSON方案与CLI接入。
