---
name: pideck-web-api
description: "用 PiDeck 自带的 HTTP 服务读自己的状态、给别的窗口发消息、让别的会话重启自己。当你要用脚本或另一个 agent 控制 PiDeck、做跨进程协作、或检查当前会话状态时用。不用于修改 PiDeck 源码，也不用于浏览器自动化。Use for PiDeck web API, SSE stream."
---

# PiDeck Web API

**PiDeck 每个窗口背后跑一个 pi 进程，同时开一个只监听本机的 HTTP 服务。用这个服务，你能读自己的状态、给别的窗口发消息、让另一个会话把自己重启。**

下面每条命令都在 2026-11 的 Windows 发行版上跑过，写了期望返回。返回形状不符说明版本变了，以源码里的 `src/main/web/WebApiRoutes.ts` 为准（`/api/health` 例外，它在 `WebServiceManager.ts:497`）。

本机克隆在 `C:\Users\15066212pp\src\PiDeck\v099`，换台机器就换成你自己的克隆路径。

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

期望：`port=<设置里那个值，默认 8765> token长度=36`。长度是 0 说明上面那行提示已经打了，先去设置页把服务打开。

自己的会话 id 是 PiDeck 启动会话时注入的环境变量，不用猜：

```bash
echo $PIDECK_SESSION_ID
```

为空说明你不在 PiDeck 里跑（比如终端里的 TUI），后面各节都不适用。

**别拿错变量**：`$PI_SESSION_ID` 是 pi 自己的会话 id，不是 PiDeck 的身份。分辨办法：`$PIDECK_SESSION_ID` 能在 `/api/state` 的 `sessions[]` 里找到，`$PI_SESSION_ID` 找不到。

**别用 `grep ^PI_` 找它。** `PIDECK_SESSION_ID` 不以 `PI_` 开头，那个 grep 会把它整条漏掉，剩下唯一像身份的 `$PI_SESSION_ID` 是 pi 自己的会话 id，看起来对，坐标系是错的。

找身份就一条命令：`echo $PIDECK_SESSION_ID`，不要从 env 里筛。

**取不到时别停。** 2026-11-14 在另一台发行版上实测：`echo $PIDECK_SESSION_ID` 打印空行，同一个进程里 `$PIDECK_SECURITY_CONFIG` 却有值——同一段注入代码里断了一半。所以这条路失败就往下走，不要以为「文档说的必对」。

**兜底：拿 `$PI_SESSION_FILE` 去 `runtimes[]` 里认自己。** 这个变量是 pi 自己的会话文件路径，本机有值（2026-11-14 实测），而 `runtimes[].sessionPath` 指向同一个文件：

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" |
  node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const s=j.runtimes.find(r=>r.sessionPath===process.env.PI_SESSION_FILE);console.log(s?s.sessionId:"没找到")'
```

打印出一个 uuid 就是你的 sessionId；打印「没找到」说明你不在这台 PiDeck 里跑。这个匹配区分大小写。

**第三条线索**：`$PIDECK_LINKED_SESSIONS_URL` 的末尾就是 PiDeck 会话 id，形如 `http://127.0.0.1:<port>/linked/<sessionId>`。前两条都空时再用它。

**认自己的目的是不出错。** 怎么判只一条：拿到的 id 在 `/api/state` 的 `sessions[]` 里能找到。找不到就是坐标系错了。

### 连通性自检：四条，一次跑完

每条都写了该返回什么。四条**放在同一次调用里跑**，因为变量不跨段：

```bash
curl -s -o /dev/null -w 'health=%{http_code}\n' "$BASE/api/health"              # 期望 health=200。除 health 外的端点不带令牌一律 401（state 实测过）
curl -s -o /dev/null -w 'state有令牌=%{http_code}\n' -H "$AUTH" "$BASE/api/state"  # 期望 200
curl -s -o /dev/null -w 'state无令牌=%{http_code}\n' "$BASE/api/state"             # 期望 401
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" | head -c 300                    # 期望 {"runtimes":[...]}
```

