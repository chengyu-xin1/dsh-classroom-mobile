// HTTP 服务：单文件手机页面 + JSON API
import http from 'node:http';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import {
  HOST, PORT_START, PORT_END, PUBLIC_DIR, MAX_AUDIO_BYTES, MAX_JSON_BYTES, PIN_REQUIRED,
} from './config.js';
import * as store from './store.js';
import { asrStatus, detectAsr, enqueueChunk, queueLength } from './asr.js';
import { getTunnelState } from './tunnel.js';

const EXT_BY_TYPE = [
  [/webm/i, '.webm'],
  [/ogg/i, '.ogg'],
  [/mp4|m4a|aac/i, '.m4a'],
  [/mpeg|mp3/i, '.mp3'],
  [/wav/i, '.wav'],
];

function extFor(contentType) {
  for (const [re, ext] of EXT_BY_TYPE) {
    if (re.test(contentType || '')) return ext;
  }
  return '.webm';
}

const AUDIO_EXTS = new Set(['.webm', '.ogg', '.oga', '.m4a', '.mp3', '.wav', '.mp4', '.aac', '.flac', '.opus']);

// 上传文件名只用于记录与显示：去掉路径、控制字符，限制长度
function cleanUploadName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '-')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim()
    .slice(0, 120);
}

function safeSlug(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  const slug = base.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'audio';
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, error, message) {
  sendJSON(res, status, { ok: false, error, message });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSONBody(req) {
  const buf = await readBody(req, MAX_JSON_BYTES);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'bad_json' });
  }
}

