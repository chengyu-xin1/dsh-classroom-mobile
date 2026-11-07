# dsh-classroom-mobile

手机可访问的课堂学习插件（DSH / cordis 插件）。

手机浏览器打开 PC 上的地址 → 录音 → 自动转写成文字 → 在 DSH 里让 Agent 生成
总结 / 思维导图 / 练习题 → 手机复习答题 → 错题不改完不让开新录音 → 课后输出专注报告。

## 先看清楚边界（不要期待它做不到的事）

- **DSH 是桌面应用，没有移动端。** 手机端 = 手机浏览器访问 PC 上本插件启动的 HTTP 服务；
  安卓和鸿蒙都用浏览器打开同一个网址。本项目**不打包 APK**，也不做原生 App。
- **浏览器无法阻止你切到其他 App。** 专注功能只做「检测 + 记录 + 报告」：
  页面监听 `visibilitychange` 记录离开/回来的时间，并配番茄钟倒计时。
  本项目**不会也不声称**能锁定手机、锁屏或强制专注。
- **零 npm 依赖**，只用 node 内置模块；转写调用本机 `ffmpeg` 和 `python`。
- **所有业务数据只写 `D:\dsh-classroom-mobile\data`**（不写 C 盘）。

## 安装

> 给别人的完整安装说明（三种方式、验证清单、常见坑、卸载）：**[INSTALL-others.md](INSTALL-others.md)**

### 从 DSH 插件市场安装（审核通过后）

在市场卡片上点「安装」，或在命令行：

```powershell
dsh plugin --profile desktop add github:chengyu-xin1/dsh-classroom-mobile
```

### 手动安装（本机开发/离线）

1. 把整个目录放到 `D:\dsh-classroom-mobile`（数据也会写在这里的 `data\` 下）。
2. 复制到 DSH profile 的插件目录：

   ```powershell
   Copy-Item -Recurse -Force "D:\dsh-classroom-mobile" `
     "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-classroom-mobile"
   ```

3. 把包名加进 profile 的 `package.json` 的 `dsh.profile.bundles` 数组末尾
   （`$env:USERPROFILE\.dsh\profiles\desktop\package.json`），加 `"dsh-classroom-mobile"`。
4. **重启 DSH**，插件 `apply()` 会自动在 `0.0.0.0:8765` 起服务（被占则 8766 起递增）。

### 换电脑 / 给别人装：先跑环境准备

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

它会依次检查并准备：Node / Python / ffmpeg、安装 `faster-whisper`（清华源）、下载
Whisper `small` 模型（约 460 MB）、下载 `cloudflared`（公网地址用）。
任何一步失败都不会让插件不可用，只影响对应能力（没有 faster-whisper 就手动粘贴文字，
没有 cloudflared 就只用局域网）。可用 `-SkipModel`、`-SkipCloudflared` 跳过下载。

## 手机访问（公网 HTTPS 隧道，任何网络都能用 —— 推荐）

插件启动时会用 `cloudflared` 建一条临时 HTTPS 隧道，手机**用流量、或在别的 Wi‑Fi 下**也能打开：

```
https://xxxx-xxxx-xxxx.trycloudflare.com
```

HTTPS 还解决了手机浏览器「非安全上下文不能调用麦克风」的限制，录音可以直接用。

- **首次准备**：`cloudflared.exe` 约 53 MB，仓库不打包。插件第一次启动会自动下载到
  `data\bin\cloudflared.exe`（优先 ghfast 镜像，官方源国内较慢）；下载失败时页面照常可用，
  只是没有公网地址。也可以手动放一份：

  ```powershell
  New-Item -ItemType Directory -Force D:\dsh-classroom-mobile\data\bin | Out-Null
  Invoke-WebRequest -Uri https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe `
    -OutFile D:\dsh-classroom-mobile\data\bin\cloudflared.exe
  ```

- **访问码（默认关闭）**：手机打开地址直接用，不弹输入框。需要保护时设环境变量
  `DSH_CLASSROOM_PIN=1` 再重启 DSH，非本机访问才要求 6 位码（存在 `data\access.json`）。
- **地址会变**：quick tunnel 每次重启 DSH 可能换地址。随时在 DSH 里问
  「手机访问地址」即可（工具 `classroom_mobile_url` 返回最新地址）。
  DSH 日志里也会有：`[dsh-classroom-mobile] 公网地址：https://…`。
