---
name: mobile-webapp
description: "把电脑上的网页或小工具，变成手机也能打开、能装到手机桌面当 App 用的东西。当用户说「手机打不开」「想用手机访问电脑上的页面」「怎么让手机录音」「怎么装到手机主屏幕」「外网也能访问」「帮我把地址发我」时使用，也用于排查手机连不上、录音没声音、地址变了这类问题。用大白话解释，一步一步带着做，每步都告诉你成功长什么样。"
compatibility: 电脑上要有 Node.js 20 以上；需要 cloudflared 这个免费小工具（没有会自动下载）；要录音才需要 ffmpeg。
allowed-tools: Bash, Read, Write, Edit
---

# 让手机打开电脑上的东西（保姆级流程）

## 先用一句话讲清楚原理

电脑上跑着一个网页，它只住在这台电脑里。
手机要看到它，得给它开一扇「朝外的门」。
这扇门就是网上的一个网址，长这样：`https://一串随机单词.trycloudflare.com`。

**但门一开，全世界都能进来**，所以要再加一把只有你知道的锁（6 位访问码）。
最后，把门牌（图标）放到手机桌面上，下次点一下就能进门，不用再输网址。

整个过程就四件事，按顺序做：

| 第几件 | 做什么 | 好比 |
|---|---|---|
| 1 | 让电脑上的网页能被别的设备访问 | 把店门从「只朝自己家开」改成「朝大街开」 |
| 2 | 给店装一个公网门牌（HTTPS 地址） | 让客人知道去哪找 |
| 3 | 加一把 6 位密码锁 | 不是谁都能进 |
| 4 | 把图标放手机桌面 | 一键直达 |

**每做完一件，都要真的验证一次再往下做**，不要四件一起做完才发现哪件错了。

---

## 第 0 步：开工前先看一眼网络

在电脑上打开终端，输：

```bash
curl -I https://cloudflare.com
```

- 看到 `HTTP/2 200` 之类 → 网络没问题，继续。
- 一直卡住、最后报超时 → **当前网络（很多校园网、公司网）把 Cloudflare 封了**，隧道怎么建都不会通。先换网络（手机开热点给电脑试试），别急着改代码。

这一步很多人跳过，结果折腾一小时才发现是网络的事。

---

## 第 1 步：让电脑上的网页能被访问

要改的地方只有两处，都是「一行」级别：

**① 监听地址写成 `0.0.0.0`**

```js
server.listen(8765, '0.0.0.0');   // 对：所有设备都能访问
// server.listen(8765, '127.0.0.1');  // 错：只有电脑自己能看到
```

**② 端口被占就往后顺延**

```js
import http from 'node:http';

export function createServer(handle, ports = [8765, 8766]) {
  const server = http.createServer((req, res) => handle(req, res));
  return {
    server,
    async start() {
      for (const port of ports) {
        try {
          await new Promise((ok, no) => {
            server.once('error', no);
            server.listen(port, '0.0.0.0', ok);
          });
          return port;              // 谁空用谁
        } catch { /* 被占用，试下一个 */ }
      }
      throw new Error('没有可用端口');
    },
    stop() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();   // 不然关了还占着端口
      });
    },
  };
}
```

**怎么算成功**：电脑上打开 `http://127.0.0.1:8765` 能看到页面，`http://127.0.0.1:8765/api/state` 能返回一段 JSON。

**顺便记一个数字**：接口里返回的 `port` 是多少，后面就用多少（不一定是 8765）。

---

## 第 2 步：给电脑装个「公网门牌」

用的是一个免费工具 `cloudflared`，它不需要注册账号。

```bash
cloudflared tunnel --url http://127.0.0.1:8765
```

会刷出一堆日志，其中有一行长这样：

```
https://tiny-words-here.trycloudflare.com
```

**这就是门牌**，手机就用这个网址。

### 两个容易翻车的地方（照着做就不会错）

**坑 1：一定要加 `--protocol http2`**

```bash
cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:8765
```

不加的话，很多校园网会慢到打不开——实测同一个页面：不加要 15 秒，加了 1 秒。

**坑 2：电脑上的程序用「读日志文件」的方式拿地址，别用管道**

如果你的程序里用代码启动 cloudflared，不要用默认的 stdout 管道（沙箱里会报 `spawn EPERM`），改成写文件再读：

```js
const fd = fs.openSync('cloudflared.log', 'a');
const child = spawn(exe, ['tunnel', '--no-autoupdate', '--protocol', 'http2',
  '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', fd] });
```

然后每 0.5 秒读一次日志，用正则找 `trycloudflare.com` 的地址。**注意别抓到 `api.trycloudflare.com`**，那是工具自己的域名，不是你的门牌。取日志里**最后一条**匹配最稳。

完整可复制的代码在 `templates/tunnel.js`，直接用，不用自己写。

### 没有 cloudflared 怎么办

下载这个文件，放到项目的 `bin` 文件夹里：

```
https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
```

下载完在终端输 `cloudflared --version`，能打印版本号才算成功。文件没下完会报「不是有效的应用程序」，那就重新下（Windows 版完整大小是 55,390,512 字节）。

