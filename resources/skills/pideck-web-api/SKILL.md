---
name: pideck-web-api
description: "用 PiDeck 的 HTTP 服务读自己的状态、给别的窗口发消息、让别的会话重启自己。要用脚本或别的 agent 控制 PiDeck、查会话状态时用。不用于改 PiDeck 源码。Use for PiDeck web API, SSE."
---

# PiDeck Web API

**PiDeck 每个窗口背后跑一个 pi 进程，同时开一个只监听本机的 HTTP 服务。用这个服务，你能读自己的状态、给别的窗口发消息、让另一个会话把自己重启。**

下面每条命令都在 2026-11 的 Windows 发行版上跑过，写了期望返回。返回形状不符说明版本变了，以源码 `src/main/web/WebApiRoutes.ts` 为准（`/api/health` 例外，在 `WebServiceManager.ts:497`）。技能本身不依赖源码，只有想确认「这个端点源码里到底怎么写的」时才需要克隆。

**所有 bash 都按 Git Bash 写**（PiDeck 在 Windows 上附带的那套）。别在 cmd 或 PowerShell 里跑：`$VAR` 不展开，`%APPDATA%` 在 bash 里不展开。怎么确认：`echo $APPDATA` 有值就是对的 shell。

**前提：服务默认关闭**，要人先在「设置 → Web 服务」里打开。没开就没有令牌，下面所有命令都会连不上或返回 401。

## 0 先确定你要做什么

| 想做的事 | 会打断别人吗 | 读哪节 |
|---|---|---|
| 读自己的时间线、todo、子 agent、运行状态 | 不会 | 第 3 节 |
| 找别的会话、发消息、读回复 | 不会停它，但消息会插进它的对话 | 第 4、5、8 节 |
| 重启某个会话（自己或别人） | 会，目标被停 | 第 6 节 |
| 单独停、启、中止 | 会，目标被停 | 第 7 节 |
| 不知道该让对方知道什么 | 不会 | 0.4 |

第 2 节是所有节的前提。**每段 bash 都是独立 shell，变量不跨段保留**——后面各节的命令都假设 `$AUTH`、`$BASE` 已经在**同一次**调用里设好。

## 0.4 子非鱼：你不知道对方知不知道

**先假定对方什么都不知道。**「子非鱼，安知鱼之乐」——你读得到对方落盘的文件，读不到它脑子里有什么：它可能没读过这个技能、读到的是旧版、刚重启、上下文被压缩过。它没坐在你的屏幕前。

所以凡是**离开这个文件的文字**——发给别的会话的消息、签核、PR 正文、写进注入面的规则——一律按最差读者写：

| 判据 | 怎么验 |
| --- | --- |
| 自包含 | 给一个从没读过任何技能的新会话，它不问「X 是什么」就能跑出 rc |
| 不引用 | 不写「见第 6 节」「按 9.2 办」「上文」。要它遵守的规则，把原文抄进消息 |
| 可复算 | 结论挂一条它自己能跑的命令与返回值；复算不出的断言，按未验证计 |

**本文件内部的节号引用不受这条限制**：同一个文件里跳转，读者手里有全文。受限的是离开文件的那些字。

机器判据 `node check-self-contained.mjs <文件>` 扫的就是前两行；第四种红是空对空——文件不到 40 个非空字符，什么要求都没提，判它自包含等于没判。

**第一步不是问「你读过技能吗」，是假定它没读过，把要它做的事连同做这件事需要的全部命令一次贴全。** 问一轮要一分钟，贴全只要十秒；而且它答「读过」你也无法验证——那正是子非鱼。

## 1 几个词

- **会话**：PiDeck 侧边栏里的一行。会话可以存在，但此刻没在跑。
- **运行时**：为某个会话在后台跑的那个 pi 进程。会话是记录，运行时是进程。
- **运行时代号**（`runtimeGeneration`）与 `agentId`：同一会话每起一次进程，代号加一，服务端同时发一个新的 `agentId` uuid。两个一起变，都在 `runtimes[]` 里，验「换没换进程」看哪个都行。
- 代号不是操作系统的 PID，那个不对外暴露。这两个字段都要传当前值：多数命令传错直接拒，唯独 `stop` 只认 `agentId`（两种语义的分界见 7.1）。
- **判据**：某一项能返回真假的检查，例如「发一条 ping，没有 error 帧就是送到了」。
- **口径**：一条判据管到哪为止。口径之外它给不出答案，不是它判错了。

## 2 连上：地址、令牌、自己的会话 id

**服务默认关闭**，在「设置 → Web 服务」里打开，端口默认 8765。令牌与端口都在设置文件里（Dev 通道在 `PiDeck Dev` 目录，下面两个都试）：

```bash
eval "$(node -e 'const fs=require("fs"),p=require("path");const base=process.env.APPDATA;for(const d of ["PiDeck","PiDeck Dev"]){try{const s=JSON.parse(fs.readFileSync(p.join(base,d,"settings.json"),"utf8"));if(s.webServiceToken){console.log("export TOKEN="+s.webServiceToken);console.log("export PORT="+(s.webServicePort||8765));break}}catch{}}')"
[ -n "$TOKEN" ] || echo "令牌为空：服务没开，或设置文件不在预期位置"
export AUTH="Authorization: Bearer $TOKEN"
export BASE="http://127.0.0.1:$PORT"
echo "port=$PORT token长度=${#TOKEN}"
```

