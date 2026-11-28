# 用自己的 Cloudflare 域名连接 PiDeck

> 本仓库发布包内置的默认中继是 `wss://relay.caoayu.top/v1/tunnel`；下面讲的是换成你自己的。
> 国内网络可能连不上 `*.workers.dev`，自建 Worker 时建议绑定自己的域名。

PiDeck 的远程服务只监听电脑的 `8787` 端口（可在「设置 → 远程」改）。要让手机在任意网络下连上，
需要有人把公网 HTTPS 转发到这个端口。下面三种方式任选一种，**都不需要电脑有固定 IP**。

- [A. Cloudflare Tunnel](#a-cloudflare-tunnel)：不写代码，CF 控制台点几下；适合个人/家庭。
- [B. Worker 中继](#b-worker-中继)：不用开入站端口，走 PiDeck 自己的配对协议；适合想完全用 CF 的人。
- [C. 其他反向代理](#c-其他反向代理)：Caddy、nginx、frp 等，只要能把 HTTPS 指到 8787。

前置条件：

- 域名已接入 Cloudflare（域名的 NS 指向 CF）。
- 电脑上已打开「设置 → 远程 → 允许手机连接」，记下端口（默认 `8787`）。
- 手机和电脑都能上网；不需要固定 IP，也不需要路由器端口映射。

---

## A. Cloudflare Tunnel

适合：只想让手机连上，不想部署 Worker、不想管代码。

1. 打开 <https://dash.cloudflare.com>，进入 **Zero Trust → Networks → Tunnels**，点 **Create a tunnel**。
2. 连接器选 **Cloudflared**，起一个名字，例如 `pideck-home`。
3. 按页面提示在**运行 PiDeck 的电脑**上安装并启动 connector：
   - Windows：下载 `cloudflared.exe`，用页面给出的命令 `cloudflared.exe service install <token>`。
   - macOS：`brew install cloudflared`，再执行页面给出的 `cloudflared tunnel run --token <token>`。
   - Linux：按页面给出的 `cloudflared service install <token>`。
4. 回到 **Public Hostname** 页，填：
   - **Subdomain**：`pideck`
   - **Domain**：你的域名，例如 `example.com`
   - **Service**：`HTTP` → `localhost:8787`
5. 保存后，在电脑浏览器打开 `https://pideck.example.com/api/ping`：
   - 返回一段 JSON（`{"name":"PiDeck",...}`）或 `401` 都说明隧道通了；`401` 只是没带令牌。
   - `1033` / `1016` / `522` 表示 connector 没连上或 hostname 没配好。
6. 回到 PiDeck：**设置 → 远程 → 自定义公网地址**，填 `https://pideck.example.com`，点「应用地址」。
7. 这一栏会出现带令牌的链接和二维码，手机扫码即可。

注意：

- Tunnel 在 Cloudflare 边缘终止 TLS，**Cloudflare 能看到明文**（令牌、会话内容）。请只用自己的账号，
  不要把别人的 Tunnel 地址填进来。
- 转发必须指向**根路径**，不要加 `/api` 或子路径；PiDeck 的 API 就在根上。
- 令牌轮换后，旧二维码会失效，需要重新扫码。

---

## B. Worker 中继

适合：不想开放任何入站端口，或想让多台设备共用同一个入口。中继只转发字节，两端在隧道里再跑一层
TLS，**Worker 看不到令牌和会话内容**。

1. 电脑安装 Node.js 20 或更新版本。
2. 在仓库里执行：

   ```sh
   cd infra/relay-worker
   npm install
   npx wrangler login     # 浏览器里授权你的 Cloudflare 账号
   npx wrangler deploy
   ```

3. 部署输出会给出地址，例如：

   ```
   https://pideck-relay.<你的账号>.workers.dev
   ```

4. （可选）换成自己的域名：
   - 控制台 → **Workers & Pages → pideck-relay → Settings → Domains & Routes → Add custom domain**；
   - 或在 `infra/relay-worker/wrangler.toml` 里写
     `routes = [{ pattern = "relay.example.com/v1/tunnel", zone_name = "example.com" }]` 后重新 deploy。
5. 回到 PiDeck：**设置 → 远程 → 外网访问 → 中继地址**，粘贴上面的地址：
   - 直接粘 `https://…` 即可，App 会自动换成 `wss://` 并补上 `/v1/tunnel`。
   - 点「测试连接」，成功后再打开「中继连接」。
6. 这一栏会出现配对链接和二维码，手机扫码即可。

费用与额度（Cloudflare 官方计费）：

- Workers 免费额度：Durable Object 每天 10 万次请求、1.3 万 GB-s；WebSocket 入站消息按 20:1
  折算成请求，出站消息和协议 ping 免费，没有流量费；空闲的 Durable Object 会休眠。
- 超出后 Workers Paid 从 $5/月起（含 100 万 DO 请求 + 40 万 GB-s/月）。
- 免费额度是**硬上限**，超出当天会直接失败；产品化建议直接开 Workers Paid。

更细的部署说明见 [infra/relay-worker/README.md](../infra/relay-worker/README.md)。

---

## C. 其他反向代理

任何能把 HTTPS 指到 `127.0.0.1:8787` 的方式都可以，例如 Caddy、nginx、frp、Tailscale Serve。

- Caddy 一行：

  ```
  pideck.example.com {
      reverse_proxy 127.0.0.1:8787
  }
  ```

- nginx 记得转发 `Upgrade` / `Connection` 头（PiDeck 的直连 API 是普通 HTTP，但以后的功能可能用
  WebSocket；转发这两个头没有副作用）。
- 配好后同样在 **设置 → 远程 → 自定义公网地址** 填 `https://pideck.example.com`。

注意：反向代理会终止 TLS，代理方能看到明文；只用自己的代理。

---

## 常见问题

**打开 `/api/ping` 是 401**

正常。`/api/ping` 需要令牌；用手机扫码后的链接会自动带上。也可以在浏览器打开
`https://你的域名/api/ping?token=<访问令牌>` 验证。

**手机连不上，但电脑浏览器能打开**

- 确认链接里带 `?token=`，且令牌没有重新生成过。
- 确认手机用的是 `https://` 地址，不是 `http://`。
- 中继方式：先点「测试连接」，看是地址问题还是 Worker 没部署。

**中继测试失败**

- 地址要以 `/v1/tunnel` 结尾（直接粘 Worker 的 `https://…` 时 App 会自动补）。
- 确认 `npx wrangler deploy` 成功，且 Worker 的 Durable Object 迁移已应用。
- 如果用了自定义域名，确认 DNS 记录和 Worker 路由都在同一个 CF 账号下。

**Cloudflare Tunnel 报 1033 / 1016 / 522**

- 1033：connector 没连上（服务没启动、token 不对）。
- 1016：hostname 没配或 DNS 没生效。
- 522：CF 连不到源站，检查 connector 是否还在运行、PiDeck 是否在跑。

**换了令牌 / 换了地址**

- 令牌轮换：手机上的旧链接失效，重新扫码。
- 地址变更：在「自定义公网地址」或「中继地址」里改完点应用，重新扫码。

**安全提醒**

- 配对链接里含访问令牌，等同于这台电脑的远程权限；不要发到群里或截图公开。
- 中继方式（Worker/自建 Go 中继）是端到端 TLS，中继看不到内容；Tunnel/反向代理方式由代理方
  终止 TLS，请只用自己的账号和代理。
