---
name: pideck-web-api
description: "要用脚本或另一个 agent 控制 PiDeck 时用：自动化、CI、跨进程协作、或让 agent 自检当前会话状态。走 HTTP，能读自己的时间线／运行时／todo，也能给别的窗口发消息、读它的思维链、重启它的运行时。不用于修改 PiDeck 源码，也不用于浏览器自动化。Use for PiDeck web API, SSE stream."
---

# PiDeck Web API（pideck-web-api）


**PiDeck 自带 HTTP + SSE 接口。它既能操作别的窗口，也能让当前会话看清自己正在发生什么。**



本技能只写「怎么调通、怎么验证调通了」。端点全集在 PiDeck 源码仓的 `src/main/web/WebApiRoutes.ts`（相对仓库根，本机装的是发行版时看不到这个文件）——本文不复制清单，避免两处真值各自漂移。

## 0 三个前提，缺一跑不通

| 前提 | 从哪拿 | 判据（跑不通先跑这条） |
|---|---|---|
| 地址 | 设置 → Web 服务 → 端口，默认 `8765` | `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/api/health` → `200` |
| 令牌 | 同一页的访问令牌（鉴权默认开启） | 带到 `/api/state` → 200；不带 → 401 |
| 会话 id | 自己的：`echo $PIDECK_SESSION_ID`；别人的：`/api/state` 的 `sessions[]` | 拿到的 id 能在 `sessions[]` 里找到 |

`/api/health` 是唯一免鉴权端点，专用于第一条判据。

## 1 认证：Bearer 走请求头，token 只在 GET/SSE 能进 query

```bash
AUTH="Authorization: Bearer $TOKEN"
```

- 写操作（POST）**只认 header**。把令牌塞进 `?token=` 会被拒，返回 `webError.unauthorized`。
- 为什么 query 只开给 GET/SSE：浏览器 EventSource 不能带 header；写操作开这个口子会把令牌漏进代理和访问日志。
- 判据：同一请求，令牌在 header → 非 401；挪到 query → 401。

## 2 观察自己（只读，最安全的一档）

身份不是猜出来的，是环境变量给的：

```bash
SELF="$PIDECK_SESSION_ID"   # PiDeck spawn 的会话才有；为空 = 你在 TUI 里跑，本节不适用
```

**别拿错变量**：`PI_SESSION_ID` 是 pi 自己的会话 id，不是 PiDeck 的身份；用它查 `sessions[]` 命中不了。判据：`SELF` 能在 `/api/state` 的 `sessions[]` 里找到，`PI_SESSION_ID` 找不到。

用它读自己（全部只读）：

| 想知道什么 | 命令 |
|---|---|
| 我的时间线 | `curl -s -H "$AUTH" http://127.0.0.1:8765/api/sessions/$SELF/messages` |
| 我的运行时还在不在 | `curl -s -H "$AUTH" http://127.0.0.1:8765/api/sessions/runtimes`，找 `sessionId == $SELF` 的那项 |
| 我的 todo | `curl -s -H "$AUTH" http://127.0.0.1:8765/api/sessions/$SELF/todo` |
| 我派了几个子 agent | `curl -s -H "$AUTH" http://127.0.0.1:8765/api/sessions/$SELF/subagents` |

`/messages` 是**有界窗口**，不是全量：返回 `{messages, total, windowStart, truncated}`。看到 `truncated: true` 说明还有更早的，用 `/api/sessions/$SELF/messages/page?before=<windowStart>&pageSize=N` 往前翻。

自检：`.../messages | jq '.total'` 返回一个数字（不是 null），说明这条路通。

**两条禁令**（无守卫时写自己会把自己弄坏；要自重启走下面 §2.5）：

- 不要对自己 `POST /api/chat`：那是往自己身上再排一条用户消息，等于自我克隆。
- 不要对自己 `runtime/stop|restart|abort`：那是把自己杀掉或打断。

读自己随便读，写自己一律走用户指令。

## 2.5 自重启：能不能停掉自己再起来
**能，但必须先摘出一个守卫。** 技能里原本写着「不要对自己 runtime/stop|restart」，
那条禁令的实质不是「禁止自重启」，而是**禁止没有人接的自杀**——stop 会杀掉发起 stop 的进程，
agent 自己停掉之后没人活着发 activate。
脚本随本技能一起安装（`~/.pi/agent/pideck-skills/pideck-web-api/self-restart.mjs`），三段式：
```bash
node ~/.pi/agent/pideck-skills/pideck-web-api/self-restart.mjs        # 干跑：打印会话 id、当前 generation、计划，不做任何事
node ~/.pi/agent/pideck-skills/pideck-web-api/self-restart.mjs --go   # 真跑：起一个 detached 守卫，本进程随即被 stop 杀掉
tail -f ~/.pi/agent/ledger/self-restart.log  # 守卫写的日志，重启后从这里读结果
```
**三个设计约束**，每条都对应一次会死人的失败：
| 约束 | 不做会怎样 |
|---|---|
| 守卫用 `detached + unref` 起，脱离进程树 | 和 agent 一起被 stop 杀掉，会话永久停着 |
| 身份只从 `$PIDECK_SESSION_ID` 取，不接受参数覆盖 | 变成「重启别人」的工具，误伤正在干活的窗口 |
| activate 失败重试 3 次，每次等 80 秒，总上限 150 秒 | 留一个半死的运行时，比停着更难查 |
**验收判据**（三条，缺一条都算没成功）：
1. `runtimes[]` 里自己那项的 `runtimeGeneration` 变了 —— 返回 200 不算，这是「真的换了进程」的唯一可判事实。
2. `/api/health` 返回 200。
3. 新会话起来后 `~/.pi/agent/ledger/self-restart.state.json` 的 `result` 是 `ok`。
**做不到的时候**：`cleanup` 阶段（会话正在结束）不要自重启，那时 stop 之后没有 activate 的时机。

