---
name: dsh-plugin-publish
description: 把一个写好的 DSH 插件发布到 GitHub，并提交到官方插件市场（awesome-dsh-plugin 目录仓库）走完 PR 审核的流程。当用户说「把插件上架市场」「发布插件」「提交到插件市场」「别人怎么在 DSH 里搜到我的插件」，或需要检查上架条件（package.json 的 dsh.bundle、仓库年龄、topic、目录 yml 格式、CI 状态）时使用。全程用 GitHub REST API，不需要 github.com 网页和 git push。
version: 1.0.0
compatibility: 需要 Node.js 20+；需要 GitHub token（权限 public_repo）；插件本身须是 cordis 插件并声明 dsh.bundle。
allowed-tools: Bash, Read, Write, Edit
---

# 把 DSH 插件发布到官方市场（可重复执行的上架流程）

> 一句话：**先把插件仓库发布到 GitHub 并满足硬条件，再往目录仓库提一个 yml PR，等维护者合并。** 合并前市场里搜不到，这是正常的。

## 0. 先确认硬条件（缺一条都会被 CI 拒）

- [ ] 仓库根 `package.json` 有 `dsh.bundle.patch`（指向 `cordis.patch.yml`），**只有 `dsh.client` 会被拒**
- [ ] 有真实可运行的代码（不是纯聚合包、不是空壳）
- [ ] 仓库**创建满 1 天**（CI 自动检查，刚建仓当天交 PR 必失败）
- [ ] 仓库加了 topic `dsh-plugin`
- [ ] 有 `LICENSE`（MIT 即可）、`README.md`（描述属实、不带营销词）
- [ ] 分类选合法枚举之一：`agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun`
- [ ] 可选：`assets/icon-180.png`（GitHub 托管的位图），目录里才显示图标

## 1. 准备 package.json 的最小发布信息

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "dsh": {
    "engines": { "dsh": ">=0.1.0-rc.6 <0.4.0" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "manifestVersion": 1
  },
  "peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.1.0" },
  "files": ["src", "public", "scripts", "cordis.patch.yml", "README.md", "LICENSE"]
}
```

- `files` 必须覆盖运行时需要的全部文件；漏了会在别人机器上缺文件。
- 检查：`node -e "const j=require('./package.json');console.log(j.name, j.dsh.bundle)"`。

## 2. 建仓库并上传（REST API，不依赖 github.com 网页）

1. 让用户提供 GitHub 用户名 + token（`public_repo` 即可），放进环境变量：
   ```powershell
   $env:GITHUB_TOKEN='...'; $env:GITHUB_USER='...'
   ```
2. 用脚本或手写 REST 调用：
   - `POST https://api.github.com/user/repos` body `{name, private:false, description}`
   - 每个文件 `PUT /repos/{owner}/{repo}/contents/{path}`（内容 base64；已存在则带 `sha` 更新）
   - topics：`PUT /repos/{owner}/{repo}/topics` body `{names:[...]}`（必须含 `dsh-plugin`）
3. 本机已有 `scripts/publish-github.mjs` 可直接改 FILES 清单复用；`--dry` 先演练。

> 校园网常见：`github.com` 网页被拦，但 `api.github.com` 可用 → **全部走 API**；读文件可走 `https://ghfast.top/https://github.com/...` 代理。

## 3. 往目录仓库提 PR（只改一个文件）

1. fork `awesome-dsh-plugin/awesome-dsh-plugin`（API：`POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/forks`，等几秒）。
2. 新建 `data/plugins/<owner>__<repo>.yml`：

```yaml
url: https://github.com/<owner>/<repo>
name: <owner>/<repo>
category: tools
description:
  en: One-line description ending with a period.
  zh: 一句话中文描述。
icon: https://raw.githubusercontent.com/<owner>/<repo>/main/assets/icon-180.png
```

3. 开 PR：`POST /repos/.../pulls` body `{title, head:"<owner>:main", base:"main", body}`。
4. 查状态：PR 的 `mergeable`、`check-runs`（`Submission gate`、`check`）、`comments`。

## 4. 等合并与市场刷新

- 首次给目录仓库提 PR 的账号，GitHub 会要求**维护者批准 workflow**，CI 才会跑（`action_required` 不是失败）。
- CI 绿了不等于合并；合并是维护者人工审。**不要催得太频**，一条礼貌评论足够。
- 合并后目录按天重建（`https://awesome-dsh-plugin.com/plugins.json` 的 `updated` 字段），刷新后市场里才能搜到并点安装。

## 5. 真实坑（都踩过）

- 仓库不满 1 天 → CI 报年龄不足；等满 24h 再推一次 PR 或重跑。
- 下载 ZIP 走 codeload 有 CDN 缓存，刚推完马上下的可能是旧内容；等 5 分钟或核对文件 sha。
- 下载的 `.bat` 被 Windows 智能应用控制拦截 → 右键 ZIP「解除锁定」再解压，或改用 `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`。
- 目录 yml 里的 `url` 必须和真实仓库完全一致；PR 不要顺手改其他条目。
- 不要在 `data/` 里手改 README/star 等生成文件；README 由 `scripts/generate-readme.mjs` 生成。

## 6. 验收（真实可查）

```powershell
# 仓库可访问 + 关键字段
curl.exe -s https://api.github.com/repos/<owner>/<repo>
# 目录条目（合并后）
curl.exe -s https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/data/plugins/<owner>__<repo>.yml
# PR 与 CI
curl.exe -s https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls/<n>
```

最后给用户一句实话：**合并前市场搜不到；这期间用一键安装脚本 / 手动安装，功能不受影响。**
