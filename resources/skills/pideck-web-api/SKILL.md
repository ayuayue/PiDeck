---
name: pideck-web-api
description: "用 PiDeck 的 HTTP 服务读会话状态、给另一个窗口发消息、重启某个会话（服务默认关闭，要先在设置里打开 Web 服务，没开就没有令牌）。要用脚本或别的 agent 控制 PiDeck 时用。不用于改 PiDeck 源码。Use for PiDeck web API, SSE."
---

# PiDeck Web API

**一个只监听本机的 HTTP 服务，把「窗口里发生的事」变成可以读、可以写的端点。读是安全的；写会落到另一个窗口上。**

三条前提，缺一条后面全不成立：

1. 服务默认关闭。要人先在「设置 → Web 服务」里打开，没开就没有令牌。
2. 命令按 Git Bash 写。确认方法：`echo $APPDATA` 有值就是对的那个 shell。
3. 每段 bash 是独立 shell，变量不跨段保留。`$AUTH` 与 `$BASE` 必须在同一次调用里设好。

端点全集以源码 `src/main/web/WebApiRoutes.ts` 为准（`/api/health` 与 `/api/events` 在 `WebServiceManager.ts`），本文是实测记录。两处对不上时信源码。


**这份文件里的每条断言属于三类之一，读之前先分清哪一类：**

| 类 | 长相 | 怎么验 |
|---|---|---|
| 实测事实 | 「翻到底没有一个相等」这种 | 文中的命令能复算；复算不出，按未验证计 |
| 机器判据 | `check-` 开头的脚本 | 跑它，看 rc。装上 PiDeck 的机器上没有源码，只跑得动带 `--selftest` 的 |
| 人的判断 | 标了 `[人]` | 机器判不了，只能人看。**别把跑绿的判据当成这条也验过了** |

**每条规则后面都带着它挡的那次事故，写成一句「为什么」。** 删掉那句只留结论，下一个人会照着结论做出相反的判断，而盘上再也读不出当初为什么这么定。

## 0 三十秒：先判会不会打断别人，再连上

**先看你要做的那件事落在哪一类。写的那一类会落到另一个窗口上。**

| 想做的事 | 会打断别人吗 | 去哪 |
|---|---|---|
| 读自己的时间线、todo、子 agent、运行状态 | 不会 | 2 |
| 找别的会话、发消息、读回复 | 不会停它，但消息会插进它的对话 | 2、3、6 |
| 重启某个会话（自己或别人） | 会，目标被停 | 4 |
| 单独停、启、中止 | 会，目标被停 | 5.1 |
| 不知道该让对方知道什么 | 不会 | `references/collab.md` |

然后才是连上。下面这段一次做完三件事：从设置文件读出令牌与端口、确认令牌非空、设成 `$AUTH` 与 `$BASE` 供后面用。
```bash
eval "$(node -e 'const fs=require("fs"),p=require("path");const base=process.env.APPDATA;for(const d of ["PiDeck","PiDeck Dev"]){try{const s=JSON.parse(fs.readFileSync(p.join(base,d,"settings.json"),"utf8"));if(s.webServiceToken){console.log("export TOKEN="+s.webServiceToken);console.log("export PORT="+(s.webServicePort||8765));break}}catch{}}')"
[ -n "$TOKEN" ] || echo "令牌为空：服务没开，或设置文件不在预期位置"
export AUTH="Authorization: Bearer $TOKEN"
export BASE="http://127.0.0.1:$PORT"
echo "port=$PORT token长度=${#TOKEN}"
echo "我=$PIDECK_SESSION_ID"
curl -s -o /dev/null -w 'health=%{http_code} ' "$BASE/api/health"              # 期望 200
curl -s -o /dev/null -w '有令牌=%{http_code} ' -H "$AUTH" "$BASE/api/state"     # 期望 200
curl -s -o /dev/null -w '无令牌=%{http_code}\n' "$BASE/api/state"              # 期望 401
```

