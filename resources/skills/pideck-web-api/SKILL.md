---
name: pideck-web-api
description: "用 PiDeck 自带的 HTTP 服务读自己的状态、给别的窗口发消息、让别的会话重启自己。当你要用脚本或另一个 agent 控制 PiDeck、做跨进程协作、或检查当前会话状态时用。不用于修改 PiDeck 源码，也不用于浏览器自动化。Use for PiDeck web API, SSE stream."
---

# PiDeck Web API

**PiDeck 每个窗口背后跑一个 pi 进程，同时开一个只监听本机的 HTTP 服务。用这个服务，你能读自己的状态、给别的窗口发消息、让另一个会话把自己重启。**

本文每条命令都在本机发行版上跑过，写了期望返回。数字或形状不符，说明版本变了，以源码仓的 `src/main/web/WebApiRoutes.ts` 为准。

## 0 先确定你要做什么

| 想做的事 | 会打断别人吗 | 读哪节 |
|---|---|---|
| 读自己的时间线、todo、子 agent、运行状态 | 不会 | §3 |
| 找别的会话、发消息、读回复 | 不会停它，但消息会插进它的对话 | §4、§5 |
| 重启某个会话（自己或别人） | 会，目标被停 | §6 |
| 单独停、启动、中止 | 会，目标被停 | §7 |

§2 是所有节的前提，先做完。

## 1 三个词

- **会话**：PiDeck 侧边栏里的一行。会话可以存在，但此刻没在跑。
- **运行时**：为某个会话在后台跑的那个 pi 进程。会话是记录，运行时是进程。
- **运行时代号（runtimeGeneration）**：每成功启动一次加一。进程号不对外暴露，所以「代号变了」是「真的换了进程」的唯一证据。

## 2 连上：地址、令牌、自己的会话 id

**服务默认关闭**，在 PiDeck 的「设置 → Web 服务」里打开。端口默认 8765，令牌在同一页。

机器上的真值在 `%APPDATA%\PiDeck\settings.json`（Dev 通道的目录叫 `PiDeck Dev`）。取令牌放进变量，不回显：

```bash
TOKEN=$(node -e 'const fs=require("fs"),path=require("path");const s=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,"PiDeck","settings.json"),"utf8"));process.stdout.write(s.webServiceToken||"")')
AUTH="Authorization: Bearer $TOKEN"
BASE="http://127.0.0.1:8765"
```

自己的会话 id 是 PiDeck 启动会话时注入的环境变量，不用猜：

```bash
echo $PIDECK_SESSION_ID
```

为空说明你不在 PiDeck 里跑（比如终端里的 TUI），后面各节都不适用。

**别拿错变量**：`$PI_SESSION_ID` 是 pi 自己的会话 id，不是 PiDeck 的身份。分辨办法：`$PIDECK_SESSION_ID` 能在 `/api/state` 的 `sessions[]` 里找到，`$PI_SESSION_ID` 找不到。

三条验证，每条都写了该返回什么：

```bash
# 1) 服务活着吗。这是唯一免鉴权的端点
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/health"                      # 期望 200

# 2) 令牌对吗
curl -s -o /dev/null -w '%{http_code}\n' -H "$AUTH" "$BASE/api/state"            # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/state"                      # 期望 401

# 3) 我在运行中吗
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes"                                 # 期望 200，返回 {runtimes:[...]}
```

第 1 条失败说明服务没开或端口不对，与令牌无关。三条全过再往下。

## 3 读自己的状态（只读）

```bash
SELF="$PIDECK_SESSION_ID"

# 我的时间线。这是有界窗口，不是全部历史
curl -s -H "$AUTH" "$BASE/api/sessions/$SELF/messages"

# 我的 todo
curl -s -H "$AUTH" "$BASE/api/sessions/$SELF/todo"

# 我派了几个子 agent
curl -s -H "$AUTH" "$BASE/api/sessions/$SELF/subagents"
```

`/messages` 返回 `{messages, total, windowStart, truncated}`。看到 `truncated: true` 说明还有更早的，用 `?before=<windowStart>` 往前翻。

## 4 找别的会话

```bash
curl -s -H "$AUTH" "$BASE/api/state"
```

返回里至少四个数组：

- `sessions[]`：**所有会话**，含没在跑的。字段有 `id`、`title`、`status`。
- `runtimes[]`：**此刻正在跑的进程**。每项含 `{sessionId, agentId, runtimeGeneration, status, cwd, sessionPath}`。
- `projects[]`、`pendingUiRequests[]`。

**两个数组答的不是同一个问题。** `sessions[]` 告诉你「有哪些会话」，`runtimes[]` 告诉你「哪些进程活着」。进程活着不代表它空闲——实测一个完全空闲的会话照样 `status: running`。反过来，不在 `runtimes[]` 里的会话进程没起，§5 的消息送不到。

要发 §7 的动作，先从 `runtimes[]` 取目标那一项，整项回传。

列表里找不到某个会话，不等于它不存在：先确认 `projects[]` 里有它所属的项目。

## 5 发消息并读回复

**最容易猜错的一步**：请求体不是 `{message: "..."}`，是完整消息数组。

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<目标 sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"你的问题"}]}]}' \
  "$BASE/api/chat"
