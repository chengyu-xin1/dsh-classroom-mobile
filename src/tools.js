// 四个 Agent 侧工具：digest / grade / focus / url
// 架构：插件只做数据读写与任务包，语言加工交给宿主 Agent
import { defineTool } from '@deepseek-ai/dsh-tools';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getCurrentSession, latestSession, sessionPaths, readMeta, readTranscript,
  parseTranscript, readQuiz, pendingWrong, rewriteQuestions, appendGrade,
  readFocus, summarizeFocus, appendFocus, updateMeta, mmss, isoNow, ensureAccessPin,
} from './store.js';
import { POMODORO_MINUTES, SESSIONS_ROOT, PORT_START } from './config.js';
import { getTunnelState } from './tunnel.js';

const textOut = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

function truncate(text, max) {
  const s = String(text || '');
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

// 按目录名 / 标题 / 日期片段找会话；不传则取当前会话
async function resolveSession(nameOrTitle) {
  if (!nameOrTitle) return getCurrentSession();
  const q = String(nameOrTitle).trim();
  let names = [];
  try {
    names = (await fsp.readdir(SESSIONS_ROOT, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => path.join(SESSIONS_ROOT, d.name))
      .sort();
  } catch {
    return null;
  }
  const exact = names.find((d) => path.basename(d) === q);
  if (exact) return loadSession(exact);
  const bySuffix = [...names].reverse().find((d) => path.basename(d).endsWith(q));
  if (bySuffix) return loadSession(bySuffix);
  // 按 meta.title 匹配
  for (const d of [...names].reverse()) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(d, 'meta.json'), 'utf8'));
      if (meta && String(meta.title) === q) return loadSession(d);
    } catch { /* 忽略坏会话 */ }
  }
  return null;
}

async function loadSession(dir) {
  const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
  return {
    title: meta.title || path.basename(dir).slice(11),
    dir,
    dirName: path.basename(dir),
    date: meta.date || path.basename(dir).slice(0, 10),
    createdAt: meta.createdAt || null,
    recording: meta.recording || { startedAt: null, stoppedAt: null },
    meta,
  };
}

