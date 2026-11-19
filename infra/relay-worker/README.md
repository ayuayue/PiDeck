# PiDeck relay Worker

一个 Worker + 一个 Durable Object，按环境号把一台电脑和一台手机配对；不存令牌、不落盘会话，
两端在隧道里再跑一层 TLS，Worker 只转发密文。没有服务器、没有固定 IP。

## 部署

```sh
cd infra/relay-worker
npm install
npx wrangler login
npx wrangler deploy
```

部署会打印 `https://pideck-relay.<你的账号>.workers.dev`；中继地址是它加 `/v1/tunnel`。
国内网络可能连不上 `*.workers.dev`，建议按下一节绑定自己的域名（本仓库默认用 `relay.caoayu.top`）。

```
wss://pideck-relay.<你的账号>.workers.dev/v1/tunnel
```

## 用自己的域名

Cloudflare 控制台 → Workers & Pages → `pideck-relay` → Settings → Domains & Routes →
Add custom domain（域名需在同一个 Cloudflare 账号下）。也可以在 `wrangler.toml` 里写：

```toml
routes = [{ pattern = "relay.example.com/v1/tunnel", zone_name = "example.com" }]
```

之后地址是 `wss://relay.example.com/v1/tunnel`。

## 在 App 里使用

设置 → 远程 → 外网访问 → 把地址填进「中继地址」→「测试连接」→ 打开「中继连接」→ 手机扫码。

地址也可以直接粘贴 Worker 的 `https://…` 地址，App 会自动换成 `wss://` 并补上 `/v1/tunnel`。
「恢复默认」只在发布包内置了默认中继时出现。

## 费用

Workers 免费额度：Durable Object 每天 10 万次请求、1.3 万 GB-s；WebSocket 入站消息按 20:1
折算成请求，出站消息和协议 ping 免费，没有流量费。空闲的 Durable Object 会休眠，不计时长。
超出后 Workers Paid 从 $5/月起（100 万 DO 请求 + 40 万 GB-s 每月）。

免费额度是硬上限，超出当天会直接失败；产品化建议直接开 Workers Paid。

## 自建 Go 中继

不想用 Cloudflare 时，`cmd/pideck-relay` 是同一协议的 Go 实现，放到有公网入口的机器上，
前面用 Caddy 终止 TLS 即可。