期望 `port=8765 token长度=36 我=<uuid> health=200 有令牌=200 无令牌=401`。令牌长度 0 说明服务没开。

前三条不对就别往下走：health 不是 200 说明服务没开或端口错，与令牌无关；有令牌还 401 说明令牌错。

**令牌每段重读，别缓存。** 主题切换、开窗口都会改写 `settings.json`，令牌重置后旧值全变 401，而 401 与「服务没开」长得一样。**别拿这个文件的哈希或字节数当判据**——它随时在变，而且可以一个字节都不差（变的是窗口位置这类时间戳）。

## 1 身份：我是谁、谁在跑

**自己的会话 id 只有一条命令**：`echo $PIDECK_SESSION_ID`。为空说明你不在 PiDeck 里跑（比如终端 TUI），后面各节不适用。

两个常见的错：

- **`$PI_SESSION_ID` 不是 PiDeck 身份**，它是 pi 自己的会话 id，坐标系不同。
- **别用 `grep ^PI_` 筛环境变量**：`PIDECK_SESSION_ID` 不以 `PI_` 开头，会被整条漏掉，剩下唯一像身份的 `$PI_SESSION_ID` 看起来对、其实错。

**取不到时走兜底，别停。** `$PI_SESSION_FILE` 是 pi 的会话文件路径，`runtimes[].sessionPath` 指向同一个文件：

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" |
  node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const s=j.runtimes.find(r=>r.sessionPath===process.env.PI_SESSION_FILE);console.log(s?s.sessionId:"没找到")'
```

打印 uuid 就是你，匹配区分大小写。

`$PIDECK_LINKED_SESSIONS_URL` 的尾段**不是** PiDeck 会话 id，只在 `sessions[]` 里查得到才算数：

```bash
curl -s -H "$AUTH" "$BASE/api/state" | grep -c "$PIDECK_SESSION_ID"                # 期望 >=1
curl -s -H "$AUTH" "$BASE/api/state" | grep -c "${PIDECK_LINKED_SESSIONS_URL##*/}"  # 实测 0
```

**认错的代价不对称。** 第 4 节第 0 步拿这个 id 判断「目标是不是我自己」，拿一个查不到的 id 去比，结论必然「不是我」，于是停掉自己——被停之后没有进程发 activate，就是永久停着。查不到就**当它不存在**。

**会话与运行时是两回事。** 会话是侧边栏的一行，可以存在而没在跑；运行时是为它跑的那个进程。`sessions[]` 答「有哪些会话」，`runtimes[]` 答「此刻哪些进程活着」，两个数组答的不是同一个问题。`runtimeGeneration` 每起一次进程加一，`agentId` 同时换一个新 uuid，验「换没换进程」看哪个都行；后者会过期。

## 2 读：自己的、别人的、全量

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/messages"   # 时间线
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/todo"       # todo
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/subagents"  # 子 agent
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" | head -c 300        # 我的进程活着没有
curl -s -H "$AUTH" "$BASE/api/state"                                  # 所有会话与项目
```

`sessions[]` 每行 `{id, projectId, title, status, model, thinkingLevel, updatedAt, createdAt}`；`runtimes[]` 每行 `{sessionId, agentId, runtimeGeneration, projectId, cwd, status, sessionPath, createdAt, deckSessionId}`。

**进程活着不代表有活在跑**：刚 activate 起来是 `idle`，有回合在跑才是 `running`。反过来，不在 `runtimes[]` 里只说明进程没起，消息照样送得到——服务端会替你 activate，所以别为了发消息先起进程。

三个会判错的点：

- **`GET /api/sessions` 不存在**，猜它拿到 `{"code":"webError.apiNotFound"}`。列会话用 `/api/state`。
- **列表里没有某个会话，不等于它不存在**：先确认 `projects[]` 里有它所属的项目。
- **`/messages` 对不存在的会话不返回 404**，返回 200 加空数组，与「存在但没消息」一模一样。要区分就看 `sessions[]`。

`/messages` 返回 `{messages, total, windowStart, truncated}`，**是有界窗口，不是全部历史**：

