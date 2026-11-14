---
name: pideck-web-api
description: "当你要用脚本或另一个 agent 控制 PiDeck 时用：自动化、CI、跨进程协作，或让 agent 自检当前会话状态。走 HTTP，能读自己的时间线／运行时／todo，也能给别的窗口发消息、读它的思维链、重启某个运行时（由另一个会话代发 stop 与 activate，脚本随技能安装）。不用于修改 PiDeck 源码，也不用于浏览器自动化。Use for PiDeck web API, SSE stream."
---

# PiDeck Web API（pideck-web-api）

**一句话：PiDeck 每个窗口在后台跑一个 pi 进程，同时开一个只监听 127.0.0.1 的 HTTP 服务。用这个服务，agent 能读自己的状态、给别的窗口发消息、以及把自己这个进程安全地重启。**

## 0 先选分支

按你要做的事读对应那节，不要通读：

| 你想做的事 | 改别人吗 | 读哪节 | 出错后果 |
|---|---|---|---|
| 读自己的时间线、todo、子 agent、运行状态 | 不改 | §4 | 无 |
| 重启某个运行时（自己或别人） | 会停掉进程 | §5 | 目标会话被停 |
| 列出/给别的窗口发消息 | 改别人 | §6、§7 | 打断对方的回合 |
| 停/启/重启别人的运行时 | 改别人 | §8 | 杀掉对方进程 |

后面每一节都要求先做完 §2（服务在跑、令牌在手）。

## 1 术语，四个

- **会话（session）**：PiDeck 侧边栏里的一行。会话可以存在，但此刻没在跑。
- **运行时（runtime）**：为会话在后台跑的那个 pi 进程。
- **运行时代号（runtimeGeneration）**：每成功启动一次加一。进程 pid 不对外暴露，所以它是「真的换了进程」的唯一可判事实。
- **SSE**：服务器推送事件。一条 HTTP 连接上逐行吐 `data: {...}`，不必等全部结束。

## 2 拿到三件东西：地址、令牌、自己的会话 id

服务默认关闭。**设置 → Web 服务 → 开启**，同一页有端口（默认 8765）和访问令牌。

机器上的真值在 `%APPDATA%\PiDeck\settings.json` 的 `webServicePort` 与 `webServiceToken`；Dev 通道的目录叫 `PiDeck Dev`。想确认而不是猜，跑这段（只报有没有令牌，不打印值）：

```bash
node -e 'const fs=require("fs"),path=require("path");const f=path.join(process.env.APPDATA||"","PiDeck","settings.json");const s=JSON.parse(fs.readFileSync(f,"utf8"));console.log("port="+(s.webServicePort||8765),"token="+(s.webServiceToken?"有 "+s.webServiceToken.length+" 字符":"缺失"))'
```

自己的会话 id 不是猜的，是 PiDeck 启动会话时注入的环境变量：

```bash
echo $PIDECK_SESSION_ID
```

为空说明你不在 PiDeck 里跑（比如终端里的 TUI），§4 起的各节都不适用。

**别拿错变量**：`$PI_SESSION_ID` 是 pi 自己的会话 id，不是 PiDeck 的身份。判据：`$PIDECK_SESSION_ID` 能在 `/api/state` 的 `sessions[]` 里找到，`$PI_SESSION_ID` 找不到。

三条验证，每条都写出它该返回什么：

```bash
# 1) 服务活着吗（这条不需要令牌）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/api/health     # 期望 200

# 2) 令牌对吗
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8765/api/state                                             # 期望 200；不带令牌是 401

# 3) 我在 runtimes 里吗
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/api/sessions/runtimes   # 期望 200，返回 {runtimes: [...]}
```

三条全过才往下走。第 1 条失败说明服务没开或端口不对，与令牌无关。

## 3 认证：令牌放请求头

```bash
AUTH="Authorization: Bearer $TOKEN"
```

一句话规律：**写操作（POST）只认请求头**；`?token=` 查询参数只对 GET 和 SSE 开放。原因：浏览器的 EventSource 不能自定义请求头，所以给 GET/SSE 开了例外；写操作也开例外的话，令牌会漏进代理日志和浏览器历史。

验证：同一个 GET，令牌放请求头 → 非 401，挪到 `?token=` → 仍非 401；同一个 POST，令牌挪到查询参数 → 401。

## 4 观察自己（只读，最安全）

```bash
SELF="$PIDECK_SESSION_ID"
BASE="http://127.0.0.1:8765"
AUTH="Authorization: Bearer $TOKEN"
```

| 想知道什么 | 命令 | 返回形状（已核对） |
|---|---|---|
| 我的完整时间线 | `curl -s -H "$AUTH" $BASE/api/sessions/$SELF/messages` | `{messages, total, windowStart, truncated}` |
| 我的运行时还活着吗 | `curl -s -H "$AUTH" $BASE/api/sessions/runtimes`，找 `sessionId == $SELF` 那项 | `{runtimes: [{sessionId, agentId, runtimeGeneration, status, cwd, sessionPath}]}` |
| 我的 todo | `curl -s -H "$AUTH" $BASE/api/sessions/$SELF/todo` | `{todo}` |
| 我派了几个子 agent | `curl -s -H "$AUTH" $BASE/api/sessions/$SELF/subagents` | `{subagents}` |