```

返回是 SSE，逐行 `data: {...}`。`-N` 必须加，否则看不到流式，会一直等到结束才吐。你只需要认这几类帧：

| type | 含义 |
|---|---|
| `start-step` | 本轮开始 |
| `finish` / `[DONE]` | 本轮结束 |
| `reasoning-delta` | 思维链片段，文本在 `delta` |
| `text-delta` | 正文片段，文本在 `delta` |
| `tool-input-available` | 模型发起了一次工具调用 |
| `tool-output-available` / `tool-output-error` | 工具返回结果 / 失败 |

两个常见错误：`webError.requestIdRequired`（请求体缺 `id`）、`webError.messageRequired`（没有 role 为 user 的项，或 text 为空）。

**这条请求是异步入队，不是同步流。** 消息进了队列就返回，HTTP 可能一个帧都不吐（实测 curl 挂 5 秒收到 0 帧），而目标照样开始干活。所以「送到了没有」看回读 `/messages` 的 `total` 加没加，不看有没有收到 `start-step`。

两种情况要分开：

- **目标没在跑**：返回 200、0 帧、`total` 不变。这是真没送到。先按 §7 启动它，等它进 `runtimes[]`，再发。
- **目标在跑但忙**：返回 200、0 帧，但 `total` 加一。消息已入队，等它做完手上的事就轮到这条。

## 6 重启：你关不掉自己，让别人关

**重启 = 停止进程 + 重新启动进程。你自己发不出这两个请求**：stop 杀掉的就是发请求的那个进程，没有进程去发 activate。

让别人做。最简单的办法：**新开一个空会话**（它自动启动、天然空闲），把技能名和下面这段一起贴给它。

> 用 `/skill:pideck-web-api`。把会话 `<目标 sessionId>` 重启，四步依次做，每步把输出贴回来。
>
> 1. 取 target：`curl -s -H "$AUTH" "$BASE/api/sessions/runtimes"`，在输出里找 `sessionId` 等于目标的那一项，记下 `agentId` 和 `runtimeGeneration`。
> 2. 停：`curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{"target":{"sessionId":"…","agentId":"…","runtimeGeneration":N}}' "$BASE/api/sessions/<目标>/runtime/stop"`。期望 200，响应里 `status` 是 `stopped`。
> 3. 启：`curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' "$BASE/api/sessions/<目标>/runtime/activate"`。期望 200，响应里 `runtimeGeneration` 比上一步大 1。
> 4. 验：再读一次 `runtimes[]`，目标那一项的 `runtimeGeneration` 变成新值。200 只说明请求收到了，不算。

**为什么不用等目标回合结束**：目标正在等你这条回复收尾，没有生成中的内容。反过来，**如果目标确实在跑长回合，等它回完再停**，否则回复会断在半句。判它忙不忙没有可靠办法，问用户最快。

**重启之后你是新进程**：不记得上一轮在干什么。会话历史仍在同一个 jsonl（`runtimes[].sessionPath`），上下文不丢，但「成没成」只能由重启后的一方读 `runtimes[]` 确认。

**界面显示「异常停下」不是失败**，那是 stop 动作本身。

## 7 停 / 启 / 中止：单个动作

动作挂在 `/api/sessions/<id>/runtime/<action>`，常用四个：`activate`（启动）、`stop`（停止）、`abort`（只中止当前回合，不停进程）、`restart`（重启）。

`activate` 是唯一**不带 target** 的动作。它要做的正是「这个冷会话现在起来」，所以没有 target 可回传：

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
  "$BASE/api/sessions/<sessionId>/runtime/activate"
```

另外三个都要完整 target——它们作用在已经存在的进程上：

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"target":{"sessionId":"…","agentId":"…","runtimeGeneration":N}}' \
  "$BASE/api/sessions/<sessionId>/runtime/stop"
```

**鉴权规则**：写操作（POST）只认请求头。`?token=` 查询参数只对 GET 和 SSE 开放，因为浏览器的 EventSource 不能自定义请求头；写操作开这个口子会把令牌漏进代理日志和浏览器历史。

## 8 动别的会话之前先问

这个技能能读别人的时间线、往别人的对话里发消息、停掉别人的运行时。三件事的后果都落在**另一个窗口**上，用户可能正在那里等结果。

- **读别的会话**：也要先说一声。理由不是隐私，是读取会刷新目标窗口的界面，用户会看到自己的窗口在动。
- **给别的会话发消息**：等于替用户对它说话。只在用户明确讲了「去让某个会话做某事」之后才发；「用户让我随便试」推不出这条授权。
- **停或重启别的会话**：会让目标当前回合中断。发出前要拿到用户对**那一个会话**的明确同意。

没有「agent 自己重启自己」的捷径。曾经有过 `self-restart.mjs`：起一个脱离进程树的守卫，由守卫替你 stop 再 activate，实测成功过三次。2026-11-14 删掉了。删的原因不是它不成立，是它和「不许自己停」这句冲突——两句话同时在，agent 会挑省事的那句执行。

## 9 边界

- 只读 pi 的会话文件，不要改 `~/.pi/agent/sessions/*.jsonl`。
- 端点全集以源码仓的 `src/main/web/WebApiRoutes.ts` 为准；本文是 2026-11 的实测记录，不一致时信源码。
- 没有第二个活着的窗口能接，就别停：被停之后没人发 activate，就是永久停着。

## 10 验收：三级别

按你做到哪一级说哪一级。

1. **能观察自己**（只读）：`echo $PIDECK_SESSION_ID` 非空，且这个 id 出现在 `/api/state` 的 `sessions[]` 里。
2. **能读别人**（只读）：`sessions[]` 里看得到别的会话标题。
3. **能驱动别人**（会改动别人）：对目标发一条 `ping`，收到 `text-delta`；要验「真进程」，走一次 §6，`runtimeGeneration` 变了才算。