- **关闭隧道**：设环境变量 `DSH_CLASSROOM_MOBILE_TUNNEL=0` 后重启 DSH，就只用局域网。
- **安全提醒**：隧道地址公网可达，**没有访问码时拿到链接的人也能打开**，不要公开发布；
  所有数据仍然只写本机 `D:\dsh-classroom-mobile\data`，不上传云端（音频只经过 Cloudflare 转发到你的电脑）。

## 手机连接（局域网，同一 Wi‑Fi 时可用）

如果隧道没起来（比如 `bin\cloudflared.exe` 没下载），电脑和手机连同一个 Wi‑Fi / 校园网，
手机浏览器打开：

```
http://<电脑局域网 IP>:8765
```

本机实测地址是 `http://10.178.55.57:8765`（本次部署时的 WLAN 地址；DHCP 可能会变，
以 `ipconfig` 里「无线局域网适配器」的 IPv4 地址为准）。注意：局域网 HTTP 下部分手机
浏览器会拒绝录音（非安全上下文），此时优先用上面的公网 HTTPS 地址。

### 连不上时的排查顺序（按顺序做，不要跳步）

0. 先看隧道状态：`curl.exe http://127.0.0.1:8765/api/state` 里的 `tunnel` 字段。
   - `status: "ready"` → 用 `tunnel.url` 在手机上打开；
   - `status: "error"` → 看 `tunnel.error`，以及 `data\.tmp\cloudflared.log`；
   - `status: "disabled"` → 环境变量 `DSH_CLASSROOM_MOBILE_TUNNEL=0` 开着，改用局域网地址。

1. 在**电脑本机**执行（PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，建议用
   `curl.exe` 或浏览器直接打开）：

   ```
   curl.exe http://127.0.0.1:8765/api/state
   ```

   - 不通 → 服务没起来：重启 DSH；仍然不通就看 DSH 日志里有没有
     `[dsh-classroom-mobile] 服务已启动`，或端口被占用（会尝试 8766~8774，
     实际端口见页面顶部或 `/api/state` 的 `port` 字段）。

2. 在**电脑本机**用局域网 IP 访问：

   ```
   curl.exe http://10.178.55.57:8765/api/state
   ```

   - 127.0.0.1 通、局域网 IP 不通 → 服务没监听 0.0.0.0，或本机 hosts/代理问题。

3. 在**手机**浏览器打开 `http://10.178.55.57:8765`。

   - 手机不通 → **Windows 防火墙**（允许 node.exe 的入站 8765 端口），或者**校园网客户端
     隔离**（很多校园网禁止设备互访）。

   遇到这种情况**报告给老师/网管，不要自己瞎改网络设置**（关防火墙、改网段、动路由都可能
   违反学校规定）。

## 使用流程

1. 手机打开页面 → 「录音」页填课程标题 → 点「开始上课」。
   - 浏览器会请求麦克风权限；录音过程中每 30 秒自动切一个分片上传，服务端逐片转写。
   - 页面顶部有状态点（录音中 ● / 已停止 ●）和计时器。
2. 录音页字幕区每 3 秒刷新最近 5 段转写。
   - 如果转写引擎未就绪（`asrAvailable=false`），页面会提示「转写引擎未就绪，
     可手动粘贴文字」，并给一个粘贴框兜底；**音频仍然照常保存**。
3. 点「结束并整理」→ 停止录音，结束专注计时。
4. 在 DSH 对话框里说：**「生成这节课的总结和导图」** → Agent 调用
   `classroom_mobile_digest`，生成 5 条带时间戳要点、mermaid 思维导图、3 条知识拓展、
   5 道由易到难的题并写入题目文件。
5. 手机切到「总结 / 导图 / 复习」页刷新即可看到。
6. 复习页作答 → 在 DSH 里让 Agent 批改（`classroom_mobile_grade`）。
   **未改正的错题 > 0 时，手机端不允许开始新录音**（服务端也会 409 拦截）。
7. 课后在 DSH 里说「结束专注/看看专注报告」→ `classroom_mobile_focus` 输出
   总时长、切走次数与累计离开时长、最长连续专注、番茄数。

## 2026-11-07 新增功能