**怎么算成功**：手机浏览器打开那个 `https://...` 网址，能看到和电脑上一模一样的页面。

---

## 第 3 步：加一把 6 位密码锁

门牌是公网的，谁拿到网址都能进，所以必须加锁。

规则很简单：

1. 第一次启动时随机生成 6 位数字，存到电脑上的一个文件里（比如 `data/access.json`），**以后都读这个**，不要每次重新生成。
2. 所有接口，只要不是「电脑自己访问自己」，就必须带对密码，否则返回 `401`。
3. 页面本身（`GET /`）可以不锁——不然手机连输密码的页面都打不开。

关键代码：

```js
const remote = req.socket.remoteAddress || '';
const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
const viaProxy = Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']);

if ((!loopback || viaProxy) && pathname.startsWith('/api/')) {
  const pin = String(req.headers['x-access-pin'] || url.searchParams.get('pin') || '');
  if (pin !== readPin()) return sendError(res, 401, 'pin_required');
}
```

`viaProxy` 那行是灵魂：因为隧道是从电脑本机转发出去的，手机明明在外网，程序看到的却还是 `127.0.0.1`。不判断这几个请求头，密码锁等于没装。

手机页面上的效果：第一次打开弹一个输入框让你输 6 位数字，输对一次就记在浏览器里，以后不再问。

**怎么算成功**（在电脑上测）：

```bash
curl -s https://你的地址/api/state                          # 应该返回 401，被拦住
curl -s -H "X-Access-Pin: 你的6位数字" https://你的地址/api/state   # 应该返回 200
```

第一条被拦住是**好事**，说明锁生效了。

---

## 第 4 步：把图标放到手机桌面

这一步让手机把它当成一个 App，而不是每次输网址。

电脑这边要提供三个小文件：

| 手机要的文件 | 作用 | 一句话解释 |
|---|---|---|
| `/manifest.webmanifest` | 告诉手机：这应用叫什么、图标是哪个、打开时全屏 | 应用身份证 |
| `/sw.js` | 提前把页面存在手机里，断网也能打开 | 离线小仓库 |
| `/icon-180.png` 等 | 桌面图标 | 门牌图片 |

页面 `<head>` 里加上这几行（照抄）：

```html
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="课堂学习">
```

再加一段注册脚本，手机上就会出现「安装到主屏幕」按钮。完整代码在 `templates/pwa-head.html`，直接复制粘贴。

**手机上怎么装**：

- iPhone：用 Safari 打开 → 点底部「分享」→「添加到主屏幕」
- 安卓：用浏览器打开 → 右上角菜单 →「安装应用 / 添加到主屏幕」

**怎么算成功**：桌面上出现图标，点开没有浏览器地址栏，像 App 一样全屏。

---

## 第 5 步：真的用手机试一次（这一步才算数）

不要只在电脑上觉得「应该没问题了」就交付。按顺序来：

1. 手机**关掉 WiFi、用流量**打开那个 `https://` 地址（能打开才说明真通了，不是只在局域网里通）
2. 输入 6 位密码
3. 允许麦克风（如果用得到）
4. 说 30 秒话
5. 等一会儿，页面出现一条带时间戳的字幕

五步都过了才算完成。任何一步没过，就停在原地查，别往下走。

详细对照表在 `references/verify-checklist.md`。

---

## 出问题了怎么办（按症状查）

完整的 12 种情况在 `references/pitfalls.md`，这里先说最常见的 4 个：

| 症状 | 人话原因 | 怎么办 |
|---|---|---|
| 手机打不开，电脑上正常 | 手机和电脑不在同一个「网络圈子」里 | 用公网地址，别用局域网地址；或者确认手机连的是同一个 WiFi |
| 页面能开，但没声音、录不了音 | `http://` 开头的地址浏览器不给麦克风权限 | 必须用 `https://` 的公网地址 |
| 地址昨天能用今天打不开 | 免费隧道每次重启地址都会变 | 问电脑要最新地址；这也是为什么需要一个「查地址」的工具 |
| 页面转圈很久才出来 | 校园网把 QUIC 限速了 | 启动 cloudflared 时加 `--protocol http2` |

---

## 三条不能骗人的红线

1. **浏览器拦不住用户切到别的 App。** 我们只能记录「几点切走、几点回来」，不能锁手机。界面和文档里不要写「锁定手机」。
2. **转写失败就写「此段待转写」，绝不编一段假文字。** 做不到就如实说做不到。
3. **手机锁屏、切后台时录音会自动暂停**，这是浏览器的规定，不是 bug。要一直录就得让页面一直亮在屏幕上，并且提前告诉用户。

---

## 想直接抄代码的同学看这里

- `templates/tunnel.js`：现成的隧道模块（自动重试、超时、停止）
- `templates/pwa-head.html`：页面头部 + 安装按钮
- `scripts/scaffold.mjs`：一条命令把上面两个文件放进你的项目

```bash
node skills/mobile-webapp/scripts/scaffold.mjs --target <你的项目目录>
```