期望 `port=<默认 8765> token长度=36`。长度 0 说明服务没开。

**自己的会话 id 只有一条命令**：`echo $PIDECK_SESSION_ID`。为空说明你不在 PiDeck 里跑（比如终端 TUI），后面各节不适用。

**别拿错变量**：`$PI_SESSION_ID` 是 pi 自己的会话 id，不是 PiDeck 身份。**也别用 `grep ^PI_` 筛**——`PIDECK_SESSION_ID` 不以 `PI_` 开头，会被整条漏掉，剩下唯一像身份的 `$PI_SESSION_ID` 看起来对、坐标系是错的。

**取不到时别停，走兜底**：`$PI_SESSION_FILE` 是 pi 自己的会话文件路径，`runtimes[].sessionPath` 指向同一个文件：

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" |
  node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const s=j.runtimes.find(r=>r.sessionPath===process.env.PI_SESSION_FILE);console.log(s?s.sessionId:"没找到")'
```

打印 uuid 就是你；「没找到」说明你不在这台 PiDeck 里跑。匹配区分大小写。

`$PIDECK_LINKED_SESSIONS_URL` 的尾段**不是** PiDeck 会话 id——只在 `sessions[]` 里查得到才算数：

```bash
curl -s -H "$AUTH" "$BASE/api/state" | grep -c "$PIDECK_SESSION_ID"                # 期望 >=1
curl -s -H "$AUTH" "$BASE/api/state" | grep -c "${PIDECK_LINKED_SESSIONS_URL##*/}"  # 实测 0
```

**认错的后果比找错人重**：第 6 节第 0 步用这个 id 判断「目标是不是我自己」，拿一个查不到的 id 去比，结论必然「不是我」，于是停掉自己——被停之后没有进程发 activate，就是永久停着。查不到就**当它不存在**。

### 连通性自检：四条，一次跑完

变量不跨段，四条必须在同一次调用里：

```bash
curl -s -o /dev/null -w 'health=%{http_code}\n' "$BASE/api/health"              # 期望 200
curl -s -o /dev/null -w 'state有令牌=%{http_code}\n' -H "$AUTH" "$BASE/api/state"  # 期望 200
curl -s -o /dev/null -w 'state无令牌=%{http_code}\n' "$BASE/api/state"             # 期望 401
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" | head -c 300                    # 期望 {"runtimes":[...]}
```

前三条不对就别往下走：health 不是 200 说明服务没开或端口不对（与令牌无关）；有令牌还 401 说明令牌错。

### 令牌有寿命，settings.json 是活的

这个文件在使用期间会被改写，**字节数可能一个都不变**（变的是窗口位置、最近会话这类时间戳）：

- **别拿它的哈希或字节数当判据**——会漂，红了也不代表配置被改。判「服务还在不在」用上面四条 HTTP 自检。
- **每段脚本重新读一遍令牌**。主题切换、开窗口会写这个文件；令牌重置后旧值全变 401，而 401 与「服务没开」长得一样。

## 3 读自己的状态（只读）

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/messages"   # 我的时间线
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/todo"       # 我的 todo
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/subagents"  # 子 agent
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" | head -c 300        # 我的进程活着没有
```

第四条给所有进程，按 `sessionId` 筛出自己：`running` 正在生成，`idle` 闲着。

`/messages` 返回 `{messages, total, windowStart, truncated}`，**是有界窗口，不是全部历史**：

- `messages` 从旧到新排，要末尾 N 条用 `messages.slice(-N)`。
- `total` 数的是**文件里的条目**，`messages` 是转换后的消息，两者基数不同（工具记录、压缩卡片、分支展开各不一样），**别相减，也别拿它推该有多少条**。
- `windowStart: 0` 表示没截断；`truncated: true` 表示还有更早的。