- **导图四视图**：手机「导图」页顶部可在「脑图 / 组织树 / 时间轴 / 分块」之间切换；数据仍来自 `mindmap.md`，首行用 `%% type: mindmap|tree|timeline|brace` 指定默认视图。旧的 mermaid mindmap 代码块仍能显示。
- **课堂重难点**：DSH 里说「生成重难点」或「生成这节课的总结、重难点和导图」，会同时写 `keypoints.md`（`## 重点 / ## 难点 / ## 易错点`，每条带 `[mm:ss]`），手机「总结」页会多一张「课堂重难点」卡片。
- **拖入已有录音**：手机「录音」页新增上传区，可拖入/选择 `webm / m4a / mp3 / wav / ogg`，自动建会话、上传、排队转写；与 30 秒分片走同一条队列，按顺序追加字幕。

`classroom_mobile_digest` 的任务包相应变为五项（总结、重难点、导图、拓展、题目）；保存时 `payload` 需要带 `keypoints` 与 `mindmapType`，缺了会明确报错、不会写坏文件。

## 转写引擎（按顺序降级）

1. 安装依赖（只需一次）：`python -m pip install faster-whisper`（校园网建议加清华源：
   `-i https://pypi.tuna.tsinghua.edu.cn/simple`）。
2. 首次转写会把 `small` 模型（int8，约 460MB）下载到
   `D:\dsh-classroom-mobile\data\models`。官方 `huggingface.co` 在部分校园网不可达，
   脚本默认走 `HF_ENDPOINT=https://hf-mirror.com`。
3. 降级规则：pip 安装失败、模型下载失败、python/ffmpeg 不可用时，**音频照存**，
   `transcript.md` 写入「`[此段待转写]`」，`/api/state` 返回 `asrAvailable=false`，
   页面提示手动粘贴。**任何情况下都不会伪造转写文字。**

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 单文件手机页面（内嵌 CSS/JS，中文，四页签） |
| GET | `/api/state` | 当前会话、录音时长、待改正错题数、ASR 状态、端口 |
| POST | `/api/session/start` | `{title}` 新建会话；有未改正错题时 409 |
| POST | `/api/audio` | 二进制音频分片（`audio/webm` 等），落盘后异步转写 |
| GET | `/api/live` | 最近 5 段转写（页面 3 秒轮询） |
| GET | `/api/summary` | `summary.md` / `mindmap.md` 内容 |
| POST | `/api/quiz/answer` | `{index, answer}` 手机端作答 |
| GET | `/api/quiz/pending` | 未改正错题（同题以最新一条为准，`correct=true` 出队） |
| GET | `/api/quiz/questions` | 题目列表与作答状态 |
| POST | `/api/focus/event` | `{type: start\|leave\|return\|stop}` 专注事件 |
| POST | `/api/transcript/manual` | `{text}` ASR 不可用时手动补录 |

## 数据目录

```
D:\dsh-classroom-mobile\data\
  current.json                     # 当前会话指针
  models\                          # faster-whisper 模型缓存
  sessions\<yyyy-mm-dd>-<标题>\
    meta.json                      # 录音起止时间、分片状态
    audio\chunk-000.webm ...       # 原始录音分片
    transcript.md                  # 增量转写，每段 "[mm:ss] 文本"
    summary.md                     # Agent 生成的总结
    mindmap.md                     # Agent 生成的 mermaid 思维导图
    quiz.jsonl                     # 出题 / 作答 / 批改记录
    focus.jsonl                    # 专注事件（start/leave/return/stop）
```

## 开发与自测

```powershell
node --check src\index.js            # 语法检查（其它 js 同理）
node scripts\dev-server.js           # 不起 DSH，直接起服务，便于 curl 验收
node test\e2e.mjs                    # 端到端：上传→转写→总结→错题门控→专注报告
```

`test\e2e.mjs` 会往真实数据目录写一个「自动验收测试」会话，运行结束会清理。

## 已知限制

- 真实手机浏览器（iOS Safari / 安卓 Chrome / 微信内置）的录音编码格式和后台行为
  未在本机自动化测试覆盖，需要真机验证；页面里对 `MediaRecorder` 不支持的浏览器有提示。
- 全屏 API 在手机上常被拒绝，失败会静默忽略，不影响录音。
- 浏览器切后台可能被系统暂停录音；本项目只记录 `visibilitychange`，不保证后台录音连续。
- 服务只在局域网内使用，**没有登录鉴权**，不要把端口暴露到公网。
- 专注报告只反映页面可见性变化，不能证明「没有分心」，更不是防沉迷工具。
