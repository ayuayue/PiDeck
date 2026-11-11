# PiDeck 远程 / 多设备访问实施计划（对标 t3code）

> **Status: Active plan（2026-11-09；未开工，等待方向确认）**
>
> 目标读者：决定是否投入远程能力的维护者。本文只写"现状 → 差距 → 分阶段交付与门禁"，不写已完成的功能叙事。
> 对标对象：`pingdotgg/t3code` 的 remote / T3 Connect 设计（调研结论见 `docs/archive/` 外的一次性会话记录，不在本仓库）。
> 相关现行文档：`docs/architecture.md`、`docs/host-boundaries.md`、`docs/electron-playbook.md`、`docs/project-location-architecture.md`、`docs/dsh-remote-contract.md`、`docs/remote-sftp-evaluation.md`。

## 0. 结论先行

PiDeck **不需要从零实现**。宿主面（HTTP + SSE + 静态 renderer）、外网隧道、SSH 远端执行都已经存在；缺的是"多设备"的三件套：**设备级身份、路由目录与重连、并发命令语义**。按三阶段推进：

| 阶段 | 内容 | 外部依赖 | 粗略量级 |
|---|---|---|---|
| A | 身份/撤销/幂等：把单 token 升级为设备 session | 无 | 1–2 人周 |
| B | 路由目录 + 重连 + TLS 三选一 + 宿主常驻 | 用户自备 Tailscale / 自己的域名 | 2–3 人周 |
| C | 零配置：自建 relay + 托管 tunnel + 推送 | Cloudflare/Clerk/DB/APNs/FCM + 域名 | 4–8 人周 + 持续运维 |

只有 C 需要提前准备账号与预算；A/B 是纯开发。

## 1. 现状盘点（代码事实）

| 能力 | 位置 | 现状 |
|---|---|---|
| Web 宿主服务 | `src/main/web/WebServiceManager.ts` | `node:http` 服务，可绑 `0.0.0.0`，SSE + 静态产物 + dev 代理 |
| Web API | `src/main/web/WebApiRoutes.ts` | `/api/state`、`/api/sessions*`、`/api/chat`（SSE）、`/api/ui-response`、`/api/projects`、`/api/models`、`/api/easytier/config.toml` |
| Web 客户端 | `src/main/web/WebStaticAssets.ts` | 直接托管 `out/renderer`，即**同一套 React UI**（无第二套前端） |
| 鉴权 | `src/main/web/WebTokenAuth.ts:95-111` | **单一共享 token**；`Authorization: Bearer` 全方法，`?token=` 仅 GET/SSE；常数时间比较；可设有效期 |
| 网络暴露 | `src/main/web/WebNetwork.ts` | 枚举非回环 IPv4/IPv6，供用户选入口；绑定与鉴权由设置控制 |
| 外网渠道 | `src/main/web/remoteAccess/RemoteAccessManager.ts` | cloudflared **quick tunnel**（域名每次变）、`tailscale serve`、EasyTier（只读探测 + 托管配置/系统服务） |
| SSH 远端执行 | `src/main/remote/RemoteHostConnectionService.ts`、`RemoteHelperEntry.ts` | NDJSON helper（fs/git/config/terminal 白名单方法）+ 远端 pi `--mode rpc`（`src/main/pi/remoteRuntimePort.ts`） |
| 设置 | `src/shared/types/settings.ts:389-410` | `webServiceEnabled/Host/Port/RequiresAuth/Token/TokenGeneratedAt/TokenExpiresIn` |

已确认的空白（对标 t3code 后逐项核过）：

1. **没有设备身份**：一个 token 全员共享，无法按设备撤销、无法给不同设备不同 scope；`webServiceRequiresAuth=false` 与 `0.0.0.0` 可同时成立。
2. **没有环境标识与路由目录**：客户端只知道 URL；quick tunnel 每次启动换域名，没有稳定 identity，也没有"这个地址是不是我要的那台机器"的校验点。
3. **客户端没有重连/升级逻辑**：浏览器刷新即重建；无退避、无路由探测、无"回到更快路由"。
4. **SSE 无续传**：`WebEventStream.ts` / `WebSessionStream.ts` 里没有 `Last-Event-ID` / cursor，断线只能整体重拉状态。
5. **多客户端语义未定义**：`SessionRuntimeCoordinator` 以 `sessionId + agentId + runtimeGeneration` 围栏，但没有 `clientId` 与命令幂等回执；两台设备同时对同一会话发 prompt 的行为未定义。
6. **宿主随窗口退出**：关最后一个窗口即停服务；没有托盘常驻/开机自启/系统服务安装。
7. **无移动端、无推送、无账号体系**。

## 2. 差距矩阵（t3code 能力 parity）

