#!/usr/bin/env node
// 把 mobile-webapp skill 的隧道模板装进目标项目，并打印接线步骤。
//
// 用法：
//   node scripts/scaffold.mjs --target "D:\\my-plugin" [--force]
//   node scripts/scaffold.mjs --target . --force
//
// 只做两件事：复制 templates/tunnel.js 到 <target>/src/tunnel.js；
// 把 templates/pwa-head.html 复制到 <target>/docs/pwa-head.html 供手工粘贴。
// 不修改目标项目已有文件（除非 --force 覆盖 tunnel.js）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, '..');
const TEMPLATES = path.join(SKILL_DIR, 'templates');

function parseArgs(argv) {
  const out = { target: '', force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--target' || a === '-t') out.target = argv[++i] || '';
    else if (a === '--force' || a === '-f') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.target) {
  console.log('用法: node scripts/scaffold.mjs --target <项目目录> [--force]');
  process.exit(args.help ? 0 : 2);
}

const target = path.resolve(args.target);
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error(`目标目录不存在：${target}`);
  process.exit(2);
}

function copy(srcName, destRel) {
  const src = path.join(TEMPLATES, srcName);
  const dest = path.join(target, destRel);
  if (!fs.existsSync(src)) {
    console.error(`模板缺失：${src}`);
    return false;
  }
  if (fs.existsSync(dest) && !args.force) {
    console.log(`跳过（已存在）：${dest}（加 --force 覆盖）`);
    return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`写入：${dest}（${fs.statSync(dest).size} 字节）`);
  return true;
}

copy('tunnel.js', path.join('src', 'tunnel.js'));
copy('pwa-head.html', path.join('docs', 'pwa-head.html'));

console.log(`
下一步（照着接线，都是模板里的真实接口）：

1. src/tunnel.js 顶部没有外部依赖，直接：
     import { createTunnel } from './tunnel.js';

2. 在服务启动拿到端口之后：
     const tunnel = createTunnel({
       exe: path.join(PKG_ROOT, 'bin', 'cloudflared.exe'),  // 或 PATH 里的 cloudflared
       port,
       logFile: path.join(TMP_DIR, 'cloudflared.log'),
     });
     tunnel.start();
     tunnel.waitReady(60000).then((s) => {
       if (s.status === 'ready') console.log('[tunnel] 公网地址：' + s.url);
       else console.error('[tunnel] 未就绪：' + s.error);
     });

3. 卸载时释放：
     ctx.effect(() => () => tunnel.stop(), 'http-server');

4. 访问码与 PWA 路由见 SKILL.md 的 Step 3 / Step 4；
   页面头部片段已复制到 docs/pwa-head.html，直接粘进 <head>。

5. 验证顺序见 references/verify-checklist.md（先本机、再隧道、最后手机）。
`);