前三条不对就别往下走：health 不是 200 说明服务没开或端口不对，与令牌无关；state 有令牌还是 401 说明令牌错。第四条不是 `{"runtimes":[...]}` 说明服务版本变了，去查源码。

## 3 读自己的状态（只读）

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/messages"     # 我的时间线
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/todo"         # 我的 todo
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/subagents"    # 我派了几个子 agent
```

`/messages` 返回 `{messages, total, windowStart, truncated}`，**是有界窗口不是全部历史**。看到 `truncated: true` 说明还有更早的。

**`/messages` 本身不吃 `?before`。** 实测传 `?before=5516`、`?before=999999`、`?before=abc`，返回的 `windowStart` 和条数与不传时完全相同。翻更早的历史用另一个端点：

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/<目标>/messages/page?pageSize=100&before=<nextBefore>"
```

返回 7 个键：`messages`、`total`、`nextBefore`、`nextBeforeEntryId`、`indexVersion`、`model`、`thinkingLevel`。

**`pageSize` 的单位是一轮问答，默认 3。** 一轮装多少条消息不固定——问一句答一句是 3 条，带一堆工具调用的轮能有几十条。同一天两个会话实测：

| 会话 | 不传 | pageSize=1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| 1653 条 | 12 | 6 | 9 | 12 |
| 5887 条 | 182 | 59 | 153 | 182 |

所以别拿条数去推轮数。翻页只做一件事：把上一页的 `nextBefore` 传给 `before`，翻到它是 `null` 就到头。

**`nextBefore` 不为 `null` 时返回 7 个键，为 `null` 时只有 6 个**——最后一页没有 `nextBeforeEntryId`。按字段名取，别按位置取。

只有这个端点也满足不了需求时（比如要原始的工具调用参数），才去读磁盘上的 jsonl：

```bash
node -e 'const fs=require("fs");fs.readFileSync(process.argv[1],"utf8").split("\n").forEach(l=>{if(!l.trim())return;const j=JSON.parse(l);if(j.role)console.log(j.role+": "+String(j.text||"").slice(0,120))})' "<runtimes[] 里的 sessionPath>"
```

首行 `type: session`，其余每行一条消息。`windowStart` 是个数字（例如 5516），不是消息 id。

**这个接口每次返回整个窗口，`?limit` 之类的参数一律无视。** 实测传 `limit=1` 和 `tail=1`，返回字节数与不传时完全相同。

`/messages` 一次返回整个窗口：1653 条的会话实测 226 KB，几十条的小会话只有几十字节。把 `pageSize` 拉到 100 会连那一段历史一起拉回来，同一会话实测 15 MB 级。`/api/state` 与 `/api/sessions/runtimes` 是几 KB。

具体数字自己量，别抄这里的：

```bash
curl -s -o /dev/null -w '%{size_download} %{time_total}\n' -H "$AUTH" "$BASE/api/state"
```

这两个数随会话数涨：单个 session 对象至少 171 字节，会话多了就线性涨，别当常量。

所以**别拿它轮询**：判断消息送没送到，先看 SSE 有没有 `error` 帧，只查一次 `/messages`。

单条消息的字段是 `{id, agentId, role, text, timestamp, meta}`，assistant 还多 `thinking`、`thinkingStartedAt`、`thinkingEndedAt`、`model`、`stopReason`。

注意正文在 `text`，不在 `parts`——`parts` 只在 `/api/chat` 的**请求**里用。

## 4 找别的会话

```bash
curl -s -H "$AUTH" "$BASE/api/state"
```

返回里至少四个数组：`sessions[]`、`runtimes[]`、`projects[]`、`pendingUiRequests[]`。

- `sessions[]`：**所有会话**，含没在跑的。字段 `{id, projectId, title, status, model, thinkingLevel, updatedAt, createdAt}`。
- `runtimes[]`：**此刻正在跑的进程**。字段 `{sessionId, agentId, runtimeGeneration, projectId, cwd, status, sessionPath, createdAt, deckSessionId}`。

