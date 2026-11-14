---
name: pideck-web-api
description: "当你要用脚本或另一个 agent 控制 PiDeck 时用：自动化、CI、跨进程协作，或让 agent 自检当前会话状态。走 HTTP，能读自己的时间线／运行时／todo，也能给别的窗口发消息、读它的思维链、重启某个运行时（由另一个会话代发 stop 与 activate，脚本随技能安装）。不用于修改 PiDeck 源码，也不用于浏览器自动化。Use for PiDeck web API, SSE stream."
---

# PiDeck Web API（pideck-web-api）

**一句话：PiDeck 每个窗口在后台跑一个 pi 进程，同时开一个只监听 127.0.0.1 的 HTTP 服务。用这个服务，agent 能读自己的状态、给别的窗口发消息、让另一个会话把自己重启。**

## 0 先选分支

按你要做的事读那一节，不必通读。三节都要求先做完 §2。

| 你想做的事 | 会动别人的进程吗 | 读哪节 |
|---|---|---|
| 读自己的时间线、todo、子 agent、运行状态 | 不会 | §4 |
| 重启某个运行时（自己或别人） | 会，目标被停 | §5 |
| 找到别的会话、给它发消息、读它的回复 | 不会停它，但会插进它的对话 | §6、§7 |
| 手工调 stop／activate／abort | 会，目标被停 | §8 |

## 1 五个词

- **会话（session）**：PiDeck 侧边栏里的一行。会话可以存在，但此刻没在跑。
- **运行时（runtime）**：为某个会话在后台跑的那个 pi 进程。会话是记录，运行时是进程。
- **运行时代号（runtimeGeneration）**：每成功启动一次加一。进程 pid 不对外暴露，所以「代号变了」是「真的换了进程」的唯一可判事实。
- **回合（turn）**：你收到一条用户消息、干完活、回完话，这一段叫一个回合。运行时在跑回合时不能安全地被停（回复会断在半句）。
- **SSE**：服务器推送事件。一条 HTTP 连接上逐行吐 `data: {...}`，不必等全部结束。

## 2 拿到三件东西：地址、令牌、自己的会话 id

服务默认关闭。**设置 → Web 服务 → 开启**；同一页有端口（默认 8765）和访问令牌。

机器上的真值在 `%APPDATA%\PiDeck\settings.json` 的 `webServicePort` 与 `webServiceToken`；Dev 通道的目录叫 `PiDeck Dev`。先确认有没有，不打印令牌：

```bash
node -e 'const fs=require("fs"),path=require("path");const f=path.join(process.env.APPDATA||"","PiDeck","settings.json");const s=JSON.parse(fs.readFileSync(f,"utf8"));console.log("port="+(s.webServicePort||8765),"token="+(s.webServiceToken?"有 "+s.webServiceToken.length+" 字符":"缺失"))'
```

把令牌放进 shell 变量（只进当前进程的内存，不回显；命令历史里会有一次明文，别在共用机器上跑）：

```bash
TOKEN=$(node -e 'const fs=require("fs"),path=require("path");const s=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,"PiDeck","settings.json"),"utf8"));process.stdout.write(s.webServiceToken||"")')
```

自己的会话 id 是 PiDeck 启动会话时注入的环境变量，不用猜：

```bash
echo $PIDECK_SESSION_ID
```

为空说明你不在 PiDeck 里跑（比如终端里的 TUI），§4 起各节都不适用。

**别拿错变量**：`$PI_SESSION_ID` 是 pi 自己的会话 id。判据是 `$PIDECK_SESSION_ID` 能在 `/api/state` 的 `sessions[]` 里找到，`$PI_SESSION_ID` 找不到。

三条验证，每条都带它该返回的值：

```bash
# 1) 服务活着吗（唯一免鉴权的端点）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/api/health        # 期望 200

# 2) 令牌对吗
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8765/api/state                                                # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/api/state         # 期望 401

# 3) 我在 runtimes 里吗
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/api/sessions/runtimes   # 期望 200，返回 {runtimes: [...]}
```

三条全过再往下。第 1 条失败说明服务没开或端口不对，与令牌无关。

