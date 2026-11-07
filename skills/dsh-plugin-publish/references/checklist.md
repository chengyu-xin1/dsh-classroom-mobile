# 上架检查清单（照着打勾）

## A. 发布前：插件本身

- [ ] `package.json` 的 `dsh.bundle.patch` 指向存在的 `cordis.patch.yml`
- [ ] `cordis.patch.yml` 内容正确（insert 的 id/name 与包名对应）
- [ ] `files` 覆盖 src/public/scripts/README/LICENSE/skills 等运行时文件
- [ ] `node --check` 所有 js 通过；`node -e "import('./src/index.js').then(m=>console.log(m.name))"` 能导入
- [ ] 有 `LICENSE`（MIT）与 `README.md`
- [ ] 有 `assets/icon-180.png`（可选，但市场卡片好看很多）
- [ ] 没有把 token、密码、本机绝对路径写进仓库

## B. GitHub 仓库

- [ ] 仓库公开，`created_at` 至少 24 小时前
- [ ] topics 含 `dsh-plugin`
- [ ] `README.md` 在 GitHub 上能打开（API contents 200）
- [ ] 抽查关键文件 sha 与本地一致：
  ```powershell
  node -e "fetch('https://api.github.com/repos/OWNER/REPO/contents/package.json').then(r=>r.json()).then(d=>console.log(d.sha,d.size))"
  ```

## C. 目录条目 PR

- [ ] 只新增 `data/plugins/<owner>__<repo>.yml`，没有改别的文件
- [ ] `url` 与仓库地址完全一致
- [ ] `category` 是合法枚举（tools / usage / ui / ...）
- [ ] `description.en` 是完整句子、结尾句号；`zh` 可选
- [ ] PR 标题清楚，body 说明「新增插件 + 满足条件」
- [ ] CI：`Submission gate` 与 `check` 均为 success
   - 若显示 `action_required`：等维护者批准 workflow，不是代码问题
- [ ] 合并前不要反复催；一条礼貌评论即可

## D. 合并后

- [ ] 目录快照 `https://awesome-dsh-plugin.com/plugins.json` 的 `updated` 变新
- [ ] 搜索插件名能命中（`count` 增加）
- [ ] DSH 插件市场刷新后能搜到，点「安装」成功
- [ ] 记录安装方式给用户：市场 / 一键脚本 / 手动

## 常见失败对照

| 现象 | 原因 | 处理 |
|---|---|---|
| CI: repository too new | 建仓不满 1 天 | 等满 24h 重跑 |
| CI: missing dsh.bundle | package.json 没有 bundle.patch | 补 `dsh.bundle` 并推新提交 |
| PR 一直 action_required | 首次贡献者需批准 workflow | 等维护者点 Approve |
| 市场搜不到 | 目录未重建 / PR 未合并 | 看 plugins.json 的 updated 与 PR 状态 |
| 下载 ZIP 内容旧 | codeload CDN 缓存 | 等 5 分钟，或核对 API sha |
| 双击 bat 被拦 | Windows 智能应用控制 | 解除锁定 ZIP，或直接跑 install.ps1 |
