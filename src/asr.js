// 转写流水线：ffmpeg 转 16k 单声道 wav -> python transcribe.py -> transcript.md
// 失败时如实写「[此段待转写]」，绝不伪造文字
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  MODELS_DIR, TMP_DIR, PYTHON, FFMPEG, FFMPEG_TIMEOUT_MS, PY_TIMEOUT_MS, SCRIPTS_DIR,
} from './config.js';
import {
  appendTranscript, appendTranscriptRaw, updateMeta, readMeta, sessionPaths, mmss, cleanText,
} from './store.js';

export const asrStatus = {
  available: false,
  checked: false,
  message: '正在检测转写引擎…',
  lastError: '',
};

let queueTail = Promise.resolve();
let queued = 0;

export function queueLength() {
  return queued;
}

// 用临时文件收集子进程输出（不使用 pipe：沙箱环境下 pipe 会 EPERM，且大输出更稳）
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const outFile = path.join(TMP_DIR, `run-${stamp}.out.txt`);
    const errFile = path.join(TMP_DIR, `run-${stamp}.err.txt`);
    let outFd;
    let errFd;
    try {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      outFd = fs.openSync(outFile, 'w');
      errFd = fs.openSync(errFile, 'w');
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: `[临时文件创建失败] ${err.message}` });
      return;
    }

    let settled = false;
    let timer = null;
    let child = null;

    const finish = async (code, extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { fs.closeSync(outFd); } catch { /* ignore */ }
      try { fs.closeSync(errFd); } catch { /* ignore */ }
      let stdout = '';
      let stderr = '';
      try { stdout = await fsp.readFile(outFile, 'utf8'); } catch { /* ignore */ }
      try { stderr = await fsp.readFile(errFile, 'utf8'); } catch { /* ignore */ }
      fsp.unlink(outFile).catch(() => {});
      fsp.unlink(errFile).catch(() => {});
      resolve({ code, stdout, stderr: `${stderr}${extra || ''}` });
    };

    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', outFd, errFd] });
    } catch (err) {
      finish(-1, `\n[无法启动] ${err.message}`);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(-1, `\n[超时] ${cmd} 超过 ${timeoutMs}ms`);
    }, timeoutMs);
    child.on('error', (err) => finish(-1, `\n[无法启动] ${err.message}`));
    child.on('close', (code) => finish(code));
  });
}

async function findModelFile() {
  async function walk(dir, depth) {
    if (depth > 5) return false;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === 'model.bin') {
        return true;
      }
      if (e.isDirectory() && (await walk(full, depth + 1))) return true;
    }
    return false;
  }
  return walk(MODELS_DIR, 0);
}

// 探测 python + faster_whisper 是否可用
export async function detectAsr() {
  const candidates = [...new Set([PYTHON, 'python', 'python3'].filter(Boolean))];
  for (const py of candidates) {
    const r = await run(py, ['-c', 'import faster_whisper,sys;print(faster_whisper.__version__)'], 45000);
    if (r.code === 0) {
      const version = (r.stdout || '').trim();
      const modelReady = await findModelFile();
      asrStatus.checked = true;
      asrStatus.available = true;
      asrStatus.python = py;
      asrStatus.version = version;
      asrStatus.modelReady = modelReady;
      asrStatus.message = modelReady
        ? `转写引擎就绪（faster-whisper ${version}，模型已就绪）`
        : `转写引擎就绪（faster-whisper ${version}），首次转写会下载 small 模型，可能较慢`;
      return asrStatus;
    }
  }
  asrStatus.checked = true;
  asrStatus.available = false;
  asrStatus.message = '转写引擎未就绪，可手动粘贴文字';
  asrStatus.lastError = 'python 无法 import faster_whisper';
  return asrStatus;
}

function parseJsonFromStdout(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && Array.isArray(obj.segments)) return obj;
    } catch {
      // 继续向上找
    }
  }
  try {
    const obj = JSON.parse(text);
    if (obj && Array.isArray(obj.segments)) return obj;
  } catch {
    // ignore
  }
  return null;
}

