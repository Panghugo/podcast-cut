# 统一剪辑方案与外部工具接口

方案版本 `podcast-edit/1`，转录版本 `podcast-transcript/1`，时间线版本 `podcast-timeline/1`。目前以 `lib/plan.js` 的校验器为规范；下例是字段说明，不可直接套到真实工程。

```json
{
  "schemaVersion": "podcast-edit/1",
  "id": "方案UUID",
  "revision": 1,
  "projectId": "工程UUID",
  "sourceFingerprint": "源轨SHA、偏移、采样率与声道绑定摘要",
  "transcriptSha256": "完整转录摘要",
  "status": "draft",
  "editorial": {"brief":"这期希望讨论的问题与保留要求", "allowReorder":false},
  "summary": "主线与剪辑取舍说明",
  "chapters": [],
  "order": ["A-0001", "B-0002"],
  "decisions": [
    {"sentenceId":"A-0001", "action":"keep", "reason":"保留回答所需问题", "locked":true},
    {"sentenceId":"B-0002", "action":"delete", "reason":"明确重录废片", "locked":false}
  ]
}
```

`order` 必须包含全部句编号且恰好一次，包括拟删除句。`decisions` 对每个编号恰好给出一个决定。首版不接受改写原文、任意源路径、任意切点、句内删词、生成新音频等操作。章节字段是预留位，首版尚不自动产生语义章节。

素材SHA、偏移或转录改变会使旧方案失效。导入的方案始终成为新草稿，不能通过填写 `status:"approved"` 绕过批准步骤。手动修改与恢复都产生新修订。

自动模型必须保留用户锁定决定。外部代理是用户主动委托的编辑者，导入时允许主动修改锁定项；导入后仍须完整审阅批准。对当前版本不确定时先重新导出，不强行覆盖。

## CLI

启动本地服务后：

```sh
node cli.js list
node cli.js export <project-id> handoff.json
# 用外部工具修改 handoff.json 中的 plan；不改录音或转录。
node cli.js import <project-id> handoff.json
node cli.js approve <project-id>
node cli.js render <project-id>
node cli.js jobs <project-id>
```

`export` 输出已有文件时会拒绝覆盖。省略输出文件会打印 JSON。CLI默认连接8770端口，可以用 `CUT_LOCAL_URL` 改为其他本机端口。

## 本机 HTTP 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/projects` | 工程列表 |
| GET | `/api/projects/:id` | 素材、转录、当前方案、意见 |
| GET | `/api/projects/:id/export` | 完整接入包，含编译后时间线 |
| POST | `/api/projects/:id/plan` | `{revision, plan}`，校验并保存外部方案 |
| POST | `/api/projects/:id/approve` | `{revision}`，批准当前完整方案 |
| POST | `/api/projects/:id/jobs` | `{revision,type:"plan"或"render"}`，提交任务 |
| GET | `/api/projects/:id/jobs` | 任务状态与产物列表 |
| GET | `/api/projects/:id/jobs/:job/files/:name` | 下载明确列入产物清单的文件 |

`revision` 是**工程修订号**，不是方案修订号；并发冲突会拒绝写入。任务按提交时的版本生成独立候选。后台分析完成时若工程已变化，不能覆盖当前方案；候选与失败记录仍保留。

## 时间映射

转录统一使用整数微秒。渲染时按48kHz取整到样本，时间线附每块实际源样本和输出样本。删除区域没有伪造的成品区间。移动导致映射可以不单调，但重复源区间与不合法的重叠移动会拒绝。

连续保留的原句合并成一段，保留其间自然停顿。新切点采用60ms保守扩边与最长10ms淡入淡出。这只是审阅候选的定位策略，未完成词音节级安全切点验证。扩边仍包含拟删句音频时，会列为保守回退，而不声称已完全删除。

多轨共用同一块顺序与时间映射，各轨保持各自声道，缺少源覆盖的区域以明确空白补齐，不把该空白认定为录音中真实静音。独立分轨不是自动选麦后的混音。