## 3 认证：令牌放请求头

```bash
AUTH="Authorization: Bearer $TOKEN"
```

**写操作（POST）只认请求头**；`?token=` 查询参数只对 GET 和 SSE 开放。原因是浏览器的 EventSource 不能自定义请求头，所以给 GET/SSE 开了例外；写操作也开例外的话，令牌会漏进代理日志和浏览器历史。

三条实测，直接跑（只需要 §2 里拿到的 $TOKEN）：

```bash
curl -s -o /dev/null -w 'POST 无令牌=%{http_code}\n' -X POST -H "Content-Type: application/json" -d '{}' \
  "http://127.0.0.1:8765/api/sessions/$PIDECK_SESSION_ID/runtime/abort"                                   # 期望 401
curl -s -o /dev/null -w 'POST 令牌放查询参数=%{http_code}\n' -X POST \
  "http://127.0.0.1:8765/api/sessions/$PIDECK_SESSION_ID/runtime/abort?token=$TOKEN" -H "Content-Type: application/json" -d '{}'   # 期望 401
curl -s -o /dev/null -w 'GET 令牌放查询参数=%{http_code}\n' "http://127.0.0.1:8765/api/state?token=$TOKEN"            # 期望 200
```

注：带请求头的 POST 会进到处理器，参数不全时返回 400（不是 401）—— 区分「没鉴权」和「参数不对」看状态码就够。

## 4 观察自己（只读，不改任何东西）

```bash
SELF="$PIDECK_SESSION_ID"
BASE="http://127.0.0.1:8765"
AUTH="Authorization: Bearer $TOKEN"
```

| 想知道什么 | 命令 | 返回（已核对） |
|---|---|---|
| 我的时间线 | `curl -s -H "$AUTH" $BASE/api/sessions/$SELF/messages` | `{messages, total, windowStart, truncated}` |
| 我的运行时 | `curl -s -H "$AUTH" $BASE/api/sessions/runtimes`，找 `sessionId == $SELF` 那项 | `{runtimes: [{sessionId, agentId, runtimeGeneration, status, cwd, sessionPath}]}` |
| 我的 todo | `curl -s -H "$AUTH" $BASE/api/sessions/$SELF/todo` | `{todo}` |
| 我派出去的子 agent（subagent） | `curl -s -H "$AUTH" $BASE/api/sessions/$SELF/subagents` | `{subagents}` |

**`status` 别当忙闲用**：它是进程状态（`running` / `idle`），不保证反映「有没有回合在跑」。要判这个，用 §5.1 的 `--wait-only`。

**`sessionPath` 的文件名不是 `sessionId`**，这是本节最容易扑空的一处。PiDeck 的会话 id 形如
`81ad8718-4057-…`；pi 自己的会话 id 形如 `01a1d27c-fe94-…`，两者不同号。所以拿 PiDeck id 去
`~/.pi/agent/sessions/` 里 `ls | grep` 找不到任何文件——路径只能从 `runtimes[].sessionPath` 拿，
那是一整条绝对路径：

```
…/sessions/--c--users-…-chat-workspace--/2026-11-13T01-19-29-430Z_01a1d27c-fe94-….jsonl
                                                    └ 带时间的目录 ┘   └── pi 的 session id ──┘
```

2026-11-14 实测：连续两次用 PiDeck id 的前 8 位当文件名去 grep，两次都扑空，白等两轮。

**要知道一个会话有多少条消息，别去 `/api/state` 找**。那里的 `sessions[]` 每项只有
`{id, projectId, title, status, model, thinkingLevel, updatedAt, createdAt}`，没有条数字段。
条数在 `/api/sessions/<id>/messages` 的 `total` 里，那要单独请求一次。