**两个数组答的不是同一个问题。** `sessions[]` 说有哪些会话，`runtimes[]` 说哪些进程活着。进程活着不代表有活在跑——刚 activate 起来的会话 `status` 是 `idle`（进程在，闲着），有回合在跑才是 `running`。

反过来，不在 `runtimes[]` 里的会话进程没起，第 5 节的消息送不到。

**`GET /api/sessions` 不存在**，猜它会拿到 `{"code":"webError.apiNotFound"}`——列会话用上面的 `/api/state`。**`POST /api/sessions` 存在**，用来新建会话，见第 6 节。别把这两个方法混成一个「端点不存在」。

`/api/sessions/runtimes` 和 `/api/state` 的 `runtimes[]` **是同一份数据**（字段逐个比对一致），用哪个都行。

列表里找不到某个会话，不等于它不存在：先确认 `projects[]` 里有它所属的项目。

## 5 发消息并读回复

**发之前再认一次自己。** `echo $PIDECK_SESSION_ID`，目标 id 等于它，你就是在给自己发消息：消息会插进你自己的对话，然后你自己等自己回。

这个错真发生过。想找「另一个会话」，用 `env | grep ^PI_` 找身份，漏掉了 `PIDECK_SESSION_ID`（它不以 `PI_` 开头）；于是拿会话标题猜，把标题恰好也是这个任务的会话当成了别人，其实那就是自己。标题、`updatedAt`、`model` 都不是身份。

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

**这条请求是异步入队，不是同步流**：消息进队列就返回，HTTP 可能一个帧都不吐，目标照样开始干活。判断「送到了没有」只有一条可靠检查——**看 `error` 帧，不看 `total`，也不看有没有 data 帧。**

- 没有 `error` 帧就是送到了。哪怕 0 个 data 帧、`total` 当场没变。
- 有 `error` 帧就是没送到，原因写在 `errorText` 里。

**会话记录存在时，对端进程死没死都能送到。** 实测：先把目标 stop 掉（`runtimes[]` 里已经没有它），直接发这条请求，照样收到完整正常流 `start` → `text-delta` → `text-end` → `finish` → `[DONE]`。

随后 `/prompt` 的返回里 `runtimeGeneration` 从 2 变成 3——服务端替你 `activate` 了一次。所以「先 activate 再发消息」这一步可以省。

**只有会话记录本身不存在时才写 error 帧**，HTTP 仍然是 200：

```text
data: {"type":"error","errorText":"Session not found: 00000000-0000-0000-0000-000000000000"}
data: {"type":"finish"}
data: [DONE]
```

注意 `error` 帧带的是 `errorText`，不是 `code`。

**对端忙的时候，整条连接可能只有一行 `: ping` 心跳，没有 data 帧，`total` 也不立即变大**，而消息确实插进了它的对话。拿 `total` 当检查办法会判成没送到，重试一次就变成两条重复消息。

两个常见错误码：`webError.requestIdRequired`（body 缺 `id`）、`webError.messageRequired`（没有 role 为 user 的项，或 text 为空）。

### 更省事的发法：`/prompt`

`/api/chat` 要自己拼 `messages` 数组；`/prompt` 只发一段文本，而且**同步返回 accepted**，不必回读任何东西就知道送到了。

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"requestId":"'"$(date +%s)"'","message":"只回两个字：收到"}' \
  "$BASE/api/sessions/<目标>/prompt"
