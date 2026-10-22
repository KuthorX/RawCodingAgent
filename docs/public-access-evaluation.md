# 公网访问：技术评估

2026-10-22。目标：手机**不装 Tailscale** 也能从公网打开 raw-coding-agent 的网页。重点看稳定性和安全性。现有的 `--remote`（tailnet 内访问）不受影响，下面每个方案都是在它旁边再加一条入口。

## 先说结论

| | A. Funnel | B. Cloudflare Tunnel + Access | C. VPS + frp 透传 | D. 端到端加密中继 |
|---|---|---|---|---|
| 谁能看到明文 | 只有这台 Mac | **Cloudflare** | 只有这台 Mac（配 CAA 后） | 只有两端 |
| 谁能往页面里注入代码 | 这台 Mac（理论上 Tailscale） | Cloudflare | 这台 Mac | **托管静态页面的一方**（GitHub/Cloudflare Pages、你的 CI） |
| 陌生人能不能连到 Mac | **能**（只靠应用自己的认证） | **不能**（边缘先登录） | **能**（只靠应用自己的认证） | 不能（中继只转发配对过的两端） |
| 前提 | 换成开源版 tailscaled；tailnet 开 Funnel | 域名托管在 Cloudflare；装 cloudflared | 一台 VPS（约 $5/月）+ 域名 | Cloudflare 账号（免费额度可能够） |
| 改动量（估） | 1–1.5 天 | 1–1.5 天 | 2 天 + 运维 | 6–9 天 |
| 主要稳定性风险 | beta，2026 年有过多次中继事故；带宽上限不公开 | 登录过期会让推送静默断开；7844 端口被封 | VPS 单点；Mac 上续证书 | 每次部署断开所有连接；SSE 要重写成可续传的流 |

**推荐 B**：两层互不依赖的认证（Cloudflare Access 在边缘，现有设备配对在应用里），公网扫描器根本到不了 Mac。代价是 Cloudflare 能看到流量明文（对话、代码、命令输出）。如果这一点不能接受，选 **A**；它省事，但应用的认证就成了唯一一道门，下面"共同要做的"里的加固必须先做完。C 和 D 的安全性不比 A 好多少，工作量和运维都大得多，不推荐。

## 现状里已经能复用的

- 设备配对、可撤销的设备凭证（`__Host-` cookie）、只能在主机上生成配对码：公网方案的应用层认证直接用它。
- 远程走单独的本地端口：每个公网入口也各开一个，算哪种来访者看端口。
- 推送用 SSE，每次连上都从头回放这个会话的事件，所以断线重连天然能恢复，只是长会话重放的数据多。

## A. Tailscale Funnel

在 `--remote` 的基础上把 `tailscale serve` 换成 `tailscale funnel`。

