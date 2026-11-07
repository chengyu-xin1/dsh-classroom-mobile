// 数据读写：会话、转写、题目、专注事件
// 不依赖任何 npm 包，只用 node 内置模块
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DATA_ROOT, SESSIONS_ROOT, CURRENT_FILE, MODELS_DIR, TMP_DIR, ACCESS_FILE,
} from './config.js';

export const isoNow = () => new Date().toISOString();

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function mmss(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

export async function ensureDirs() {
  for (const d of [DATA_ROOT, SESSIONS_ROOT, MODELS_DIR, TMP_DIR]) {
    await fsp.mkdir(d, { recursive: true });
  }
}

// 访问码：手机/公网访问需要它。存在 data/access.json，固定 6 位数字。
export async function ensureAccessPin() {
  await ensureDirs();
  const cur = await readJSON(ACCESS_FILE, null);
  if (cur && typeof cur.pin === 'string' && /^\d{6}$/.test(cur.pin)) return cur.pin;
  const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await writeJSON(ACCESS_FILE, { pin, createdAt: isoNow() });
  return pin;
}

export async function readAccessPin() {
  const cur = await readJSON(ACCESS_FILE, null);
  return cur && typeof cur.pin === 'string' ? cur.pin : '';
}

// 标题 -> 目录安全片段；保留中文，替换非法字符
export function sanitizeTitle(title) {
  const t = String(title || '').trim();
  const cleaned = t
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (cleaned || '未命名课堂').slice(0, 30);
}

export async function readJSON(file, fallback) {
  try {
    const txt = await fsp.readFile(file, 'utf8');
    if (!txt.trim()) return fallback;
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

// 原子写：先写 .tmp 再 rename，避免半截文件
export async function writeJSON(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

export async function appendLine(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(obj)}\n`, 'utf8');
}

export async function readLines(file) {
  try {
    const txt = await fsp.readFile(file, 'utf8');
    return txt.split(/\r?\n/).filter((l) => l.trim());
  } catch {
    return [];
  }
}

export function sessionPaths(dir) {
  return {
    dir,
    meta: path.join(dir, 'meta.json'),
    audio: path.join(dir, 'audio'),
    transcript: path.join(dir, 'transcript.md'),
    summary: path.join(dir, 'summary.md'),
    mindmap: path.join(dir, 'mindmap.md'),
    keypoints: path.join(dir, 'keypoints.md'),
    quiz: path.join(dir, 'quiz.jsonl'),
    focus: path.join(dir, 'focus.jsonl'),
  };
}

// 新建（或复用未录音的）当天会话
export async function createSession(title) {
  await ensureDirs();
  const clean = sanitizeTitle(title);
  const date = todayStr();
  const safeRaw = clean;
  let name = `${date}-${safeRaw}`;
  let dir = path.join(SESSIONS_ROOT, name);

  // 同名会话已存在且还没录音 -> 复用
  if (fs.existsSync(dir)) {
    const meta = await readJSON(path.join(dir, 'meta.json'), null);
    const recording = meta && meta.recording;
    if (recording && !recording.startedAt) {
      return { reused: true, session: await sessionInfo(dir, meta) };
    }
    // 否则追加序号
    for (let i = 2; i < 100; i += 1) {
      const candidate = path.join(SESSIONS_ROOT, `${date}-${safeRaw}-${i}`);
      if (!fs.existsSync(candidate)) {
        dir = candidate;
        name = `${date}-${safeRaw}-${i}`;
        break;
      }
    }
    if (fs.existsSync(dir)) throw new Error('同名会话过多，请换一个标题');
  }

  await fsp.mkdir(path.join(dir, 'audio'), { recursive: true });
  const p = sessionPaths(dir);
  const meta = {
    title: clean,
    dirName: name,
    date,
    createdAt: isoNow(),
    recording: { startedAt: null, stoppedAt: null },
    chunks: [],
    transcriptOffsetSec: 0,
  };
  await writeJSON(p.meta, meta);
  await fsp.writeFile(
    p.transcript,
    `# ${clean}（${date}）\n\n> 本文件由课堂录音自动追加，每段带 [分:秒] 时间戳。\n\n`,
    'utf8',
  );
  await fsp.writeFile(p.quiz, '', 'utf8');
  await fsp.writeFile(p.focus, '', 'utf8');
  await writeJSON(CURRENT_FILE, { title: clean, dir, startedAt: isoNow() });
  return { reused: false, session: await sessionInfo(dir, meta) };
}

export async function sessionInfo(dir, metaArg) {
  const meta = metaArg || (await readJSON(path.join(dir, 'meta.json'), null));
  const name = path.basename(dir);
  const date = (meta && meta.date) || name.slice(0, 10);
  return {
    title: (meta && meta.title) || name.slice(11),
    dir,
    dirName: name,
    date,
    createdAt: (meta && meta.createdAt) || null,
    recording: (meta && meta.recording) || { startedAt: null, stoppedAt: null },
    meta,
  };
}

export async function getCurrentSession() {
  const cur = await readJSON(CURRENT_FILE, null);
  if (!cur || !cur.dir) return null;
  if (!fs.existsSync(path.join(cur.dir, 'meta.json'))) return null;
  return sessionInfo(cur.dir);
}

// 最近一次会话（当前会话不存在时给工具做提示）
export async function latestSession() {
  try {
    const names = await fsp.readdir(SESSIONS_ROOT, { withFileTypes: true });
    const dirs = names
      .filter((d) => d.isDirectory())
      .map((d) => path.join(SESSIONS_ROOT, d.name))
      .sort();
    if (!dirs.length) return null;
    return sessionInfo(dirs[dirs.length - 1]);
  } catch {
    return null;
  }
}

export async function readMeta(session) {
  return readJSON(sessionPaths(session.dir).meta, null);
}

export async function updateMeta(session, patch) {
  const p = sessionPaths(session.dir);
  const meta = (await readJSON(p.meta, null)) || {};
  const next = { ...meta, ...patch };
  await writeJSON(p.meta, next);
  return next;
}

// ---------- transcript.md ----------

// 清洗一段转写文本：去掉零宽字符、多余空白；不伪造内容
export function cleanText(text) {
  return String(text || '')
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function appendTranscript(session, offsetSec, text) {
  const p = sessionPaths(session.dir);
  const line = `[${mmss(offsetSec)}] ${cleanText(text)}\n`;
  await fsp.appendFile(p.transcript, line, 'utf8');
  return line.trimEnd();
}

export async function appendTranscriptRaw(session, line) {
  const p = sessionPaths(session.dir);
  await fsp.appendFile(p.transcript, `${line}\n`, 'utf8');
  return line;
}

export async function readTranscript(session) {
  try {
    return await fsp.readFile(sessionPaths(session.dir).transcript, 'utf8');
  } catch {
    return '';
  }
}

// 解析 transcript.md 为 [{t, text}]，跳过标题/引用行
export function parseTranscript(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^\[(\d{1,3}:\d{2})\]\s*(.+)$/);
    if (m) {
      out.push({ t: m[1], text: m[2] });
    }
  }
  return out;
}

// ---------- quiz.jsonl ----------

export async function readQuiz(session) {
  const lines = await readLines(sessionPaths(session.dir).quiz);
  const rows = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 忽略坏行
    }
  }
  return rows;
}

