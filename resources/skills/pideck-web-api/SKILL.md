---
name: pideck-web-api
description: "用 PiDeck 自带的 HTTP 服务读自己的状态、给别的窗口发消息、让别的会话重启自己。当你要用脚本或另一个 agent 控制 PiDeck、做跨进程协作、或检查当前会话状态时用。不用于修改 PiDeck 源码，也不用于浏览器自动化。Use for PiDeck web API, SSE stream."
---

# PiDeck Web API

**PiDeck 每个窗口背后跑一个 pi 进程，同时开一个只监听本机的 HTTP 服务。用这个服务，你能读自己的状态、给别的窗口发消息、让另一个会话把自己重启。**

下面每条命令都在 2026-11 的 Windows 发行版上跑过，写了期望返回。返回形状不符说明版本变了，以源码 `C:\Users\15066212pp\src\PiDeck\v099\src\main\web\WebApiRoutes.ts` 为准（这是本机路径，换机器要换成你自己的克隆）。

**下面所有 bash 都按 Git Bash 写**（PiDeck 在 Windows 上附带的那套）。别在 cmd 或 PowerShell 里跑：`$VAR` 不展开，`%APPDATA%` 在 bash 里不展开。判据：`echo $APPDATA` 有值就是对的 shell。

## 0 先确定你要做什么

| 想做的事 | 会打断别人吗 | 读哪节 |
|---|---|---|
| 读自己的时间线、todo、子 agent、运行状态 | 不会 | §3 |
| 找别的会话、发消息、读回复 | 不会停它，但消息会插进它的对话 | §4、§5 |
| 重启某个会话（自己或别人） | 会，目标被停 | §6 |
| 单独停、启、中止 | 会，目标被停 | §7 |

§2 是所有节的前提。

**先读 §2 的一条注意事项**：每段 bash 都是独立 shell，变量不跨段保留。后面几节的命令都假设 `$AUTH`、`$BASE` 已经在**同一次**调用里设好。

## 1 三个词

- **会话**：PiDeck 侧边栏里的一行。会话可以存在，但此刻没在跑。
- **运行时**：为某个会话在后台跑的那个 pi 进程。会话是记录，运行时是进程。
- **运行时代号**（`runtimeGeneration`）：每成功启动一次加一。进程号不对外暴露，所以「代号变了」是「真的换了进程」的唯一证据。

## 2 连上：地址、令牌、自己的会话 id

**服务默认关闭**，在 PiDeck 的「设置 → Web 服务」里打开。端口默认 8765。

令牌和端口都存在设置文件里。Dev 通道的设置文件在 `PiDeck Dev` 目录，下面这段两个都试：

```bash
# 取端口和令牌，同时确认不是空值
eval "$(node -e 'const fs=require("fs"),p=require("path");const base=process.env.APPDATA;for(const d of ["PiDeck","PiDeck Dev"]){try{const s=JSON.parse(fs.readFileSync(p.join(base,d,"settings.json"),"utf8"));if(s.webServiceToken){console.log("export TOKEN="+s.webServiceToken);console.log("export PORT="+(s.webServicePort||8765));break}}catch{}}')"
[ -n "$TOKEN" ] || echo "令牌为空：服务没开，或设置文件不在预期位置"
export AUTH="Authorization: Bearer $TOKEN"
export BASE="http://127.0.0.1:$PORT"
echo "port=$PORT token长度=${#TOKEN}"
```

期望：`port=8765 token长度=36`。长度是 0 说明上面那行提示已经打了，先去设置页把服务打开。

自己的会话 id 是 PiDeck 启动会话时注入的环境变量，不用猜：

```bash
echo $PIDECK_SESSION_ID
```

为空说明你不在 PiDeck 里跑（比如终端里的 TUI），后面各节都不适用。

**别拿错变量**：`$PI_SESSION_ID` 是 pi 自己的会话 id，不是 PiDeck 的身份。分辨办法：`$PIDECK_SESSION_ID` 能在 `/api/state` 的 `sessions[]` 里找到，`$PI_SESSION_ID` 找不到。

三条验证，每条写了该返回什么，**放在同一次调用里跑**（变量不跨段）：

```bash
curl -s -o /dev/null -w 'health=%{http_code}\n' "$BASE/api/health"              # 期望 health=200，这是唯一免鉴权的端点
curl -s -o /dev/null -w 'state有令牌=%{http_code}\n' -H "$AUTH" "$BASE/api/state"  # 期望 200
curl -s -o /dev/null -w 'state无令牌=%{http_code}\n' "$BASE/api/state"             # 期望 401
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" | head -c 300                    # 期望 {"runtimes":[...]}
```

