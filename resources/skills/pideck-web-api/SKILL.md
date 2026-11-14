---
name: pideck-web-api
description: "用 PiDeck 自带的 HTTP 服务读自己的状态、给别的窗口发消息、让别的会话重启自己。当你要用脚本或另一个 agent 控制 PiDeck、做跨进程协作、或检查当前会话状态时用。不用于修改 PiDeck 源码，也不用于浏览器自动化。Use for PiDeck web API, SSE stream."
---

# PiDeck Web API

**PiDeck 每个窗口背后跑一个 pi 进程，同时开一个只监听本机的 HTTP 服务。用这个服务，你能读自己的状态、给别的窗口发消息、让另一个会话把自己重启。**

下面每条命令都在 2026-11 的 Windows 发行版上跑过，写了期望返回。返回形状不符说明版本变了，以源码里的 `src/main/web/WebApiRoutes.ts` 为准。本机克隆在 `C:\Users\15066212pp\src\PiDeck\v099`，换台机器就换成你自己的克隆路径。

**下面所有 bash 都按 Git Bash 写**（PiDeck 在 Windows 上附带的那套）。别在 cmd 或 PowerShell 里跑：`$VAR` 不展开，`%APPDATA%` 在 bash 里不展开。怎么确认：`echo $APPDATA` 有值就是对的 shell。

## 0 先确定你要做什么

| 想做的事 | 会打断别人吗 | 读哪节 |
|---|---|---|
| 读自己的时间线、todo、子 agent、运行状态 | 不会 | 第 3 节 |
| 找别的会话、发消息、读回复 | 不会停它，但消息会插进它的对话 | 第 4 节、第 5 节 |
| 重启某个会话（自己或别人） | 会，目标被停 | 第 6 节 |
| 单独停、启、中止 | 会，目标被停 | 第 7 节 |

第 2 节是所有节的前提。

**先读第 2 节的一条注意事项**：每段 bash 都是独立 shell，变量不跨段保留。后面几节的命令都假设 `$AUTH`、`$BASE` 已经在**同一次**调用里设好。

## 1 三个词

- **会话**：PiDeck 侧边栏里的一行。会话可以存在，但此刻没在跑。
- **运行时**：为某个会话在后台跑的那个 pi 进程。会话是记录，运行时是进程。
- **运行时代号**（`runtimeGeneration`）：每起来一次加一。进程号不对外暴露，所以「代号变了」是「真的换了进程」的证据。`agentId` 也会跟着换，两个标一个意思，看哪个都行。

## 2 连上：地址、令牌、自己的会话 id

**服务默认关闭**，在 PiDeck 的「设置 → Web 服务」里打开。端口默认 8765。

令牌和端口都存在设置文件里。Dev 通道的设置文件在 `PiDeck Dev` 目录，下面这段两个都试：

这段一次把三件事做完：从设置文件读出令牌和端口、检查令牌不是空的、把它们设成 `$AUTH` 和 `$BASE` 供后面用。

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

四条验证，每条写了该返回什么，**放在同一次调用里跑**（变量不跨段）：

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

**这个接口每次返回整个窗口，`?limit` 之类的参数一律无视。** 实测传 `limit=1` 和 `tail=1`，返回字节数与不传时完全相同。我这个会话 208 条 = 1.5 MB，耗时 100~260 ms；作为对比 `/api/state` 4 KB 用 2 ms，`/api/sessions/runtimes` 1 KB 用 1.4 ms。所以**别拿它轮询**：判断消息送没送到，先看 SSE 有没有 `error` 帧，只查一次 `/messages`。

单条消息的字段是 `{id, agentId, role, text, timestamp, meta}`，assistant 还多 `thinking`、`model`、`stopReason`。注意正文在 `text`，不在 `parts`——`parts` 只在 `/api/chat` 的**请求**里用。

## 4 找别的会话

```bash
curl -s -H "$AUTH" "$BASE/api/state"
```