```

期望：

```json
{"result":{"accepted":true,"sessionId":"...","requestId":"probe-1794669273","agentId":"...","runtimeGeneration":3}}
```

字段名是 `message` 不是 `text`，写错返回 400 `webError.messageRequired`；`requestId` 必填，缺了返回 400 `webError.requestIdRequired`。

返回里的 `runtimeGeneration` 是对端当前的运行时代号。它比你发之前记下的那个大，说明服务端刚替你拉起过它——这个信息 `/api/chat` 的 SSE 里没有。

**发完之后怎么知道它做完了**：看第 5.5 节，或者查 `/api/sessions/<目标>/messages` 的 `total` 是否变大（这时候可以看，因为它已经不在生成中途）。

## 5.5 看着对方干活：订阅 stream，不要 sleep

**两个流别搞混。**

- `/api/sessions/<id>/stream` 推的是**这个会话的消息流**：`start` / `text-delta` / `finish`。看它干活用这个。
- `/api/events` 推的是**全局状态快照**：`event: state` 加一份 `data: {projects, sessions, runtimes, ...}` 的 JSON。看谁上线、谁下线、标题变没变用这个，它不推消息文本。

订阅一个不存在的会话 id 到 `/stream`，第一帧仍然是全局 `event: state`（实测：拿全零 UUID 请求，HTTP 200，返回的就是状态快照）。**别把这一帧当成「对方说话了」**——消息帧一定带 `"type"`。

**首选订阅它的流。** 一次连接，服务端把对端的 `start` / `text-delta` / `finish` 实时推过来，比轮询文件干净：

```bash
curl -sN --max-time 600 -H "$AUTH" "$BASE/api/sessions/<目标>/stream"
```

`--max-time` 是给自己设的上限，别不设。到点断开不影响对端继续干活，重连一次接着看。

**看它活着没有，看 `runtimes[].status`**：`running` 表示它正在生成，`idle` 表示它手上的活已经做完。整条从 `runtimes[]` 里消失说明进程已经停了；这时发消息它会自己回来（见第 5 节），不必先 `activate`。

**退路才是轮询。** 长 sleep 会撞上工具自己的超时——几百秒的 curl 会被中途中止，数据只到手一半。所以把第 5 节那条 curl 的输出重定向到文件、后台跑：

```bash
curl -sN -H "$AUTH" -H "Content-Type: application/json" -d @body.json "$BASE/api/chat" > /tmp/reply.txt 2>&1 &
```

然后每轮只查一次、立刻返回：

```bash
stat -c %s /tmp/reply.txt
tail -c 200 /tmp/reply.txt | tr -d "\n" | tail -c 120
```

看见 `"type":"finish"` 和 `data: [DONE]` 就是跑完了。没看见就下一轮再查——查一次不到 1 秒，一次完整审查要查几十轮。
## 5.6 复用旧会话还是新开

判断办法只有一条：**目标会话里有没有关于被审对象的结论。**

- 有，就新开。它记得自己上一次的判断，你说「这些已经修了」，它会顺着那个结论找理由，不再独立看。审查、验证、要第二意见都属于这类。
- 没有，就复用。同一件事的下一轮执行、换个小需求、接着改代码，上下文有用，新开反而要重新交代一遍。

新开之后旧会话不要停：它可能还有没跑完的活，停掉等于丢掉。它不动了会自己进 idle。
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
> 0. **先认自己是谁**：`echo $PIDECK_SESSION_ID`。
>
>    它为空就用第 2 节那两条兜底：`$PI_SESSION_FILE` 去 `runtimes[].sessionPath` 里对，或者取 `$PIDECK_LINKED_SESSIONS_URL` 的尾段。
>
>    拿到自己的 id 之后比对：等于 `<目标 sessionId>` 就停下——停掉的就是你自己，没有进程去发 activate。**三条路都拿不到自己的 id 也停下，别赌。**
> 1. **取 target**：`curl -s -H "$AUTH" "$BASE/api/sessions/runtimes"`。在 `runtimes[]` 里找 `sessionId` 等于目标的那一项，记下 `agentId` 和 `runtimeGeneration`（下面叫它 `N`）。
> 找不到说明目标没在跑，直接跳到第 3 步。
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
>      -d '{"id":"<目标>","messages":[{"role":"user","parts":[{"type":"text","text":"重启结束，这条消息用来验证你能接活"}]}]}' \
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

**为什么不用等目标回合结束**：如果目标正在写回复，stop 会让它断在半句。判断它忙不忙没有可靠办法——问用户最快。新开的空会话天然空闲，这是它最省事的地方。

**重启之后你是新进程**：不记得上一个进程在干什么。会话历史仍在同一个 jsonl（`runtimes[].sessionPath`），上下文不丢，但「成没成」只能由重启后的一方重读 `runtimes[]` 确认。

### 6.1 这条流程的实测记录

2026-11-14，Windows 发行版。两种用法都真跑过。

**用法一：重启一个没在跑的会话。**

```text
第 0 步 echo $PIDECK_SESSION_ID -> 执行者自己的 id，不是目标
第 1 步 取 target        目标不在 runtimes[] 里 -> 按技能跳到第 3 步
第 3 步 activate        HTTP 200  gen=3  status=idle
第 5 步 发消息          total 加 3
收尾  stop(gen=3)       HTTP 200
       activate         gen=4