`/messages` 返回的是**有界窗口**，不是全部历史（长会话上千条，一次全吐会卡住）。看到 `truncated: true` 说明还有更早的，翻页用：

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/$SELF/messages/page?before=<windowStart>&pageSize=100"
```

**两条禁令**，违反的后果不是报错，而是把自己弄坏：

- 不要对自己 `POST /api/chat`：那等于给自己再排一条用户消息，会自我克隆。
- 不要对自己 `runtime/stop`、`runtime/restart`、`runtime/abort`：stop 杀掉的就是发请求的那个进程，你停了自己就没人接 activate。

读自己随便读；写自己只能按 §5 由别的会话来发。

## 5 重启：你关不掉自己，让别人关

**重启自己和重启别人是同一个动作**：从 `runtimes[]` 取目标，`POST .../runtime/stop`，等它从列表消失，再 `POST .../runtime/activate`。区别只在于**谁发这两个请求**，而 §4 已经说明你自己发不了。

### 5.1 让别的会话重启你

**先选对协作会话**：你需要一个「此刻没在干活」的会话替你发指令。判法是把 `/api/state` 返回的两个
数组对一遍——`sessions[]` 列出全部会话，`runtimes[]` 列出此刻真的在跑的；只有出现在前者、不在后者
的那些才是空闲的。

不要选正在跑的：它可能正忙自己的任务，你这条消息会插进它手里的事，它回的是它的任务，不是你的指令。

都忙的话，在 PiDeck 里新开一个空会话（新会话会自动启动，不用额外操作），或者让人按 §5.3 手工点。

把下面这条命令交给那个**空闲协作会话**执行（不是你自己执行），参数是你要重启的那个会话 id：

```bash
node ~/.pi/agent/pideck-skills/pideck-web-api/restart-peer.mjs --target <目标 sessionId> --message "重启完成，这条消息用来验证目标能被唤醒"
```

脚本不会傻等固定秒数，它先订阅目标的事件流，再按两条判据之一动手：

- 看到本轮结束帧（`finish` 或 `[DONE]`）：目标刚回完话，立刻 stop，回复不会被截断。
- 8 秒内没有任何 `data:` 帧：目标当前没有回合在跑，立刻 stop。

默认上限 120 秒；超时就不动作，报 `wait-failed`，不硬来。三个开关：`--no-wait` 不等直接动手；`--wait-only` 只判定不动手（不会停任何人）；`--wait-turn-end <毫秒>` 改上限。

它按顺序做五件事，每件都写进 `~/.pi/agent/ledger/restart-peer.log`：

1. 从 `runtimes[]` 取目标的 `{sessionId, agentId, runtimeGeneration}` 作为基线
2. `stop`，等目标从 `runtimes[]` 消失（最多 60 秒）
3. `activate`
4. 等 `runtimeGeneration` 变化且 `/api/health` 是 200（最多 80 秒）
5. 给目标发一条消息，证明它真的能被唤醒

判据四条，都在日志里：

1. 先出现等待判定：`收到本轮结束帧` 或 `视为没有活跃回合`。
2. `stop -> 200`，随后出现 `目标已停止`。
3. `activate -> 200`，随后出现 `成功：generation N -> N+1，health=200`。
4. `唤醒消息 -> 200`。

最终结论在 `~/.pi/agent/ledger/restart-peer.state.json` 的 `result`，取值见 §5.4。

**实测（2026-11-14，Windows，PiDeck 发行版）**：协作会话 b1e367af 重启 cf4bffc3，日志依次是 `目标已停止` → `成功：generation 3 -> 4，health=200，总耗时 4 秒` → `唤醒消息 -> 200`；`state` 里 `waited: turn-end`、`waitMs: 29`，被重启方的 `agentId` 由 `a2217435…` 变为 `f547f8fb…`。目标是空闲状态时，同一条路径 8 秒判定 `idle` 后动手。

### 5.2 你重启别人

同一个脚本，`--target` 换成对方会话 id。**这会真的停掉对方**，停之前先确认它没有回合在跑——最省事的办法是先用 `--wait-only` 判一次：

```bash
node ~/.pi/agent/pideck-skills/pideck-web-api/restart-peer.mjs --target <对方 sessionId> --wait-only
```

它只打印判定（`idle` / `turn-end` / `cap`），不动任何人。判成 `cap` 说明对方一直在输出，等它自己停下再说。

### 5.3 没有别的窗口时（只能人工）

你被停之后必须有人接。所以这条路只能由人走：在 PiDeck 里点该会话的「停止」，再点「激活」；或人自己执行 §8 的两条 curl。

不存在「agent 自己重启自己」的路径。硬来（`--no-wait` 指向自己）等于自杀：进程没了，没有人发 activate。

`~/.pi/agent/bin/self-restart.mjs` 曾经提供过这条捷径：起一个脱离进程树的守卫，由守卫替你 stop 再
activate，实测成功过三次。2026-11-14 删掉了。原因不是它不成立，是它和上面那句禁令冲突——文档里
写着「不许自己停」，bin 目录里却有个专门干这个的脚本。两句话同时在的时候，agent 会挑省事的那句
执行，当天就是这么发生的。删掉脚本后，只剩「让别人关」这一条路。

### 5.4 失败时读哪一行

`restart-peer.state.json` 的 `result`：

| result | 含义 | 你该做什么 |
|---|---|---|
| `ok` | 停、启、唤醒都成 | 无 |
| `no-target` | 目标本来就没在跑 | 直接 activate，不用 stop |
| `stop-timeout` | 没停稳，旧运行时可能还在 | **不要再发 activate**，先确认状态 |
| `start-failed` | 启动三次都没起来 | 人工在 PiDeck 里点激活 |
| `up-but-unhealthy` | 代号变了但 health 不是 200 | 查端口是否被别的实例占了 |
| `wait-failed` | 等待上限内目标一直在输出，脚本主动放弃 | 稍后再跑一次；目标停下来后会自动很快 |

唤醒消息是否发出是另一个字段 `messaged`，与 `result` 并列：`messaged` 是 200 表示发出去了；失败不影响「重启已成功」这个结论。

状态文件每开一轮就整份覆盖，所以看到 `no-target` 时不会残留上一轮的 `genBefore`／`genAfter`。看到这些字段，说明那一轮真的取到过基线。

### 5.5 两条反直觉的事实

- **界面显示「异常停下」不是失败**，那是 stop 动作本身。成败只能读日志文件，不要看界面。
- **重启后你是新进程**：它不会自动读日志，也不知道上一轮在干什么。会话历史仍在同一个 jsonl（`runtimes[].sessionPath`），上下文不丢；但「成没成」必须由重启后的一方读 `restart-peer.log` 与 `restart-peer.state.json` 确认。

### 5.6 什么时候不要做

- 没有第二个活着的窗口或脚本能接：别停。没有接的人，就是永久停着。
- 目标正在跑长回合：可以等（脚本默认会等），也可以稍后再来；不要在它写到一半时用 `--no-wait`。

## 6 找别的会话

```bash
curl -s -H "$AUTH" "$BASE/api/state" | jq '.sessions[] | {id, title, status}'
```

`/api/state` 至少返回 `projects[]`、`sessions[]`、`runtimes[]`、`pendingUiRequests[]`。

- `sessions[]` 是**所有会话**，含没在跑的，字段有 `id`、`title`、`status`。
- `runtimes[]` 是**此刻正在跑的进程**，每项含 `{sessionId, agentId, runtimeGeneration, status, cwd, sessionPath}`。

要做 §8 的动作，先从 `runtimes[]` 里取出目标那一项，整项原样回传。

列表里找不到某会话，不等于它不存在：先确认 `projects[]` 里有它所属的项目。

## 7 发消息并读回复

**最容易猜错的一步**：请求体不是 `{message: "..."}`，而是完整的消息数组。

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<目标 sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"你的问题"}]}]}' \
  http://127.0.0.1:8765/api/chat
```