返回里至少四个数组：`sessions[]`、`runtimes[]`、`projects[]`、`pendingUiRequests[]`。

- `sessions[]`：**所有会话**，含没在跑的。字段 `{id, projectId, title, status, model, thinkingLevel, updatedAt, createdAt}`。
- `runtimes[]`：**此刻正在跑的进程**。字段 `{sessionId, agentId, runtimeGeneration, projectId, cwd, status, sessionPath, createdAt, deckSessionId}`。

**两个数组答的不是同一个问题。** `sessions[]` 说有哪些会话，`runtimes[]` 说哪些进程活着。进程活着不代表有活在跑——刚 activate 起来的会话 `status` 是 `idle`（进程在，闲着），有回合在跑才是 `running`。反过来，不在 `runtimes[]` 里的会话进程没起，第 5 节的消息送不到。

**没有 `/api/sessions` 这个端点。** 猜它会拿到 `{"code":"webError.apiNotFound"}`。列会话就是上面的 `/api/state`。

`/api/sessions/runtimes` 和 `/api/state` 的 `runtimes[]` **是同一份数据**（字段逐个比对一致），用哪个都行。

列表里找不到某个会话，不等于它不存在：先确认 `projects[]` 里有它所属的项目。

## 5 发消息并读回复

**最容易猜错的一步**：请求体不是 `{message: "..."}`，是完整消息数组；`id` 是**目标会话的 sessionId**（`sessions[].id`），不是 `agentId`。

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<目标 sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"ping"}]}]}' \
  "$BASE/api/chat"
```

返回是 SSE（服务端推过来的流式文本，一行一帧，`data:` 后面是 JSON）。实测形状：

```text
data: {"type":"start","messageId":"msg_1794659108957"}
data: {"type":"text-start","id":"text_1794659109932_i4wmgw"}
data: {"type":"reasoning-delta","id":"reasoning_...","delta":"「"}
data: {"type":"text-delta","id":"text_1794659109932_i4wmgw","delta":"收到"}
data: {"type":"finish"}
data: [DONE]
```

`finish` 和 `[DONE]` 是同一件事的两种表示，看到任一个就是本轮结束。`-N` 必须加，否则看不到流式。

**这条请求是异步入队，不是同步流。** 消息进了队列就返回，HTTP 可能一个帧都不吐（实测挂 5 秒 0 帧），而目标照样开始干活。所以判断「送到了没有」看两个地方：

1. 回读目标的 `/messages`，`total` 变大就是送到了。
2. 或者看 SSE 里有没有 `error` 帧——目标没在跑时服务端会写 `error` + `finish` + `[DONE]`，消息不入队。

**目标不存在或没在跑时**，服务端写这三帧，HTTP 仍然是 200：

```text
data: {"type":"error","errorText":"Session not found: 00000000-0000-0000-0000-000000000000"}
data: {"type":"finish"}
data: [DONE]
```

注意 `error` 帧带的是 `errorText`，不是 `code`。HTTP 200 加这三帧，等于没送到。

两种情况：

- **目标没在跑**：`total` 不变，SSE 里有 `error` 帧。先按第 7 节启动它，等它进 `runtimes[]`，再发。
- **目标在跑但忙**：`total` 变大，消息已入队，等它做完手上的事就轮到这条。

两个常见错误码：`webError.requestIdRequired`（body 缺 `id`）、`webError.messageRequired`（没有 role 为 user 的项，或 text 为空）。

## 6 重启：你关不掉自己，让别人关

**重启 = 停止进程 + 重新启动进程。你自己发不出这两个请求**：stop 杀掉的就是发请求的那个进程，没有进程去发 activate。

让别人做。最简单的办法：**新建一个普通会话**，把技能名和下面这段一起贴给它。

建普通会话用这条（`projectId` 从 `/api/state` 的 `projects[]` 里取，常见的是 `builtin-chat`）：

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"projectId":"builtin-chat"}' "$BASE/api/sessions"
```