- `messages` 从旧到新排，要末尾 N 条用 `messages.slice(-N)`。
- `total` 数的是**文件里的条目**，`messages` 是转换后的消息，基数不同（工具记录、压缩卡片、分支展开各不一样）。**别相减，也别拿它推该有多少条。**
- `windowStart: 0` 表示没截断；`truncated: true` 表示还有更早的。

**翻历史用 `/messages/page`，判据只看 `nextBefore`**：

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/<目标>/messages/page?pageSize=100&before=<nextBefore>"
```

把上一页的 `nextBefore` 传给 `before`，直到它是 `null`，那就是拿全了。不要用「累计条数等于 `total`」——翻到底没有一个相等。`pageSize` 的单位是**一轮问答**（默认 3），一轮多少条从 3 到几十不等。单次 `/messages` 不吃 `?before`，传了也不生效。

参数不校验，四个坑：非整数当没传；负数 `before` 返回空 `messages` 且 `nextBefore: null`（像翻到底，其实是参数错）；`pageSize` 给 0 或负数退成 1 轮；`?limit` 一律无视。**每次返回整个窗口**：1653 条的会话一次 226 KB，`pageSize=100` 能到 15 MB。所以别拿它轮询。

单条消息字段 `{id, agentId, role, text, timestamp, meta}`，assistant 多 `thinking`、`model`、`stopReason`。正文在 `text` 不在 `parts`（`parts` 只在 `/api/chat` 请求里用）。要原始工具调用参数只能读磁盘 jsonl，路径取 `runtimes[]` 的 `sessionPath`。

## 3 写：发消息

**发之前再认一次自己**：`echo $PIDECK_SESSION_ID`。目标等于它，你就是在给自己发消息——消息插进你自己的对话，然后你自己等自己回。标题、`updatedAt`、`model` 都不是身份。

### 3.1 首选 `/prompt`：同步返回 accepted

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"requestId":"'"$(date +%s)"'","message":"只回两个字：收到"}' \
  "$BASE/api/sessions/<目标>/prompt"
```

期望 `{"result":{"accepted":true,...,"runtimeGeneration":3}}`。`accepted: true` 表示进了队列，服务端负责投递，**此时可以先不读回执**——accepted 之后还要隔十几秒才出现在对方记录里。要证明对方真的看到了，让它在回执里贴原文片段（做法见 `references/collab.md`）。字段名是 `message` 不是 `text`（写错 400 `webError.messageRequired`）；`requestId` 必填（缺了 400 `webError.requestIdRequired`）。返回里的 `runtimeGeneration` 比你发之前记的大，说明服务端刚替你拉起过它；`sessionPath` 直接给 jsonl 路径，省一次查询。

**中文别走命令行参数。** `curl -d "中文"` 会先过终端代码页（Windows 上常是 GBK），对端收到一串 U+FFFD。两处都要：请求头带 `charset=utf-8`，正文走文件。

```bash
node -e 'const fs=require("fs");fs.writeFileSync("msg.json",JSON.stringify({requestId:String(Date.now()),message:fs.readFileSync("msg.txt","utf8")}),"utf8")'
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @msg.json "$BASE/api/sessions/<目标>/prompt"
```

判据：读对端的会话记录，数替换符，期望 0。

```bash
node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8");console.log((t.match(/\uFFFD/g)||[]).length)' "<对端的 sessionPath>"
```

**收到乱码就直说，别猜。** 对端回复变成 `���` 时，唯一正确的动作是回一句「读不懂，这是原文：<逐字粘贴>」，然后停下等它对。按上下文猜，猜错了在记录上看不出异常——你会照着猜出来的意思改出完全无关的东西。

### 3.2 要看流式才用 `/api/chat`

请求体是完整消息数组；`id` 是目标会话的 sessionId，不是 `agentId`。

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<目标 sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"ping"}]}]}' \
  "$BASE/api/chat"
