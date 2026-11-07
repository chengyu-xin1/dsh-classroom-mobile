// 端到端验收：上传 → 转写 → 总结/导图 → 错题门控 → 放行 → 专注报告
// 用法（需要有 D 盘写权限，因为默认数据目录是 D:\dsh-classroom-mobile\data）：
//   node test\e2e.mjs
// 会新建「自动验收测试」会话，结束后清理。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const AUDIO_SRC = process.env.E2E_AUDIO || 'E:\\D h\\build\\test-audio\\tts-zh-16k.wav';
const TITLE_PREFIX = '自动验收测试';
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
const TITLE = `${TITLE_PREFIX}-${stamp}`;

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { startClassroomServer } = await import('../src/server.js');
const store = await import('../src/store.js');
const { mobileTools } = await import('../src/tools.js');
const tool = (name) => mobileTools.find((t) => t.name === name);

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cls-e2e-'));
const createdDirs = [];
let instance;

async function jfetch(base, p, opts = {}) {
  const res = await fetch(base + p, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, headers: res.headers, body };
}

try {
  console.log('=== 0. 启动服务（真实 D 盘数据目录）===');
  const started = await startClassroomServer();
  instance = started.instance;
  const base = `http://127.0.0.1:${started.port}`;
  console.log(`  服务端口：${started.port}，数据目录：${store && (await import('../src/config.js')).DATA_ROOT}`);

  // 0.1 等 ASR 探测完成（detectAsr 是异步的，最多等 60 秒）
  let state;
  for (let i = 0; i < 120; i += 1) {
    state = (await jfetch(base, '/api/state')).body;
    if (state && state.checked !== false && state.asrAvailable === true) break;
    await sleep(500);
  }
  console.log('  /api/state →', JSON.stringify({ ok: state.ok, asrAvailable: state.asrAvailable, asrMessage: state.asrMessage, port: state.port }));
  ok('GET /api/state 200', state.ok === true);
  ok('ASR 引擎可用', state.asrAvailable === true, state.asrMessage);

  console.log('\n=== 1. 新建会话 ===');
  let r = await jfetch(base, '/api/session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: TITLE }),
  });
  ok('POST /api/session/start 成功', r.status === 200 && r.body.ok === true, r.body.session && r.body.session.title);
  const sessionA = r.body.session;
  createdDirs.push(sessionA.dir);

  console.log('\n=== 2. 生成测试音频并上传（模拟手机分片）===');
  const toneWebm = path.join(tmpDir, 'tone5s.webm');
  const speechWebm = path.join(tmpDir, 'speech.webm');
  const ff = (args) => {
    const p = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    if (p.status !== 0) throw new Error(`ffmpeg 失败：${p.stderr}`);
  };
  ff(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:a', 'libopus', '-b:a', '32k', '-ar', '16000', '-ac', '1', toneWebm]);
  ff(['-y', '-hide_banner', '-loglevel', 'error', '-i', AUDIO_SRC, '-c:a', 'libopus', '-b:a', '32k', '-ar', '16000', '-ac', '1', speechWebm]);
  const toneBuf = await fsp.readFile(toneWebm);
  const speechBuf = await fsp.readFile(speechWebm);
  console.log(`  5 秒 440Hz 分片：${toneBuf.length} 字节；中文语音分片（${(speechBuf.length / 1024).toFixed(1)}KB）：${speechBuf.length} 字节`);

  for (const [label, buf] of [['静音/纯音分片', toneBuf], ['中文语音分片', speechBuf]]) {
    r = await jfetch(base, '/api/audio', { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: buf });
    ok(`POST /api/audio（${label}）`, r.status === 200 && r.body.ok === true, JSON.stringify({ chunk: r.body.chunk, size: r.body.size, queued: r.body.queued }));
  }

  console.log('\n=== 3. 等后台转写完成（最多 8 分钟，首次加载模型较慢）===');
  let live;
  const t0 = Date.now();
  for (;;) {
    live = (await jfetch(base, '/api/live')).body;
    const st = (await jfetch(base, '/api/state')).body;
    if ((live.pending || 0) === 0 && (st.pendingTranscribed || 0) === 0) break;
    if (Date.now() - t0 > 480000) throw new Error('转写超时（8 分钟）');
    await sleep(3000);
  }
  const stDone = (await jfetch(base, '/api/state')).body;
  console.log(`  转写完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s；录音时长 ${stDone.durationSec}s；chunkCount=${stDone.chunkCount}`);
  console.log('  /api/live.lastText =', JSON.stringify(live.lastText));
  ok('转写出中文文字', /同学|黑板|极限|连续/.test(live.lastText || ''), live.lastText);

  console.log('\n=== 4. transcript.md 真实内容 ===');
  const transcriptPath = path.join(sessionA.dir, 'transcript.md');
  const transcript = await fsp.readFile(transcriptPath, 'utf8');
  console.log(transcript);
  ok('transcript.md 带 [mm:ss] 时间戳', /^\[\d{1,3}:\d{2}\]/m.test(transcript));
  ok('transcript.md 不是伪造占位', !/此段待转写/.test(transcript) && /同学|黑板/.test(transcript));

  console.log('\n=== 5. Agent 工具 classroom_mobile_digest（第一步：任务包）===');
  const digest = tool('classroom_mobile_digest');
  const step1 = await digest.execute({ session: sessionA.dirName });
  console.log(`  返回 ${step1.text.length} 字，预览：\n${step1.text.slice(0, 420)}\n  ...（截断）`);
  ok('任务包包含时间戳要点要求', /\[mm:ss\]/.test(step1.text));
  ok('任务包包含 5 道题要求', /5 道/.test(step1.text));
  ok('任务包带转写正文', /转写正文开始/.test(step1.text) && /同学|黑板/.test(step1.text));

  console.log('\n=== 6. classroom_mobile_digest（第二步：保存 summary/mindmap/quiz）===');
  const payload = {
    summary: '- [00:00] 本节课学习函数的连续性与极限的定义。\n- [00:06] 强调注意黑板例题。\n- [00:10] 连续性判定要点。\n- [00:14] 极限存在性与左右极限。\n- [00:18] 课堂练习与总结。',
    keypoints: '## 重点\n- [00:00] 连续性的定义\n- [00:06] 极限存在性\n## 难点\n- [00:10] 左右极限与函数值的比较\n## 易错点\n- [00:14] 忘记检查定义域',
    mindmapType: 'tree',
    mindmap: '- 函数连续性\n  - 极限\n    - 定义\n    - 左右极限\n  - 连续性\n    - 判定\n    - 例题',
    extensions: ['连续性是函数性质的基础，与可导、可积密切相关。', '极限的 ε-δ 定义有助于理解连续性。', '可结合分段函数讨论连续点。'],
    questions: [
      { question: '函数在某点连续的定义是什么？', expected: '左极限=右极限=函数值', level: 1 },
      { question: '左右极限存在且相等，是否一定连续？', expected: '还需等于该点函数值', level: 2 },
      { question: '分段函数在分界点如何判断连续性？', expected: '计算左右极限并与函数值比较', level: 3 },
      { question: '连续性与可导性的关系？', expected: '可导必连续，连续不一定可导', level: 4 },
      { question: '举例说明极限不存在的情况。', expected: '左右极限不相等或振荡', level: 5 },
    ],
  };
  const step2 = await digest.execute({ session: sessionA.dirName, payload: JSON.stringify(payload) });
  console.log(step2.text);
  ok('digest 保存成功', /已保存/.test(step2.text) && /5 道/.test(step2.text));
  const sum = (await jfetch(base, '/api/summary')).body;
  ok('GET /api/summary 返回 summary', /本节课学习/.test(sum.summary));
  ok('GET /api/summary 返回 mindmap', /函数连续性/.test(sum.mindmap) && /%%.*type:\s*tree/.test(sum.mindmap));
  ok('GET /api/summary 返回 mindmapType=tree', sum.mindmapType === 'tree');
  ok('GET /api/summary 返回 keypoints', /重点/.test(sum.keypoints) && /易错点/.test(sum.keypoints));
  ok('quiz.jsonl 已写入 5 道题', store.readQuiz && (await store.readQuiz({ ...sessionA })).filter((x) => x.type === 'question').length === 5);

  console.log('\n=== 7. 专注记录（visibilitychange 模拟 + 报告）===');
  const evs = [{ type: 'start', wait: 1000 }, { type: 'leave', wait: 1200 }, { type: 'return', wait: 3000 }, { type: 'leave', wait: 800 }, { type: 'return', wait: 0 }];
  for (const e of evs) {
    r = await jfetch(base, '/api/focus/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: e.type }) });
    if (e.wait) await sleep(e.wait);
  }
  const focusTool = tool('classroom_mobile_focus');
  const focus = await focusTool.execute({});
  console.log(focus.text);
  ok('专注报告含切走次数', /切走次数：\d+ 次/.test(focus.text));
  ok('专注报告含番茄数', /番茄数：\d+ 个/.test(focus.text));
  ok('专注报告如实说明无法阻止切 App', /无法阻止/.test(focus.text));

  console.log('\n=== 8. 错题门控：答错 → 拦截新录音 ===');
  r = await jfetch(base, '/api/quiz/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 1, answer: '连续就是极限存在' }) });
  ok('POST /api/quiz/answer 记录作答', r.status === 200 && r.body.ok === true);
  const grade = tool('classroom_mobile_grade');
  let g = await grade.execute({ index: 1, correct: false, note: '漏了「等于函数值」' });
  console.log(' ', g.text.replace(/\n/g, '\n  '));
  const pending1 = (await jfetch(base, '/api/quiz/pending')).body;
  ok('未改正错题 1 道', pending1.count === 1, JSON.stringify(pending1.pending));
  r = await jfetch(base, '/api/session/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: TITLE + '-放行' }) });
  ok('有错题时新录音被 409 拦截', r.status === 409 && r.body.error === 'wrong_questions_pending', JSON.stringify(r.body).slice(0, 160));

  console.log('\n=== 9. 复习答对 → 放行 ===');
  await jfetch(base, '/api/quiz/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 1, answer: '左右极限存在且相等，并且等于该点函数值' }) });
  g = await grade.execute({ index: 1, correct: true, note: '正确' });
  console.log(' ', g.text.replace(/\n/g, '\n  '));
  const pending2 = (await jfetch(base, '/api/quiz/pending')).body;
  ok('未改正错题清零', pending2.count === 0);
  r = await jfetch(base, '/api/session/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: TITLE + '-放行' }) });
  ok('放行后新录音成功', r.status === 200 && r.body.ok === true, r.body.session && r.body.session.dirName);
  if (r.status === 200) createdDirs.push(r.body.session.dir);

  console.log('\n=== 10. 页面与接口抽查 ===');
  r = await jfetch(base, '/');
  ok('GET / 返回 HTML', r.status === 200 && /<html/i.test(r.body) && /录音/.test(r.body), `${String(r.body).length} 字节`);
  for (const p of ['/api/quiz/questions', '/api/live', '/api/summary', '/api/health']) {
    const x = await jfetch(base, p);
    ok(`GET ${p}`, x.status === 200 && x.body && x.body.ok !== false);
  }
} catch (err) {
  fail += 1;
  console.log('\n💥 异常：', err && err.stack ? err.stack : err);
} finally {
  console.log('\n=== 清理测试会话 ===');
  try {
    for (const dir of createdDirs) {
      await fsp.rm(dir, { recursive: true, force: true });
      console.log('  已删除', dir);
    }
    await fsp.rm(path.join((await import('../src/config.js')).DATA_ROOT, 'current.json'), { force: true });
    await fsp.rm(tmpDir, { recursive: true, force: true });
  } catch (e) {
    console.log('  清理警告：', e.message);
  }
  if (instance) await instance.stop();
  console.log(`\n=== 结果：通过 ${pass} 项，失败 ${fail} 项 ===`);
  process.exitCode = fail ? 1 : 0;
}