| 能力 | t3code | PiDeck 现状 | 目标阶段 |
|---|---|---|---|
| 环境标识独立于路由 | environmentId 跨重启/换端点稳定，descriptor 校验 | 无 | A |
| 每设备独立会话 + scope + 撤销 | SessionStore + scoped session + ticket | 单共享 token | A |
| 命令幂等 | receipt + 事件日志 | 仅 runtimeGeneration 围栏 | A |
| 路由排序/探测/升级/学习 | `driver` + `supervisor`，7 种 RouteKind | 无，用户手填 URL | B |
| 断线续传 | 事件日志 + snapshot 回退 | 无 cursor | B |
| TLS/安全上下文 | tunnel 或 Tailscale 或用户 CA | quick tunnel/serve 有 TLS；LAN 明文 | B |
| 宿主常驻 | 后台服务（systemd/launchd） | 随窗口退出 | B（最小版：托盘） |
| 零配置发现 + 托管 tunnel | relay + cloudflared + 一次性 bootstrap | 无 | C |
| 移动端 + 推送 | APNs/FCM + Live Activity | 无 | C |
| 数据面不经 relay | 明确设计约束 | 天然满足（现在没有 relay） | C 的前置约束 |

## 3. 阶段 A：设备级身份与并发语义（纯开发）

**完成定义**：两台设备各自持有一个可命名的 session；撤销其中一台后，它的下一次请求立即 401、已开的 SSE 被关闭；两台同时对同一会话发 prompt 不会双跑。

- **A1 环境 descriptor**：新增 `GET /api/descriptor`（**不鉴权**），只回 `{ environmentId, name, apiVersion, capabilities, advertisedRoutes }`。`environmentId` 首次生成后持久化（与 `docs/architecture.md` 的会话 ID 稳定性同源处理），换端口/换路由不变。作用：客户端探测路由时先验明身份，避免把凭据发给"同网段另一台机器"。
- **A2 session store**：`src/main/web/auth/WebSessionStore.ts`，条目 `{ id, label, scopes, createdAt, lastSeenAt, expiresAt, tokenHash }`。令牌只在创建时返回一次，落盘只存哈希。scope 至少分 `orchestration:read|write`、`terminal:operate`、`filesystem:read|write`、`access:manage`。桌面端保留一个 `access:manage` 的 master session。
- **A3 兼容与迁移**：`settings.webServiceToken` 保留为 fallback，映射为一个 `label="legacy"` 的 admin session；迁移只做一次、可回滚（旧字段不删）。
- **A4 撤销生效**：鉴权不得跨撤销缓存；SSE 在 `token → sessionId` 绑定后，session 被撤销/过期即关闭连接（`WebStateEventHub` / `WebSessionStream`）。参考 t3code 的口径：撤销只影响该设备，不影响其它健康连接。
- **A5 命令幂等**：`commandId` 进入写路径，服务端保存有界 receipt；重复 `commandId` 返回首次结果。同时在 runtime 围栏里带 `clientId`，让"谁发起的这一轮"可归因。
- **A6 安全门禁**：`webServiceRequiresAuth=false` 只在绑定 loopback 时生效；非 loopback 绑定强制鉴权并在设置层直接拒绝保存。任何写操作继续要求 Bearer（现有约定），`?token=` 仅限 GET/SSE。

**门禁**：`npm run typecheck` + 新增单测（store/descriptor/revocation/idempotency/legacy 迁移）+ 一个双浏览器上下文 E2E（撤销 + 并发 prompt）。不跑全量 `npm test` / `npm run build`。

## 4. 阶段 B：可达性与重连（用户自备网络能力）

**完成定义**：同一台宿主配置 2 条以上路由，手机浏览器在断网/切 Wi-Fi 后能自动回到可用路由，并优先使用局域网；用户能在一个列表里看到/移除设备。

- **B1 路由模型**：`RouteKind = "lan" | "tailnet" | "easytier" | "quick-tunnel" | "named-tunnel" | "ssh-forward"`，每条 `{ kind, url, label, learnedFrom? }`，排序按"延迟/成本"（loopback < lan < tailnet/easytier < named-tunnel < quick-tunnel）。用户手加的路由永不自动删除。
- **B2 环境目录（renderer 侧）**：浏览器 `localStorage` 存多个环境 + 各自路由；探测顺序与 t3code 一致——先打 `/api/descriptor`（2.5s 超时、500ms 起跑差），`environmentId` 匹配才继续带凭据。
- **B3 重连 supervisor**：独立模块，指数退避（上限 5 分钟）、`visibilitychange`/`online` 触发探测、在线后升级更靠前路由、失败路由冷却。SSE 走 `Last-Event-ID` 或 `?after=<seq>` 续传；服务端保留有界事件环，过期则回退整包 state。
- **B4 TLS 三选一**（按推荐顺序）：`tailscale serve`（自动证书，零配置）→ 用户自己的 `cloudflared` named tunnel + 自己的域名（稳定 URL）→ 自签 CA（Android 需安装 CA，iOS 需描述文件）。**LAN 明文仅允许 loopback**；`0.0.0.0` + http 的组合在 UI 上标记为不安全并默认关闭。
- **B5 宿主常驻（最小版）**：托盘 + 关窗不退出 + 开机自启；不做 systemd/launchd 服务安装（那是独立产品决策，见 §9）。