const digestTool = defineTool({
  name: 'classroom_mobile_digest',
  description:
    '读取手机端课堂录音的转写，生成「总结/导图/拓展/题目」任务包。分两步调用：第一次不带 payload，返回任务包与转写正文；Agent 按任务包生成内容后，第二次带上 payload（JSON 字符串）保存 summary.md、mindmap.md 并写入 5 道题。当学生说「生成这节课的总结和导图」时调用。',
  parameters: {
    session: {
      type: 'string',
      description: '会话目录名或课程标题（可选，默认当前会话）。',
    },
    payload: {
      type: 'string',
      description: '第二步使用：JSON 字符串，形如 {"summary":"...","mindmap":"```mermaid\\nmindmap\\n...```","extensions":["..."],"questions":[{"question":"...","expected":"...","level":1},...]}',
    },
  },
  output: textOut,
  async execute(args) {
    const session = await resolveSession(args.session);
    if (!session) {
      const last = await latestSession();
      return {
        text: last
          ? `错误：没有当前会话。最近的会话是「${last.title}」（${last.dirName}），可在参数 session 里指定它。`
          : '错误：还没有任何课堂会话。请先在手机页面开始上课录音。',
      };
    }

    // ── 第一步：返回任务包 ──
    if (!args.payload) {
      const raw = await readTranscript(session);
      const segments = parseTranscript(raw);
      if (!segments.length) {
        return {
          text: `错误：会话「${session.title}」还没有转写内容（transcript.md 为空或只有占位符）。\n`
            + '请先在手机页面录音，等转写完成后再试；如果转写引擎不可用，可在手机页面手动粘贴文字。',
        };
      }
      const bodyText = segments.map((s) => `[${s.t}] ${s.text}`).join('\n');
      const { text: body, truncated } = truncate(bodyText, 30000);
      const brief = [
        `【课堂总结任务包】课程：${session.title}（${session.date}）`,
        `会话目录：${session.dirName}`,
        `转写：${segments.length} 段，共 ${bodyText.replace(/\s/g, '').length} 字${truncated ? '（超过 30000 字，已截断展示）' : ''}`,
        '',
        '请严格按下面四项产出（内容用中文，基于转写原文，不要编造转写里没有的事实）：',
        '1) summary.md：5 条带 [mm:ss] 时间戳的要点，每条 1~2 句；',
        '2) mindmap.md：一个 mermaid mindmap 代码块（根节点 root((课程标题))，3~4 层，节点用中文短语）；',
        '3) 3 条知识拓展（每条 2~4 句，说明与本节课的关系）；',
        '4) 5 道由易到难的检验题，每题给出参考答案。',
        '',
        '完成后调用本工具保存，参数：',
        `session="${session.dirName}"`,
        'payload=一个 JSON 字符串（不要用代码块包裹）：',
        '{"summary":"- [00:12] ...\\n- [03:40] ...","mindmap":"```mermaid\\nmindmap\\n  root((课程标题))\\n    ...\\n```","extensions":["...","...","..."],"questions":[{"question":"...","expected":"...","level":1},{"question":"...","expected":"...","level":2},{"question":"...","expected":"...","level":3},{"question":"...","expected":"...","level":4},{"question":"...","expected":"...","level":5}]}',
        '',
        '--- 转写正文开始 ---',
        body,
        '--- 转写正文结束 ---',
      ].join('\n');
      return { text: brief };
    }

    // ── 第二步：保存 ──
    let payload;
    try {
      payload = typeof args.payload === 'string' ? JSON.parse(args.payload) : args.payload;
    } catch (err) {
      return { text: `错误：payload 不是合法 JSON（${err.message}）。请把 summary/mindmap/extensions/questions 组合成一个 JSON 字符串再调用。` };
    }
    if (!payload || typeof payload !== 'object') {
      return { text: '错误：payload 必须是一个 JSON 对象。' };
    }
    const summary = String(payload.summary || '').trim();
    const mindmap = String(payload.mindmap || '').trim();
    const extensions = Array.isArray(payload.extensions) ? payload.extensions.map(String).filter(Boolean) : [];
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    if (!summary) return { text: '错误：payload.summary 为空，没有保存。' };
    if (!mindmap) return { text: '错误：payload.mindmap 为空，没有保存。' };
    if (questions.length !== 5) {
      return { text: `错误：payload.questions 需要正好 5 道题（由易到难），当前 ${questions.length} 道，没有保存。请补齐后再调用。` };
    }
    const cleanedQuestions = questions.map((q, i) => ({
      question: String((q && q.question) || '').trim(),
      expected: String((q && q.expected) || '').trim(),
      level: Number((q && q.level) || i + 1),
    }));
    if (cleanedQuestions.some((q) => !q.question)) {
      return { text: '错误：有题目的 question 为空，没有保存。请检查第 ' + (cleanedQuestions.findIndex((q) => !q.question) + 1) + ' 题。' };
    }

    const p = sessionPaths(session.dir);
    let summaryMd = `# ${session.title} 课堂总结\n\n${summary}\n`;
    if (extensions.length) {
      summaryMd += `\n## 知识拓展\n\n${extensions.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n`;
    }
    await fsp.writeFile(p.summary, summaryMd, 'utf8');
    await fsp.writeFile(p.mindmap, mindmap.endsWith('\n') ? mindmap : `${mindmap}\n`, 'utf8');
    const count = await rewriteQuestions(session, cleanedQuestions);
    return {
      text: `已保存到手机可读的会话「${session.title}」：\n`
        + `- 总结 → ${p.summary}\n`
        + `- 导图 → ${p.mindmap}\n`
        + `- 题目 → ${p.quiz}（${count} 道，correct 留空待批改）\n\n`
        + `更新于 ${isoNow()}。手机页面刷新「总结/导图/复习」页即可看到。`,
    };
  },
});

const gradeTool = defineTool({
  name: 'classroom_mobile_grade',
  description:
    '回填手机端课堂练习的批改结果。学生答完题后，Agent 判定对错并调用本工具；correct=true 表示该题已改正（移出错题队列），false 表示仍在队列。',
  parameters: {
    index: {
      type: 'integer',
      required: true,
      description: '题号（从 1 开始，对应题目顺序）',
    },
    correct: {
      type: 'boolean',
      required: true,
      description: '是否答对',
    },
    note: {
      type: 'string',
      description: '评语/正确答案说明（可选）',
    },
  },
  output: textOut,
  async execute(args) {
    const session = await getCurrentSession();
    if (!session) return { text: '错误：还没有当前课堂会话。' };
    const rows = await readQuiz(session);
    const exists = rows.some(
      (r) => (r.type === 'question' || (!r.type && r.answer === undefined)) && String(r.index) === String(args.index),
    );
    if (!exists) {
      const maxIndex = rows.reduce((m, r) => Math.max(m, Number(r.index) || 0), 0);
      return { text: `错误：会话「${session.title}」没有第 ${args.index} 题（当前题号范围 1~${maxIndex || 0}）。` };
    }
    await appendGrade(session, args.index, !!args.correct, args.note || '');
    const pending = pendingWrong(await readQuiz(session));
    const tail = pending.length
      ? `当前未改正错题 ${pending.length} 道：${pending.map((q) => `第${q.index}题`).join('、')}。手机端仍会拦截新录音。`
      : '所有题目已改正 ✓ 手机端可以开始新录音。';
    return {
      text: `已批改 第 ${args.index} 题：${args.correct ? '答对' : '答错'}${args.note ? `（${args.note}）` : ''}。\n${tail}`,
    };
  },
});

