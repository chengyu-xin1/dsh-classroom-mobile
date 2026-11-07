// 通用 cloudflared quick tunnel（零 npm 依赖，Node 20+，Windows / macOS / Linux）
//
// 用法：
//   import { createTunnel } from './tunnel.js';
//   const tunnel = createTunnel({ exe: './bin/cloudflared', port: 8765, logFile: '.tmp/cloudflared.log' });
//   tunnel.start();                       // 异步拉起 cloudflared，失败自动重试
//   await tunnel.waitReady(60000);        // { status:'ready', url:'https://xxx.trycloudflare.com' }
//   tunnel.getState();                    // { status, url, error, restarts }
//   tunnel.stop();                        // 卸载时调用
//
// 关键点（不要改）：
//   1) 用文件 fd 接住 stderr，不用管道 —— 很多沙箱禁止 spawn 管道（EPERM）。
//   2) 强制 --protocol http2 —— 校园网下 QUIC 慢到不可用。
//   3) 从日志里嗅探 trycloudflare URL，不解析 stdout。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 注意：日志里也会出现 API 域名（api.trycloudflare.com），必须排除；
// 真正的 quick tunnel 地址是随机单词组合，且通常出现在最新日志行，所以取最后一个匹配。
const URL_RE = /https:\/\/(?!api\.|update\.|www\.|developers\.|blog\.)[a-z0-9][a-z0-9-]*\.trycloudflare\.com/gi;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function createTunnel(options = {}) {
  const {
    exe,
    port,
    logFile = path.join(process.cwd(), 'cloudflared.log'),
    protocol = 'http2',
    maxRestarts = 10,
    startTimeoutMs = 60000,
    extraArgs = [],
    onReady = null,
  } = options;

  if (!exe) throw new Error('createTunnel: exe is required');
  if (!port) throw new Error('createTunnel: port is required');

  const state = {
    status: 'idle',      // idle | starting | ready | error | stopped | disabled
    url: '',
    error: '',
    restarts: 0,
    updatedAt: '',
  };

  let child = null;
  let fd = null;
  let pollTimer = null;
  let startTimer = null;
  let restartTimer = null;
  let stopped = false;

  const setState = (patch) => {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
  };

  function readLogTail(maxBytes = 200000) {
    try {
      const st = fs.statSync(logFile);
      const start = Math.max(0, st.size - maxBytes);
      const buf = Buffer.alloc(st.size - start);
      const fh = fs.openSync(logFile, 'r');
      try { fs.readSync(fh, buf, 0, buf.length, start); } finally { fs.closeSync(fh); }
      return buf.toString('utf8');
    } catch {
      return '';
    }
  }

  function closeFd() {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      fd = null;
    }
  }

  function killChild() {
    if (!child) return;
    try { child.kill(); } catch { /* ignore */ }
    child = null;
  }

  function clearTimers() {
    for (const t of [pollTimer, startTimer, restartTimer]) {
      if (t) clearTimeout(t);
    }
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    startTimer = null;
    restartTimer = null;
  }

  function scheduleRestart() {
    if (stopped) return;
    if (state.restarts >= maxRestarts) {
      setState({ status: 'error', error: `隧道多次失败（已重试 ${state.restarts} 次）` });
      return;
    }
    state.restarts += 1;
    const delay = Math.min(3000 * state.restarts, 20000);
    setState({ status: 'starting', error: `隧道断开，${Math.round(delay / 1000)} 秒后重试（第 ${state.restarts} 次）` });
    restartTimer = setTimeout(() => { restartTimer = null; spawnTunnel(); }, delay);
  }

  function spawnTunnel() {
    if (stopped) return;
    if (!fs.existsSync(exe)) {
      setState({ status: 'error', error: `找不到 cloudflared：${exe}` });
      return;
    }
    clearTimers();
    killChild();
    closeFd();

    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, '');
      fd = fs.openSync(logFile, 'a');
    } catch (err) {
      setState({ status: 'error', error: `无法创建隧道日志：${err.message}` });
      return;
    }

    setState({ status: 'starting', url: '', error: '' });

    const args = ['tunnel', '--no-autoupdate', '--protocol', protocol, '--url', `http://127.0.0.1:${port}`, ...extraArgs];
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'ignore', fd], windowsHide: true });
    } catch (err) {
      setState({ status: 'error', error: `无法启动 cloudflared：${err.message}` });
      closeFd();
      scheduleRestart();
      return;
    }

    child.on('error', (err) => setState({ status: 'error', error: `cloudflared 启动失败：${err.message}` }));
    child.on('exit', (code) => {
      child = null;
      closeFd();
      if (stopped) return;
      setState({ status: 'error', error: `cloudflared 退出（code=${code}）` });
      scheduleRestart();
    });

    pollTimer = setInterval(() => {
      const text = readLogTail().replace(ANSI_RE, '');
      if (!text) return;
      const matches = text.match(URL_RE) || [];
      const url = matches.length ? matches[matches.length - 1] : '';
      if (url && url !== state.url) {
        setState({ status: 'ready', url, error: '' });
        if (typeof onReady === 'function') {
          try { onReady(url); } catch { /* user callback must not break the tunnel */ }
        }
      }
    }, 500);

    startTimer = setTimeout(() => {
      startTimer = null;
      if (state.status !== 'ready') {
        setState({ status: 'error', error: `隧道 ${Math.round(startTimeoutMs / 1000)} 秒内未就绪` });
        killChild();
        scheduleRestart();
      }
    }, startTimeoutMs);
  }

  return {
    getState: () => ({ ...state }),
    start() {
      stopped = false;
      state.restarts = 0;
      spawnTunnel();
      return this.getState();
    },
    stop() {
      stopped = true;
      clearTimers();
      killChild();
      closeFd();
      setState({ status: 'stopped', url: '' });
    },
    waitReady(timeoutMs = 60000) {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
          const s = this.getState();
          if (['ready', 'error', 'stopped'].includes(s.status)) return resolve(s);
          if (Date.now() > deadline) return resolve({ ...s, timeout: true });
          setTimeout(tick, 500);
        };
        tick();
      });
    },
  };
}