返回是 SSE，逐行 `data: {...}`。你只需要认这几类帧：

| type | 含义 |
|---|---|
| `start-step` | 本轮开始 |
| `finish` / `[DONE]` | 本轮结束（§5.1 用它判时机） |
| `reasoning-delta` | 思维链片段，文本在 `delta` |
| `text-delta` | 正文片段，文本在 `delta` |
| `tool-input-available` | 模型发起了一次工具调用 |
| `tool-output-available` / `tool-output-error` | 工具返回了结果 / 失败了 |

`-N` 关掉 curl 的缓冲。不加就看不到流式，会一直等到结束才吐。

两个常见错误码：`webError.requestIdRequired`（请求体缺 `id`）、`webError.messageRequired`（`messages` 里没有 role 为 user 的项，或 text 为空）。

**这条请求是异步入队，不是同步流**。消息进了目标会话的队列就返回，HTTP 可能一个帧都不吐（实测
curl 挂 5 秒收到 0 帧），而目标照样开始干活。所以**送达的判据是回读 `messages` 的 `total` 加没加**，
不是「收到 `start-step`」。想要流式帧就一路挂着 SSE 等；只想确认送到了，读 `total` 更快。

两件事要分开：

- **目标没在跑**：`/api/chat` 返回 `200`、0 帧、`total` 不变。这是真没送到。先 `runtime/activate`，
  等它进 `runtimes[]`，再发。
