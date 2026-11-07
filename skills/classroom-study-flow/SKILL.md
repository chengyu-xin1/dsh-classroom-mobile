---
name: classroom-study-flow
version: 1
description: "把「手机录音（或拖入已有录音文件）→ 逐段转写 → 生成总结、课堂重难点与多视图导图 → 出 5 道由易到难的题 → 错题门控 → 专注报告」这套课堂学习闭环固化成可重复执行的流程。当用户说「整理这节课」「生成这节课的总结和导图」「生成重难点」「出几道题」「复习错题」「看看我的专注报告」「开始上课」「把这个录音转成总结」时使用；也用于检查这套闭环是否按规则运行（门控、转写降级、禁止伪造文字）。"
compatibility: 依赖 dsh-classroom-mobile 插件（4 个工具 + 8765 HTTP 服务 + faster-whisper 转写）；纯 Node 内置模块，无 npm 依赖。
allowed-tools: Bash, Read, Write, Edit
---

# 课堂学习闭环（手机录音 → 总结 → 练习 → 门控）

这个 skill 描述的是「一节课从录音到复习」的完整规矩。照着做，不要临场发挥。

## 固定约定（不可改）

```yaml
fixed:
  数据根目录: "D:\\dsh-classroom-mobile\\data"      # 可用环境变量 DSH_CLASSROOM_MOBILE_DIR 覆盖；绝不写 C 盘业务文件
  会话目录: "<yyyy-mm-dd>-<标题>"                    # 例如 2026-11-05-英语
  会话内文件:
    audio/: "chunk-000.webm...（每片 30 秒，独立可解码）；拖入的文件存为 upload-<idx>-<文件名>.m4a/.mp3/..."
    transcript.md: "增量追加，每段一行，格式 [mm:ss] 正文"
    summary.md: "Agent 写入，5 条带时间戳要点 + 知识拓展"
    keypoints.md: "Agent 写入，## 重点 / ## 难点 / ## 易错点 三小节，每条带 [mm:ss]"
    mindmap.md: "Agent 写入，首行 %% type: mindmap|tree|timeline|brace，其余为缩进大纲"
    quiz.jsonl: "每行一个 JSON，type = question / answer / grade"
    focus.jsonl: "事件流 start / leave / return / stop"
  服务: "0.0.0.0，端口从 8765 起顺延（最多 8774），卸载时关闭"
  访问码: "默认关闭（手机直接打开地址）；设 DSH_CLASSROOM_PIN=1 才要求 6 位 X-Classroom-Pin"
  番茄钟: "25 分钟"
  工具:
    - classroom_mobile_digest   # 两阶段：无参数返回任务包；带 payload 保存总结/重难点/导图/题目
    - classroom_mobile_grade    # {index, correct, note} 回填某题判定
    - classroom_mobile_focus    # 结束专注并输出报告
    - classroom_mobile_url      # 返回当前公网地址、局域网地址（访问码仅在开启保护时返回）
```

## 输入（开始前确认）

```yaml
inputs:
  required:
    - 手机已通过公网 HTTPS 地址打开页面（录音必须有 HTTPS，http 局域网地址不能调麦克风）
    - 会话标题（用于建目录，避免特殊字符）
  optional:
    - 手动粘贴的补充文字（听不清的板书、公式）
  blocking:
    - 存在未改正错题时，禁止开始新录音（接口直接 409）
```

## 规则（按顺序执行，每条都要落到真实文件/接口）