`/messages` 返回的是**有界窗口**，不是全部历史（长会话上千条，全吐会卡住）。`truncated: true` 说明还有更早的，翻页用：

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/$SELF/messages/page?before=<windowStart>&pageSize=100"
```

**两条禁令**，违反的后果不是「报错」而是「把自己弄坏」：

- 不要对自己 `POST /api/chat`：那等于往自己身上再排一条用户消息，会自我克隆。
- 不要对自己 `runtime/stop`、`runtime/restart`、`runtime/abort`：那是把自己杀掉或打断。

读自己随便读。写自己只在用户明确要求、且按 §5 由另一个会话来发时做。

## 5 重启：你关不掉自己，让别人关

**重启自己和重启别人是同一个动作**：从 `runtimes[]` 取目标，`POST .../runtime/stop`，等它从列表消失，再 `POST .../runtime/activate`。区别只在于**谁发这两个请求**。

自己不能发，理由在 §4：stop 杀掉的是**发起请求的那个进程**，你自己发就没人接 activate。所以这条路只有一个形式——由另一个会话驱动。

### 5.1 让别的会话重启你

脚本 `restart-peer.mjs` 随技能安装，由**协作会话**执行，参数是目标会话 id：

```bash
node ~/.pi/agent/pideck-skills/pideck-web-api/restart-peer.mjs --target <目标 sessionId> --message "重启完成，这条消息用来验证目标能被唤醒"
```

**不用固定等待**。脚本先订阅目标的事件流，再按判据动手：

- 看到本轮结束帧（`finish` 或 `[DONE]`）：目标刚回完话，立刻 stop，回复不会被截断。
- 8 秒内没有任何 `data:` 帧：目标当前没有回合在跑，立刻 stop。
- 默认上限 120 秒；超时不动作，报 `wait-failed`。目标一直在流式输出时不硬来。

三个开关：`--no-wait` 不等直接动手；`--wait-only` 只判定不动手（不会停任何人）；`--wait-turn-end <毫秒>` 改上限。

它按顺序做五件事，每件写进 `~/.pi/agent/ledger/restart-peer.log`：

1. 从 `runtimes[]` 取目标的 `{sessionId, agentId, runtimeGeneration}` 作为基线
2. `stop`，等目标从 `runtimes[]` 消失（最多 60 秒）
3. `activate`
4. 等 `runtimeGeneration` 变化且 `/api/health` 是 200（最多 80 秒）
5. 给目标发一条消息，证明它真的能被唤醒

判据四条，全在日志里：

0. 先出现等待判定：`收到本轮结束帧` 或 `视为没有活跃回合`。
1. `stop -> 200`，随后出现 `目标已停止`。
2. `activate -> 200`，随后出现 `成功：generation N -> N+1，health=200`。
3. `唤醒消息 -> 200`。

最终结论在 `~/.pi/agent/ledger/restart-peer.state.json` 的 `result`，取值见 §5.4。


**实测（2026-11-14，Windows，PiDeck 发行版）**：协作会话 b1e367af 执行本脚本重启 cf4bffc3，日志依次是 `目标已停止` → `成功：generation 2 -> 3，health=200` → `唤醒消息 -> 200`，`state.result` 为 `ok`；被重启方的 `agentId` 由 `3fe9ddcd…` 变为 `a2217435…`。等待判定不用固定时长：目标空闲时 8 秒判 `idle`，目标正在回话时收到第 12 帧即判 `turn-end`（4 秒）。演练最后一步由被重启方执行：它把协作会话停掉（代号 4 → 从 `runtimes[]` 消失），证明两个方向用的是同一套动作。 代发时目标正在回话：订阅后第 78 帧抓到本轮结束，`waitMs` 29 毫秒，整段 3 -> 4 用了 4 秒（旧版固定等 90 秒）。

### 5.2 你重启别人

同一个脚本，`--target` 换成对方的会话 id。**这会真的停掉对方**：先看 `runtimes[]` 里它是不是 `idle`，别打断正在干活的窗口。

### 5.3 没有别的窗口时（只能人工）

你被停之后必须有人接，所以这条路只能由人走：在 PiDeck 里点该会话的「停止」，再点「激活」；或人自己执行 §8 的两条 curl。

**不存在「agent 自己重启自己」的合法路径**——那正是 §4 的禁令。

### 5.4 失败时读哪一行

`restart-peer.state.json` 的 `result`：

| result | 含义 | 你该做什么 |
|---|---|---|
| `ok` | stop、activate、唤醒三步都成 | 无 |
| `no-target` | 目标本来就没在跑 | 直接 activate，不用 stop |
| `stop-timeout` | 没停稳，旧运行时可能还在 | **不要再发 activate**，先确认状态 |
| `start-failed` | 启动三次都没起来 | 人工在 PiDeck 里点激活 |
| `up-but-unhealthy` | 代号变了但 health 不是 200 | 查端口是否被别的实例占了 |
| `messaged: error` | 重启成功但唤醒消息没发出去 | 重启已成功，别重做 |

### 5.5 三条验收判据

1. `/api/sessions/runtimes` 返回的 `runtimes[]` 里，目标那项的 `runtimeGeneration` 变了。**动作接口返回 200 不算**——那只说明请求收到了。
2. `/api/health` 返回 200。
3. `restart-peer.state.json` 的 `result` 是 `ok`。

### 5.6 两条反直觉的事实

- **界面显示「异常停下」不是失败**，那是 stop 动作本身。成败只能读日志文件，不要看界面。
- **重启后你是新进程**：它不会自动读日志，也不知道上一轮在干什么。会话历史仍在同一个 jsonl（`runtimes[].sessionPath`），上下文不丢；但「成没成」必须由重启后的一方读 `restart-peer.log` 与 `restart-peer.state.json` 确认。

### 5.7 什么时候不要做

- 目标正在跑回合：先等它结束，否则唤醒消息会排在它后面。
- 没有第二个活着的窗口或脚本能接：别停。没有接的人，就是永久停着。

## 6 找别的会话

```bash
curl -s -H "$AUTH" "$BASE/api/state" | jq '.sessions[] | {id, title, status}'
```

`/api/state` 一次返回：`projects[]`、`sessions[]`、`runtimes[]`、`pendingUiRequests[]`。

- `sessions[]` 是**所有会话**，含没在跑的，字段有 `id`、`title`、`status`。
- `runtimes[]` 是**此刻正在跑的进程**，每项 `{sessionId, agentId, runtimeGeneration}`。

要做 §8 的动作，先从 `runtimes[]` 里取出目标那一项，整项原样回传。

列表里找不到某会话，不等于它不存在：先确认 `projects[]` 里有它所属的项目。

## 7 发消息并读回复

**最容易猜错的一步**：请求体不是 `{message: "..."}`，而是完整的消息数组。

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<目标 sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"你的问题"}]}]}' \
  http://127.0.0.1:8765/api/chat
```