**单次 `/messages` 不吃 `?before`**（传了也不生效）。翻历史用：

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/<目标>/messages/page?pageSize=100&before=<nextBefore>"
```

`pageSize` 的单位是**一轮问答**（默认 3），一轮多少条从 3 到几十不等，别用条数推轮数。翻页只做一件事：把上一页的 `nextBefore` 传给 `before`，直到它是 `null`——那就是拿全了。**判据只看 `nextBefore`**，不要用「累计条数等于 `total`」：翻到底没有一个相等。

`nextBefore` 不为 `null` 时返回 7 个键，为 `null` 时 6 个，按字段名取。`before` / `pageSize` 不校验：非整数当没传；负数 `before` 返回空 `messages` 且 `nextBefore: null`（看起来像翻到底，其实是参数错）；`pageSize` 给 0 或负数退成 1 轮。

**每次返回整个窗口**，`?limit` 一律无视：1653 条的会话一次 226 KB，`pageSize=100` 能到 15 MB。所以**别拿它轮询**——判断消息送没送到看 SSE 有没有 `error` 帧。

单条消息字段 `{id, agentId, role, text, timestamp, meta}`，assistant 多 `thinking`、`model`、`stopReason`。正文在 `text` 不在 `parts`（`parts` 只在 `/api/chat` 请求里用）。要原始工具调用参数只能读磁盘 jsonl（路径取 `runtimes[]` 的 `sessionPath`）。

## 4 找别的会话

```bash
curl -s -H "$AUTH" "$BASE/api/state"
```

返回里至少四个数组：`sessions[]`、`runtimes[]`、`projects[]`、`pendingUiRequests[]`。

- `sessions[]`：**所有会话**，含没在跑的。字段 `{id, projectId, title, status, model, thinkingLevel, updatedAt, createdAt}`。
- `runtimes[]`：**此刻正在跑的进程**。字段 `{sessionId, agentId, runtimeGeneration, projectId, cwd, status, sessionPath, createdAt, deckSessionId}`。

**两个数组答的不是同一个问题。** 进程活着不代表有活在跑——刚 activate 起来的 `status` 是 `idle`，有回合在跑才是 `running`。反过来，不在 `runtimes[]` 里只是说明进程没起，消息照样送得到：服务端会替你 `activate` 一次，所以别为了发消息先起进程。

**`GET /api/sessions` 不存在**，猜它拿到 `{"code":"webError.apiNotFound"}`——列会话用 `/api/state`。**`POST /api/sessions` 存在**，建会话用，见第 6 节。`/api/sessions/runtimes` 与 `/api/state` 的 `runtimes[]` 是同一份数据，用哪个都行。

列表里找不到某个会话，不等于它不存在：先确认 `projects[]` 里有它所属的项目。

## 5 发消息

**发之前再认一次自己**：`echo $PIDECK_SESSION_ID`。目标 id 等于它，你就是在给自己发消息——消息插进你自己的对话，然后你自己等自己回。标题、`updatedAt`、`model` 都不是身份。

### 5.1 首选 `/prompt`：同步返回 accepted

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"requestId":"'"$(date +%s)"'","message":"只回两个字：收到"}' \
  "$BASE/api/sessions/<目标>/prompt"
```

期望 `{"result":{"accepted":true,..."runtimeGeneration":3}}`。`accepted: true` 表示进了队列，服务端负责投递。字段名是 `message` 不是 `text`（写错 400 `webError.messageRequired`）；`requestId` 必填。返回里的 `runtimeGeneration` 比你发之前记的大，说明服务端刚替你拉起过它；`sessionPath` 直接给 jsonl 路径，省一次查询。

**中文别走命令行参数。** `curl -d "中文"` 会先过终端代码页（Windows 上常是 GBK），对端收到一串 U+FFFD。两处都要：请求头带 `charset=utf-8`，正文走文件：

```bash
node -e 'const fs=require("fs");fs.writeFileSync("msg.json",JSON.stringify({requestId:String(Date.now()),message:fs.readFileSync("msg.txt","utf8")}),"utf8")'
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @msg.json "$BASE/api/sessions/<目标>/prompt"
```

判据：读对端的会话记录，数替换符，期望 0：

```bash
node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8");console.log((t.match(/\uFFFD/g)||[]).length)' "<对端的 sessionPath>"
```

**收到乱码就直说，别猜。** 对端回复变成 `���` 时，唯一正确的动作是回一句「读不懂，这是原文：<逐字粘贴>」，然后停下等它对。按上下文猜，猜错了在记录上看不出异常——你会照着猜出来的意思改出完全无关的东西。

### 5.2 要看流式才用 `/api/chat`

请求体是完整消息数组；`id` 是目标会话的 sessionId，不是 `agentId`：

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<目标 sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"ping"}]}]}' \
  "$BASE/api/chat"