```yaml
rules:
  recording:
    - 每 30 秒 recorder.stop() → 上传 → 立刻 start()，保证每片都有 EBML 头、各自可解码
    - 停止录音时上传最后一片
    - 页面每 3 秒轮询 /api/live，显示最近 5 段字幕
    - 锁屏/切后台会暂停录音，这是浏览器规则：页面必须前台常亮，如实告知用户
  transcribe:
    - 流程：ffmpeg 转 16kHz 单声道 16bit wav → python scripts/transcribe.py（faster-whisper small，int8）
    - 输出 JSON [{start,end,text}]，Node 侧按偏移量换算成 [mm:ss] 追加到 transcript.md
    - 失败降级：音频照存，写「[此段待转写]」，/api/state 返回 asrAvailable=false，页面提示可手动粘贴
    - 绝不伪造文字：没有识别结果就写「[此段未识别到语音]」或「[此段待转写]」
  upload:
    - 页面支持拖入/选择已有录音（webm/m4a/mp3/wav/ogg），POST /api/audio 原始二进制 + X-File-Name（encodeURIComponent）
    - 无当前会话时先 POST /api/session/start {title: 文件名去扩展名}
    - 拖入文件与 30 秒分片走同一条转写队列，按上传顺序追加 [mm:ss]；不要并行开多个 python 进程
  digest:
    - 第一步（无 payload）：读当天 transcript.md，返回任务包，不要直接写文件
    - 任务包必须包含：5 条带 [mm:ss] 的要点、课堂重难点（## 重点 / ## 难点 / ## 易错点，每条带 [mm:ss]）、1 份缩进大纲导图（4 种结构 mindmap/tree/timeline/brace 任选，首行 %% type: X）、3 条知识拓展、5 道由易到难的题（附参考答案）
    - 第二步（带 payload）：校验 summary/mindmap/keypoints 非空、mindmapType 在白名单、questions 恰好 5 道；写 summary.md / keypoints.md / mindmap.md，并重写 quiz.jsonl 的 5 条 question 行（correct 留空 null）
    - 每条要点的时间戳必须能在 transcript.md 里找到原文，不得编造时间
  quiz:
    - 手机端答题写 answer 行；Agent 判定写 grade 行 {index, correct, note}
    - 判题口径：同一 index 以最后一行 answer/grade 为准；correct === true 才出队
    - 未改正题数 = pendingWrong.length；>0 时 POST /api/session/start 返回 409 wrong_questions_pending
    - 复习页强制停留，全部答对后才显示「可以开始新录音」
  focus:
    - 只做检测：visibilitychange 记录 leave / return，配番茄钟倒计时
    - 录音开始发 start，页面隐藏发 leave，回来发 return，停止发 stop
    - 报告字段：总时长、有效专注、切走次数、累计离开时长、最长连续专注、番茄数
    - 禁止在代码/界面/文档写「锁定手机」「锁屏」「阻止切换」——浏览器做不到
  page:
    - 单文件 HTML，内嵌 CSS/JS，零外链（校园网可能无外网）
    - 手机竖屏优先，正文 18px 以上，按钮触控高度 ≥56px
```

## 输出（缺一不算完成）

```yaml
outputs:
  - transcript.md       # 每段 [mm:ss]，可追溯到音频分片或拖入的文件
  - summary.md          # 5 条带时间戳要点 + 3 条知识拓展
  - keypoints.md        # 重点 / 难点 / 易错点，每条带时间戳
  - mindmap.md          # 首行 %% type: mindmap|tree|timeline|brace + 缩进大纲
  - quiz.jsonl          # 5 道由易到难的题，correct 为 null；后续追加 answer/grade
  - focus 报告          # 六项数字，基于 focus.jsonl 事件计算
```

## 校验清单（交付前逐条打勾）

```yaml
validation:
  - 转写：随机抽 3 段时间戳，能在 transcript.md 找到对应原文，且与音频时长对得上
  - 总结：5 条要点，每条都有 [mm:ss]，时间戳都真实存在
  - 导图：mindmap.md 首行是 %% type: mindmap|tree|timeline|brace 之一，至少 3 层缩进，手机页面四个视图都能渲染
  - 重难点：keypoints.md 有 重点/难点/易错点 三个小节，每条都带 [mm:ss]
  - 上传：拖入的音频与 30 秒分片按顺序追加到 transcript.md，时间戳连续，不跳段
  - 题目：正好 5 道，难度递增，correct 全为 null
  - 门控：pendingWrong > 0 时新会话请求返回 409；全部 correct=true 后放行
  - 专注：报告里的切走次数、累计离开、最长连续与 focus.jsonl 事件逐一吻合
  - 边界：转写失败时文件里只有「[此段待转写]」，没有任何编造正文
  - 用词：全项目 grep「锁定手机」「锁屏」「阻止切换」必须为 0
  - 数据：所有写入都在 D:\dsh-classroom-mobile\data 下，C 盘无业务文件
```

## 参考实例（真实会话，可用于对照）

```yaml
example:
  会话: "2026-11-05-英语"
  音频: "chunk-000 ~ chunk-004.webm，共 5 片，合计 149.8 秒"
  转写: "transcript.md 共 36 段，[00:00] ~ [02:28]（含简繁混出，如「社交焦慮」「金恐障礙」）"
  专注: "focus.jsonl 事件顺序 start → leave → return → stop"
  已知限制: "录音跨度 79.5 分钟，但锁屏后浏览器暂停录音，实际只录到前 2.5 分钟"
```

## 出错时先看这里

| 现象 | 先查什么 |
|---|---|
| 手机页面没有任何字幕 | `/api/state` 的 asrAvailable 是否为 true；后台转写队列 pendingTranscribed 是否在降 |
| 字幕出现但全是「[此段待转写]」 | python / faster-whisper / 模型是否就绪；ffmpeg 能否解码该 webm |
| 生成总结时说「还没有转写内容」 | 当前会话目录是否选对；transcript.md 是否为空 |
| 答完题还是不让开新录音 | 判题是否写成 correct=true；pendingWrong 是否仍有残留 |
| 专注报告数字是 0 | 手机端是否发了 start/stop 事件；focus.jsonl 是否为空 |