**第一条实测（2026-11-14）：「stop → 已停止 → activate 第 1 次 → 200 → generation 1 → 2，health=200」，守卫存活 8 秒（跨过 stop）。** 界面会显示「异常停下」——那是 stop 本身，不是失败。

**从界面上分不清成功和失败，所以要读文件**：`~/.pi/agent/ledger/self-restart.log` 最后一行、`~/.pi/agent/ledger/self-restart.state.json` 的 `result`。

**重启之后第一件事**：读这两个文件确认上一轮是什么结果。成功就把 generation 新值记下来；失败就看停在哪一步——`stop-timeout` 是没停稳（会话可能还在跑，别再发 activate），`start-failed` 是起了三次没起来（需要人工在 PiDeck 里点激活）。

**脱离进程树的判据不是 ppid。** Windows 上 `detached + unref` 之后 ppid 仍指向原进程（实测 46752），但进程组独立，stop 杀不到它。真判据是「stop 之后还能写日志」——守卫在停止与启动之间写出的每一行都是证据。

**守卫自己挂了怎么办**：那是唯一无法自愈的情形（会话停着，守卫也没了）。退路是**让另一个会话重启你**：从任何活着的 PiDeck 会话里，用 §6 的 runtime/stop + activate 指向你的 sessionId。所以自重启前先确认还有一个窗口活着并且能连上 API——那是你唯一的保险。
真跑之前先确认没有别的会话正在通过 `/api/chat` 调你——你会把它们挂在那里等超时。
---
## 3 拿别人的会话 id

```bash
curl -s -H "$AUTH" http://127.0.0.1:8765/api/state | jq '.sessions[] | {id, title, status}'
```

`runtimes[]` 是**正在跑的进程**，每项 `{sessionId, agentId, runtimeGeneration}`。两个用途：

- 调 runtime 动作时 `target` 原样回传这一项；
- `runtimeGeneration` 是「重启是否真换了进程」的唯一可判事实。

列表里没有 ≠ 没有这个会话：先确认 `projects[]` 里有目标项目。

## 4 发消息并读回复

body 不是 `{message:"..."}`，而是完整消息数组——最容易猜错的一步：

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"你的问题"}]}]}' \
  http://127.0.0.1:8765/api/chat
```

返回 SSE，逐行 `data: {...}`。拼回复认这几种帧：

| type | 含义 |
|---|---|
| `reasoning-delta` | 思维链片段（`delta`） |
| `text-delta` | 正文片段（`delta`） |
| `tool-input-available` | 模型发起工具调用 |
| `tool-output-available` / `tool-output-error` | 工具返回 / 失败 |

`-N` 关掉 curl 缓冲，否则看不到流式。

错误码：`webError.requestIdRequired`（缺 `id`）、`webError.messageRequired`（没有 role=user 或 text 为空）。

## 5 读别人的历史

```bash
curl -s -H "$AUTH" "http://127.0.0.1:8765/api/sessions/<sessionId>/messages"
```

同样是有界窗口，长历史走 `/messages/page`，不要一次拉全量。

## 6 重启 / 停止别人的运行时

动作挂在 `/api/sessions/<id>/runtime/<action>`：`activate`（启动）、`stop`（停）、`abort`（中止当前回合）、`restart`（重启）。

```bash
# 1) 取 target：原样来自 runtimes[]
curl -s -H "$AUTH" http://127.0.0.1:8765/api/sessions/runtimes
# 2) 动作：body 带完整 target
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"target":{"sessionId":"…","agentId":"…","runtimeGeneration":N}}' \
  http://127.0.0.1:8765/api/sessions/<sessionId>/runtime/stop
```

**判据**：动作后再读 `runtimes[]`，`runtimeGeneration` 变了才算换了进程。返回 200 不算。

## 7 三条自检（都过才算接上）

1. `echo $PIDECK_SESSION_ID` 非空，且能在 `sessions[]` 里找到自己 → 自观通。
2. 对别的会话发一条 `ping`，收到 `text-delta` → 驱动通。
3. 对别的会话 stop + activate 后 `runtimeGeneration` 变了 → 你控制的是真的那个进程。

## 边界

- 只读 pi 的会话文件，不改 `~/.pi/agent/sessions/*.jsonl`（PiDeck 仓库明令禁止）。
- 端点以 PiDeck 源码仓的 `src/main/web/WebApiRoutes.ts` 为准。手边没有源码时以本文实测结果为准，并记下版本号；两者不一致时信源码。
