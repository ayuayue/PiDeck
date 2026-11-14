---
name: pideck-web-api
description: "当你要用脚本或另一个 agent 控制 PiDeck 时用：自动化、CI、跨进程协作，或让 agent 自检当前会话状态。走 HTTP，能读自己的时间线／运行时／todo，也能给别的窗口发消息、读它的思维链、重启它的运行时。不用于修改 PiDeck 源码，也不用于浏览器自动化。Use for PiDeck web API, SSE stream."
---

# PiDeck Web API（pideck-web-api）

**一句话：PiDeck 每个窗口在后台跑一个会话，同时开一个只监听本机的 HTTP 服务；本技能教你怎么用这个服务读自己的状态、给别的窗口发消息、以及安全地重启运行时。**

## 0 这是什么

PiDeck 是桌面应用。**一个窗口 = 一个会话 = 一个在后台跑的 pi agent 进程**（下文叫「运行时」）。

PiDeck 内置一个 HTTP 服务，只监听 `127.0.0.1`，外部访问不到。**它默认关闭**，所以第一件事是打开：

```
设置 → Web 服务 → 开启
```

同一页还有两个值后面每一节都要用：**端口**（默认 `8765`）和**访问令牌**。

打开后有两种用法，风险完全不同：

| 用法 | 读还是写 | 影响范围 |
|---|---|---|
| 观察自己 | 只读 | 只有本会话，出错也不改变任何东西 |
| 驱动别的窗口 | 读写 | 会改变别人的会话状态 |

本文的端点没有全量复制：全集在源码仓的 `src/main/web/WebApiRoutes.ts`（相对仓库根）。装的是发行版时这个文件不存在——那时以本文的实测结果为准，并记下你的 PiDeck 版本号。

## 1 先证明连通

三件东西缺一就跑不通，每件都配一条能立刻验证的命令：

| 需要 | 从哪拿 | 验证命令 |
|---|---|---|
| 地址 | 设置 → Web 服务 → 端口，默认 8765 | `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/api/health` → `200` |
| 令牌 | 同一页的访问令牌 | 带上它能读 `/api/state` → 200；不带 → 401 |
| 会话 id | 自己的：`echo $PIDECK_SESSION_ID`；别人的：`/api/state` 的 `sessions[]` | 拿到的 id 能在 `sessions[]` 里找到 |

`/api/health` 是唯一免鉴权的端点，专门用来做第一条验证——连不上就说明服务没开或端口不对，和令牌无关。

## 2 认证：令牌放请求头

```bash
AUTH="Authorization: Bearer $TOKEN"
```

规律一句话：**写操作（POST）只认请求头**；`?token=` 查询参数只对 GET 和 SSE 开放。

为什么有这个区别：浏览器的事件流（EventSource）不能自定义请求头，所以给 GET/SSE 开了查询参数的例外；如果写操作也开，令牌会漏进代理日志和浏览器历史。

验证：同一个请求，令牌放请求头 → 非 401；挪到 `?token=` → 401。

## 3 观察自己（只读，最安全）

你的身份不是猜的，是 PiDeck 启动会话时注入的环境变量：

```bash
SELF="$PIDECK_SESSION_ID"   # 为空 = 你不是 PiDeck 启动的会话（比如终端里的 TUI），本节不适用
```

**别拿错变量**：`PI_SESSION_ID` 是 pi 自己的会话 id，不是 PiDeck 的身份。验证：`$SELF` 能在 `/api/state` 的 `sessions[]` 里找到，`PI_SESSION_ID` 找不到。

能读自己的四样东西，全部只读：

| 想知道什么 | 命令 |
|---|---|
| 我的完整时间线 | `curl -s -H "$AUTH" http://127.0.0.1:8765/api/sessions/$SELF/messages` |
| 我的运行时还活着吗 | `curl -s -H "$AUTH" http://127.0.0.1:8765/api/sessions/runtimes`，找 `sessionId == $SELF` 那项 |
| 我的 todo | `curl -s -H "$AUTH" http://127.0.0.1:8765/api/sessions/$SELF/todo` |
| 我派了几个子 agent | `curl -s -H "$AUTH" http://127.0.0.1:8765/api/sessions/$SELF/subagents` |