// 处理一个分片：ffmpeg -> python -> transcript.md
// chunk: meta.json 中的 { index, file, size }
export async function processChunk(session, chunk) {
  const p = sessionPaths(session.dir);
  const src = path.join(p.audio, chunk.file);
  let meta = (await readMeta(session)) || {};
  const offset = Number(meta.transcriptOffsetSec) || 0;
  const entry = (meta.chunks || []).find((c) => c.index === chunk.index) || {};

  // 分片元数据标 pending
  await patchChunk(session, chunk.index, { status: 'processing' });

  if (!asrStatus.available) {
    await appendTranscriptRaw(session, `[${mmss(offset)}] [此段待转写]（转写引擎未就绪）`);
    await patchChunk(session, chunk.index, { status: 'failed', offsetSec: offset, durationSec: 0 });
    await updateMeta(session, { transcriptOffsetSec: offset });
    return { ok: false, reason: 'asr_unavailable' };
  }

  const wav = path.join(TMP_DIR, `chunk-${chunk.index}-${Date.now()}.wav`);
  const ff = await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
  ], FFMPEG_TIMEOUT_MS);

  if (ff.code !== 0) {
    await safeUnlink(wav);
    // 太小的尾巴分片（几乎没录到内容）不算失败，静默忽略，避免污染转写
    if (Number(entry.size || chunk.size || 0) < 1500) {
      await patchChunk(session, chunk.index, { status: 'empty', offsetSec: offset, durationSec: 0 });
      return { ok: false, reason: 'empty_chunk' };
    }
    await appendTranscriptRaw(session, `[${mmss(offset)}] [此段待转写]（音频无法解码：${shortErr(ff.stderr)}）`);
    await patchChunk(session, chunk.index, { status: 'failed', offsetSec: offset, durationSec: 0, error: shortErr(ff.stderr) });
    await updateMeta(session, { transcriptOffsetSec: offset });
    return { ok: false, reason: 'ffmpeg_failed' };
  }

  const py = asrStatus.python || PYTHON;
  const script = path.join(SCRIPTS_DIR, 'transcribe.py');
  const pr = await run(py, [
    script, wav, '--offset', String(offset), '--model-dir', MODELS_DIR,
  ], PY_TIMEOUT_MS);

  await safeUnlink(wav);

  const result = parseJsonFromStdout(pr.stdout);
  if (pr.code !== 0 || !result) {
    const err = shortErr(pr.stderr || pr.stdout || 'python 退出码异常');
    await appendTranscriptRaw(session, `[${mmss(offset)}] [此段待转写]（转写失败：${err}）`);
    await patchChunk(session, chunk.index, { status: 'failed', offsetSec: offset, durationSec: 0, error: err });
    await updateMeta(session, { transcriptOffsetSec: offset });
    // 模块/模型级错误视为引擎不可用，页面提示手动粘贴
    if (/No module named|faster_whisper|Repository Not Found|model\.bin|无法下载|CUDA|下载模型/i.test(pr.stderr || '')) {
      asrStatus.available = false;
      asrStatus.message = '转写引擎未就绪，可手动粘贴文字';
      asrStatus.lastError = err;
    }
    return { ok: false, reason: 'python_failed', error: err };
  }

  const duration = Number(result.duration) || 0;
  const segments = Array.isArray(result.segments) ? result.segments : [];
  let wrote = 0;
  for (const seg of segments) {
    const text = cleanText(seg.text);
    if (!text) continue;
    const t = offset + (Number(seg.start) || 0);
    await appendTranscript(session, t, text);
    wrote += 1;
  }
  if (!wrote) {
    await appendTranscriptRaw(session, `[${mmss(offset)}] [此段未识别到语音]`);
  }
  const nextOffset = offset + duration;
  await patchChunk(session, chunk.index, {
    status: 'done',
    offsetSec: offset,
    durationSec: duration,
    segments: wrote,
  });
  await updateMeta(session, { transcriptOffsetSec: nextOffset });
  return { ok: true, segments: wrote, duration, offsetSec: offset };
}

async function patchChunk(session, index, patch) {
  const meta = (await readMeta(session)) || {};
  meta.chunks = Array.isArray(meta.chunks) ? meta.chunks : [];
  const i = meta.chunks.findIndex((c) => c.index === index);
  if (i >= 0) meta.chunks[i] = { ...meta.chunks[i], ...patch };
  else meta.chunks.push({ index, ...patch });
  await updateMeta(session, { chunks: meta.chunks });
}

function shortErr(s) {
  return String(s || '未知错误')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

async function safeUnlink(f) {
  try { await fsp.unlink(f); } catch { /* ignore */ }
}

// 串行队列：分片依次转写，避免 CPU 抢占
export function enqueueChunk(session, chunk) {
  queued += 1;
  const task = queueTail
    .then(() => processChunk(session, chunk))
    .catch((err) => ({ ok: false, reason: 'exception', error: String((err && err.message) || err) }))
    .finally(() => { queued = Math.max(0, queued - 1); });
  queueTail = task.then(() => undefined);
  return task;
}