function quizKey(row) {
  if (row && row.index !== undefined && row.index !== null && row.index !== '') {
    return `i:${row.index}`;
  }
  return `q:${String(row.question || '').trim()}`;
}

// 每个题目 key 的最新一条
export function latestRows(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(quizKey(row), row);
  }
  return map;
}

// 未改正错题：最后一条是 answer/grade 且 correct !== true
export function pendingWrong(rows) {
  const latest = latestRows(rows);
  const pending = [];
  for (const row of latest.values()) {
    const type = row.type || (row.answer !== undefined ? 'answer' : 'question');
    if (type !== 'answer' && type !== 'grade') continue;
    if (row.correct === true) continue;
    pending.push({
      index: row.index,
      question: row.question || '',
      lastAnswer: row.answer || '',
      note: row.note || '',
      status: type === 'grade' ? 'wrong' : 'ungraded',
    });
  }
  pending.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  return pending;
}

// 出题行（最新），并标注是否已作答
export function questionsWithState(rows) {
  const latest = latestRows(rows);
  const answerKeys = new Set();
  for (const row of rows) {
    const type = row.type || (row.answer !== undefined ? 'answer' : 'question');
    if (type === 'answer' || type === 'grade') answerKeys.add(quizKey(row));
  }
  const out = [];
  for (const [key, row] of latest.entries()) {
    const type = row.type || (row.answer !== undefined ? 'answer' : 'question');
    if (type !== 'question') continue;
    out.push({
      index: row.index,
      question: row.question || '',
      level: row.level || null,
      expected: row.expected || '',
      answered: answerKeys.has(key),
    });
  }
  out.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  return out;
}