```

`activate` 要 4~6 秒才返回，不是卡住。

**用法二：让别人重启自己。** 执行者是一个新建的普通会话。

```text
被停的那一刻    手上正在跑的工具调用直接 abort（This operation was aborted）
重启后自读      gen 2 -> 3
执行者第 5 步发的报告    代号与我自读的一致
```

**`total` 一次加 3 不是 1**：你发的那条 + assistant 的回复 + 一条注入。

**各步耗时**（同一台机器，目标原本没在跑，跑完整一套）：

```text
建普通会话     百毫秒级
activate       秒级（最贵，服务端拉起 pi 进程）
取 target      百毫秒级
stop           百毫秒级
activate       秒级
发消息         秒级（要等模型回一轮）
停 + 删         亚秒级
```

**绝大部分时间花在 activate 上，那是服务端拉起 pi 进程的时间，省不掉。** 目标已经在跑时只走 stop + activate，秒级就是一次重启的下限。其余各步：`取 target`、`stop`、`建会话` 是百毫秒级；`发消息` 要等模型回一轮。

表里是量级，不是常量：换台机器、换模型都会变。

所以别做这两件事：不要建完会话反复轮询 `runtimes[]` 等它出现（`activate` 返回时进程已经在里面，`status` 就在返回体里）；不要为了拿 `total` 反复拉 `/messages`（一次几十 KB 起，大会话更大）。

**代号和 `agentId` 会一起变。** 两个都是「换没换进程」的证据，任一个变了就是换了。对照就看这两个数字，别去猜 pid。

**用完把执行者删掉**，别留在侧边栏里：

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
  "$BASE/api/sessions/<执行者 id>/delete"
```

返回 `{"deleted":true}`。先 stop 再 delete，否则进程还占着。

**匿名会话会在空闲后消失。** `POST /api/sessions/anonymous` 建出来的会话（标题是「匿名聊天 - Chat」）空闲几分钟后自己从 `runtimes[]` 和 `sessions[]` 里消失，之后对它的 `activate` 返回 `SESSION_NOT_FOUND`。

PiDeck 里正常新建的会话不受这个影响。

**一个空会话被 stop 会整个消失，不是变闲。** 实测（本机，2026-11-14）：新建会话 → `activate` → 直接 `stop`，中间没发过任何消息。

结果：`/api/state` 的 `sessions[]` 里已经没有它，`activate` 返回 `{"result":{"ok":false,"error":{"code":"SESSION_NOT_FOUND"}}}`，`/messages` 返回 HTTP 200 加空数组。

发过消息的会话不会这样：同样 `stop` 之后 `state` 里还在，`status` 是 `active`，`activate` 成功且 `runtimeGeneration` 1→2。

所以：**别拿刚建好的空会话试 stop**，试完它就不存在了，而且不会有任何报错提示你这一点。

**target 里只有 `agentId` 真的被校验。** 实测：传一个不存在的 `agentId`，返回 `{"result":{"ok":false,"error":{"code":"SESSION_RUNTIME_UNAVAILABLE"}}}`。

同一个请求，`agentId` 对、`runtimeGeneration` 故意传 9（真实值是 1）却**返回成功**。

所以代号写错不拦，进程号写错才拦。别把 `runtimeGeneration` 当成安全边界，它只是给你自己对账用的。

**会话不存在时 `/messages` 不给 404。** 返回 HTTP 200 加 `{"messages":[],"total":0,"windowStart":0,"truncated":false}`，和「存在但一条消息都没有」长得一模一样。