`/messages` 返回的是**有界窗口**，不是全部历史（长会话可能有上千条，一次全吐会卡住）：返回值是 `{messages, total, windowStart, truncated}`。看到 `truncated: true` 说明还有更早的，翻页用 `/api/sessions/$SELF/messages/page?before=<windowStart>&pageSize=N`。

验证：`.../messages | jq '.total'` 返回一个数字（不是 null），说明这条路通。

**两条禁令**（写自己会把自己弄坏，除非按第 4 节起守卫）：

- 不要对自己 `POST /api/chat`：那等于往自己身上再排一条用户消息，会自我克隆。
- 不要对自己 `runtime/stop`、`runtime/restart`、`runtime/abort`：那是把自己杀掉或打断。

读自己随便读，写自己只在用户明确要求、并且按第 4 节起了守卫时才做。

## 4 重启自己（可以做，但必须先起守卫）

**先解释什么是守卫**：一个独立的进程，在你被停掉之后还活着，负责把你重新启动起来。没有它，你停下来就没人发启动命令了——这才是第 3 节那条禁令的实质：不是「不许自重启」，而是「不许没有人接的自杀」。

脚本随本技能一起安装：

```bash
# 干跑：打印会话 id、当前运行时代号、计划，什么都不做
node ~/.pi/agent/pideck-skills/pideck-web-api/self-restart.mjs

# 真跑：起一个守卫，本进程随即被停掉
node ~/.pi/agent/pideck-skills/pideck-web-api/self-restart.mjs --go

# 重启完成后读结果（真跑时这是你唯一能看到结果的地方）
tail -f ~/.pi/agent/ledger/self-restart.log
```

**运行时代号**（`runtimeGeneration`）：每成功启动一次加一。进程 pid 不对外暴露，所以它是「真的换了进程」的唯一可判事实。

三个设计约束，每条都对应一种真实的死法：

| 约束 | 不做会怎样 |
|---|---|
| 守卫以脱离进程树的方式启动（detached + unref） | 它和会话一起被停掉，会话永久停着 |
| 身份只从 `$PIDECK_SESSION_ID` 取，不接受参数覆盖 | 会变成「重启别人」的工具，误伤正在干活的窗口 |
| 启动失败重试 3 次，单次等 80 秒，总计上限 150 秒 | 留下一个半死的运行时，比干脆停着更难查 |

**验收判据三条，缺一条都算没成功：**

1. `runtimes[]` 里自己那项的 `runtimeGeneration` 变了。返回 200 不算。
2. `/api/health` 返回 200。
3. `~/.pi/agent/ledger/self-restart.state.json` 的 `result` 是 `ok`。

**实测记录（2026-11-14）**：`stop → 已停止 → activate 第 1 次 → 200 → 代号 1 → 2，health=200`，守卫存活 8 秒，跨过了停止动作。注意界面这时会显示「异常停下」——那是停止本身，不是失败。

**不要用界面判断成败，要读文件**：`~/.pi/agent/ledger/self-restart.log` 的最后一行，以及 `self-restart.state.json` 的 `result`。重启之后第一件事就是读这两个，确认上一轮到底成没成。

失败时看停在哪一步：

| result | 含义 | 你该做什么 |
|---|---|---|
| `stop-timeout` | 没停稳，会话可能还在跑 | 不要再发启动命令，先确认状态 |
| `start-failed` | 启动三次都没起来 | 需要人工在 PiDeck 里点激活 |

**两条反直觉的事实**：

