// 公网隧道：用 cloudflared quick tunnel 把本机 8765 暴露成 https://xxx.trycloudflare.com
// 目的：手机用流量、在别处 WiFi 也能打开页面；HTTPS 让手机浏览器允许调用麦克风。
// 只用 node 内置模块；cloudflared 是独立可执行文件（bin/cloudflared.exe）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  CLOUDFLARED_EXE, TMP_DIR, TUNNEL_ENABLED, TUNNEL_MAX_RESTARTS, TUNNEL_PROTOCOL, TUNNEL_START_TIMEOUT_MS,
} from './config.js';

const URL_RE = /https:\/\/(?!api\.|update\.|www\.|developers\.|blog\.)[a-z0-9][a-z0-9-]*\.trycloudflare\.com/gi;

const state = {
  enabled: !!TUNNEL_ENABLED,
  status: TUNNEL_ENABLED ? 'idle' : 'disabled',
  url: '',
  error: '',
  updatedAt: '',
  restarts: 0,
  logFile: path.join(TMP_DIR, 'cloudflared.log'),
};

let child = null;
let pollTimer = null;
let restartTimer = null;
let startTimer = null;
let stopping = false;
let targetPort = 0;
let fd = null;

export function getTunnelState() {
  return { ...state, port: targetPort || null };
}

function setState(patch) {
  Object.assign(state, patch, { updatedAt: new Date().toISOString() });
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function readLogTail(file, maxBytes = 200000) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    const fh = fs.openSync(file, 'r');
    try {
      fs.readSync(fh, buf, 0, len, start);
    } finally {
      fs.closeSync(fh);
    }
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

// cloudflared 不在仓库里（55MB 二进制太大），第一次启动时自动下载；支持镜像，官方源在国内较慢
const CLOUDFLARED_URL_PATH = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const DOWNLOAD_MIRRORS = [
  process.env.DSH_CLASSROOM_CLOUDFLARED_MIRROR,
  `https://ghfast.top/${CLOUDFLARED_URL_PATH}`,
  `https://gh-proxy.com/${CLOUDFLARED_URL_PATH}`,
  CLOUDFLARED_URL_PATH,
].filter(Boolean);

async function ensureCloudflared() {
  if (fs.existsSync(CLOUDFLARED_EXE)) return;
  if (state.status === 'disabled') throw new Error('隧道已被 DSH_CLASSROOM_MOBILE_TUNNEL=0 关闭');
  setState({ status: 'starting', error: '首次启动：正在下载 cloudflared（约 55MB，可能需要几分钟）' });
  await fs.promises.mkdir(path.dirname(CLOUDFLARED_EXE), { recursive: true });
  const tmp = `${CLOUDFLARED_EXE}.download`;
  let lastErr = null;
  for (const url of DOWNLOAD_MIRRORS) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60 * 1000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 20 * 1024 * 1024) throw new Error(`文件太小（${buf.length} 字节）`);
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, CLOUDFLARED_EXE);
      setState({ error: '' });
      return;
    } catch (err) {
      lastErr = err;
      try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
    }
  }
  throw new Error(`下载失败：${lastErr ? lastErr.message : '未知错误'}（可手动下载后放到 ${CLOUDFLARED_EXE}）`);
}

function clearTimers() {  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (startTimer) { clearTimeout(startTimer); startTimer = null; }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
}

function closeFd() {
  if (fd !== null) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    fd = null;
  }
}

function killChild() {
  if (child) {
    try { child.kill(); } catch { /* ignore */ }
    child = null;
  }
}

function scheduleRestart() {
  if (stopping) return;
  if (state.restarts >= TUNNEL_MAX_RESTARTS) {
    setState({ status: 'error', error: `隧道多次失败（已重试 ${state.restarts} 次），可重启 DSH 再试` });
    return;
  }
  state.restarts += 1;
  const delay = Math.min(3000 * state.restarts, 20000);
  setState({ status: 'starting', error: `隧道断开，${Math.round(delay / 1000)} 秒后重试（第 ${state.restarts} 次）` });
  restartTimer = setTimeout(() => {
    restartTimer = null;
    spawnCloudflared();
  }, delay);
}

function spawnCloudflared() {
  if (stopping) return;
  if (!fs.existsSync(CLOUDFLARED_EXE)) {
    setState({ status: 'error', error: `找不到 cloudflared：${CLOUDFLARED_EXE}` });
    return;
  }
  clearTimers();
  killChild();
  closeFd();

  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(state.logFile, '');
    fd = fs.openSync(state.logFile, 'a');
  } catch (err) {
    setState({ status: 'error', error: `无法创建隧道日志：${err.message}` });
    return;
  }

  setState({ status: 'starting', error: '', url: '' });

  const args = [
    'tunnel',
    '--no-autoupdate',
    '--protocol', TUNNEL_PROTOCOL,
    '--url', `http://127.0.0.1:${targetPort}`,
  ];
  try {
    child = spawn(CLOUDFLARED_EXE, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', fd],
    });
  } catch (err) {
    setState({ status: 'error', error: `无法启动 cloudflared：${err.message}` });
    closeFd();
    scheduleRestart();
    return;
  }

  child.on('error', (err) => {
    setState({ status: 'error', error: `cloudflared 启动失败：${err.message}` });
  });

  child.on('exit', (code) => {
    child = null;
    closeFd();
    if (stopping) return;
    if (state.status === 'ready') {
      // 已就绪后又断开：重试
      scheduleRestart();
    } else {
      setState({ status: 'error', error: `cloudflared 退出（code=${code}）` });
      scheduleRestart();
    }
  });

  // 轮询日志找公网地址
  pollTimer = setInterval(() => {
    const text = stripAnsi(readLogTail(state.logFile));
    if (!text) return;
    const matches = text.match(URL_RE) || [];
    const url = matches.length ? matches[matches.length - 1] : '';
    if (url && url !== state.url) {
      setState({ status: 'ready', url, error: '' });
    }
  }, 500);

  startTimer = setTimeout(() => {
    startTimer = null;
    if (state.status !== 'ready') {
      setState({ status: 'error', error: `隧道 ${Math.round(TUNNEL_START_TIMEOUT_MS / 1000)} 秒内未就绪` });
      killChild();
      scheduleRestart();
    }
  }, TUNNEL_START_TIMEOUT_MS);
}

export function startTunnel(port) {
  targetPort = Number(port) || 0;
  if (!TUNNEL_ENABLED) {
    setState({ status: 'disabled', error: '已通过 DSH_CLASSROOM_MOBILE_TUNNEL=0 关闭' });
    return getTunnelState();
  }
  if (!targetPort) {
    setState({ status: 'error', error: 'HTTP 服务端口未知，无法建立隧道' });
    return getTunnelState();
  }
  stopping = false;
  state.restarts = 0;
  ensureCloudflared()
    .then(() => spawnCloudflared())
    .catch((err) => {
      setState({ status: 'error', error: `cloudflared 未就绪：${err.message}` });
    });
  return getTunnelState();
}

export function stopTunnel() {
  stopping = true;
  clearTimers();
  killChild();
  closeFd();
  setState({ status: 'stopped', url: '' });
}

// 等待隧道就绪：最多 timeoutMs，返回最终状态（失败也返回状态，不抛错）
export function waitTunnelReady(timeoutMs = 60000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const s = getTunnelState();
      if (s.status === 'ready' || s.status === 'error' || s.status === 'disabled' || s.status === 'stopped') {
        resolve(s);
        return;
      }
      if (Date.now() > deadline) {
        resolve({ ...s, timeout: true });
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}