要区分就看 `/api/state` 的 `sessions[]` 里有没有这个 id。


## 7 动作：运行时 21 个，记录层 8 个

两套东西别混：**运行时动作**动的是活着的进程，**记录层动作**只改会话记录。改记录不会让正在跑的进程换模型，停进程也不会删掉记录。

### 7.1 运行时动作：`/api/sessions/<id>/runtime/<action>`

全部 21 个，从源码 `WebApiRoutes.ts` 的路由正则逐条抄出：

| action | 额外 body 字段 | 作用 |
|---|---|---|
| `activate` | 无（body 传 `{}`） | 冷会话拉起进程 |
| `stop` | — | 停进程，会话记录留着 |
| `abort` | — | 只中止当前回合，进程留着 |
| `restart` | — | 停完接着启；等待期间每 2 秒回一次心跳 |
| `compact` | `prompt?` | 压缩上下文 |
| `state` | — | 读运行时状态 |
| `commands` | — | 列该运行时的命令 |
| `models` | — | 列可用模型 |
| `model` | `provider` `modelId` `modelName?` | 给活着的进程换模型 |
| `thinking` | `level` | 换思考档 |
| `permission` | `preset` | 换权限预设 |
| `edit-message` | `messageId` `newText` | 改历史里某条消息 |
| `delete-message` | `messageId` | 删历史里某条消息 |
| `prepare-resend` | `messageId` | 准备重发 |
| `clone` | — | 克隆运行时 |
| `fork` | `entryId` `mutationFork?` `branchMode?` | 从某一轮分叉出新会话 |
| `get-fork-messages` | — | 分叉点候选消息 |
| `rewind-list` | `limit?` `beforeTimestamp?` | 检查点列表，可翻页 |
| `rewind-diff` | `checkpointId` | 某个检查点改了什么 |
| `rewind-restore` | `checkpointId` `scope` | 回滚到某检查点 |
| `export-html` | — | 导出成 HTML |

`activate` 是唯一不要 target 的——它要做的正是「这个冷会话现在起来」，没有 target 可回传。其余 20 个都要 `body.target.sessionId` 与路径里的 id 完全相同，不一致返回 400 `webError.runtimeTargetRequired`。

`target.agentId` 是真闸：给假值会被拒（2026-11-14 在 Windows 发行版上实测）。`target.runtimeGeneration` 不校验，给 999 也照做。三个字段都传最稳。

**`activate` 是冷启动，别按毫秒算。** 本机实测（Windows 发行版，进程完全没起）一次 3556 毫秒；别人机器上记过一次 45 毫秒，那是进程已经预热的情况。给它设超时按 5 秒以上给。

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
  "$BASE/api/sessions/<sessionId>/runtime/activate"