```

返回 SSE，一行一帧：`start` → `reasoning-delta`（有思考时才有）→ `text-start` → `text-delta` → `text-end` → `finish` → `[DONE]`；带工具调用还有 `tool-input-start` / `tool-output-available`。不认识的帧按类型过滤，别等某个特定帧——**只认 `finish` 或 `[DONE]`** 判「流结束了没有」。`-N` 必须加，否则看不到流式。

### 5.3 判「送到没有」只有一条

**看 `error` 帧，不看 `total`，也不看有没有 data 帧。** 没有 `error` 帧就是送到了（哪怕 0 个 data 帧、`total` 当场没变）；有就是没送到，原因写在 `errorText` 里。

三处分开看：400 是没进队列（缺 `id`、没有 user 项、text 为空，直接 JSON 报错）；200 加 `error` 帧是进了但找不到会话；200 加无 `error` 帧才是送到。

**`finish` 不是「送到」的证据**——error 流里同样带 `finish` 与 `[DONE]`。向不存在的 sessionId 发 `/api/chat`，200 的正文就是 error 帧加这两个。

可执行的一条：

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

目标会话没激活时这条会自己拉起它（服务端替你 activate），但第一次可能慢几秒。`--max-time 30` 到点就断；三态：1 没送到、0 送到、2 无法判定。

### 5.4 对方在 goal 模式时

发完消息立刻补一条 `/goal on`，**单独成一条，正文一个字都不带**。

- 对方收到 `/goal` 加文字会进入自动续跑；普通消息不会。
- `/goal 新目标` 是覆盖，会把它的活换成你写的那句——等于你替用户改了对方的目标。

发送前能机器核的一条：

```bash
[ "$(wc -c < msg.txt)" -eq 8 ] || { echo "msg.txt 必须正好 8 字节：/goal on，无换行无正文"; exit 1; }
```

用 `printf` 写 msg.txt，别用 `echo`（会补换行或解释反斜杠）。

## 5.5 等对方干完：订阅、复用还是新开、什么时候算结束

**两个流别搞混。** `/api/sessions/<id>/stream` 推这个会话的消息帧；`/api/events` 推全局状态快照（`event: state`），不推消息文本，也没有心跳帧——连接静默不等于断了。

首选订阅对方的流：

```bash
curl -sN --max-time 600 -H "$AUTH" "$BASE/api/sessions/<目标>/stream"
```

`--max-time` 必须设：到点断开不影响对端继续干活，重连接着看。订阅一个不存在的 id，第一帧仍是全局 `event: state`——**别把这一帧当成「对方说话了」**，消息帧一定带 `"type"`。

**只有 `finish` 和 `[DONE]` 是结束证据。** 连接自己断了、被 `--max-time` 掐了、一直只有 `: ping`，都不算跑完——对方可能在跑长工具调用。要判断它在不在动，用 7.1 的 `state` 看 `isStreaming` 与 `isTurnActive`。

退路是轮询：把 curl 重定向到文件后台跑，每轮查一次立刻返回：

```bash
stat -c %s /tmp/reply.txt
tail -c 200 /tmp/reply.txt | tr -d "\n" | tail -c 120
```

**复用旧会话还是新开，判据只有一条：目标会话里有没有关于被审对象的结论。** 有就新开——它记得自己上次的判断，会顺着那个结论找理由，不再独立看（审查、验证、要第二意见都属于这类）；没有就复用——同一件事的下一轮、换个小需求，上下文有用。新开之后旧会话不要停。

## 5.6 与另一个会话按 PR 模式协作
**什么时候算结束**：对方明确写出它那边也没有了，或者逐条回应了你提的每一条。回一句「收到」不算。代价不对称——多等一轮只花一轮，早停一轮则它的修复找不到人复核。
**改完必须当场交对方，不发消息等于没改完。** 落盘后立刻发一条消息：对象与 md5、改了什么、跑过哪些判据与 rc、坏样本在哪。PR 评论不算交付、签核文件也不算——对方不会去翻你的 PR，也不看你目录里的 signoff。写得再详细，没人读就是零。

**签核第一屏写六行**：`轮次: Rn`、`提出者: <会话名>`、`发现者: <会话名>`、`修改者: <会话名>`、`复核者: <会话名>`、`交付: <发给对方的时刻>`。再加三段：`审查:`（读到什么、发现什么）、`已改:`（真改了什么）、`未改:`（只能写「无」）。

`~/.pi/agent/bin/check-round-robin.mjs` 判四件事：发现者与修改者同一会话、修改者与复核者不同、`交付` 行在、`未改` 只能写「无」。再加推责词表（11 个）。缺任一字段也红。口径上限：它只扫「已改」「未改」两行的值，不扫全文——全文里引用规则原文会误伤（「不许写下一轮再说」这句自己就含禁用词）。所以**消息正文里的推责说法 rc 抓不到，只能由收到的一方当场指出**。


**交接用文件，不用消息正文。** 中文经命令行参数会被代码页转码（5.1 末尾有实测），提案超过几十行也会被截断。约定：提案写 `proposals-rN.md`、回执写 `review-rN.md`，发消息只发路径与第一行署名。

**每条消息第一行必须署名，md5、字节、行数、时间四样缺一样，对端只能猜。**

```
[<发送者> → <收件人> · <对象> <md5前8位> · <字节>B · <行数>L · <时间>]
```

命令：`md5sum f | cut -c1-8`、`stat -c %s f`、`wc -l < f`。数字一律现取（理由见 9.1）：2026-11-17 白争一轮，一方写「634 行」、另一方核到 638，两个人盘上的文件本来就是同一个。接收方第一步拿这一行的 md5 与自己盘上的比，不一致就回「你这条基于旧版」。

**证明对方真读了原文**：让它在回执里贴出原文片段。行号只作定位、不当证据——插入一行行号就漂。只说「我看了」，与没看无法区分。

**每轮产出必须是 git commit，不能只改盘上文件。** 判据：`git log --oneline -1` 能指到这次改动。在分支上改、一次提交一件事、提交信息写为什么；`SKILL.md` 这种装在多处的文件，先 commit 再同步副本，回执里同时给 commit 号、`git diff --stat`、各处 md5 与判据 rc。桌面临时复制与副本同步是部署动作，不算改动凭证。

**动手前看，交回执时写。** 动手前跑 `git log --oneline -3` 与 `git status`：对方最近落过你要改的那一节，就先停手合并。核的人在回执里必须写一句「这次改动有没有第二处说同一件事」——语义重复脚本抓不住，2026-11-16 实测同一件事被写了三段，四个判据全绿。

**凭据在谁手上，就由谁执行那一行命令。** 发现方给命令原文，持凭据方原样执行、回贴命令与输出。对外推送不可逆，许可只能来自用户——核的人不能代用户说「可以推了」。别人的仓只 pull 与建 PR，合并是仓主的事：`permissions.push:false` 就不要试 merge（实测返回 404 不是 403，容易被误读成「PR 不存在」）。

## 6 重启：你关不掉自己，让别人关

**重启 = stop + activate。你自己发不出这两个请求**：stop 杀掉的就是发请求的那个进程，没有进程去发 activate。

让别人做。最省事：**新建一个普通会话**，把技能名与下面这段一起贴给它。

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"projectId":"builtin-chat"}' "$BASE/api/sessions"
```

