// dsh-classroom-mobile — 手机可访问的课堂学习插件
//
// 职责：起 HTTP 服务（手机浏览器访问 PC），提供四个 Agent 工具，把
// 「手机录音 → 转写文字 → 总结/导图/题目 → 错题门控 → 专注报告」串成闭环。
//
// 手机访问：优先用 cloudflared 公网 HTTPS 隧道（手机用流量也能开，HTTPS 才能调麦克风）；
// 隧道不可用时自动退回局域网 http://<PC-IP>:8765。
//
// 边界（写死，不改）：
// - DSH 是桌面应用，没有移动端；手机端只是浏览器访问本机 HTTP 服务。
// - 浏览器无法阻止切换 App，专注只做「检测 + 记录 + 报告」。
// - 零 npm 依赖；数据只写 D:\dsh-classroom-mobile\data。
import { ensureDirs, ensureAccessPin } from './store.js';
import { startClassroomServer } from './server.js';
import { mobileTools } from './tools.js';
import { DATA_ROOT } from './config.js';
import { startTunnel, stopTunnel, waitTunnelReady } from './tunnel.js';

export const name = 'dsh-classroom-mobile';

export const inject = ['tools'];

export function apply(ctx) {
  for (const tool of mobileTools) {
    ctx.tools.register(tool);
  }

  let instance = null;
  let closed = false;

  const booting = (async () => {
    await ensureDirs();
    const pin = await ensureAccessPin();
    if (closed) return;
    const started = await startClassroomServer();
    instance = started.instance;
    if (closed) {
      await instance.stop().catch(() => {});
      return;
    }
    // 插件日志：DSH 宿主会把 console 输出收进日志
    console.log(
      `[dsh-classroom-mobile] 服务已启动：http://127.0.0.1:${started.port}  （数据目录 ${DATA_ROOT}，访问码 ${pin}）`,
    );

    // 公网隧道：成功的话手机在任何网络都能打开 https://xxx.trycloudflare.com
    startTunnel(started.port);
    waitTunnelReady(90000).then((t) => {
      if (closed) return;
      if (t.status === 'ready' && t.url) {
        console.log(
          `[dsh-classroom-mobile] 公网地址：${t.url}  访问码：${pin}（手机浏览器打开，输入访问码即可）`,
        );
      } else if (t.status === 'disabled') {
        console.log('[dsh-classroom-mobile] 公网隧道已关闭（DSH_CLASSROOM_MOBILE_TUNNEL=0），仅局域网可访问');
      } else {
        console.error(
          `[dsh-classroom-mobile] 公网隧道未就绪（${t.status}${t.error ? `：${t.error}` : ''}），可继续用局域网地址`,
        );
      }
    }).catch(() => {});
  })().catch((err) => {
    console.error(`[dsh-classroom-mobile] 服务启动失败：${(err && err.message) || err}`);
  });

  // cordis 卸载钩子：关闭隧道与服务
  ctx.effect(() => () => {
    closed = true;
    const close = async () => {
      await booting.catch(() => {});
      stopTunnel();
      if (instance) await instance.stop().catch(() => {});
    };
    close().catch(() => {});
  }, 'dsh-classroom-mobile.http-server');
}
