#requires -Version 5.1
<#
  dsh-classroom-mobile 一键环境准备（Windows）
  用法（在插件目录里）：
      powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
  可选参数：
      -SkipModel        不下载 Whisper small 模型（约 460 MB）
      -SkipCloudflared  不下载 cloudflared（没有它就没有公网地址，只保留局域网）
      -Model tiny|base|small|medium
  脚本只做检查/安装，不改系统网络设置、不改 hosts、不装服务。
#>
param(
  [switch]$SkipModel,
  [switch]$SkipCloudflared,
  [string]$Model = 'small',
  [string]$DataDir = ''
)

$ErrorActionPreference = 'Continue'
function Say($msg) { Write-Host $msg }
function Ok($msg) { Write-Host ("[ok]   " + $msg) -ForegroundColor Green }
function Warn($msg) { Write-Host ("[warn] " + $msg) -ForegroundColor Yellow }
function Bad($msg) { Write-Host ("[fail] " + $msg) -ForegroundColor Red }

$PkgRoot = Split-Path -Parent $PSScriptRoot
if (-not $DataDir) {
  if (Test-Path 'D:\dsh-classroom-mobile') { $DataDir = 'D:\dsh-classroom-mobile\data' }
  elseif ($env:DSH_CLASSROOM_MOBILE_DIR) { $DataDir = $env:DSH_CLASSROOM_MOBILE_DIR }
  else { $DataDir = Join-Path $env:USERPROFILE '.dsh\classroom-mobile\data' }
}
Say "插件目录：$PkgRoot"
Say "数据目录：$DataDir"
New-Item -ItemType Directory -Force $DataDir | Out-Null

# 1. Node
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $ver = (& node --version) -replace 'v', ''
  $major = [int]($ver.Split('.')[0])
  if ($major -ge 20) { Ok "Node $ver" } else { Warn "Node $ver 偏旧，建议 20+" }
} else { Bad '没找到 node（DSH 自带 node，通常不需要单独装）' }

# 2. Python + faster-whisper
$py = $null
foreach ($cand in @('python', 'python3', 'py')) {
  if (Get-Command $cand -ErrorAction SilentlyContinue) { $py = $cand; break }
}
if (-not $py) {
  Bad '没找到 Python 3。转写需要 python + faster-whisper，页面会降级为「可手动粘贴文字」'
} else {
  $pyver = (& $py -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null)
  Say "Python $pyver（$py）"
  $haveFw = (& $py -c "import faster_whisper,sys;print(faster_whisper.__version__)" 2>$null)
  if ($LASTEXITCODE -eq 0 -and $haveFw) {
    Ok "faster-whisper 已安装（$haveFw）"
  } else {
    Say '安装 faster-whisper（清华源，约 1～3 分钟）…'
    & $py -m pip install faster-whisper -i https://pypi.tuna.tsinghua.edu.cn/simple
    if ($LASTEXITCODE -eq 0) {
      $haveFw = (& $py -c "import faster_whisper;print(faster_whisper.__version__)" 2>$null)
      Ok "faster-whisper 安装完成（$haveFw）"
    } else {
      Bad 'faster-whisper 安装失败；插件仍可用，但转写会提示「引擎未就绪」'
    }
  }
}

# 3. ffmpeg
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
  $ff = (& ffmpeg -version 2>$null | Select-Object -First 1)
  Ok "ffmpeg 可用：$ff"
} else {
  Bad '没找到 ffmpeg：手机录音（webm/opus）无法转成 wav，转写会失败。装法：winget install Gyan.FFmpeg'
}

# 4. Whisper 模型
if (-not $SkipModel) {
  $modelDir = Join-Path $DataDir 'models'
  $modelFile = Get-ChildItem $modelDir -Recurse -Filter 'model.bin' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($modelFile) {
    Ok ("模型已存在：" + [math]::Round($modelFile.Length / 1MB, 1) + " MB → " + $modelFile.FullName)
  } elseif ($py) {
    Say "下载 Whisper $Model 模型（约 460 MB，走 hf-mirror 镜像）…"
    & $py (Join-Path $PkgRoot 'scripts\download_model.py') --model $Model --model-dir $modelDir
    if ($LASTEXITCODE -eq 0) { Ok '模型下载完成' } else { Warn '模型下载失败：页面仍能录音，转写会显示「此段待转写」' }
  } else {
    Warn '没有 Python，跳过模型下载'
  }
} else { Warn '按参数跳过模型下载' }

# 5. cloudflared（公网地址）
if (-not $SkipCloudflared) {
  $binDir = Join-Path $DataDir 'bin'
  $exe = Join-Path $binDir 'cloudflared.exe'
  New-Item -ItemType Directory -Force $binDir | Out-Null
  $okExe = $false
  if (Test-Path $exe) {
    $len = (Get-Item $exe).Length
    if ($len -gt 20000000) { Ok ("cloudflared 已存在：" + [math]::Round($len / 1MB, 1) + ' MB') ; $okExe = $true }
    else { Warn ("已有 cloudflared 但只有 $([math]::Round($len/1MB,1)) MB，判定不完整，重新下载") ; Remove-Item $exe -Force }
  }
  if (-not $okExe) {
    $target = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    $mirrors = @(
      ('https://ghfast.top/' + $target),
      ('https://gh-proxy.com/' + $target),
      $target
    )
    foreach ($u in $mirrors) {
      Say "下载 cloudflared：$u"
      try {
        Invoke-WebRequest -Uri $u -OutFile $exe -UseBasicParsing -TimeoutSec 900
        if ((Test-Path $exe) -and (Get-Item $exe).Length -gt 20000000) { Ok 'cloudflared 下载完成' ; $okExe = $true ; break }
      } catch { Warn ("失败：" + $_.Exception.Message) }
    }
    if (-not $okExe) { Warn 'cloudflared 全部源失败：不影响局域网/本机使用，只是没有公网地址' }
  }
} else { Warn '按参数跳过 cloudflared 下载' }

# 把插件自带的 skill 复制到 DSH 用户技能目录（DSH 只扫描这些目录，不扫描插件包内）
try {
  $skillSrc = Join-Path $PSScriptRoot '..\skills'
  $skillDst = Join-Path $env:USERPROFILE '.dsh\skills'
  if (Test-Path $skillSrc) {
    New-Item -ItemType Directory -Force -Path $skillDst | Out-Null
    Get-ChildItem $skillSrc -Directory | ForEach-Object {
      Copy-Item $_.FullName (Join-Path $skillDst $_.Name) -Recurse -Force
    }
    Ok ("已安装 skill 到 " + $skillDst)
  }
} catch { Warn ("skill 安装失败：" + $_.Exception.Message) }

Say ''
Say '================ 下一步 ================'
Say '1) 把插件装进 DSH（二选一）：'
Say '   A. 插件市场搜 dsh-classroom-mobile → 点安装（上架合并后可用）'
Say '   B. 手动：把目录复制到 ~\.dsh\profiles\desktop\node_modules\dsh-classroom-mobile，'
Say '      并在 profile 的 package.json 的 dsh.profile.bundles 末尾加 "dsh-classroom-mobile"'
Say '2) 重启 DSH'
Say '3) 在 DSH 里问「手机访问地址」→ 用手机打开返回的 https 地址，输入访问码'
Say ''
Say ('数据只写：' + $DataDir)