- **目标在跑但忙**：返回 `200`、0 帧，但 `total` 会加一。消息已入队，等它做完手上的事就轮到这条。

2026-11-14 实测：对一个 `status: idle`、已在 `runtimes[]` 里的会话，curl 5 秒 0 帧，`total` 从 7395
涨到 7396，几十秒后它开始做题。

## 8 停止 / 启动 / 重启：原样请求

§5.2 的脚本是这一节三个动作的封装。要手工调、或自己写工具时，用下面的请求。

动作挂在 `/api/sessions/<id>/runtime/<action>`，常用四个：`activate`（启动）、`stop`（停止）、`abort`（只中止当前回合，不停进程）、`restart`（重启）。

```bash
# 第一步：取 target，整项原样来自 runtimes[]
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes"

# 第二步：发动作，请求体带完整 target
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"target":{"sessionId":"…","agentId":"…","runtimeGeneration":N}}' \
  "$BASE/api/sessions/<sessionId>/runtime/stop"
```

**`activate` 是唯一不带 target 的动作**。它要做的正是「这个冷会话（此刻不在 `runtimes[]` 里）现在
起来」，所以没有 target 可回传。body 传 `{}` 就行，响应直接给新的 runtime 对象：

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
  "$BASE/api/sessions/<sessionId>/runtime/activate"
```

2026-11-14 实测：目标是一个 7389 条历史、压缩过 23 次、`runtimes[]` 里没有的会话。这条请求返回 200，
body 里带 `agentId`、`runtimeGeneration: 3`、`status: "idle"`、`compactionCount: 23`；紧接着 `runtimes[]`
里就有它了。另外三个（`stop` / `abort` / `restart`）都要完整 target——它们作用在已经存在的进程上。

**验证**：动作之后再读一次 `runtimes[]`，`runtimeGeneration` 变了才算真的换了进程。接口返回 200 不算——那只说明请求收到了。

## 9 最终自检

按危险程度分三级，做到哪级说哪级：

1. **能观察自己**（只读）：`echo $PIDECK_SESSION_ID` 非空，且这个 id 出现在 `/api/state` 的 `sessions[]` 里。
2. **能读别人**（只读）：`/api/state` 的 `sessions[]` 里看得到别的会话标题。
3. **能驱动别人**（会改动别人）：对目标发一条 `ping`，收到 `text-delta`。要验「真进程」，再走一次 §5.2；`runtimeGeneration` 变了才算。停别人的运行时会打断它的回合，所以先把 §5.2 的 `--wait-only` 跑一遍再动手。

## 10 边界

- 只读 pi 的会话文件，不要改 `~/.pi/agent/sessions/*.jsonl`（PiDeck 仓库明令禁止直接改）。
- 端点全集以源码仓的 `src/main/web/WebApiRoutes.ts` 为准；本文是 2026-11 的实测记录，不一致时信源码。
- 本文每条命令都在本机发行版上跑过并写出期望返回；数字或形状不符说明版本变了。
- `restart-peer.mjs` 会真的停掉 `--target` 指定的会话，不读环境变量，所以不会误停你自己；但也别把它指向正在干活的窗口。