返回 `{"session":{"id":"...", ...}}`，取 `session.id`。新建的是草稿态，还得按第 7 节对它 activate 一次才会进 `runtimes[]`，进不去就发不了消息。

**别用 `/api/sessions/anonymous` 建执行者。** 它有两个实测的坑：

- `noSession: true`，**没有自己的 `sessionPath`**。执行者要认「我是谁」时会去比对磁盘上哪个 jsonl 正在被写，拿到的却是目标的路径，结论必然是「目标就是我」，于是拒绝执行。
- stop 之后整条记录被删掉，紧接着 activate 返回 `{"result":{"ok":false,"error":{"code":"SESSION_NOT_FOUND"}}}`——HTTP 仍是 200。它连当目标都不行。

> 用 `/skill:pideck-web-api`。把会话 `<目标 sessionId>` 重启，先跑完该技能的第 2 节，再按第 0 步到第 5 步做，每步把输出贴回来。
>
> 0. **先认自己是谁**：`echo $PIDECK_SESSION_ID`。如果它等于 `<目标 sessionId>`，停下——停掉的就是你自己，没有进程去发 activate。如果它不等于，继续。
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
> 4. **验**：`activate` 的返回里直接有 `runtimeGeneration` 和 `agentId`，不用再读一次 `runtimes[]`。代号比第 1 步的 `N` 大 1 才是换了进程，例如 `N=3` 重启后返回 `4`。
> 5. **发一条消息，证明它能接活**：
>    ```bash
>    curl -s -H "$AUTH" -H "Content-Type: application/json" \
>      -d '{"id":"<目标>","messages":[{"role":"user","parts":[{"type":"text","text":"重启完成，这条消息用来验证你能接活"}]}]}' \
>      "$BASE/api/chat"
>    ```
>    送达看回读 `/messages` 的 `total` **变大**（不只是 user 那条：实测加 3，还有 assistant 回复和注入）。第 5 节说过，这条请求是异步入队，可能一个帧都不吐。

**第 0 步不能省，也别换成别的判法。** 别拿 `sessionPath` 或磁盘写入时间去推断自己是谁——匿名会话没有 `sessionPath`，会拿目标的路径认自己，结论正好反过来。只有 `echo $PIDECK_SESSION_ID` 可靠。

**HTTP 200 不代表做成了，必须看 body。** 三个实测形状：

| 情况 | HTTP | body |
|---|---|---|
| 停成了 | 200 | `{"result":{"ok":true,"value":{...}}}` |
| 目标本来就没在跑 | 200 | `{"result":{"ok":false,"error":{"code":"SESSION_RUNTIME_UNAVAILABLE"}}}` |
| URL 与 body 的 sessionId 不一致 / 没给 target | 400 | `{"code":"webError.runtimeTargetRequired","error":"A matching Session runtime target is required"}` |

**`runtimeGeneration` 不校验。** 实测传一个比实际大 99 的代号，stop 照样 200 并真的把目标停了。所以这个字段是给你自己核对用的，不是防误停的闸。

**要不要直接用 `restart` 一步做完？** 有这个动作，请求体和 stop 一样（带 target），由服务端串起停和启。本文的流程用 stop + activate 两步，是因为每一步都能单独验收：停完能确认目标真的从 `runtimes[]` 消失，启完能确认代号变了。用 `restart` 省一次调用，但中间状态看不到。

**为什么不用等目标回合结束**：如果目标正在写回复，stop 会让它断在半句。判断它忙不忙没有可靠办法——问用户最快。新开的空会话天然空闲，这是它最省事的地方。

**重启之后你是新进程**：不记得上一个进程在干什么。会话历史仍在同一个 jsonl（`runtimes[].sessionPath`），上下文不丢，但「成没成」只能由重启后的一方重读 `runtimes[]` 确认。界面显示「异常停下」是 stop 动作本身，不是失败。