```

返回 SSE，一行一帧：`start` → `reasoning-delta`（有思考时才有）→ `text-start` → `text-delta` → `text-end` → `finish` → `[DONE]`；带工具调用还有 `tool-input-start` / `tool-output-available`。不认识的帧按类型过滤，别等某个特定帧——只认 `finish` 或 `[DONE]` 判「流结束了没有」。`-N` 必须加，否则看不到流式。

### 3.3 判「送到没有」只有一条

**看 `error` 帧，不看 `total`，也不看有没有 data 帧。** 没有 `error` 帧就是送到了（哪怕 0 个 data 帧、`total` 当场没变）；有就是没送到，原因在 `errorText` 里。

三处分开看：400 是没进队列（缺 `id`、没有 user 项、text 为空，直接 JSON 报错）；200 加 `error` 帧是进了但找不到会话；200 加无 `error` 帧才是送到。

**`finish` 不是「送到」的证据**——error 流里同样带 `finish` 与 `[DONE]`。

```bash
curl -sN --max-time 30 -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<目标 sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"ping"}]}]}' \
  "$BASE/api/chat" > /tmp/chat.txt
if grep -q '"type":"error"' /tmp/chat.txt; then
  echo "FAIL 没送到：$(sed -n 's/.*"errorText":"\([^"]*\)".*/\1/p' /tmp/chat.txt | head -1)"
  exit 1
fi
grep -Eq '"type":"(start|finish)"' /tmp/chat.txt || { echo "未验证：既没有 start 也没有 finish（空文件、只有 : ping 心跳、或被 --max-time 掐断）"; exit 2; }
echo "PASS 没有 error 帧，且收到了 start 或 finish"
```

三态：1 没送到、0 送到、2 无法判定。目标没激活时这条会自己拉起它，第一次可能慢几秒。

### 3.4 对方在 goal 模式时

发完消息立刻补一条 `/goal on`，**单独成一条，正文一个字都不带**。对方收到 `/goal` 加文字会进入自动续跑，普通消息不会；`/goal 新目标` 是覆盖，会把它的活换成你写的那句，等于你替用户改了对方的目标。

```bash
[ "$(wc -c < msg.txt)" -eq 8 ] || { echo "msg.txt 必须正好 8 字节：/goal on，无换行无正文"; exit 1; }
```

用 `printf` 写 msg.txt，别用 `echo`（会补换行或解释反斜杠）。

### 3.5 等它干完

**两个流别搞混。** `/api/sessions/<id>/stream` 推这个会话的消息帧；`/api/events` 推全局状态快照（`event: state`），不推消息文本，也没有心跳帧——连接静默不等于断了。

```bash
curl -sN --max-time 600 -H "$AUTH" "$BASE/api/sessions/<目标>/stream"
```

`--max-time` 必须设：到点断开不影响对端继续干活，重连接着看。订阅一个不存在的 id，第一帧仍是全局 `event: state`——别把这一帧当成「对方说话了」，消息帧一定带 `"type"`。

**只有 `finish` 和 `[DONE]` 是结束证据。** 连接自己断了、被 `--max-time` 掐了、一直只有 `: ping`，都不算跑完——对方可能在跑长工具调用。要判断它在不在动，用 5.1 的 `state` 看 `isStreaming` 与 `isTurnActive`。退路是轮询：把 curl 重定向到文件后台跑，每轮查 `stat -c %s /tmp/reply.txt` 与 `tail -c 200`。

**[人] 什么时候算结束**：对方明确写出它那边也没有了，或者逐条回应了你提的每一条。回一句「收到」不算。代价不对称——多等一轮只花一轮，早停一轮则它的修复找不到人复核。

**[人] 复用旧会话还是新开，判据只有一条：目标会话里有没有关于被审对象的结论。** 有就新开——它记得自己上次的判断，会顺着那个结论找理由；没有就复用——同一件事的下一轮、换个小需求，上下文有用。新开之后旧会话不要停。

[人] 同一对象的多轮复核可以复用会话，但要守住三条：每轮重新现跑判据、重读本轮改动的那几段、不拿上一次的结论当依据。违反任一条，复用就等于没复核。要第三方独立判断时必须新开。

与另一个会话按 PR 模式协作（抢活、署名、交付四件、GitHub 三种权限）见 [references/collab.md](references/collab.md)。

## 4 停与启：你关不掉自己

**重启 = stop + activate。你自己发不出这两个请求**：stop 杀掉的就是发请求的那个进程，没有进程去发 activate。

让别人做。最省事：新建一个普通会话，把这个技能名和下面这段一起贴给它。

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"projectId":"builtin-chat"}' "$BASE/api/sessions"
```

`projectId` 从 `/api/state` 的 `projects[]` 取。返回 `{"session":{"id":"..."}}`。新建是草稿态（`status: draft`，无 `sessionPath`），直接发消息它就起来，不用先 activate。

**别用 `/api/sessions/anonymous` 建执行者**：它 `noSession: true`、没有自己的 `sessionPath`，认「我是谁」时拿到目标的路径，结论必然是「目标就是我」；而且 stop 之后记录被删，activate 返回 `SESSION_NOT_FOUND`（HTTP 仍是 200）。

> 用 `/skill:pideck-web-api`。把会话 `<目标 sessionId>` 重启，先跑完该技能第 0 节，再按下面 0–5 步做，每步贴回输出。
>
> 0. **先认自己是谁**：`echo $PIDECK_SESSION_ID`。为空就走第 1 节两条兜底。拿到之后比对：等于 `<目标>` 就停下——停掉的是你自己，没有进程去发 activate。三条路都拿不到也停下，别赌。
> 1. **取 target**：`curl -s -H "$AUTH" "$BASE/api/sessions/runtimes"`，找 `sessionId` 等于目标那项，记下 `agentId` 与 `runtimeGeneration`（记作 N）。找不到说明目标没在跑，跳到第 3 步。
> 2. **停**：
>    ```bash
>    curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
>      -d '{"target":{"sessionId":"<目标>","agentId":"<上一步的 agentId>","runtimeGeneration":<N>}}' \
>      "$BASE/api/sessions/<目标>/runtime/stop"
>    ```
>    `<N>` 连尖括号一起换成真实数字。URL 里的 `<目标>` 与 body 里的 `sessionId` 必须是同一个值，不一致返回 400 `webError.runtimeTargetRequired`。
> 3. **启**：
>    ```bash
>    curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
>      "$BASE/api/sessions/<目标>/runtime/activate"
>    ```
> 4. **验**：activate 的返回里直接有 `runtimeGeneration` 与 `agentId`。第 1 步找到 target 时，新代号必须比 N 大 1（等于 N 说明没换进程）。第 1 步没找到时没有 N 可比，改看「返回里有 `agentId` 且 `status` 是 `running`」。
> 5. **发一条消息证明它能接活**：用上面 3.2 那条 `/api/chat`，送达看 HTTP 200 且流里没有 `error` 帧。**别把「没吐帧」当成「没送到」**——这条是异步入队，回 200 之后一帧不吐是正常的，重发会真的入队多条。

**第 0 步不能省，也不能换判法。** 别拿 `sessionPath` 或磁盘写入时间推断自己是谁——匿名会话没有 `sessionPath`，会拿目标的路径认自己，结论正好反过来。

**HTTP 200 不代表做成了，必须看 body**：

| 情况 | HTTP | body |
|---|---|---|
| 停成了 | 200 | `{"result":{"ok":true,"value":{...}}}` |
| 目标本来就没在跑 | 200 | `{"result":{"ok":false,"error":{"code":"SESSION_RUNTIME_UNAVAILABLE"}}}` |
| URL 与 body 的 sessionId 不一致 / 没给 target | 400 | `{"code":"webError.runtimeTargetRequired"}` |

**`runtimeGeneration` 有两种语义。** 除 `activate` 外的动作走 `requireBoundTarget`：代号与绑定都比，传错返回 `SESSION_RUNTIME_CHANGED`，命令不执行。`stop` 走 `resolveStopTarget`：只要有 live 绑定的 `agentId` 就取当前代号，传什么代号都不拦。所以 `stop` 唯一的闸是 `agentId`，它比路径里的 sessionId 更权威。

**重启之后你是新进程**，不记得上一个进程在干什么。会话历史仍在同一个 jsonl，上下文不丢，但「成没成」只能由重启后的一方重读 `runtimes[]` 确认。

### 4.1 几张会让你判断错的表

| 现象 | 真相 |
|---|---|
| 空会话被 stop 后整个消失，不是变闲 | 新建 → activate → 直接 stop（中间没发过消息），几秒后从 `sessions[]` 消失，之后 activate 返回 `SESSION_NOT_FOUND` |
| 匿名会话空闲几分钟后消失 | 消失后 activate 返回 `SESSION_NOT_FOUND`；正常新建的会话不受影响 |
| `total` 一次加 3 | 你发的 + assistant 回复 + 一条注入。这是现象，不是判据 |
| 第一次 activate 要几秒 | 在拉起 pi 进程，不是卡住；其余各步百毫秒级。量级不是常量，换机器会变 |

**两件别做的事**：建完会话反复轮询 `runtimes[]` 等它出现（activate 返回时进程已经在了）；为拿 `total` 反复拉 `/messages`（一次几十 KB 起）。

**用完把执行者删掉**：

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
  "$BASE/api/sessions/<执行者 id>/delete"
```

返回 `{"deleted":true}`。删除只走 `POST .../delete`，`DELETE /api/sessions/<id>` 不存在。先 stop 再 delete。删不存在的 id 返回 `{"deleted":false}`，HTTP 仍是 200，那不是失败。

## 5 动作：运行时 21 个，记录层 8 个

**运行时动作动的是活着的进程，记录层动作只改会话记录。** 改记录不会让正在跑的进程换模型，停进程也不会删掉记录。

### 5.1 运行时动作：`/api/sessions/<id>/runtime/<action>`

| action | 额外 body 字段 | 作用 | 回得去吗 |
|---|---|---|---|
| `activate` | 无（body 传 `{}`） | 冷会话拉起进程 | `stop` |
| `stop` | — | 停进程，会话记录留着 | `activate`，但上下文已丢 |
| `abort` | — | 只中止当前回合，进程留着 | 回不去（回合已断） |
| `restart` | — | 停完接着启；等待期间每 2 秒回一次心跳 | 回不去 |
| `compact` | `prompt` | 压缩上下文 | 回不去（上下文已压） |
| `state` | — | 读运行时状态 | 读，无副作用 |
| `commands` | — | 列该运行时的命令 | 读，无副作用 |
| `models` | — | 列可用模型 | 读，无副作用 |
| `model` | `provider` `modelId` `modelName` | 给活着的进程换模型 | 换回原模型，但 `thinking` 已被重置 |
| `thinking` | `level` | 换思考档 | 换回 |
| `permission` | `preset` | 换权限预设 | 换回 |
| `edit-message` | `messageId` `newText` | 改历史里某条消息 | 再改一次（旧文只在历史里） |
| `delete-message` | `messageId` | 删历史里某条消息 | 回不去 |
| `prepare-resend` | `messageId` | 准备重发 | 无副作用 |
| `clone` | — | 克隆运行时 | 删掉克隆 |
| `fork` | `entryId` `mutationFork` `branchMode` | 从某一轮分叉出新会话 | 删掉分叉 |
| `get-fork-messages` | — | 分叉点候选消息 | 读，无副作用 |
| `rewind-list` | `limit` `beforeTimestamp` | 检查点列表，可翻页 | 读，无副作用 |
| `rewind-diff` | `checkpointId` | 某个检查点改了什么 | 读，无副作用 |
| `rewind-restore` | `checkpointId` `scope` | 回滚到某检查点 | 回不去（除非回滚前已有检查点） |
| `export-html` | — | 导出成 HTML | 写文件，不改状态 |

`activate` 是唯一不要 target 的——它要做的正是「这个冷会话现在起来」，没有 target 可回传。其余 20 个都要 `body.target.sessionId` 与路径里的 id 完全相同。

`target.agentId` 在所有命令上都是真闸；`target.runtimeGeneration` 只在非 `stop` 的命令上是真闸。两个字段被拒时返回的不是同一个码：

- `agentId` 给不存在的 uuid，或它与路径里的 sessionId 对不上，返回 `SESSION_RUNTIME_UNAVAILABLE`。
- `agentId` 对、`runtimeGeneration` 漏传或给错，返回 `SESSION_RUNTIME_CHANGED`。

依据是 `runtime/runtimeBinding.ts` 的 `requireBoundTarget`：先核对绑定，再比代号，两步抛的码不同。`SESSION_RUNTIME_CHANGED` 容易被读成「代号变了」，实际是「你传的值不对」，别据此判断会话被重启过。**`agentId` 会随进程换，抓完立刻用**——隔几分钟拿旧值，先撞的是绑定对不上。

**`state` 是唯一能一次问清「它现在在干嘛」的动作**，返回体套两层 `{result:{ok, value:{target, value:{...}}}}`：

| 字段 | 读出来的意思 |
|---|---|
| `modelId` / `provider` / `thinkingLevel` | 它此刻实际在用的模型与思考档，不是记录里那份 |
| `isStreaming` / `isTurnActive` | 正在生成 / 有回合没结束 |
| `isExecutingTool` / `isCompacting` | 正在跑工具 / 正在压缩上下文 |
| `contextTokens` / `contextWindow` / `contextPercent` | 上下文用掉多少 |
| `toolStateSequence` | 只在状态切换时跳变。判断「有没有在动」看两次读是否不同，别拿差值当调用次数 |

**换模型会把思考档重置成新模型的默认值。** 所以先 `model` 再 `thinking`，反过来等于没设。

**`permission` 在 pi 后端一定失败**：源码只给 DSH 后端注册了这个能力，pi 会话发过去返回 `SESSION_COMMAND_FAILED`。要改 pi 会话的权限，走记录层的 `update` 或界面。

**鉴权规则**：写操作只认请求头。`?token=` 查询参数只对 GET 和 SSE 开放，因为浏览器的 EventSource 不能自定义请求头；写操作开这个口子会把令牌漏进代理日志和浏览器历史。

### 5.2 记录层动作：改记录，不碰进程

| 端点 | 方法 | body / 查询 | 作用 | 回得去吗 |
|---|---|---|---|---|
| `/api/sessions` | POST | `projectId`（必填）`title` `model` `welcomeModel` `thinkingLevel` `backend` `agentPreset` `acpToolId` `sideTask` | 建一份草稿，返回 `{session}` | 删掉这份草稿 |
| `/api/sessions/anonymous` | POST | `projectId` `title` `backend` `model` `thinkingLevel` | 不写会话文件的一次性运行时 | 无（不写文件，进程退出即无） |
| `/api/sessions/<id>/update` | POST | `title` `model` `thinkingLevel` `permissionPreset` `agentPreset` `backend` `acpToolId` `proxy` `sideTask` | 改会话记录 | 再 update 改回；但标题已被首条消息改写过 |
| `/api/sessions/<id>/delete` | POST | — | 删记录 | 回不去 |
| `/api/sessions/<id>/copy` | POST | — | 复制 | 删掉副本 |
| `/api/sessions/<id>/export-html` | GET | — | 导出 | 写文件，不改状态 |
| `/api/sessions/<id>/reference-messages` | GET | — | 取被引用的消息 | 读，无副作用 |
| `/api/sessions/<id>/security-level` | POST | `levelId`（字符串或 `null`） | 换安全等级，`null` 表示跟全局默认 | 换回旧的 levelId |

`update` 把 `model` / `thinkingLevel` 传 `null` 当作「清掉覆盖、回到默认」。它只改记录：改标题立刻生效（下一次 `/api/state` 就能看到），但改模型对已经活着的进程不起作用，要换活进程的模型得用 5.1 的 `model`。

**首条消息会改写标题。** 第一轮对话结束后 pi 的命名扩展会用模型重新起一个标题（`titleOrigin` 记录「这条标题是谁取的」）。拿标题认会话会认错，认会话只认 id。

**删除不等于停进程。** `delete` 删的是记录，界面上的条目要到下一次状态推送才消失，偶尔几秒残影，刷新即无。

其余只读端点（项目、智能体、模型、用量、DSH 面板、检索、全文与事件流）见 [references/endpoints.md](references/endpoints.md)。

## 6 代价与边界

这个技能能读别人的时间线、往别人的对话里发消息、停掉别人的运行时。三件事的后果都落在**另一个窗口**上。

- **读别的会话也要先说一声。** 理由不是隐私，是读取会刷新目标窗口的界面，用户会看到自己的窗口在动。
- **给别的会话发消息，等于替用户对它说话。** 只在用户明确讲了「去让某个会话做某事」之后才发。
- **停或重启别的会话，会让目标当前回合中断。** 发出前要拿到用户对**那一个会话**的明确同意。

**别做「守卫替你停」这种设计。** 它会死在两处：stop 的 body 没带 `target` 时返回 400；用 `runtimes[].status` 判断「停了吗」时，空闲进程是 `idle`，于是判定已停。能发出 stop 的应该是另一个活着的进程，不是守卫。

四条硬边界：

1. **只读 pi 的会话文件，不要改** `~/.pi/agent/sessions/*.jsonl`。
2. **没有第二个活着的窗口能接，就别停**：被停之后没人发 activate，就是永久停着。
3. **改了这个技能，已经在跑的会话看不到新版。** 技能是进程启动时注入的（`PiProcess.ts:379`），内容在启动那刻进了内存。要生效只能重启或新开一个。
4. **写给别的会话的文字离开这个文件之后，对方可能什么都不知道**：它可能没读过这个技能、读到的是旧版、刚重启、上下文被压缩过。所以跨会话消息一律自带四件——要它做什么（一句）、依据（绝对路径与 md5）、算完成的标志、它可以拒绝的方式。不要写「见某节」「照某条办」这类指路词——节号是索引，不是内容。

### 6.1 写出去的字

**判断一条话要不要署名只有一条：它会不会被别人当成事实引用。** 会，就要能追到「谁说的、依据哪一版」；不会，署名只是噪声。

- 发到另一个会话：第一行 `[<发送者> → <收件人> · <对象> <md5前8位> · <字节>B · <行数>L · <时间>]`，四个数一律现取。
- 回给用户：每条断言标注来源——`我跑过` / 对端报的 / `未验证`。
- 写进盘上：正文写「依据 `<md5>`」加时间。

通用写作规范与「结论挂证据」不在这里重复：说人话见 `plain-chinese`，证据规范见 `lean-kernel`。

## 7 验收：三条路，各验各的

级别只表示路越来越长，不表示系统更强。

1. **能观察自己**（只读）：`echo $PIDECK_SESSION_ID` 非空，且这个 id 出现在 `/api/state` 的 `sessions[]` 里。
2. **能读别人**（只读）：`sessions[]` 里看得到别的会话标题。这是会话记录那一层；要看别人的**进程**活着没有，用 `runtimes[]`，两件事别混成一句验收。
3. **能驱动别人**（会改动别人）：对目标发一条 `ping`，**没有 `error` 帧**就是送到了。要验「真进程」，走一次第 4 节，`runtimeGeneration` 变了才算。

## 8 改这个技能之前

**用技能的人只需要知道一句：不要手改。** PiDeck 每次启动从安装包写一份到 `~/.pi/agent/pideck-skills/pideck-web-api/`，手改的会被覆盖。

**改技能的人只需要动一个地方**：`<仓库>/resources/skills/pideck-web-api/`。副本同步、清单重生成、CI 门禁、六个判据各自管什么、踩过的坑，见 [references/rewrite.md](references/rewrite.md)。
