# 别人怎么装、怎么用（Windows 完整说明）

这份文档写给**拿到仓库、想在自己电脑上跑起来的人**。不用读源码，照着做即可。

- 仓库：<https://github.com/chengyu-xin1/dsh-classroom-mobile>
- 插件名：`dsh-classroom-mobile`
- 插件市场 PR：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12365>（合并后可在市场里搜索安装）

---

## 0. 前提

| 需要 | 说明 |
|---|---|
| Windows 电脑 | 核心代码是 node（跨平台），但一键安装脚本是 PowerShell |
| DSH 桌面版 | 版本需满足 `>=0.1.0-rc.6 <0.4.0` |
| Python 3.9+ | 可选；没有也能用，但转写会降级为「手动粘贴文字」 |
| ffmpeg | 可选；没有的话手机录音（webm/opus）转不成 wav，转写会失败 |
| 网络 | 需要能访问 GitHub（校园网常被拦，见第 5 节）|

> DSH 桌面版自带 node，**不需要**另外装 Node.js。

---

## 1. 方式 A：插件市场（最简单，等 PR 合并后）

1. 打开 DSH → 插件 → 插件市场
2. 搜 `dsh-classroom-mobile`（或 `classroom`）
3. 点「安装」→ 重启 DSH

---

## 1.5 方式 A+：双击 `install.bat`（现在就能用，最推荐）

1. 打开 <https://github.com/chengyu-xin1/dsh-classroom-mobile>
2. 绿色 **Code → Download ZIP**
3. 解压，进入文件夹，**双击 `install.bat`**
4. 等它跑完（下载插件、复制到 profile、注册 bundle、准备 Python/模型/cloudflared，首次可能 5～20 分钟）
5. 完全退出 DSH 再重新打开 → 在对话里说「手机访问地址」

脚本做的事（可自己核对，就在 `scripts/install.ps1`）：
- 从 GitHub 下载最新 ZIP（官方源失败会自动换 ghfast 镜像）
- 复制到 `C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-classroom-mobile`
- 备份并修改 profile 的 `package.json`，把插件加进 `dsh.profile.bundles`
- 调用 `scripts/setup.ps1` 装 faster-whisper、small 模型、cloudflared

常用参数：

```powershell
# 只装插件，不装模型/环境
install.bat -SkipSetup
# 覆盖重装（会先备份旧目录）
install.bat -Force
# 用已经下载好的 ZIP
install.bat -ZipPath "D:\下载\插件.zip"
# 只看计划，不写文件
install.bat -DryRun
```

---

## 2. 方式 B：命令行安装（需要 dsh CLI）

```powershell
dsh plugin --profile desktop add github:chengyu-xin1/dsh-classroom-mobile
```

装完准备环境并重启：

```powershell
& "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-classroom-mobile\scripts\setup.ps1"
```

如果你的 DSH 是桌面版且 PowerShell 里没有 `dsh` 命令，用方式 C。

---

## 3. 方式 C：手动安装（不依赖市场，也不依赖 dsh CLI）

### 3.1 下载仓库

```powershell
$zip = "$env:TEMP\dsh-classroom-mobile.zip"
Invoke-WebRequest 'https://ghfast.top/https://github.com/chengyu-xin1/dsh-classroom-mobile/archive/refs/heads/main.zip' -OutFile $zip
```

（GitHub 网络正常时也可以直接把上面地址换成
`https://github.com/chengyu-xin1/dsh-classroom-mobile/archive/refs/heads/main.zip`。）

### 3.2 解压并复制进 DSH profile

```powershell
$tmp = "$env:TEMP\dcmm"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip $tmp -Force

$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-classroom-mobile"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item "$tmp\dsh-classroom-mobile-main\*" $dst -Recurse -Force
```

### 3.3 在 profile 里登记插件

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
Copy-Item $p "$p.bak-install"

$j = Get-Content $p -Raw | ConvertFrom-Json
if ($j.dsh.profile.bundles -notcontains 'dsh-classroom-mobile') {
  $j.dsh.profile.bundles += 'dsh-classroom-mobile'
}
[IO.File]::WriteAllText($p, ($j | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
```

- 已备份为 `package.json.bak-install`，改坏可还原。
- 不要用记事本手改 JSON（容易多逗号）；上面写法不会写 BOM。

### 3.4 准备运行环境

```powershell
& $dst\scripts\setup.ps1
```

它会依次：检查 Node/Python/ffmpeg → 用清华源安装 `faster-whisper` → 下载 Whisper `small`
模型（约 460 MB，走 hf-mirror）→ 下载 `cloudflared`（约 53 MB，公网地址用）。
任何一步失败只降级对应能力，插件本身仍可用。可加 `-SkipModel` / `-SkipCloudflared` 跳过下载。

### 3.5 重启 DSH

---

## 4. 装好后怎么用

1. 在 DSH 里问：**「手机访问地址」**
   - 工具 `classroom_mobile_url` 返回公网 HTTPS 地址 + 6 位访问码
   - 例：`https://xxxx-xxxx.trycloudflare.com`，访问码 `123456`
2. 手机浏览器打开该地址 → 输入访问码 → 点「开始上课」→ 允许麦克风
3. 同一 WiFi 也可用局域网地址：`http://电脑IP:8765`（同样需要访问码）

数据全部在本机：

- 有 `D:\dsh-classroom-mobile` 目录 → `D:\dsh-classroom-mobile\data`
- 没有 → `%USERPROFILE%\.dsh\classroom-mobile\data`

手机只负责录音和显示，不保存业务数据，也不上传云端。

---

## 5. 验证是否装成功

| 检查 | 期望 |
|---|---|
| DSH 工具列表 | 出现 `classroom_mobile_url` / `classroom_mobile_digest` / `classroom_mobile_grade` / `classroom_mobile_focus` |
| 浏览器打开 `http://127.0.0.1:8765/api/state` | 返回 JSON，含 `"asrAvailable"` |
| DSH 日志 | `[dsh-classroom-mobile] 服务已启动：http://127.0.0.1:8765` |
| 问「手机访问地址」 | 返回 `https://xxx.trycloudflare.com` + 访问码 |

`asrAvailable: false` 不影响录音——页面会提示「转写引擎未就绪，可手动粘贴文字」。

---

## 6. 常见坑

1. **GitHub 打不开 / 克隆超时**：校园网常见，用 `ghfast.top` 镜像（3.1 节）或换网络。
2. **没装 Python**：`setup.ps1` 会红字提示；装 Python 3.9+ 并勾选 Add to PATH，然后重跑。
3. **没装 ffmpeg**：`winget install Gyan.FFmpeg`，然后重开终端、重启 DSH。
4. **第一次转写慢**：要下 460 MB 模型；之后每 30 秒音频约 10～40 秒出字（看 CPU）。
5. **杀毒软件拦 cloudflared**：允许即可；不允许只是没有公网地址，局域网仍可用。
6. **手机连不上**：排查顺序见 README「手机连接」——先本机 `127.0.0.1`，再局域网 IP，
   本机通、手机不通通常是 Windows 防火墙或校园网客户端隔离。
7. **不要公开隧道地址**：插件只有 6 位访问码，没有账号体系；地址只发给同学本人。

---

## 7. 卸载

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
$j = Get-Content $p -Raw | ConvertFrom-Json
$j.dsh.profile.bundles = @($j.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-classroom-mobile' })
[IO.File]::WriteAllText($p, ($j | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-classroom-mobile" -Recurse -Force
```

数据目录（`D:\dsh-classroom-mobile\data` 或 `~\.dsh\classroom-mobile\data`）不会自动删除，
需要的话手动删。