**门禁**：真机双端验收——手机浏览器经 tailscale serve 连接；断网 30s 恢复；切 Wi-Fi 后 learned route 生效；撤销设备后连接立即失效。

## 5. 阶段 C：零配置（需要账号与预算，未决）

沿用 t3code 的硬约束：**relay 不代理数据面**。relay 只做发现、tunnel 分配、一次性 bootstrap 凭据、推送；连上后流量直连环境的 tunnel hostname。

需要准备（缺一不可）：

| 类别 | 具体项 |
|---|---|
| 域名/DNS | 一个 API 域 + 一个 tunnel 泛域名 zone，程序化建记录 |
| Cloudflare | 账号 + API Token；Workers、Durable Objects、Queues、Hyperdrive（付费计划） |
| 数据库 | PlanetScale（或 D1）；按 stage 分 branch |
| 身份 | Clerk（JWT 模板 + public OAuth/PKCE + device grant + 原生 redirect 白名单），或自建 OIDC |
| 观测 | Axiom（或等价）+ 告警 notifier |
| 推送 | APNs：Apple Developer（$99/年）、Team ID/Key ID/`.p8`/bundle id；FCM：Firebase 服务账号 |
| 运维 | cloudflared 版本 pin、tunnel 回收任务、离线 webhook hold、滥用限流、隐私说明（TLS 在 Cloudflare 边缘终止） |

若不做 C，B 阶段已经覆盖"技术用户自用/小团队"的绝大多数场景。

## 6. 契约与代码落点

- 类型：扩展 `src/shared/types/remoteAccess.ts`（路由/descriptor）；设备 session 放新文件 `src/shared/types/webSession.ts`，避免把鉴权语义塞进 UI 状态类型。
- IPC：任何"桌面端管理设备/路由"的入口都按三处同步（`src/shared/ipc.ts` → `src/main/ipc/*Ipc.ts` → `src/preload/index.ts`），漏一处运行时 undefined。
- **不新增 pi ↔ PiDeck 通道**：远程能力全部落在 PiDeck 自己的宿主面（HTTP/WS），pi 仍只经既有六类通道通信（`docs/host-boundaries.md`）。
- Web API 版本化：descriptor 带 `apiVersion` + `capabilities`；客户端按能力降级，不按版本号假设。
- 新增文件优先放在 `src/main/web/`（宿主面）与 `src/renderer/src/connection/`（客户端连接层），不改 `main/index.ts` 的业务逻辑，只在装配处接线。

## 7. 数据与迁移

- 新增 `userData/web-sessions.json`（原子写、权限 0600）；不写 pi 的会话 JSONL（离线上下文编辑仍走 `context_edit`）。
- 一次性迁移 `webServiceToken` → legacy session；保留旧字段 30 天作为回滚路径，之后单独一个提交删除。
- 迁移必须可重入：重复执行收敛到同一状态；失败保留旧 token 可用。

## 8. 验证计划

| 层 | 内容 |
|---|---|
| 单测 | `tests/webSessionStore.test.mjs`、`tests/webDescriptor.test.mjs`、`tests/webSessionRevocation.test.mjs`、`tests/webCommandIdempotency.test.mjs`、`tests/webRouteProbe.test.mjs` |
| 类型/格式 | `npm run typecheck`；改 zh-CN 词典时 `node scripts/genZhTwCopy.mjs` |
| E2E | `npx playwright test e2e/<web-remote>.spec.ts`：双上下文并发、撤销即断、SSE 续传 |
| 真机 | 手机浏览器（iOS Safari + Android Chrome）经 tailscale serve；自签 CA 分支单独验收 |
| 不跑 | 全量 `npm test`、`npm run build`（仅跨域大改或合并前才跑） |

## 9. 待决策（需产品/方向拍板，技术侧已给推荐）

1. **是否做 C**：决定现在要不要准备账号/预算/隐私文案。推荐：先 A+B，用真实使用数据决定。
2. **移动端形态**：PWA（复用现有 web UI，零商店成本，但后台推送受限）vs 原生（推送完整，需 Apple/Google 账号与发版流程）。推荐先 PWA。
3. **overlay 主推谁**：已有 EasyTier（P2P overlay）与 Tailscale 两条路。推荐主推 Tailscale（自动证书、跨平台稳定），EasyTier 保留为无公网环境的备选。
4. **LAN 明文**：是否一律禁止（推荐禁止，只留 loopback 例外）。
5. **宿主常驻**：托盘常驻（推荐，改动小）vs 安装系统服务（覆盖无头 Linux，但引入服务管理与权限模型）。

## 10. 明确不做

- 不自研 NAT 穿透 / P2P 打洞（现有 overlay 与隧道已覆盖；t3code 同样不做）。
- 不做第二套前端：远程客户端复用 `out/renderer`。
- 不在远程链路复刻 pi 行为：远端 agent 仍由用户自己的 pi 进程执行。
- 不把 relay 做成数据面代理（成本、隐私、合规三重代价）。
- 不为远程新增 pi ↔ PiDeck 通道类别。
