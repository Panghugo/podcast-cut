# 公开中文语音小样

- 原文件：`Chinese-lesson-7-dialogue-1.ogg`，仓库内命名为 `source.ogg`，内容未修改。
- 作者：Supernaturalist；原始上传于2007-05-03。
- [Wikimedia Commons来源与许可](https://commons.wikimedia.org/wiki/File:Chinese-lesson-7-dialogue-1.ogg)。作者已将作品置于全球公有领域；页面亦载明在无法实现该声明的地区允许无条件再利用。
- 下载日期和SHA-256见 [source.json](source.json)。录音不改标为项目MIT代码。
- 这是约12秒的普通话对话朗读，不是多人访谈，也不是长访谈自动剪辑质量基准。

新建单轨工程，复制导入 `source.ogg`，选择 `transcript.json`，确认稿件与素材时间轴对应后绑定。配套JSON由本地faster-whisper large-v3生成，记录了后端、模型版本、时间与词级概率。它未经实际听辨确认，说话人统一标为待核，不把朗读的不同角色当作已确认的不同真人。

可以先保留全部内容导出、回听、批注；接入API由自己决定，不需要为了演示而删除正常内容。检查重点是导入、源时间映射、版本与批注，不能用这个短样本推断整期编辑效果。