前三条不对就别往下走：health 不是 200 说明服务没开或端口不对，与令牌无关；state 有令牌还是 401 说明令牌错。

## 3 读自己的状态（只读）

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/messages"     # 我的时间线
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/todo"         # 我的 todo
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/subagents"    # 我派了几个子 agent
```

`/messages` 返回 `{messages, total, windowStart, truncated}`，**是有界窗口不是全部历史**。看到 `truncated: true` 说明还有更早的，往前翻用 `?before=<windowStart>`：

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/messages?before=<上一页的 windowStart>"
```

单条消息的字段是 `{id, agentId, role, text, timestamp, meta}`，assistant 还多 `thinking`、`model`、`stopReason`。注意正文在 `text`，不在 `parts`——`parts` 只在 `/api/chat` 的**请求**里用。

## 4 找别的会话

```bash
curl -s -H "$AUTH" "$BASE/api/state"
```

返回里至少四个数组：`sessions[]`、`runtimes[]`、`projects[]`、`pendingUiRequests[]`。

- `sessions[]`：**所有会话**，含没在跑的。字段 `{id, projectId, title, status, model, thinkingLevel, updatedAt, createdAt}`。
- `runtimes[]`：**此刻正在跑的进程**。字段 `{sessionId, agentId, runtimeGeneration, projectId, cwd, status, sessionPath, createdAt, deckSessionId}`。

**两个数组答的不是同一个问题。** `sessions[]` 说有哪些会话，`runtimes[]` 说哪些进程活着。进程活着不代表空闲——实测一个完全空闲的会话照样 `status: running`；反过来，不在 `runtimes[]` 里的会话进程没起，§5 的消息送不到。

`/api/sessions/runtimes` 和 `/api/state` 的 `runtimes[]` **是同一份数据**（字段逐个比对一致），用哪个都行。

列表里找不到某个会话，不等于它不存在：先确认 `projects[]` 里有它所属的项目。

## 5 发消息并读回复

**最容易猜错的一步**：请求体不是 `{message: "..."}`，是完整消息数组；`id` 是**目标会话的 sessionId**（`sessions[].id`），不是 `agentId`。

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<目标 sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"ping"}]}]}' \
  "$BASE/api/chat"
```

返回是 SSE，逐行 `data: {...}`。原始形状长这样（一行一帧，`data:` 后面是 JSON）：

```text
data: {"type":"start-step"}
data: {"type":"reasoning-delta","delta":"先看看"}
data: {"type":"text-delta","delta":"收到"}
data: {"type":"finish"}
data: [DONE]
```

`finish` 和 `[DONE]` 是同一件事的两种表示，看到任一个就是本轮结束。`-N` 必须加，否则看不到流式。

**这条请求是异步入队，不是同步流。** 消息进了队列就返回，HTTP 可能一个帧都不吐（实测挂 5 秒 0 帧），而目标照样开始干活。所以判断「送到了没有」看两个地方：

1. 回读目标的 `/messages`，`total` 加一就是送到了。
2. 或者看 SSE 里有没有 `error` 帧——目标没在跑时服务端会写 `error` + `finish` + `[DONE]`，消息不入队。

两种情况：

- **目标没在跑**：`total` 不变，SSE 里有 `error` 帧。先按 §7 启动它，等它进 `runtimes[]`，再发。
- **目标在跑但忙**：`total` 加一，消息已入队，等它做完手上的事就轮到这条。

两个常见错误码：`webError.requestIdRequired`（body 缺 `id`）、`webError.messageRequired`（没有 role 为 user 的项，或 text 为空）。

## 6 重启：你关不掉自己，让别人关

**重启 = 停止进程 + 重新启动进程。你自己发不出这两个请求**：stop 杀掉的就是发请求的那个进程，没有进程去发 activate。

让别人做。最简单的办法：**新开一个空会话**（它自动启动、天然空闲），把技能名和下面这段一起贴给它。

> 用 `/skill:pideck-web-api`。把会话 `<目标 sessionId>` 重启，先跑完该技能的 §2，再按四步做，每步把输出贴回来。
>
> 1. **取 target**：`curl -s -H "$AUTH" "$BASE/api/sessions/runtimes"`。在 `runtimes[]` 里找 `sessionId` 等于目标的那一项，记下 `agentId` 和 `runtimeGeneration`（下面叫它 `N`）。找不到说明目标没在跑，直接跳到第 3 步。
> 2. **停**：
>    ```bash
>    curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
>      -d '{"target":{"sessionId":"<目标>","agentId":"<上一步的 agentId>","runtimeGeneration":<N>}}' \
>      "$BASE/api/sessions/<目标>/runtime/stop"
>    ```
>    `<N>` 要连尖括号一起换成上一步输出的真实数字（例如 `runtimeGeneration":3`）。URL 里的 `<目标>` 和 body 里的 `sessionId` **必须是同一个值**，不一致会返回 400 `webError.runtimeTargetRequired`。
> 3. **启**：
>    ```bash
>    curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
>      "$BASE/api/sessions/<目标>/runtime/activate"
>    ```
> 4. **验**：再读一次 `runtimes[]`，目标那一项的 `runtimeGeneration` 变成新值才算换进程。

