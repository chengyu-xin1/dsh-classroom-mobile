// 开发期独立启动 HTTP 服务（不依赖 DSH，方便本机 curl 验收）
// 用法：
//   node scripts/dev-server.js                 # 只起 HTTP（8765）
//   DSH_CLASSROOM_MOBILE_TUNNEL=1 node scripts/dev-server.js   # 同时起公网隧道
// 可选环境变量：DSH_CLASSROOM_MOBILE_DIR（数据目录）、DSH_CLASSROOM_PYTHON、
//              DSH_CLASSROOM_FFMPEG、DSH_CLASSROOM_MOBILE_TUNNEL、DSH_CLASSROOM_CLOUDFLARED
import { ensureDirs, ensureAccessPin } from '../src/store.js';
import { startClassroomServer } from '../src/server.js';
import { DATA_ROOT, TUNNEL_ENABLED } from '../src/config.js';
import { startTunnel, stopTunnel, waitTunnelReady, getTunnelState } from '../src/tunnel.js';

async function main() {
  await ensureDirs();
  const pin = await ensureAccessPin();
  const { instance, port } = await startClassroomServer();
  console.log(`[dev] 服务已启动：http://127.0.0.1:${port}`);
  console.log(`[dev] 数据目录：${DATA_ROOT}`);
  console.log(`[dev] 访问码：${pin}（非本机访问 /api/* 需要带 X-Classroom-Pin）`);

  if (TUNNEL_ENABLED) {
    startTunnel(port);
    const t = await waitTunnelReady(90000);
    if (t.status === 'ready') {
      console.log(`[dev] 公网地址：${t.url}`);
    } else {
      console.error(`[dev] 公网隧道未就绪（${t.status}${t.error ? `：${t.error}` : ''}）`);
    }
    console.log(`[dev] 隧道状态：${JSON.stringify(getTunnelState())}`);
  }

  const shutdown = async (sig) => {
    console.log(`[dev] 收到 ${sig}，正在关闭…`);
    try { stopTunnel(); } catch { /* ignore */ }
    try {
      await instance.stop();
    } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[dev] 启动失败：${(err && err.stack) || err}`);
  process.exit(1);
});