// /api/state 的完整快照
export async function buildState() {
  const session = await store.getCurrentSession();
  const base = {
    ok: true,
    session: null,
    recording: false,
    durationSec: 0,
    pendingWrong: 0,
    questionCount: 0,
    answeredCount: 0,
    asrAvailable: !!(asrStatus.checked && asrStatus.available),
    asrMessage: asrStatus.message,
    asrQueue: queueLength(),
    chunkCount: 0,
    pendingTranscribed: 0,
  };
  if (!session) return base;

  const meta = (await store.readMeta(session)) || {};
  const rec = meta.recording || {};
  const startMs = rec.startedAt ? Date.parse(rec.startedAt) : null;
  const stopMs = rec.stoppedAt ? Date.parse(rec.stoppedAt) : null;
  const recording = !!startMs && !stopMs;
  let durationSec = 0;
  if (startMs && recording) durationSec = Math.round((Date.now() - startMs) / 1000);
  else if (startMs && stopMs) durationSec = Math.max(0, Math.round((stopMs - startMs) / 1000));

  const rows = await store.readQuiz(session);
  const pending = store.pendingWrong(rows);
  const questions = store.questionsWithState(rows);
  const chunks = Array.isArray(meta.chunks) ? meta.chunks : [];

  return {
    ...base,
    session: {
      title: session.title,
      dir: session.dir,
      dirName: session.dirName,
      date: session.date,
      createdAt: session.createdAt,
    },
    recording,
    durationSec,
    pendingWrong: pending.length,
    questionCount: questions.length,
    answeredCount: questions.filter((q) => q.answered).length,
    pendingTranscribed: chunks.filter((c) => c.status === 'pending' || c.status === 'processing').length,
    chunkCount: chunks.length,
  };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Classroom-Pin',
    });
    res.end();
    return;
  }

  // 页面
  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    let html;
    try {
      html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    } catch {
      sendError(res, 500, 'page_missing', '页面文件 public/index.html 不存在，请检查插件安装');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }

  if (method === 'GET' && p === '/favicon.ico') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  // PWA：主屏幕图标 / 全屏打开
  if (method === 'GET' && p === '/manifest.webmanifest') {
    const manifest = {
      name: '课堂学习',
      short_name: '课堂学习',
      description: '手机录音 → 转写 → 总结/导图/题目',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f2f5fa',
      theme_color: '#1f3a8a',
      lang: 'zh-CN',
      icons: [
        { src: '/icon-180.png', sizes: '180x180', type: 'image/png' },
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      ],
    };
    const body = JSON.stringify(manifest);
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (method === 'GET' && p === '/sw.js') {
    try {
      const js = await fsp.readFile(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/',
        'Content-Length': Buffer.byteLength(js),
      });
      res.end(js);
    } catch {
      sendError(res, 404, 'not_found', 'sw.js 不存在');
    }
    return;
  }

  if (method === 'GET' && /^\/icon-(180|192|512)\.png$/.test(p)) {
    try {
      const buf = await fsp.readFile(path.join(PUBLIC_DIR, path.basename(p)));
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': buf.length,
      });
      res.end(buf);
    } catch {
      sendError(res, 404, 'not_found', '图标不存在');
    }
    return;
  }

  if (method === 'GET' && p === '/api/health') {
    sendJSON(res, 200, { ok: true, up: true, port: handle.port || null, time: new Date().toISOString() });
    return;
  }

  // 非本机访问（手机 / 公网隧道）需要 6 位访问码，防止地址外泄后被陌生人使用。
  // 注意：cloudflared 在电脑本机转发，socket 会显示 127.0.0.1，因此同时检查
  // Cloudflare 加的 cf-connecting-ip / cf-ray / x-forwarded-for 头来判断是否走公网。
  // 访问码默认关闭（PIN_REQUIRED=false），手机打开地址直接用；
  // 需要保护时设环境变量 DSH_CLASSROOM_PIN=1，非本机/公网请求才要求 6 位码。
  const remote = req.socket.remoteAddress || '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const viaProxy = Boolean(
    req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for'],
  );
  if (PIN_REQUIRED && (!loopback || viaProxy) && p.startsWith('/api/')) {
    const given = String(req.headers['x-classroom-pin'] || url.searchParams.get('pin') || '');
    const pin = await store.ensureAccessPin();
    if (given !== pin) {
      sendError(res, 401, 'pin_required', '需要 6 位访问码（在电脑上问我「手机访问码是多少」）');
      return;
    }
  }

  if (method === 'GET' && p === '/api/state') {
    const state = await buildState();
    sendJSON(res, 200, {
      ...state, port: handle.port || null, pinRequired: PIN_REQUIRED, tunnel: getTunnelState(),
    });
    return;
  }

  if (method === 'POST' && p === '/api/session/start') {
    const body = await readJSONBody(req);
    const title = String(body.title || '').trim();
    if (!title) {
      sendError(res, 400, 'title_required', '请先填写课程标题');
      return;
    }
    const current = await store.getCurrentSession();
    if (current) {
      const rows = await store.readQuiz(current);
      const pending = store.pendingWrong(rows);
      if (pending.length) {
        sendJSON(res, 409, {
          ok: false,
          error: 'wrong_questions_pending',
          message: `还有 ${pending.length} 道错题未改正，先复习`,
          pending,
        });
        return;
      }
    }
    const created = await store.createSession(title);
    sendJSON(res, 200, {
      ok: true,
      reused: created.reused,
      session: {
        title: created.session.title,
        dir: created.session.dir,
        dirName: created.session.dirName,
        date: created.session.date,
        createdAt: created.session.createdAt,
      },
      state: await buildState(),
    });
    return;
  }

  if (method === 'POST' && p === '/api/audio') {
    const session = await store.getCurrentSession();
    if (!session) {
      sendError(res, 409, 'no_session', '还没有开始上课，请先新建会话');
      return;
    }
    let buf;
    try {
      buf = await readBody(req, MAX_AUDIO_BYTES);
    } catch (err) {
      if (err.code === 'too_large') sendError(res, 413, 'too_large', '音频分片超过 40MB，请缩短分片');
      else sendError(res, 400, 'bad_body', '音频上传失败');
      return;
    }
    if (!buf.length) {
      sendError(res, 400, 'empty_audio', '音频分片为空');
      return;
    }
    const pth = store.sessionPaths(session.dir);
    await fsp.mkdir(pth.audio, { recursive: true });
    const meta = (await store.readMeta(session)) || {};
    const chunks = Array.isArray(meta.chunks) ? meta.chunks : [];
    const index = chunks.length;
    const rawName = String(req.headers['x-file-name'] || '');
    let originalName = '';
    try { originalName = rawName ? decodeURIComponent(rawName) : ''; } catch { originalName = rawName; }
    originalName = cleanUploadName(originalName);
    const isUpload = Boolean(originalName);
    let ext = extFor(req.headers['content-type']);
    if (isUpload) {
      const nameExt = path.extname(originalName).toLowerCase();
      if (AUDIO_EXTS.has(nameExt)) ext = nameExt;
    }
    const file = isUpload
      ? `upload-${String(index).padStart(3, '0')}-${safeSlug(originalName)}${ext}`
      : `chunk-${String(index).padStart(3, '0')}${ext}`;
    await fsp.writeFile(path.join(pth.audio, file), buf);

    const now = new Date().toISOString();
    chunks.push({
      index,
      file,
      size: buf.length,
      contentType: req.headers['content-type'] || '',
      uploadedAt: now,
      status: 'pending',
      offsetSec: 0,
      durationSec: 0,
      kind: isUpload ? 'upload' : 'chunk',
      originalName: originalName || undefined,
    });
    const rec = meta.recording || {};
    await store.updateMeta(session, {
      chunks,
      recording: {
        startedAt: rec.startedAt || now,
        stoppedAt: null,
      },
    });

    const fresh = await store.getCurrentSession();
    enqueueChunk(fresh || session, { index, file, size: buf.length });
    sendJSON(res, 200, {
      ok: true, chunk: index, file, size: buf.length, queued: true, uploaded: isUpload,
      originalName: originalName || undefined,
    });
    return;
  }

  if (method === 'GET' && p === '/api/live') {
    const session = await store.getCurrentSession();
    if (!session) {
      sendJSON(res, 200, {
        ok: true, asrAvailable: !!(asrStatus.checked && asrStatus.available),
        asrMessage: asrStatus.message, segments: [], lastText: '', pending: 0,
      });
      return;
    }
    const text = await store.readTranscript(session);
    const all = store.parseTranscript(text);
    const rows = await store.readQuiz(session);
    const meta = (await store.readMeta(session)) || {};
    const chunks = Array.isArray(meta.chunks) ? meta.chunks : [];
    sendJSON(res, 200, {
      ok: true,
      asrAvailable: !!(asrStatus.checked && asrStatus.available),
      asrMessage: asrStatus.message,
      segments: all.slice(-5),
      lastText: all.length ? all[all.length - 1].text : '',
      pending: chunks.filter((c) => c.status === 'pending' || c.status === 'processing').length,
      pendingWrong: store.pendingWrong(rows).length,
    });
    return;
  }

  if (method === 'GET' && p === '/api/summary') {
    const session = await store.getCurrentSession();
    const empty = {
      ok: true, title: null, summary: '', mindmap: '', keypoints: '', mindmapType: 'mindmap',
      summaryUpdatedAt: null, mindmapUpdatedAt: null, keypointsUpdatedAt: null,
    };
    if (!session) {
      sendJSON(res, 200, empty);
      return;
    }
    const pth = store.sessionPaths(session.dir);
    let summary = '';
    let mindmap = '';
    let keypoints = '';
    let summaryUpdatedAt = null;
    let mindmapUpdatedAt = null;
    let keypointsUpdatedAt = null;
    try {
      summary = await fsp.readFile(pth.summary, 'utf8');
      summaryUpdatedAt = (await fsp.stat(pth.summary)).mtime.toISOString();
    } catch { /* 文件不存在 */ }
    try {
      mindmap = await fsp.readFile(pth.mindmap, 'utf8');
      mindmapUpdatedAt = (await fsp.stat(pth.mindmap)).mtime.toISOString();
    } catch { /* 文件不存在 */ }
    try {
      keypoints = await fsp.readFile(pth.keypoints, 'utf8');
      keypointsUpdatedAt = (await fsp.stat(pth.keypoints)).mtime.toISOString();
    } catch { /* 文件不存在 */ }
    const m = mindmap.match(/^\s*%%\s*type\s*:\s*([a-z]+)/i);
    const mindmapType = m ? m[1].toLowerCase() : 'mindmap';
    sendJSON(res, 200, {
      ok: true, title: session.title, summary, mindmap, keypoints, mindmapType,
      summaryUpdatedAt, mindmapUpdatedAt, keypointsUpdatedAt,
    });
    return;
  }

  if (method === 'POST' && p === '/api/quiz/answer') {
    const session = await store.getCurrentSession();
    if (!session) {
      sendError(res, 409, 'no_session', '还没有开始上课');
      return;
    }
    const body = await readJSONBody(req);
    if (body.index === undefined || body.index === null) {
      sendError(res, 400, 'index_required', '缺少题号 index');
      return;
    }
    const answer = String(body.answer || '').trim();
    if (!answer) {
      sendError(res, 400, 'answer_required', '请先写下你的答案');
      return;
    }
    const q = await store.appendAnswer(session, body.index, answer);
    if (!q) {
      sendError(res, 404, 'question_not_found', `没有找到第 ${body.index} 题`);
      return;
    }
    const rows = await store.readQuiz(session);
    sendJSON(res, 200, { ok: true, index: q.index, pending: store.pendingWrong(rows).length });
    return;
  }

  if (method === 'GET' && p === '/api/quiz/pending') {
    const session = await store.getCurrentSession();
    if (!session) {
      sendJSON(res, 200, { ok: true, pending: [], count: 0 });
      return;
    }
    const rows = await store.readQuiz(session);
    const pending = store.pendingWrong(rows);
    sendJSON(res, 200, { ok: true, pending, count: pending.length });
    return;
  }

  if (method === 'GET' && p === '/api/quiz/questions') {
    const session = await store.getCurrentSession();
    if (!session) {
      sendJSON(res, 200, { ok: true, questions: [] });
      return;
    }
    const rows = await store.readQuiz(session);
    sendJSON(res, 200, { ok: true, questions: store.questionsWithState(rows) });
    return;
  }

  if (method === 'POST' && p === '/api/focus/event') {
    const session = await store.getCurrentSession();
    if (!session) {
      sendError(res, 409, 'no_session', '还没有开始上课');
      return;
    }
    const body = await readJSONBody(req);
    const type = String(body.type || '');
    if (!['start', 'leave', 'return', 'stop'].includes(type)) {
      sendError(res, 400, 'bad_event', '未知的专注事件');
      return;
    }
    const meta = (await store.readMeta(session)) || {};
    const rec = meta.recording || {};
    const now = new Date().toISOString();
    if (type === 'start') {
      await store.updateMeta(session, { recording: { startedAt: now, stoppedAt: null } });
    } else if (type === 'stop') {
      await store.updateMeta(session, {
        recording: { startedAt: rec.startedAt || now, stoppedAt: rec.stoppedAt || now },
      });
    }
    const fresh = (await store.getCurrentSession()) || session;
    await store.appendFocus(fresh, type);
    const state = await buildState();
    sendJSON(res, 200, { ok: true, type, recording: state.recording, durationSec: state.durationSec });
    return;
  }

  if (method === 'POST' && p === '/api/transcript/manual') {
    const session = await store.getCurrentSession();
    if (!session) {
      sendError(res, 409, 'no_session', '还没有开始上课');
      return;
    }
    const body = await readJSONBody(req);
    const text = store.cleanText(body.text);
    if (!text) {
      sendError(res, 400, 'text_required', '粘贴内容为空');
      return;
    }
    const meta = (await store.readMeta(session)) || {};
    const offset = Number(meta.transcriptOffsetSec) || 0;
    await store.appendTranscript(session, offset, `[手动] ${text}`);
    sendJSON(res, 200, { ok: true, appended: true, chars: text.length, offsetSec: offset });
    return;
  }

  if (p.startsWith('/api/')) {
    sendError(res, 404, 'not_found', `没有这个接口：${p}`);
    return;
  }
  sendError(res, 404, 'not_found', '没有这个页面');
}

export function createClassroomServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      sendError(res, 500, 'internal_error', `服务内部错误：${(err && err.message) || err}`);
    });
  });

  const handleRef = handle;

  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, HOST);
    });
  }

  return {
    server,
    port: null,
    async start() {
      let lastErr = null;
      for (let port = PORT_START; port <= PORT_END; port += 1) {
        try {
          const bound = await listenOn(port);
          this.port = bound;
          handleRef.port = bound;
          return bound;
        } catch (err) {
          lastErr = err;
          if (err && err.code === 'EADDRINUSE') continue;
          throw err;
        }
      }
      throw lastErr || new Error('没有可用端口');
    },
    async stop() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        // 手机浏览器会保持 keep-alive 连接；不主动断开的话 close() 会一直等，导致插件卸载卡住
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
      this.port = null;
    },
  };
}

export async function startClassroomServer() {
  const inst = createClassroomServer();
  const port = await inst.start();
  detectAsr().catch(() => { /* 探测失败由 asrStatus 反映 */ });
  return { instance: inst, port };
}

export { handle as handleRequest };