- **安全**
  - TLS 在 Mac 上终结，Funnel 中继解不开（[KB 1223](https://tailscale.com/kb/1223/funnel)）。
  - **没有身份头**：Funnel 流量不带 `Tailscale-User-Login`（[KB 1312](https://tailscale.com/kb/1312/serve)）。现在的"必须是本机账号"这层检查在公网入口上没有了，只剩设备 cookie。
  - 地址公开：开 HTTPS 证书会把 `*.ts.net` 名字写进公开的证书透明日志（[KB 1153](https://tailscale.com/kb/1153/enabling-https)），要假设会被扫描。配对接口、页面都直接暴露在公网。
  - Tailscale 控制 `ts.net` 的 DNS 和证书签发，理论上能做中间人，这和现在的 tailnet 方案一样。
- **稳定性**
  - 仍是 beta，带宽上限不公开（第三方测得中位数约 7 Mbps，对文字和 SSE 足够）。2026-04-13 到 04-17 官方状态页有 Funnel 性能事故。
  - 新名字生效最多要 10 分钟。
  - SSE 经 Funnel 有第三方项目报告可用，官方没写，需要实测。
- **前提（这台机器目前都不满足）**
  - macOS 上**只有开源版 tailscaled 支持 Funnel**，App Store 版和 Standalone 版都不行（[macOS variants](https://tailscale.com/kb/1065/macos-variants)）。这台机器装的是 Standalone 版（`io.tailscale.ipn.macsys`），要换成开源版客户端（没有图形界面，不自动更新）。
  - tailnet policy 要给这台机器加 `funnel` 属性（这台机器目前没有）。
- **要改的**：公网入口单独一个端口；不检查身份头，但必须有设备 cookie；配对接口改成按来源限速，不再全局锁定（否则任何人都能每分钟锁一次）；见下面"共同要做的"。

## B. Cloudflare Tunnel（命名隧道）+ Cloudflare Access

`cloudflared` 从 Mac 主动连 Cloudflare，`agent.你的域名` 上挂 Access 策略（邮箱验证码或 GitHub 登录，只放行你自己）。

- **安全**
  - 没通过 Access 登录的请求在 Cloudflare 边缘就被挡掉，到不了 Mac。
  - 应用里再校验 `Cf-Access-Jwt-Assertion`：用团队域名的 JWKS（`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`）验签，检查 `aud` 和 `iss`（[文档](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/)）。这样策略配错了也不会直接放行。设备配对照旧，三层：Access 登录、JWT、设备 cookie。
  - **Cloudflare 能看到明文**（TLS 在它的边缘终结），包括对话、代码、bash 输出。
  - 本地仍只监听 `127.0.0.1`，隧道是唯一入口。
- **稳定性**
  - SSE：命名隧道默认缓冲响应，但 `Content-Type: text/event-stream` 时会流式转发（[文档](https://developers.cloudflare.com/tunnel/troubleshooting/)）；我们本来就发这个头，加 `Cache-Control: no-cache`。有社区报告说某些情况下先攒约 100 KB 才发，要实测。quick tunnel（trycloudflare）不支持 SSE，不能用。
  - 代理读超时 125 秒，我们 15 秒一次心跳，碰不到。
  - Access 登录过期（默认 24 小时）后，后台请求会被 302 到登录页，浏览器当成跨域错误，EventSource 只会不停重试。前端要识别出来，整页跳去重新登录。
  - `cloudflared` 开 4 条连接到边缘，断了按 2 秒到 64 秒退避重连，QUIC 不通退回 HTTP/2；可以装成 launchd 服务开机启动。需要出站 7844 端口（UDP 和 TCP）没被封。
- **前提**：一个 DNS 托管在 Cloudflare 的域名；Zero Trust 免费版（50 个用户以内，有报告说要绑卡）。
- **要改的**：`--public` 参数（或者只写文档，让用户自己配 cloudflared，应用只负责校验 JWT）；JWT 校验（`jose` 库，或者用 Node 自带的 `crypto` 手写 RS256 验签）；登录过期的前端处理。

## C. 自己的 VPS + frp，TLS 透传到 Mac

VPS 上跑 frps，按 SNI 把 443 的 TLS 连接原样转给 Mac；Mac 用 DNS-01 申请 Let's Encrypt 证书，自己终结 TLS。

- **安全**：VPS 只看到密文。但 VPS 能控制域名指向的 IP，可以用 HTTP-01 给你的域名签一张证书来做中间人，所以要配 CAA 记录，加上 `accounturi` 和 `validationmethods=dns-01`（RFC 8657），并且盯着证书透明日志。和 A 一样，Mac 直接暴露在公网，只靠应用认证。
- **稳定性**：VPS 是单点，要自己打补丁；证书续期在 Mac 上跑，过期了就全断。
- **结论**：明文不经过第三方，这一点和 A 一样，但多了一台服务器和证书运维。只有在不想依赖 Tailscale、又不想让 Cloudflare 看到明文时才值得。

## D. 端到端加密中继（Orca / Happy 的做法）

Mac 和手机都主动连一个中继（Cloudflare Durable Objects 或 VPS 上的小 Node 服务），中继只转发密文；配对时交换 X25519 公钥，HKDF 派生两个方向各自的 AES-GCM 密钥，帧带计数器防重放（Orca 的 v2 方案）。

- **浏览器绕不开的问题**：Orca 安全是因为客户端是原生 App。浏览器里，页面代码是谁下发的，谁就能偷走密钥。
  - 中继不能顺便托管页面，必须放到另一个源（比如这个仓库的 GitHub Pages 或 Cloudflare Pages）。这样信任从"中继"变成"托管页面的平台、你的 GitHub 账号和 CI"。
  - SRI 管不到顶层 HTML；PWA 的 service worker 最晚 24 小时会重新检查更新，也钉不住代码。
  - Happy 自托管时服务器同时下发网页，浏览器用户的端到端加密实际上要信任服务器。
- **稳定性**
  - Durable Objects 每次部署都会断开所有 WebSocket。
  - SSE 不能直接过中继，要改成"Mac 上带序号的事件日志 + 客户端带上次序号续传"。
  - 所有 HTTP 接口都要改成走加密通道的 RPC，相当于重写一遍前后端通信。
- **成本**：Durable Objects 免费额度：每天 10 万次请求，超了直接失败；付费 $5/月起。WebSocket 收到的消息按 20:1 计费。
- **结论**：防中继最彻底，但对浏览器客户端，信任只是从中继挪到了页面托管方，换来的是 6–9 天的重写和一套新的重连协议。不推荐，除非以后做原生 App。

## 不考虑的

- **ngrok**：和 B 一样边缘终结 TLS；免费版每月 1 GB、2 万次请求，浏览器还有一个确认页，去掉要 $10/月起。
- **WebRTC 直连**：仍要信令服务器和 TURN（移动网络下 25–35% 的会话需要中继），换网络要重新协商，页面托管的信任问题不变，工作量最大。
- **zrok、Pinggy、localtunnel、微软 dev tunnels**：要么有确认页或时长限制，要么已停止维护，要么边缘认证太弱。

## 共同要做的

不论选哪个，都要先做下面这些。A 和 C 必须全部做完，因为应用认证是唯一一道门。

**安全**

- **按来源限速**：配对接口现在是全局锁定，一分钟错 10 次就锁到这分钟结束。公网上任何人都能借此让你配对不了，要改成按来源 IP 限速（A 和 C 从 `X-Forwarded-For` 取；只信任我们自己的代理加的那一层）。
- **公网入口单独一个端口**：和 tailnet 入口、本机入口分开，各自只做适合自己的检查。
- **审计日志**：每次远程的审批和发消息都记下来源设备，可以事后查。
- **公网会话默认每次询问**：从公网入口新建的会话默认不自动批准 bash（可以手动切换）。
- **一键关闭**：设置页上停掉公网入口，同时撤销所有设备。

**稳定性**

- **iOS 后台恢复**：iOS Safari 切到后台会冻结页面、掐断连接，而且常常不触发 `onerror`。`readyState` 还显示 OPEN，实际已经断了。要在 `visibilitychange` / `pageshow` / `online` 时主动重建推送连接。
- **长会话重连**：现在每次重连都回放整个会话的事件。改成带上 `Last-Event-ID`、只补发缺的部分。
- **Mac 睡眠**：Mac 睡眠时所有方案都不通，远程请求也唤不醒它。要插电，并用 `caffeinate -s` 或 `pmset` 防止睡眠；页面上应显示"主机离线"，而不是一直转圈。

## 已核实与未核实

**本机已核实**

- 装的是 Tailscale Standalone 版（`io.tailscale.ipn.macsys`），不是开源版 tailscaled。
- 这台机器在 tailnet 里没有 `funnel` 属性。
- 没装 `cloudflared`、`ngrok`、`frpc`。

**需要实测才能下结论**

- SSE 在 Funnel 上的表现。
- SSE 在命名隧道上的首包缓冲。
- Safari 稳定版对 WebCrypto X25519 的支持（只有 D 方案需要）。

**引用来源**

- 调研报告和官方文档：Tailscale KB 1223 / 1312 / 1153 / 1065，Cloudflare Tunnel 与 Access 文档，Durable Objects 价格与限制页，frp README。
- 本地读过的源码：Orca（commit 301059f）和 Happy（commit 1a643ba）。