**HTTP 200 不等于成功，必须看 body。** 三个实测形状：

| 情况 | HTTP | body |
|---|---|---|
| 停成功 | 200 | `{"result":{"ok":true,"value":{...}}}` |
| 目标本来就没在跑 | 200 | `{"result":{"ok":false,"error":{"code":"SESSION_RUNTIME_UNAVAILABLE"}}}` |
| URL 与 body 的 sessionId 不一致 / 没给 target | 400 | `{"code":"webError.runtimeTargetRequired"}` |

**`runtimeGeneration` 不校验。** 实测传一个比实际大 99 的代号，stop 照样 200 并真的把目标停了。所以这个字段是给你自己对齐用的，不是防误停的闸。

**要不要直接用 `restart` 一步做完？** 有这个动作，请求体和 stop 一样（带 target），由服务端串起停和启。本文的流程用 stop + activate 两步，是因为每一步都能单独验收：停完能确认目标真的从 `runtimes[]` 消失，启完能确认代号变了。用 `restart` 省一次调用，但中间状态看不到。

**为什么不用等目标回合结束**：如果目标正在写回复，stop 会让它断在半句。判断它忙不忙没有可靠办法——问用户最快。新开的空会话天然空闲，这是它最省事的地方。

**重启之后你是新进程**：不记得上一轮在干什么。会话历史仍在同一个 jsonl（`runtimes[].sessionPath`），上下文不丢，但「成没成」只能由重启后的一方重读 `runtimes[]` 确认。界面显示「异常停下」是 stop 动作本身，不是失败。

## 7 停 / 启 / 中止：单个动作

动作挂在 `/api/sessions/<id>/runtime/<action>`。常用的四个：

| action | 要 target 吗 | 作用 |
|---|---|---|
| `activate` | **不要**，body 传 `{}` | 把冷会话的进程拉起来 |
| `stop` | 要 | 停进程 |
| `abort` | 要 | 只中止当前回合，进程留着 |
| `restart` | 要 | 停完接着启，服务端串起来 |

`activate` 是唯一不要 target 的——它要做的正是「这个冷会话现在起来」，没有 target 可回传。

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
  "$BASE/api/sessions/<sessionId>/runtime/activate"
```

**鉴权规则**：写操作（POST）只认请求头。`?token=` 查询参数只对 GET 和 SSE 开放，因为浏览器的 EventSource 不能自定义请求头；写操作开这个口子会把令牌漏进代理日志和浏览器历史。

## 8 动别的会话之前先问

这个技能能读别人的时间线、往别人的对话里发消息、停掉别人的运行时。三件事的后果都落在**另一个窗口**上。

- **读别的会话**：也要先说一声。理由不是隐私，是读取会刷新目标窗口的界面，用户会看到自己的窗口在动。
- **给别的会话发消息**：等于替用户对它说话。只在用户明确讲了「去让某个会话做某事」之后才发。
- **停或重启别的会话**：会让目标当前回合中断。发出前要拿到用户对**那一个会话**的明确同意。

没有「agent 自己重启自己」的捷径。曾经有过 `self-restart.mjs`：起一个脱离进程树的守卫替你 stop 再 activate，实测成功过三次。2026-11-14 删掉了——不是它不成立，是它和「不许自己停」这句冲突：两句话同时在，agent 会挑省事的那句执行。

## 9 边界

- 只读 pi 的会话文件，不要改 `~/.pi/agent/sessions/*.jsonl`。
- 端点全集以源码 `WebApiRoutes.ts` 为准；本文是 2026-11 的实测记录，不一致时信源码。
- 没有第二个活着的窗口能接，就别停：被停之后没人发 activate，就是永久停着。

## 10 验收：三级别

按你做到哪一级说哪一级。

1. **能观察自己**（只读）：`echo $PIDECK_SESSION_ID` 非空，且这个 id 出现在 `/api/state` 的 `sessions[]` 里。
2. **能读别人**（只读）：`sessions[]` 里看得到别的会话标题。
3. **能驱动别人**（会改动别人）：对目标发一条 `ping`，收到 `text-delta` 帧且 `total` 加一；要验「真进程」，走一次 §6，`runtimeGeneration` 变了才算。
