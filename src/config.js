// 全局配置：所有路径与会话常量
// 本机默认数据目录 D:\dsh-classroom-mobile\data（用户硬约束：只写 D 盘业务数据）
// 换一台机器装（插件市场用户）时自动退回 ~/.dsh/classroom-mobile/data，可用环境变量覆盖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PKG_ROOT = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(PKG_ROOT, 'public');
export const SCRIPTS_DIR = path.join(PKG_ROOT, 'scripts');

const LEGACY_DATA_ROOT = 'D:\\dsh-classroom-mobile\\data';
function defaultDataRoot() {
  try {
    if (fs.existsSync('D:\\dsh-classroom-mobile')) return LEGACY_DATA_ROOT;
  } catch { /* ignore */ }
  return path.join(os.homedir(), '.dsh', 'classroom-mobile', 'data');
}

export const DATA_ROOT = process.env.DSH_CLASSROOM_MOBILE_DIR
  ? path.resolve(process.env.DSH_CLASSROOM_MOBILE_DIR)
  : defaultDataRoot();
export const SESSIONS_ROOT = path.join(DATA_ROOT, 'sessions');
export const CURRENT_FILE = path.join(DATA_ROOT, 'current.json');
export const MODELS_DIR = path.join(DATA_ROOT, 'models');
export const TMP_DIR = path.join(DATA_ROOT, '.tmp');

export const HOST = '0.0.0.0';
export const PORT_START = 8765;
export const PORT_END = 8774;

export const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
export const MAX_JSON_BYTES = 4 * 1024 * 1024;
// 每个录音分片的目标时长（页面按 30 秒切一片）
export const CHUNK_SECONDS = 30;
// 番茄钟：25 分钟一个
export const POMODORO_MINUTES = 25;

// 公网隧道（cloudflared quick tunnel）：手机用流量也能打开页面，HTTPS 才能调麦克风
// 二进制优先用环境变量 / 插件包内 bin/，都没有就下载到数据目录 bin/（不写 node_modules）
export const BIN_DIR = path.join(DATA_ROOT, 'bin');
const CLOUDFLARED_CANDIDATES = [
  process.env.DSH_CLASSROOM_CLOUDFLARED,
  path.join(PKG_ROOT, 'bin', 'cloudflared.exe'),
  path.join(BIN_DIR, 'cloudflared.exe'),
].filter(Boolean);
export const CLOUDFLARED_EXE = CLOUDFLARED_CANDIDATES.find((p) => {
  try { return fs.existsSync(p); } catch { return false; }
}) || path.join(BIN_DIR, 'cloudflared.exe');
export const TUNNEL_ENABLED = String(process.env.DSH_CLASSROOM_MOBILE_TUNNEL ?? '1') !== '0';
export const TUNNEL_MAX_RESTARTS = 10;
export const TUNNEL_START_TIMEOUT_MS = 60 * 1000;
// 隧道传输协议：默认 http2（走 TCP 443）。校园网常把 QUIC/UDP 限得很慢（实测 49KB 页面要 15s），
// 改用 http2 后同一页面约 0.8～2.4s。可用 DSH_CLASSROOM_TUNNEL_PROTOCOL=quic 改回。
export const TUNNEL_PROTOCOL = process.env.DSH_CLASSROOM_TUNNEL_PROTOCOL || 'http2';
// 访问码：非本机访问（手机/公网）需要带 6 位访问码，防止隧道地址被陌生人利用
export const ACCESS_FILE = path.join(DATA_ROOT, 'access.json');
// 访问码默认关闭：手机打开地址直接用，不需要输入。需要保护时设 DSH_CLASSROOM_PIN=1 打开。
export const PIN_REQUIRED = String(process.env.DSH_CLASSROOM_PIN ?? '0') !== '0';

export const PYTHON = process.env.DSH_CLASSROOM_PYTHON || 'python';
export const FFMPEG = process.env.DSH_CLASSROOM_FFMPEG || 'ffmpeg';
export const FFMPEG_TIMEOUT_MS = 60 * 1000;
export const PY_TIMEOUT_MS = 10 * 60 * 1000;