```

**`state` 是唯一能一次问清「它现在在干嘛」的动作。** 返回体套两层：`{result:{ok, value:{target, value:{...}}}}`，真正的字段在里层：

| 字段 | 读出来的意思 |
|---|---|
| `modelId` / `provider` / `thinkingLevel` | 它此刻实际在用的模型与思考档，不是记录里那份 |
| `isStreaming` / `isTurnActive` | 正在生成 / 有回合没结束 |
| `isExecutingTool` / `isCompacting` | 正在跑工具 / 正在压缩上下文 |
| `contextTokens` / `contextWindow` / `contextPercent` | 上下文用掉多少 |
| `toolStateSequence` | 工具状态序号，每变一次 +1，拿它看它有没有在动 |

**换模型会把思考档重置成新模型的默认值。** 本机实测：`thinking=low` 的时候调 `model` 换到另一个模型，`thinkingLevel` 变回 `high`。所以这两步要按顺序发——先 `model`，再 `thinking`。反过来先设了思考档再换模型，等于没设。

**`permission` 在 pi 后端一定失败。** 源码里只给 DSH 后端注册了这个能力，pi 会话发过去返回 `SESSION_COMMAND_FAILED`（本机实测）。要改 pi 会话的权限，走记录层的 `update` 或者界面。

**鉴权规则**：写操作（POST）只认请求头。`?token=` 查询参数只对 GET 和 SSE 开放，因为浏览器的 EventSource 不能自定义请求头；写操作开这个口子会把令牌漏进代理日志和浏览器历史。

其余 20 个都要 `body.target.sessionId` 与路径里的 id 完全相同，不一致返回 400 `webError.runtimeTargetRequired`。

`target.agentId` 是真闸：给假值会被拒（2026-11-14 在 Windows 发行版上实测）。`target.runtimeGeneration` 不校验，给 999 也照做。三个字段都传最稳。

### 7.2 记录层动作：改记录，不碰进程

| 端点 | 方法 | body / 查询 | 作用 |
|---|---|---|---|
| `/api/sessions` | POST | `projectId`（必填）`title` `model` `welcomeModel` `thinkingLevel` `backend` `agentPreset` `acpToolId` `sideTask` | 建一份草稿，返回 `{session}` |
| `/api/sessions/anonymous` | POST | `projectId` `title` `backend` `model` `thinkingLevel` | 不写会话文件的一次性运行时 |
| `/api/sessions/<id>/update` | POST | `title` `model` `thinkingLevel` `permissionPreset` `agentPreset` `backend` `acpToolId` `proxy` `sideTask` | 改会话记录 |
| `/api/sessions/<id>/delete` | POST | — | 删记录 |
| `/api/sessions/<id>/copy` | POST | — | 复制 |
| `/api/sessions/<id>/export-html` | GET | — | 导出 |
| `/api/sessions/<id>/reference-messages` | GET | — | 取被引用的消息 |
| `/api/sessions/<id>/security-level` | POST | `levelId`（字符串或 `null`） | 换安全等级，`null` 表示跟全局默认 |

`update` 把 `model` / `thinkingLevel` 传 `null` 当作「清掉覆盖、回到默认」。它**只改记录**：改标题立刻生效（下一次 `/api/state` 就能看到），但改模型对已经活着的进程不起作用，要换活进程的模型得用 7.1 的 `model`。

**首条消息会改写标题。** 新会话建好时标题是你给的那个，第一轮对话结束后 pi 的命名扩展会用模型重新起一个（`titleOrigin` 字段记录「这条标题是谁取的」）。所以拿标题认会话会认错，认会话只认 id。

**删除不等于停进程。** `delete` 删的是记录，界面上那份条目要到下一次状态推送才消失，偶尔会看到几秒残影，刷新即无。

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
- **改了这个技能，已经在跑的会话看不到新版。** 技能是进程启动时用 `--skill <目录>` 注入的（源码 `PiProcess.ts`），内容在启动那一刻就进了内存。要让它生效，只能重启那个会话（第 6 节）或者新开一个。

## 10 验收：三级别

按你做到哪一级说哪一级。

1. **能观察自己**（只读）：`echo $PIDECK_SESSION_ID` 非空，且这个 id 出现在 `/api/state` 的 `sessions[]` 里。
2. **能读别人**（只读）：`sessions[]` 里看得到别的会话标题。
3. **能驱动别人**（会改动别人）：对目标发一条 `ping`，**没有 `error` 帧**就是送到了（别拿 `total` 或帧数当判据——对方忙的时候整条连接可能只有一行 `: ping`，而消息确实进了它的对话，见第 5 节）。要验「真进程」，走一次第 6 节，`runtimeGeneration` 变了才算。

## 11 改这个技能之前

第 7 节那两张表是照源码抄的，抄错没人看得见。改完跑下面这两条检查，两条的 rc 都得是 0：

```bash
node resources/skills/pideck-web-api/check-doc.mjs    # 第 7 节的动作表、端点数，逐条对源码
node resources/skills/pideck-web-api/check-paths.mjs  # 全文每个 /api 路径，逐段对源码
```

两条都自带坏样本：故意写错一个动作名，或者把一个路径段拼错，它们必须报红。一直绿的那条，多半是检查本身坏了。