`projectId` 从 `/api/state` 的 `projects[]` 取。返回 `{"session":{"id":"..."}}`，取 `session.id`。新建是草稿态（`status: draft`，无 `sessionPath`），直接发消息它就起来，不用先 activate。

**别用 `/api/sessions/anonymous` 建执行者**：它 `noSession: true`、没有自己的 `sessionPath`，认「我是谁」时拿到目标的路径，结论必然是「目标就是我」；而且 stop 之后记录被删，activate 返回 `SESSION_NOT_FOUND`（HTTP 仍是 200）。

> 用 `/skill:pideck-web-api`。把会话 `<目标 sessionId>` 重启，先跑完该技能第 2 节，再按下面 0–5 步做，每步贴回输出。
>
> 0. **先认自己是谁**：`echo $PIDECK_SESSION_ID`。为空就走第 2 节两条兜底。拿到之后比对：等于 `<目标>` 就停下——停掉的是你自己，没有进程去发 activate。三条路都拿不到也停下，别赌。
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
> 4. **验**：activate 的返回里直接有 `runtimeGeneration` 与 `agentId`。第 1 步找到 target 时，新代号必须比 N 大 1（N=3 重启后返回 4；等于 N 说明没换进程）。第 1 步没找到时没有 N 可比，改看「返回里有 `agentId` 且 `status` 是 `running`」。
> 5. **发一条消息证明它能接活**：
>    ```bash
>    curl -s -H "$AUTH" -H "Content-Type: application/json" \
>      -d '{"id":"<目标>","messages":[{"role":"user","parts":[{"type":"text","text":"重启结束，这条用来验证你能接活"}]}]}' \
>      "$BASE/api/chat"
>    ```
>    送达看 HTTP 200 且流里没有 `error` 帧。**别把「没吐帧」当成「没送到」**——这条是异步入队，回 200 之后一帧不吐是正常的，重发会真的入队多条。

**第 0 步不能省，也不能换判法。** 别拿 `sessionPath` 或磁盘写入时间推断自己是谁——匿名会话没有 `sessionPath`，会拿目标的路径认自己，结论正好反过来。只有 `echo $PIDECK_SESSION_ID` 可靠。

**HTTP 200 不代表做成了，必须看 body**：

| 情况 | HTTP | body |
|---|---|---|
| 停成了 | 200 | `{"result":{"ok":true,"value":{...}}}` |
| 目标本来就没在跑 | 200 | `{"result":{"ok":false,"error":{"code":"SESSION_RUNTIME_UNAVAILABLE"}}}` |
| URL 与 body 的 sessionId 不一致 / 没给 target | 400 | `{"code":"webError.runtimeTargetRequired"}` |

**`runtimeGeneration` 有两种语义。** 其余 20 个运行时动作走 `requireBoundTarget`：代号与绑定都比，传错返回 `SESSION_RUNTIME_CHANGED`，命令不执行。`stop` 走 `resolveStopTarget`：只要有 live 绑定的 `agentId` 就取当前代号，传什么代号都不拦。所以 `stop` 唯一的闸是 `agentId`，且它比路径里的 sessionId 更权威（见 7.1）。

**重启之后你是新进程**，不记得上一个进程在干什么。会话历史仍在同一个 jsonl（`runtimes[].sessionPath`），上下文不丢，但「成没成」只能由重启后的一方重读 `runtimes[]` 确认。

### 6.1 几种会让你判断错的行为

- **`stop` 只认 `agentId`**，`runtimeGeneration` 传错也照停；其余动作传错直接拒。
- **第一次 `activate` 要几秒**（拉起 pi 进程），不是卡住；其余各步百毫秒级。量级不是常量，换机器会变。
- **空会话被 stop 会整个消失**，不是变闲：新建 → activate → 直接 stop（中间没发过消息），几秒后从 `sessions[]` 消失，之后 activate 返回 `SESSION_NOT_FOUND`。别拿刚建好的空会话试 stop。
- **匿名会话会在空闲几分钟后自己消失**，消失后 activate 返回 `SESSION_NOT_FOUND`。正常新建的会话不受影响。
- **`/messages` 对不存在的会话不返回 404**，返回 200 加空数组，与「存在但没消息」一模一样。要区分就看 `sessions[]` 里有没有这个 id。
- **`total` 一次加 3 不是 1**：你发的 + assistant 的回复 + 一条注入。这是现象不是判据。
- **别做这两件事**：建完会话反复轮询 `runtimes[]` 等它出现（activate 返回时进程已经在了）；为拿 `total` 反复拉 `/messages`（一次几十 KB 起）。

**用完把执行者删掉**：

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
  "$BASE/api/sessions/<执行者 id>/delete"
