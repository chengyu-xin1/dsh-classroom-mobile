<#
  dsh-classroom-mobile 一键安装脚本（Windows）
  用途：从 GitHub 下载插件 → 装进 DSH profile → 注册 bundle → 准备 Python/模型/cloudflared。
  用法：
    双击 install.bat
    或 powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
  参数：
    -Profile desktop         DSH profile 名（默认 desktop）
    -ProfileDir <路径>       直接指定 profile 目录（一般不用）
    -ZipPath <路径>          用本地 ZIP，不联网下载
    -SkipSetup               只装插件，不装 Python/模型/cloudflared
    -Force                   覆盖已存在的插件目录（会先备份）
    -DryRun                  只打印计划，不写文件
#>
param(
  [string]$Profile = 'desktop',
  [string]$ProfileDir = '',
  [string]$ZipPath = '',
  [switch]$SkipSetup,
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-classroom-mobile'
$Repo = 'chengyu-xin1/dsh-classroom-mobile'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Say($msg) { Write-Host "[install] $msg" }
function Fail($msg) { Write-Host "[失败] $msg" -ForegroundColor Red; exit 1 }

# 1) 找 profile 目录
if (-not $ProfileDir) {
  $ProfileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
}
if (-not (Test-Path $ProfileDir)) {
  Fail "找不到 DSH profile：$ProfileDir（先启动一次 DSH，或检查 -Profile 名字）"
}
$pkgPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $pkgPath)) { Fail "profile 缺少 package.json：$pkgPath" }
$nodeModules = Join-Path $ProfileDir 'node_modules'
$dest = Join-Path $nodeModules $PluginName

Say "profile：$ProfileDir"
Say "目标目录：$dest"

# 2) 准备 ZIP（下载或本地）
$tmpRoot = Join-Path $env:TEMP "dsh-classroom-mobile-install-$Stamp"
$zip = $ZipPath
if (-not $zip) {
  $zip = Join-Path $env:TEMP "dsh-classroom-mobile-$Stamp.zip"
  $urls = @(
    "https://codeload.github.com/$Repo/zip/refs/heads/main",
    "https://ghfast.top/https://codeload.github.com/$Repo/zip/refs/heads/main"
  )
  $ok = $false
  foreach ($u in $urls) {
    try {
      Say "下载：$u"
      Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -TimeoutSec 900
      $len = (Get-Item $zip).Length
      if ($len -lt 50000) { throw "文件太小（$len 字节），可能下载失败" }
      Say "下载完成：$([math]::Round($len/1KB)) KB"
      $ok = $true
      break
    } catch {
      Say "这条源失败：$($_.Exception.Message)"
    }
  }
  if (-not $ok) {
    Fail "下载失败。请换网络/热点重试，或手动下载 ZIP 后用 -ZipPath 指定，或下载后解压手动安装。"
  }
} else {
  if (-not (Test-Path $zip)) { Fail "ZIP 不存在：$zip" }
  Say "使用本地 ZIP：$zip"
}

# 3) 解压并找到 package.json
Say "解压到：$tmpRoot"
if (-not $DryRun) {
  New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null
  Expand-Archive -Path $zip -DestinationPath $tmpRoot -Force
}
$srcDir = $null
if (-not $DryRun) {
  $found = Get-ChildItem -Path $tmpRoot -Recurse -Filter 'package.json' -File |
    Where-Object { (Get-Content $_.FullName -Raw) -match [regex]::Escape("`"name`": `"$PluginName`"") } |
    Select-Object -First 1
  if (-not $found) { Fail "ZIP 里没找到 $PluginName 的 package.json" }
  $srcDir = Split-Path $found.FullName -Parent
  Say "包目录：$srcDir"
}

if ($DryRun) {
  Say "【DryRun】将复制 $srcDir → $dest"
  Say "【DryRun】将把 `"$PluginName`" 加到 dsh.profile.bundles"
  if (-not $SkipSetup) { Say "【DryRun】将运行 scripts\setup.ps1" }
  exit 0
}

# 4) 备份并复制
if (-not (Test-Path $nodeModules)) { New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null }
if (Test-Path $dest) {
  if (-not $Force) {
    Fail "插件目录已存在：$dest。如果要覆盖重装，请加 -Force（会先备份）"
  }
  $bak = "$dest.bak-$Stamp"
  Say "备份旧版本 → $bak"
  Move-Item -Path $dest -Destination $bak -Force
}
Say "复制文件 → $dest"
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Copy-Item -Path (Join-Path $srcDir '*') -Destination $dest -Recurse -Force

# 5) 注册到 profile 的 bundles（先备份 package.json）
$node = (Get-Command node.exe -ErrorAction SilentlyContinue)
if (-not $node) { Fail "找不到 node.exe，请先安装 Node.js（>=20）再重跑" }
$bakPkg = "$pkgPath.bak-$Stamp"
Copy-Item $pkgPath $bakPkg -Force
Say "已备份 profile package.json → $bakPkg"

$patchJs = @'
const fs = require('fs');
const [file, name] = process.argv.slice(2);
const raw = fs.readFileSync(file, 'utf8');
const j = JSON.parse(raw);
j.dsh = j.dsh || {};
j.dsh.profile = j.dsh.profile || {};
const bundles = Array.isArray(j.dsh.profile.bundles) ? j.dsh.profile.bundles : [];
if (!bundles.includes(name)) {
  bundles.push(name);
  j.dsh.profile.bundles = bundles;
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8');
  console.log('ADDED');
} else {
  console.log('ALREADY');
}
'@
$patchFile = Join-Path $env:TEMP "dsh-add-bundle-$Stamp.js"
Set-Content -Path $patchFile -Value $patchJs -Encoding UTF8
$patchOut = & node.exe $patchFile $pkgPath $PluginName 2>&1
Say "bundle 注册：$patchOut"
if ($patchOut -notmatch 'ADDED|ALREADY') { Fail "写 bundles 失败：$patchOut" }

# 6) 准备运行环境（可选）
if (-not $SkipSetup) {
  $setup = Join-Path $dest 'scripts\setup.ps1'
  if (Test-Path $setup) {
    Say '开始准备 Python/ffmpeg/模型/cloudflared（首次可能要几分钟到十几分钟）'
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $setup
    if ($LASTEXITCODE -ne 0) { Say "setup.ps1 退出码 $LASTEXITCODE（可稍后手动重跑 $setup）" }
  } else {
    Say '没有找到 scripts\setup.ps1，跳过环境准备'
  }
}

Say ''
Say '=============================================='
Say ' 安装完成。下一步：'
Say ' 1. 完全退出并重新打开 DSH'
Say ' 2. 在对话里说：手机访问地址'
Say ' 3. 手机打开返回的 https 链接即可'
Say '=============================================='
