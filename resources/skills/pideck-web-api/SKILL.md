---
name: pideck-web-api
description: 用 HTTP 观察和驱动 PiDeck 里的会话——既能读自己的时间线、运行时与 todo，也能给别的窗口发消息、读它的思维链、重启它的运行时。当用户想用脚本或另一个 agent 控制 PiDeck（自动化、CI、跨进程协作），或需要 agent 自检当前会话状态时使用；不用于修改 PiDeck 源码，也不用于浏览器自动化。Use for PiDeck web API, SSE stream, driving or inspecting a PiDeck session over HTTP.
---

# PiDeck Web API（pideck-web-api）

**PiDeck 自带 HTTP + SSE 接口。它既能操作别的窗口，也能让当前会话看清自己正在发生什么。**

本技能只写「怎么调通、怎么验证调通了」。端点全集见 `src/main/web/WebApiRoutes.ts`——本文不复制清单，避免两处真值各自漂移。

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

**两条禁令**（写自己会把自己弄坏）：

- 不要对自己 `POST /api/chat`：那是往自己身上再排一条用户消息，等于自我克隆。
- 不要对自己 `runtime/stop|restart|abort`：那是把自己杀掉或打断。

读自己随便读，写自己一律走用户指令。

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
- 端点以 `src/main/web/WebApiRoutes.ts` 为准。跑不通先读那里的路由表，不要照本文猜。