- **脱离进程树的判据不是 ppid。** Windows 上 detached 之后 ppid 仍指向原进程（实测 46752），但进程组已经独立，停止命令杀不到它。真判据是「停止之后守卫还能继续写日志」——停止与启动之间写出的每一行都是证据。
- **守卫自己挂了，是唯一无法自愈的情形**（会话停着，守卫也没了）。唯一的退路是让另一个活着的会话重启你：在别的窗口里用第 7 节的 stop + activate，指向你的 sessionId。所以自重启之前先确认至少还有一个窗口活着并且能连上 API——那是你唯一的保险。

**什么时候不要自重启**：会话正在结束（`cleanup` 阶段）时不要做，那时停了之后没有启动的时机。真跑之前还要确认没有别的会话正通过 `/api/chat` 调你——你会把它们挂在那里等超时。

## 5 找别的会话

```bash
curl -s -H "$AUTH" http://127.0.0.1:8765/api/state | jq '.sessions[] | {id, title, status}'
```

`/api/state` 一次返回四组东西：`projects[]`、`sessions[]`、`runtimes[]`、`pendingUiRequests[]`。

- `sessions[]` 是**所有会话**（含没在跑的），字段有 `id`、`title`、`status`。
- `runtimes[]` 是**当前正在跑的进程**，每项 `{sessionId, agentId, runtimeGeneration}`。调第 7 节的动作时，`target` 就原样回传这一项。

列表里找不到某个会话，不等于它不存在：先确认 `projects[]` 里有目标项目。

## 6 发消息并读回复

**最容易猜错的一步**：请求体不是 `{message: "..."}`，而是完整的消息数组：

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"你的问题"}]}]}' \
  http://127.0.0.1:8765/api/chat
```

返回是 SSE（服务器推送事件：每条消息一行，逐条到达，不用等全部结束）。逐行形如 `data: {...}`。拼回复只需要认四种帧：

| type | 含义 |
|---|---|
| `reasoning-delta` | 思维链的一个片段，文本在 `delta` 字段 |
| `text-delta` | 正文的一个片段，文本在 `delta` 字段 |
| `tool-input-available` | 模型发起了一次工具调用 |
| `tool-output-available` / `tool-output-error` | 工具返回了结果 / 失败了 |

`-N` 是关掉 curl 的缓冲，不加就看不到流式，会一直等到结束才吐。

两个常见错误码：`webError.requestIdRequired`（请求体缺 `id`）、`webError.messageRequired`（`messages` 里没有 role 为 user 的项，或 text 为空）。

## 7 停止 / 启动 / 重启别人的运行时

动作挂在 `/api/sessions/<id>/runtime/<action>`，常用四个：`activate`（启动）、`stop`（停止）、`abort`（只中止当前回合，不停进程）、`restart`（重启）。

```bash
# 第一步：取 target，原样来自 runtimes[] 里的那一项
curl -s -H "$AUTH" http://127.0.0.1:8765/api/sessions/runtimes

# 第二步：发动作，请求体带完整 target
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"target":{"sessionId":"…","agentId":"…","runtimeGeneration":N}}' \
  http://127.0.0.1:8765/api/sessions/<sessionId>/runtime/stop
```

**验证**：动作之后再读一次 `runtimes[]`，`runtimeGeneration` 变了才算真的换了进程。接口返回 200 不算——它只说明请求收到了。

## 8 最终自检

三条都过，才算真的接上了：

1. `echo $PIDECK_SESSION_ID` 非空，且这个 id 出现在 `/api/state` 的 `sessions[]` 里 → 能观察自己。
2. 对别的会话发一条 `ping`，收到 `text-delta` → 能驱动别人。
3. 对别的会话 stop 再 activate，`runtimeGeneration` 变了 → 你控制的是真实进程，不是缓存。

## 边界

- 只读 pi 的会话文件，不要改 `~/.pi/agent/sessions/*.jsonl`（PiDeck 仓库明令禁止直接改）。
- 端点全集以源码仓的 `src/main/web/WebApiRoutes.ts` 为准；本文是 2026-11 的实测记录，两者不一致时信源码。