返回是 SSE，逐行 `data: {...}`。拼回复只需认五种帧：

| type | 含义 |
|---|---|
| `reasoning-delta` | 思维链片段，文本在 `delta` |
| `text-delta` | 正文片段，文本在 `delta` |
| `tool-input-available` | 模型发起了一次工具调用 |
| `tool-output-available` | 工具返回了结果 |
| `tool-output-error` | 工具失败了 |

`-N` 关掉 curl 的缓冲。不加就看不到流式，会一直等到结束才吐。

两个常见错误码：`webError.requestIdRequired`（请求体缺 `id`）、`webError.messageRequired`（`messages` 里没有 role 为 user 的项，或 text 为空）。

## 8 停止 / 启动 / 重启别人的运行时

§5.2 的脚本就是这一节三个动作的封装。要手工调或写自己的工具时，用下面的原样请求。

动作挂在 `/api/sessions/<id>/runtime/<action>`，常用四个：`activate`（启动）、`stop`（停止）、`abort`（只中止当前回合，不停进程）、`restart`（重启）。

```bash
# 第一步：取 target，整项原样来自 runtimes[]
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes"

# 第二步：发动作，请求体带完整 target
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"target":{"sessionId":"…","agentId":"…","runtimeGeneration":N}}' \
  "$BASE/api/sessions/<sessionId>/runtime/stop"
```

**验证**：动作之后再读一次 `runtimes[]`，`runtimeGeneration` 变了才算真的换了进程。接口返回 200 不算。

## 9 最终自检

按危险程度分三级，做到哪级说哪级：

1. **能观察自己**（只读，无风险）：`echo $PIDECK_SESSION_ID` 非空，且这个 id 出现在 `/api/state` 的 `sessions[]` 里。
2. **能读别人的状态**（只读，无风险）：`/api/state` 的 `sessions[]` 里能看到别的会话标题。
3. **能驱动别人**（写别人，有风险）：对**你确认空闲**的目标发一条 `ping`，收到 `text-delta`。要验「真进程」再对它 stop + activate，`runtimeGeneration` 变了才算；这一步会打断对方，别对正在干活的会话做。

## 10 边界

- 只读 pi 的会话文件，不要改 `~/.pi/agent/sessions/*.jsonl`（PiDeck 仓库明令禁止直接改）。
- 端点全集以源码仓的 `src/main/web/WebApiRoutes.ts` 为准。本文是 2026-11 的实测记录，两者不一致时信源码。
- 本文每条命令都在本机发行版上跑过并写出期望返回；数字或形状不符说明版本变了。
- `cross-restart.mjs` 会真的停掉目标会话，别对正在干活的窗口用；它只停参数里指定的那个，不读环境变量，所以不存在「误重启自己」。