const focusTool = defineTool({
  name: 'classroom_mobile_focus',
  description:
    '结束当前课堂的专注记录并输出报告：总时长、切走次数与累计离开时长、最长连续专注、番茄数。学生说「结束专注/看看专注报告」或课后收尾时调用。浏览器页面无法阻止切到其他 App，只能记录离开/回来时间。',
  parameters: {},
  output: textOut,
  async execute() {
    const session = await getCurrentSession();
    if (!session) return { text: '错误：还没有当前课堂会话。' };
    const events = await readFocus(session);
    if (!events.length) {
      return { text: `会话「${session.title}」还没有专注记录。请先在手机页面开始上课录音。` };
    }
    const hasStart = events.some((e) => e.type === 'start');
    if (!hasStart) return { text: `会话「${session.title}」还没有开始专注（缺少 start 事件）。` };
    const lastStop = [...events].reverse().find((e) => e.type === 'stop');
    const lastStart = [...events].reverse().find((e) => e.type === 'start');
    if (!lastStop || (lastStart && Date.parse(lastStart.time) > Date.parse(lastStop.time))) {
      const meta = (await readMeta(session)) || {};
      await updateMeta(session, {
        recording: {
          startedAt: (meta.recording && meta.recording.startedAt) || isoNow(),
          stoppedAt: isoNow(),
        },
      });
      const fresh = (await getCurrentSession()) || session;
      await appendFocus(fresh, 'stop');
    }
    const all = await readFocus(session);
    const r = summarizeFocus(all, POMODORO_MINUTES);
    return {
      text: [
        `【专注报告】${session.title}（${session.date}）`,
        `- 总时长：${mmss(r.totalSec)}`,
        `- 有效专注：${mmss(r.activeSec)}`,
        `- 切走次数：${r.leaveCount} 次，累计离开 ${mmss(r.awaySec)}`,
        `- 最长连续专注：${mmss(r.longestFocusSec)}`,
        `- 番茄数：${r.pomodoros} 个（${POMODORO_MINUTES} 分钟/个）`,
        '',
        '说明：手机浏览器无法阻止你切到其他 App，这里只记录页面离开/回来的时间，用于事后复盘，不代表强制专注。',
      ].join('\n'),
    };
  },
});

// 查手机访问地址与访问码（学生问「手机打开什么网址」时用）
function lanIPv4List() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

const urlTool = defineTool({
  name: 'classroom_mobile_url',
  description:
    '查询手机访问地址与访问码。学生问「手机打开什么网址」「访问码是多少」「手机怎么连不上」时调用。返回公网 HTTPS 隧道地址（手机用流量或任意 WiFi 都能访问）、6 位访问码、局域网备用地址与隧道状态。',
  parameters: {},
  output: textOut,
  async execute() {
    const t = getTunnelState();
    const pin = await ensureAccessPin();
    const lan = lanIPv4List();
    const port = t.port || PORT_START;
    const lines = ['【手机访问地址】'];
    if (t.status === 'ready' && t.url) {
      lines.push(`公网地址（推荐，手机用流量/任意 WiFi 都能开）：${t.url}`);
    } else if (t.status === 'disabled') {
      lines.push('公网地址：已关闭（DSH_CLASSROOM_MOBILE_TUNNEL=0），只能同一 WiFi 用局域网地址。');
    } else {
      lines.push(`公网地址：暂时不可用（状态：${t.status}${t.error ? `，${t.error}` : ''}）。稍等片刻再问一次。`);
    }
    lines.push(`访问码：${pin}（手机首次打开公网地址时输入，输入后本机记住）`);
    if (lan.length) {
      lines.push('', '局域网备用（手机与电脑连同一个 WiFi 时）：');
      for (const x of lan) lines.push(`- http://${x.address}:${port}（${x.name}）`);
    }
    lines.push(
      '',
      '说明：公网地址是临时隧道，重启 DSH 后可能变化，以本工具最新返回为准；',
      '录音需要 HTTPS 才能调用麦克风，公网地址已满足。页面无法锁定手机，只会记录你切走的时间。',
    );
    return { text: lines.join('\n') };
  },
});

export const mobileTools = [digestTool, gradeTool, focusTool, urlTool];