```

返回 `{"deleted":true}`。删除只走 `POST .../delete`，`DELETE /api/sessions/<id>` 不存在。先 stop 再 delete。删不存在的 id 返回 `{"deleted":false}`，HTTP 仍是 200，那不是失败。

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

`target.agentId` 在所有命令上都是真闸；`target.runtimeGeneration` 只在非 `stop` 的命令上是真闸（`stop` 用 live 绑定，见本节前面那段）。两个字段被拒时返回的不是同一个码：

`agentId` 给不存在的 uuid，或它与路径里的 sessionId 对不上，返回 `SESSION_RUNTIME_UNAVAILABLE`。`agentId` 对、`runtimeGeneration` 漏传或给错（实测给 999），返回 `SESSION_RUNTIME_CHANGED`。

依据是 `runtime/runtimeBinding.ts` 的 `requireBoundTarget`：它先核对 sessionId 与 agentId 的绑定，再比代号，两步抛的码不同。

**`agentId` 会随进程换，抓完立刻用。** 隔着几分钟拿旧 `agentId` 去请求，先撞的是第一步「绑定对不上」，返回 `SESSION_RUNTIME_UNAVAILABLE`。看起来像会话没了，其实是身份过期。

这两个码里 `SESSION_RUNTIME_CHANGED` 容易被读成「运行时代号变了」，实际意思是「你传的值不对」，别据此判断会话被重启过。三个字段都传当前值最稳，取法见第 6 节第 1 步。


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
| `toolStateSequence` | 工具状态序号，只在状态切换时跳变。判断「有没有在动」看两次读是否不同，别拿差值当调用次数 |



**换模型会把思考档重置成新模型的默认值。** 所以先 `model` 再 `thinking`；反过来的话等于没设。

**`permission` 在 pi 后端一定失败**：源码只给 DSH 后端注册了这个能力，pi 会话发过去返回 `SESSION_COMMAND_FAILED`。要改 pi 会话的权限，走记录层的 `update` 或界面。

**鉴权规则**：写操作（POST）只认请求头。`?token=` 查询参数只对 GET 和 SSE 开放，因为浏览器的 EventSource 不能自定义请求头；写操作开这个口子会把令牌漏进代理日志和浏览器历史。


### 7.2 记录层动作：改记录，不碰进程

`check-doc.mjs` 会同时比路径与方法：它抓「源码里没有这条完整路由」和「方法列写错」。源码里用模板串拼出来的路由切不出整条时，正则会在边界上截出残缺串（裸 `/api`、通配 `/api/*`、带中文标点的注释片段）——这些不进台账，`--update-routes` 会跳过它们并打印跳了几条。判据只保证「台账里有的路由，源码里还在」，别指望它替你发现残缺串。

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


**别做「守卫替你停」这种设计。** 它会死在两处：stop 的 body 没带 `target` 时返回 400 `webError.runtimeTargetRequired`；用 `runtimes[].status` 判断「停了吗」时，空闲进程的 status 是 `idle`，于是判定已停。

要停掉自己，stop 必须带齐 `sessionId` + `agentId` + `runtimeGeneration` 三件；能发出这个请求的应该是**另一个活着的进程**，不是守卫。让别的会话替你重启的完整任务书见本节第 0~5 步，关键就一句：目标会话不能是执行者自己。

## 9 边界

- 只读 pi 的会话文件，不要改 `~/.pi/agent/sessions/*.jsonl`。
- 端点全集以源码 `WebApiRoutes.ts` 为准；本文是实测记录，不一致时信源码。比对用第 11 节的 `check-doc.mjs`。
- 没有第二个活着的窗口能接，就别停：被停之后没人发 activate，就是永久停着。
- **改了这个技能，已经在跑的会话看不到新版。** 技能是进程启动时用 `--skill <目录>` 注入的（`PiProcess.ts:379`），内容在启动那刻进了内存。要生效只能重启（第 6 节）或新开一个。

## 9.1 每句话带来源

**判据只有一条：这句话会不会被别人当成事实引用。会，就必须能追到「谁说的、依据哪一版」；不会，署名只是噪声。**

| 去哪 | 署名形式 | 缺了会怎样 |
| --- | --- | --- |
| 发到另一个会话 | 第一行署名，格式见 5.6 | 对端没有可比的东西，只能猜你基于哪一版 |
| 回给用户 | 每条断言标来源：`我跑过` / 对端报的 / `未验证` | 用户分不清「你核的」与「别人说的」 |
| 写进盘上（文件、commit、PR 正文、签核） | 依据版本加时间；正文写「依据 `<md5>`」 | 半年后的人不知道这句话当时基于哪一版 |

**数字一律现取。** 报「技能 634 行」实际 638、报「字节 30424」那是 JS 字符数、报「七处已同步」实际六处——三次都发生在同一台机器同一个下午。命令：`md5sum f | cut -c1-8`、`stat -c %s f`、`wc -l < f`。

**两个人先后动同一个仓，比同一时刻的现值，不是各自报过的值。** 比较时同一秒内现取两次；隔了提交的差值写成「你的时刻与我的时刻之间发生了什么」，不是「你说的与盘上不符」。

**三个人称分清：我、你、他，各自指谁要在同一句里落地。** 我＝署名行的发送者；你＝收件人；他＝用户、别的会话、仓主三者之一，每处写明哪一个。别写「我们这边」「对方」这类不指名的说法——收件人不止一个，指代会漂。

**转述要标明出处。** 对端报的数字写进自己的回执时前面写「对端报的」；不标等于冒充自己核过。

**这三句不算署名**：「实测」「已验证」「我看了」——不写命令、文件名、md5，与没说是同一件事。

## 9.2 说人话

**开口之前先做一次假设，不是写完再查：读者什么都不知道、只看第一屏、不记前情、不关心你试错几次。**

这一条是所有写字的起点，不是清单最后一项。落笔那刻就按最差读者写：他要事先知道的东西当场给；他不认识的名字当场解释；他看不到的「刚才」，把原话重述一遍。写完再回头补，补出来的仍是作者视角。

**动词要有画面。** 抽象名词换成手能做的动作，读完第一屏要能说出「谁对什么做了什么」。不止修 bug——同步、验证、回滚、提交、删除，凡是名词化的说法都换。

| 别写 | 说成 |
| --- | --- |
| 修复了这个缺陷 | 砍了一刀 |
| 重构了模块 | 推倒重写 |
| 优化了性能 | 让它快了一截 |
| 部署完成 | 装到机器上了 |
| 同步了两边 | 对了一遍表 |
| 验证通过 | 跑了一遍，没红 |
| 回滚了改动 | 退回去 |
| 提交了 | 落了一笔 |
| 撤销了那次改动 | 拿掉了 |

**同类一次砍完。**「砍一刀」是一刀把同类全砍掉，不是挨个修。

**对另一个会话说话，也是说话。** 它不记得上一轮、上下文随时被压缩、可能刚重启。跨会话消息与任务书一律自包含四件：要它做什么（一句）；依据（绝对路径、md5、字节）；算完成的标志；它可以拒绝的方式。不用「上一条」「刚才那个」指代前情。

**离开本文件的文字按 0.4 写。** 提案与回执这类长文件仍走文件路径；规则原文抄进消息，不写「按 5.6 办」。

## 9.3 一切改动都进 git

**判据只有一条：`git log` 能指到这笔改动，工作区干净。**

1. 改完立刻提交，不攒。攒着的改动会被下一次改动污染。
2. 提交信息写为什么，不写「update」「fix」。
3. 有远端就推，推完用 `git ls-remote <remote> refs/heads/<branch>` 与本地 `git rev-parse HEAD` 比对——不看自己的输出，`git push` 之后跟着别的命令时 rc 会是别人的。
4. 动手前跑 `git status`：有别人的脏文件就先停，别把两件事混进一笔。

**行数不是判据。** 判「追加还是替换」要看 diff 里的 `-` 行：把一段删掉再添一段，行数可以一模一样。判据：`git diff --numstat <旧> <新> -- <文件> | awk '{a+=$1; d+=$2} END{printf "%d %d\n", a+0, d+0}'`，加 > 0 且减 = 0 才是纯追加，「0 0」是没有行增删（改名也会得 0 0）。三个坑：`grep -c "^-"` 被 `--- a/file` 表头喂成恒 1；两版相同时 `--numstat` 一行都不打；只聚第二列分不出纯追加与无改动。

**例外只有两条**：会变的值（令牌、时间戳、机器相关路径）不进仓；大二进制不进仓，留个生成脚本。

```bash
git status --porcelain | wc -l   # 期望 0
git log --oneline -1             # 能指到这次改动
```

坏样本：改一个文件不提交，第一条就不是 0；用 `git status --porcelain | head` 会拿到 0，那是 head 的退出码。

## 9.4 每来一件新事，先重排

**新任务进来时按顺序做三件：列全、排序、只做队首。**

1. **列全**：所有未完成项，一项一行。漏掉的一项会变成之后某次返工。
2. **排序**：晚一周的损失 ÷ 工期。分子指不出具体会话、具体文件的就是 0；分子为 0 的事不做，并说清为什么不做。
3. **只做队首**：做完再排一次。半途插队，两件都脏。

判据：能说出现在做哪一件、为什么它在最前、其余各在第几。

**用户的话优先于另一个会话的话。** 对端回执进来时，先看用户有没有没处理的指令：有就先做用户的。对端可以等，用户的指令等成「未完成项」就是错序。

**别人的东西不进队列。** 有上游维护的仓、别人的技能、别人的 PR——没经用户明确批准，一律不碰、不报、不列进待办。判据：待办清单里出现不属于自己的仓或文件就红，一条也算。

## 10 验收：三级别

按你做到哪一级说哪一级。

1. **能观察自己**（只读）：`echo $PIDECK_SESSION_ID` 非空，且这个 id 出现在 `/api/state` 的 `sessions[]` 里。
2. **能读别人**（只读）：`sessions[]` 里看得到别的会话标题。这是**会话记录**那一层；要看别人的**进程**活着没有，用 `runtimes[]`（第 4 节讲过两个数组答的不是同一个问题），那两件事别混成一句验收。
3. **能驱动别人**（会改动别人）：对目标发一条 `ping`，**没有 `error` 帧**就是送到了（别拿 `total` 或帧数当判据——对方忙的时候整条连接可能只有一行 `: ping`，而消息确实进了它的对话，见第 5 节）。要验「真进程」，走一次第 6 节，`runtimeGeneration` 变了才算。

## 11 改这个技能之前

用技能的人：PiDeck 只用这一处 `~/.pi/agent/pideck-skills/pideck-web-api/`——每次启动从安装包写过去，装上就能用，不是给手改的地方（改了下次启动被覆盖）。终端里直接起的 pi 读 `~/.agents/skills/pideck-web-api/`，两处内容相同，不用分开维护。

改这个技能的人：只有一处算数——`<仓库>/resources/skills/pideck-web-api/`。改完打包发版，用户装上就是新版。

不想等发版、要在本机先试：

```bash
mkdir -p "<userData>/skills-overlay"
cp -r <仓库>/resources/skills/* "<userData>/skills-overlay"/
```

**整包才生效。** overlay 必须自带 `skills-manifest.json`，清单里列的全部文件都在，且逐个哈希对得上。只放本技能那几个文件也能过本技能的校验，但其余技能在 overlay 里找不到，安装会被跳过。

`installTemplate`（`src/main/skills/SkillManager.ts`）每次启动无条件 `writeFile`，内容取自 overlay——**条件不是「有目录」，而是「overlay 自带清单且逐文件哈希对得上」**，任一不符就回落到打包的那份。唯一例外：frontmatter 的 `disable-model-invocation: true` 会被记住并写回（`SkillManager.ts:438-449`）。

**五个判据在源码克隆根目录跑，rc 都得是 0：**

```bash
node resources/skills/pideck-web-api/check-doc.mjs     # 第 7 节动作表、端点数、字段
node resources/skills/pideck-web-api/check-paths.mjs   # 全文每个 /api 路径逐段对源码
node resources/skills/pideck-web-api/check-format.mjs  # 表格列数、加粗成对、代码块配对、$ 变量
node resources/skills/pideck-web-api/check-fields.mjs  # 反引号标识符逐词对源码
node resources/skills/pideck-web-api/check-self-contained.mjs --selftest  # 判据自己；给文件参数时扫的是「离开文件的文字」
```

改了源码里的路由之后，还要重写台账。`--update-routes` 是**写操作，不是判据**——它的 rc=0 只表示写成功：

```bash
node resources/skills/pideck-web-api/check-doc.mjs --update-routes   # 重写 check-doc-routes.json，并打印跳过几条残缺串
```

带 `--selftest` 的是 `check-paths`、`check-format`、`check-fields`、`check-self-contained` 四个，能脱离源码单独验「判据自己还对不对」（装了 PiDeck 的机器上只有这份副本，没有 `src/main`）。`check-doc` 没有自检：传 `--selftest` 会直接 rc=2 并打印「check-doc 没有自检」，因为它的每条判据都要真的路由表，源码不在就报 rc=2——那是环境不全，不是判据失败。

`check-doc.mjs` 还要读同目录的 `check-doc-routes.json`：60 条路由的台账，生成物，别手改。源码里少了一条台账里有的路由，它逐条打印并判 rc=1，所以删路由必须连台账一起改、在提交信息里说明为什么。台账缺失也判 rc=1，那是部署不全不是环境缺失。源码新增路由只提示不判红，否则每改一次源码都会红，这条判据就没人用了。残缺串（裸 `/api`、通配 `/api/*`、带中文的注释片段）不进台账，`--update-routes` 会跳过并打印跳了几条。

口径上限写在各自文件头：`check-paths` 只按段比对、抓不到顺序错；`check-doc` 抓不到模板串拼出来的路由；`check-fields` 要读全量 src，克隆不完整时用 `--src=<完整 src 目录>` 指过去，别删它求绿。

### 踩过的坑（都是实测，改这个技能时会再撞上）


```bash
npm run generate:skills-manifest    # 写操作：重写 resources/skills/skills-manifest.json
npm run check:skills-manifest       # 判据：rc 必须是 0
```

**管道会吃掉退出码。** `node check-doc.mjs | tail -1` 之后取到的 rc 是 `tail` 的，不是判据的——2026-11-16 因此三次误判「判据红了」。要看真 rc，先重定向再取：

```bash
node check-doc.mjs > /tmp/o 2>&1; rc=$?; tail -1 /tmp/o; echo "rc=$rc"
```

**`git push` 失败时也可能看到 rc=0**（同一条命令后面还跟着别的命令）。推完用远端复核，别只看自己的输出：

```bash
git ls-remote <remote> refs/heads/<branch>   # 与本地 git rev-parse HEAD 对齐才算推上
```

**门禁里「后续判据依赖的前置步骤」不能写成可能静默为假的条件。** 实测：版本检查依赖先拉 base commit，而那一步的 `if` 在 fork PR 上被判 skipped，下一步直接报 `fatal: path 'package.json' exists on disk, but not in '<sha>'`——错在上一行，红在这一行。写成总是执行、取不到时回落，并把回落结果用 GITHUB_ENV 显式传下去。

**插入位置在围栏内还是围栏外，比文字本身更容易错。** 2026-11-16 往代码块里插一段，围栏被破坏，判据红在「标题前缺空行」这种看不出原因的位置。改完 SKILL.md 第一件事就是跑 check-format。