### 6.1 这条流程的实测记录

2026-11-14，Windows 发行版。两种用法都真跑过。

**用法一：重启一个没在跑的会话**（目标 `fc3b8a41`）。

```text
第 0 步 echo $PIDECK_SESSION_ID -> 执行者自己的 id，不是目标
第 1 步 取 target        目标不在 runtimes[] 里 -> 按技能跳到第 3 步
第 3 步 activate        HTTP 200  gen=3  agentId=5c87249a-…  status=idle
第 5 步 发消息          total 7473 -> 7476（加 3）
收尾  stop(gen=3)       HTTP 200
       activate         gen=4  agentId=f711cb00-…
```

`activate` 要 4~6 秒才返回，不是卡住。

**用法二：让别人重启自己**（本会话 `b1e367af` 当目标，执行者是一个新建的普通会话）。

```text
被停的那一刻    手上正在跑的工具调用直接 abort（This operation was aborted）
重启后自读      gen 2 -> 3，agentId 0ec64be6-… -> 2a8ef668-…
执行者第 5 步发的报告    代号和 agentId 与我自读的一致
```

**`total` 一次加 3 不是 1**：你发的那条 + assistant 的回复 + 一条注入。

**各步耗时**（同一台机器，目标原本没在跑，跑完整一套）：

```text
建普通会话     245 ms
activate       4149 ms
取 target      102 ms
stop           100 ms
activate       4227 ms
发消息         2069 ms
停 + 删         297 ms
合计          11.6 秒
```

**activate 占 8.4 秒，是服务端拉起 pi 进程的时间，省不掉。** 目标已经在跑时只走 stop + activate，约 4.3 秒就是一次重启的下限。其余每步都在 100~250 ms。

所以别做这两件事：不要建完会话反复轮询 `runtimes[]` 等它出现（`activate` 返回时进程已经在里面，`status` 就在返回体里）；不要为了拿 `total` 反复拉 `/messages`（1.5 MB 一次）。

**代号和 `agentId` 会一起变。** 两个都是「换没换进程」的证据，任一个变了就是换了。

**用完把执行者删掉**，别留在侧边栏里：

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
  "$BASE/api/sessions/<执行者 id>/delete"
```

返回 `{"deleted":true}`。先 stop 再 delete，否则进程还占着。

**匿名会话会在空闲后消失。** `POST /api/sessions/anonymous` 建出来的会话（标题是「匿名聊天 - Chat」）空闲几分钟后自己从 `runtimes[]` 和 `sessions[]` 里消失，之后对它的 `activate` 返回 `SESSION_NOT_FOUND`。PiDeck 里正常新建的会话不受这个影响。

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

没有「agent 自己重启自己」的捷径。曾经有过 `self-restart.mjs`：起一个脱离进程树的守卫替你 stop 再 activate，实测跑了三次，三次都起来了。2026-11-14 删掉了——不是它不成立，是它和「不许自己停」这句冲突：两句话同时在，agent 会挑省事的那句执行。

## 9 边界

- 只读 pi 的会话文件，不要改 `~/.pi/agent/sessions/*.jsonl`。
- 端点全集以源码 `WebApiRoutes.ts` 为准；本文是 2026-11 的实测记录，不一致时信源码。
- 没有第二个活着的窗口能接，就别停：被停之后没人发 activate，就是永久停着。

## 10 验收：三级别

按你做到哪一级说哪一级。

1. **能观察自己**（只读）：`echo $PIDECK_SESSION_ID` 非空，且这个 id 出现在 `/api/state` 的 `sessions[]` 里。
2. **能读别人**（只读）：`sessions[]` 里看得到别的会话标题。
3. **能驱动别人**（会改动别人）：对目标发一条 `ping`，收到 `text-delta` 帧且 `total` 变大；要验「真进程」，走一次第 6 节，`runtimeGeneration` 变了才算。