export async function appendAnswer(session, index, answer) {
  const rows = await readQuiz(session);
  const qRow = rows.find(
    (r) => (r.type === 'question' || (!r.type && r.answer === undefined)) && String(r.index) === String(index),
  );
  if (!qRow) return null;
  await appendLine(sessionPaths(session.dir).quiz, {
    type: 'answer',
    index: qRow.index,
    question: qRow.question,
    answer: String(answer || ''),
    correct: null,
    time: isoNow(),
  });
  return qRow;
}

export async function appendGrade(session, index, correct, note) {
  const rows = await readQuiz(session);
  const qRow = rows.find(
    (r) => (r.type === 'question' || (!r.type && r.answer === undefined)) && String(r.index) === String(index),
  );
  if (!qRow) return null;
  const lastAnswer = [...rows].reverse().find(
    (r) => String(r.index) === String(index) && r.type === 'answer',
  );
  await appendLine(sessionPaths(session.dir).quiz, {
    type: 'grade',
    index: qRow.index,
    question: qRow.question,
    answer: (lastAnswer && lastAnswer.answer) || '',
    correct: !!correct,
    note: String(note || ''),
    time: isoNow(),
  });
  return qRow;
}

// 重写题目（digest 第二次调用）：清空旧记录，写 5 条 question 行
export async function rewriteQuestions(session, questions) {
  const p = sessionPaths(session.dir);
  const lines = questions.map((q, i) => JSON.stringify({
    type: 'question',
    index: i + 1,
    question: q.question,
    expected: q.expected || '',
    level: q.level || i + 1,
    correct: null,
    time: isoNow(),
  }));
  await fsp.writeFile(p.quiz, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  return questions.length;
}

// ---------- focus.jsonl ----------

export async function appendFocus(session, type) {
  const meta = (await readMeta(session)) || {};
  const rec = meta.recording || {};
  const now = new Date();
  const base = rec.startedAt ? Date.parse(rec.startedAt) : now.getTime();
  await appendLine(sessionPaths(session.dir).focus, {
    type,
    time: now.toISOString(),
    elapsedSec: Math.max(0, Math.round((now.getTime() - base) / 1000)),
  });
}

export async function readFocus(session) {
  const lines = await readLines(sessionPaths(session.dir).focus);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // 忽略坏行
    }
  }
  return out;
}

// 专注报告：总时长、切走次数/总时长、最长连续专注、番茄数
export function summarizeFocus(events, pomodoroMinutes = 25) {
  const started = events.find((e) => e.type === 'start');
  const stopped = [...events].reverse().find((e) => e.type === 'stop');
  const startMs = started ? Date.parse(started.time) : null;
  const stopMs = stopped ? Date.parse(stopped.time) : null;
  const totalSec = startMs && stopMs ? Math.max(0, Math.round((stopMs - startMs) / 1000)) : 0;

  let leaveCount = 0;
  let awaySec = 0;
  let longestFocusSec = 0;
  let segmentStart = startMs;
  let openLeave = null;

  for (const e of events) {
    if (e.type === 'leave') {
      openLeave = Date.parse(e.time);
      leaveCount += 1;
      if (segmentStart && openLeave) {
        const seg = Math.max(0, Math.round((openLeave - segmentStart) / 1000));
        if (seg > longestFocusSec) longestFocusSec = seg;
      }
    } else if (e.type === 'return') {
      const ret = Date.parse(e.time);
      if (openLeave) {
        awaySec += Math.max(0, Math.round((ret - openLeave) / 1000));
        openLeave = null;
      }
      segmentStart = ret;
    }
  }
  if (openLeave && stopMs) {
    awaySec += Math.max(0, Math.round((stopMs - openLeave) / 1000));
  }
  if (!openLeave && segmentStart && stopMs) {
    const seg = Math.max(0, Math.round((stopMs - segmentStart) / 1000));
    if (seg > longestFocusSec) longestFocusSec = seg;
  }
  const pomodoros = Math.floor(totalSec / (pomodoroMinutes * 60));
  return {
    totalSec,
    leaveCount,
    awaySec,
    longestFocusSec,
    pomodoros,
    activeSec: Math.max(0, totalSec - awaySec),
  };
}
