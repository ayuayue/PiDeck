---
name: pideck-web-api
description: "用 PiDeck 的 HTTP 服务读自己的状态、给别的窗口发消息、让别的会话重启自己。要用脚本或别的 agent 控制 PiDeck、查会话状态时用。不用于改 PiDeck 源码。Use for PiDeck web API, SSE."
---

# PiDeck Web API

**PiDeck 每个窗口背后跑一个 pi 进程，同时开一个只监听本机的 HTTP 服务。用这个服务，你能读自己的状态、给别的窗口发消息、让另一个会话把自己重启。**

下面每条命令都在 2026-11 的 Windows 发行版上跑过，写了期望返回。返回形状不符说明版本变了，以源码里的 `src/main/web/WebApiRoutes.ts` 为准（`/api/health` 例外，它在 `WebServiceManager.ts:497`）。

要看源码就看你自己的那份克隆。技能本身不依赖它，只有想确认「这个端点源码里到底怎么写的」时才需要。

**下面所有 bash 都按 Git Bash 写**（PiDeck 在 Windows 上附带的那套）。别在 cmd 或 PowerShell 里跑：`$VAR` 不展开，`%APPDATA%` 在 bash 里不展开。怎么确认：`echo $APPDATA` 有值就是对的 shell。

**前提：服务默认关闭，要人先在 PiDeck 的「设置 → Web 服务」里打开。** 没开就没有令牌，下面所有命令都会连不上或返回 401。

## 0 先确定你要做什么

| 想做的事 | 会打断别人吗 | 读哪节 |
|---|---|---|
| 读自己的时间线、todo、子 agent、运行状态 | 不会 | 第 3 节 |
| 找别的会话、发消息、读回复 | 不会停它，但消息会插进它的对话 | 第 8 节、第 4 节、第 5 节 |
| 重启某个会话（自己或别人） | 会，目标被停 | 第 6 节 |
| 单独停、启、中止 | 会，目标被停 | 第 7 节 |

第 2 节是所有节的前提。第 8 节是动别的会话之前必须满足的条件，第 9 节是使用边界，第 10 节是验收标准，第 11 节只对改这个技能的人有用。第 5.5 节讲怎么等对方干完、什么时候该新开会话。

**先读第 2 节的一条注意事项**：每段 bash 都是独立 shell，变量不跨段保留。后面几节的命令都假设 `$AUTH`、`$BASE` 已经在**同一次**调用里设好。

## 1 几个词

下面三个是这套接口的骨架，最后两个是本文反复用的说法。


- **会话**：PiDeck 侧边栏里的一行。会话可以存在，但此刻没在跑。
- **运行时**：为某个会话在后台跑的那个 pi 进程。会话是记录，运行时是进程。
- **运行时代号**（`runtimeGeneration`）与 `agentId`：同一会话每起一次进程，代号加一，服务端同时发一个新的 `agentId` uuid。两个一起变，都在 `runtimes[]` 里，验「换没换进程」看哪个都行。
- 代号不是操作系统的 PID（进程号），那个不对外暴露。请求里这两个字段都要传当前值：多数命令传错直接拒，唯独 `stop` 只认 `agentId`，代号传什么都不拦。两种语义的分界见第 7.1 节。
- **判据**（判断对错的依据）：本文里指某一项能返回真假的检查，例如「发一条 ping，没有 error 帧就是送到了」。
- **口径**（一条判据管到哪为止）：口径之外它给不出答案，不是它判错了。


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

**第三条线索要先验证再用。** `$PIDECK_LINKED_SESSIONS_URL` 形如 `http://127.0.0.1:<port>/linked/<某 id>`，但那一段**不是** PiDeck 会话 id——同一时刻 `$PIDECK_SESSION_ID` 在 `sessions[]` 里查得到，这个 URL 尾段查不到。只在 `sessions[]` 里查得到才算数：

```bash
curl -s -H "$AUTH" "$BASE/api/state" | grep -c "$PIDECK_SESSION_ID"                # 期望 >=1
curl -s -H "$AUTH" "$BASE/api/state" | grep -c "${PIDECK_LINKED_SESSIONS_URL##*/}"  # 本机实测 0
```

**认错的后果比「找错人」重。** 第 6 节第 0 步用这个 id 判断「目标是不是我自己」：拿一个查不到的 id 去比，结论必然是「不是我」，于是停掉自己——被停之后没有进程发 activate，就是永久停着。所以查不到就**当它不存在**。

### 连通性自检：四条，一次跑完

四条**放在同一次调用里跑**，因为变量不跨段：

```bash
curl -s -o /dev/null -w 'health=%{http_code}\n' "$BASE/api/health"              # 期望 200。除 health 外不带令牌一律 401
curl -s -o /dev/null -w 'state有令牌=%{http_code}\n' -H "$AUTH" "$BASE/api/state"  # 期望 200
curl -s -o /dev/null -w 'state无令牌=%{http_code}\n' "$BASE/api/state"             # 期望 401
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" | head -c 300                    # 期望 {"runtimes":[...]}
```

前三条不对就别往下走：health 不是 200 说明服务没开或端口不对（与令牌无关）；state 有令牌还是 401 说明令牌错。第四条形状不对说明服务版本变了，去查源码。

### 令牌有寿命，settings.json 是活的

`settings.json` 的 `webServiceToken` 旁边有 `webServiceTokenGeneratedAt` 与 `webServiceTokenExpiresIn`——令牌是生成的，不是手填的。这个文件在使用期间会被改写，而**字节数可能一个都不变**（同一个文件两次读，哈希就不同；变的是窗口位置、最近会话这类时间戳。具体字节数别写进判据，它自己也在变）。

- **别拿它的哈希或字节数当判据。** 会漂，红了也不代表配置被改。要判「服务还在不在」，用上面那四条 HTTP 自检。
- **每段脚本重新读一遍令牌。** 主题切换、开窗口会写这个文件；令牌重置后旧值全变 401，而 401 与「服务没开」长得一样。

## 3 读自己的状态（只读）

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/messages"   # 我的时间线
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/todo"       # 我的 todo
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/subagents"  # 子 agent
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" | head -c 300        # 我的进程活着没有
```

第四条给的是所有进程，按 `sessionId` 筛出自己那一行：`running` 表示正在生成，`idle` 表示闲着。字段解释在第 4 节。

`/messages` 返回 `{messages, total, windowStart, truncated}`，**是有界窗口，不是全部历史**：

- `messages` 从旧到新排，要末尾 N 条用 `messages.slice(-N)`。
- `total` 数的是**文件里的条目**，`messages` 是转换后的消息，两者基数不同（工具记录、压缩卡片、分支展开的进出各不一样），**别相减，也别拿它推该有多少条**。
- `windowStart: 0` 表示没截断；`truncated: true` 表示还有更早的。

**单次 `/messages` 不吃 `?before`**（传了也不生效）。翻历史用另一个端点：

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/<目标>/messages/page?pageSize=100&before=<nextBefore>"
```

`pageSize` 的单位是**一轮问答**（默认 3），一轮多少条从 3 到几十不等，所以别用条数推轮数。翻页只做一件事：把上一页的 `nextBefore` 传给 `before`，直到它是 `null`——那就是拿全了。**判据只看 `nextBefore`**，不要用「累计条数等于 `total`」：本机十个会话翻到底，没有一个相等。

`nextBefore` 不为 `null` 时返回 7 个键，为 `null` 时 6 个（最后一页没有 `nextBeforeEntryId`），按字段名取。`before` / `pageSize` 不校验：非整数当没传；负数 `before` 返回空 `messages` 且 `nextBefore: null`（看起来像翻到底，其实是参数错）；`pageSize` 给 0 或负数退成 1 轮。

**每次返回整个窗口**，`?limit` 之类一律无视：1653 条的会话一次 226 KB，`pageSize=100` 能到 15 MB。所以**别拿它轮询**——判断消息送没送到，看 SSE 有没有 `error` 帧。

单条消息字段 `{id, agentId, role, text, timestamp, meta}`，assistant 多 `thinking`、`model`、`stopReason`。正文在 `text` 不在 `parts`（`parts` 只在 `/api/chat` 的请求里用）。

要原始工具调用参数只能读磁盘 jsonl（路径取 `runtimes[]` 的 `sessionPath`）：

```bash
node -e 'const fs=require("fs");fs.readFileSync(process.argv[1],"utf8").split("\n").forEach(l=>{if(!l.trim())return;const j=JSON.parse(l);if(j.role)console.log(j.role+": "+String(j.text||"").slice(0,120))})' "<sessionPath>"
```

## 4 找别的会话

```bash
curl -s -H "$AUTH" "$BASE/api/state"
```

返回里至少四个数组：`sessions[]`、`runtimes[]`、`projects[]`、`pendingUiRequests[]`。

- `sessions[]`：**所有会话**，含没在跑的。字段 `{id, projectId, title, status, model, thinkingLevel, updatedAt, createdAt}`。
- `runtimes[]`：**此刻正在跑的进程**。字段 `{sessionId, agentId, runtimeGeneration, projectId, cwd, status, sessionPath, createdAt, deckSessionId}`。

**两个数组答的不是同一个问题。** `sessions[]` 说有哪些会话，`runtimes[]` 说哪些进程活着。进程活着不代表有活在跑——刚 activate 起来的会话 `status` 是 `idle`（进程在，闲着），有回合在跑才是 `running`。

反过来，不在 `runtimes[]` 里只是说明进程没起，消息照样送得到——服务端会替你 `activate` 一次。实测发完那一刻它已经出现在 `runtimes[]` 里，`status` 是 `running`。所以别为了发消息先起进程。

**`GET /api/sessions` 不存在**，猜它会拿到 `{"code":"webError.apiNotFound"}`——列会话用上面的 `/api/state`。**`POST /api/sessions` 存在**，用来新建会话，见第 6 节。别把这两个方法混成一个「端点不存在」。

`/api/sessions/runtimes` 和 `/api/state` 的 `runtimes[]` **是同一份数据**（字段逐个比对一致），用哪个都行。

列表里找不到某个会话，不等于它不存在：先确认 `projects[]` 里有它所属的项目。

## 5 发消息

**发之前再认一次自己**：`echo $PIDECK_SESSION_ID`，目标 id 等于它，你就是在给自己发消息——消息插进你自己的对话，然后你自己等自己回。标题、`updatedAt`、`model` 都不是身份，身份只认 `$PIDECK_SESSION_ID`。

### 5.1 首选 `/prompt`：同步返回 accepted，先不必回读

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"requestId":"'"$(date +%s)"'","message":"只回两个字：收到"}' \
  "$BASE/api/sessions/<目标>/prompt"
```

期望：`{"result":{"accepted":true,"sessionId":"...","requestId":"...","agentId":"...","sessionPath":"C:\\...jsonl","runtimeGeneration":3}}`。

`accepted: true` 表示这条消息进了队列，服务端负责投递，此时可以先不读回执。**要证明对方真的看到了，让它在回执里贴原文片段**（做法见 5.6）；accepted 之后还会隔十几秒才出现在对方记录里。字段名是 `message` 不是 `text`（写错 400 `webError.messageRequired`）；`requestId` 必填（缺了 400 `webError.requestIdRequired`）。返回里的 `runtimeGeneration` 是对端当前代号——比你发之前记的大，说明服务端刚替你拉起过它。要 jsonl 路径直接看返回里的 `sessionPath`，省一次 `runtimes[]` 查询。

**中文别走命令行参数。** `curl -d "中文"` 会先把这段参数交给终端代码页（Windows 上常是 GBK），对端收到的是一串 U+FFFD（替换符，表示字节解不出来）。2026-11 实测两次：中文当参数发，对端记录里 16 个替换符；把 JSON 写进文件、用 `--data-binary @file` 发，替换符归零。

```bash
node -e 'const fs=require("fs");fs.writeFileSync("msg.json",JSON.stringify({requestId:String(Date.now()),message:fs.readFileSync("msg.txt","utf8")}),"utf8")'
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @msg.json "$BASE/api/sessions/<目标>/prompt"
```

两处都要：请求头带 `charset=utf-8`（不带时接收端可以按本机代码页解码），正文走文件不走参数。判据是读对端的会话记录，数替换符，期望 0：

```bash
node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8");console.log((t.match(/\uFFFD/g)||[]).length)' "<对端的 sessionPath>"
```

**收到乱码就直说，别猜。** 对端回复变成 `���` 这类替换符时，唯一正确的动作是回一句「读不懂，这是原文：<逐字粘贴>」，然后停下等它对。按上下文猜它的意思，猜错了在记录上看不出任何异常——你会照着猜出来的意思改出完全无关的东西。判据：自己的回复里不出现「我理解你的意思是……」这类转述，除非同时贴得出原文片段。这条没有例外：看不懂就停，不要边猜边做。命令行参数经代码页转码会产生那串 U+FFFD，改用文件通道后归零。

### 5.2 要看流式才用 `/api/chat`

请求体不是 `{message: "..."}`，是完整消息数组；`id` 是**目标会话的 sessionId**，不是 `agentId`：

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<目标 sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"ping"}]}]}' \
  "$BASE/api/chat"
```

返回 SSE，一行一帧。典型顺序 `start` → `reasoning-delta`（有思考时才有）→ `text-start` → `text-delta` → `text-end` → `finish` → `[DONE]`；带工具调用还有 `tool-input-start` / `tool-output-available`。不认识的帧按类型过滤，别当错误，也别等某个特定帧——**只认 `finish` 或 `[DONE]`**。这里说的是「流结束了没有」，不是「消息送到没有」——送达看 5.3。`-N` 必须加，否则看不到流式。

### 5.3 判「送到没有」只有一条

**看 `error` 帧，不看 `total`，也不看有没有 data 帧。** 没有 `error` 帧就是送到了（哪怕 0 个 data 帧、`total` 当场没变）；有就是没送到，原因写在 `errorText` 里。

参数错误不进流：缺 `id`、没有 role 为 user 的项、text 为空，直接 400 加 JSON。所以分三处看——400 是没进队列；200 加 `error` 帧是进了但找不到会话；200 加无 `error` 帧才是送到。

**会话记录存在时，对端进程死没死都能送到**：服务端会替你 activate 一次。反过来，对端忙的时候整条连接可能只有 `: ping` 心跳，`total` 也不当场变大，而消息确实进了它的对话——拿 `total` 当判据会判成没送到，重发一次就变成两条重复消息。

**`finish` 不是「送到」的证据。** error 流里同样带 `data: {"type":"finish"}` 与 `data: [DONE]`——实测向不存在的 sessionId 发 `/api/chat`，200 的正文是 error 帧、再跟 finish 和 `[DONE]`。所以别拿 finish 判断送到，只看有没有 `error` 帧。

把上面的规则变成可执行的一条：

```bash
curl -sN --max-time 30 -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<目标 sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"ping"}]}]}' \
  "$BASE/api/chat" > /tmp/chat.txt
if grep -q '"type":"error"' /tmp/chat.txt; then
  echo "FAIL 没送到：$(sed -n 's/.*"errorText":"\([^"]*\)".*/\1/p' /tmp/chat.txt | head -1)"
  exit 1
fi
grep -Eq '"type":"(start|finish)"' /tmp/chat.txt || { echo "未验证：输出里既没有 start 也没有 finish（空文件、只有 : ping 心跳、或被 --max-time 掐断）"; exit 2; }
echo "PASS 没有 error 帧，且收到了 start 或 finish"
```

目标会话没激活时这条命令会自己拉起它（服务端替你 activate），不必先手动 activate，但第一次可能慢几秒。

`--max-time 30` 到点就断，长回复收不全；判「送到没有」按上面三态：1 没送到、0 送到、2 无法判定（一条消息帧都没收到）。

### 5.4 对方在 goal 模式时

发完消息立刻补一条 `/goal on`，**单独成一条，正文一个字都不带**。

- 对方收到 `/goal` 加一段文字会进入自动续跑，一轮结束后接着做原来那件事；普通消息不会触发续跑。
- `/goal 新目标` 是覆盖，会把它的活换成你写的那句。所以只发斜杠加两个词，不带参数，也别等它先回复。
- 后面跟一段话，那段话会被当成你的指令读——等于你替用户改了对方的目标。

发送前能机器核的一条：

```bash
[ "$(wc -c < msg.txt)" -eq 8 ] || { echo "msg.txt 必须正好 8 字节：/goal on，无换行无正文"; exit 1; }
```

用 `printf` 写 msg.txt，别用 `echo`（后者会补换行或解释反斜杠，你真发出去的就不是你以为的那串）。

## 5.5 等对方干完：订阅、复用还是新开、什么时候算结束

**两个流别搞混。** `/api/sessions/<id>/stream` 推这个会话的消息帧（`start` / `text-delta` / `finish`）；`/api/events` 推全局状态快照（`event: state` 加一份 `sessions`/`runtimes` 的 JSON），不推消息文本，也没有心跳帧和 `id:` 行——连接静默不等于断了，重连只能拿全量。

**首选订阅对方的流**，一次连接把它的 `start` / `text-delta` / `finish` 实时推过来：

```bash
curl -sN --max-time 600 -H "$AUTH" "$BASE/api/sessions/<目标>/stream"
```

`--max-time` 必须设：到点断开不影响对端继续干活，重连接着看。订阅一个不存在的 id，第一帧仍是全局 `event: state`——**别把这一帧当成「对方说话了」**，消息帧一定带 `"type"`。

**只有 `finish` 和 `data: [DONE]` 是结束证据。** 连接自己断了、被 `--max-time` 掐了、或者一直只有 `: ping` 心跳，都不算跑完——对方可能正在跑一个长工具调用。要判断它此刻在不在动，用 7.1 的 `state` 动作看 `isStreaming` 和 `isTurnActive`。

**退路是轮询**：长 sleep 会撞上工具自己的超时。把第 5 节那条 curl 重定向到文件后台跑，然后每轮查一次、立刻返回：

```bash
stat -c %s /tmp/reply.txt
tail -c 200 /tmp/reply.txt | tr -d "\n" | tail -c 120
```

**复用旧会话还是新开，判据只有一条：目标会话里有没有关于被审对象的结论。** 有就新开——它记得自己上次的判断，你说「这些已经修了」，它会顺着那个结论找理由，不再独立看（审查、验证、要第二意见都属于这类）；没有就复用——同一件事的下一轮执行、换个小需求，上下文有用。新开之后旧会话不要停，它可能还有没跑完的活。

**什么时候算结束：对方明确写出它那边也没有了，或者逐条回应了你提的每一条。** 回一句「收到」「我看看」不算。代价不对称——你多等一轮只花一轮；早停一轮则它下一轮的修复找不到人复核。

## 5.6 与另一个会话按 PR 模式协作

**两个 agent 改同一份东西时，唯一起作用的机制是「改的人」与「核的人」分开。** 一个人自己改完自己核，等于没核。

| 角色 | 必须做什么 | 不许做什么 |
| --- | --- | --- |
| 改的人（发现方） | 发现问题就自己落盘：贴原文、贴改后原文、给一条能返回真假的判据命令；改完交对方 | 只提不改 |
| 核的人 | 读原文、跑判据、回 accept 或 reject，附 md5 与 rc | 替对方改他的文件；只回「认可」 |
| 双方 | 谁发现谁改，改完换手复核；文件归属对方的（对方签核、对方那份副本）只交证据与建议改法，由所有者自己改 | 发现方让对方替自己改 |

**换边规则**：这一轮甲发现问题、甲改、乙核；下一轮乙发现、乙改、甲核。角色按「谁发现」每轮重定，不沿用上一轮的分工——沿用等于没换边。同一个人既发现又自己核完，等于这一轮没有复核。

**两条规则冲突时按这条断**：凭据在谁手上由谁执行，但改后原文必须由发现方写，执行方只许原样执行。别拿「先做，不满意再退」当替代——文件的改动可逆，**独立判断不可逆**：执行方一给出自己的改法，发现方读到的东西就从「问题」变成「答案」，只能顺着说同意或不同意，给不出自己的版本了。这一步做反了，退回重做也补不回来。

判据写进签核，两条都要：`改法作者` 与 `执行者` 是不同的人；`git diff` 里每一处 `+` 行都能指到发现方给的原文，多出一个它没写过的字，就是执行方在改措辞。缺一条按未签计。实时例子：2026-11-17 对端列出 5 处缺陷并明写「第 4 条要用户定，不是我们能定的」，我方把 5 处都自己改了并推送，退回时发现方已被我的措辞污染。

**交接用文件，不用消息正文。** 中文经过命令行参数会被代码页转码（5.1 末尾那段有实测与判据），提案超过几十行也会被截断。约定：提案写到临时目录的 proposals-rN.md，回执写 review-rN.md；**发消息只发路径与第一行署名，不贴正文**。
```bash
TMP="${TMPDIR:-${TEMP:-/tmp}}"
md5sum "$TMP/proposals-r1.md" | cut -c1-8; stat -c %s "$TMP/proposals-r1.md"
[ -f "$TMP/proposals-r1.md" ] || echo "文件不在 $TMP：Windows 上 bash 的 /tmp 与 %TEMP% 不是同一个位置"
```

**每条消息第一行必须署名，md5、字节、行数、时间四样缺一样，对端只能猜。** 格式固定成一行：

```
[<发送者> → <收件人> · <对象> <md5前8位> · <字节>B · <行数>L · <时间>]
```

收件人填会话名或会话 id，同一次协作内保持一种，换种就注明。

命令：`md5sum f | cut -c1-8`、`stat -c %s f`、`wc -l < f`。为什么必须现取，见 9.1。接收方第一步拿这一行的 md5 与自己盘上的比：不一致就回「你这条基于旧版，我盘上是 <自己的 md5>」，不要先去猜内容差在哪。正文里再出现的任何 md5、字节、行数，都必须与第一行相同；对不上就是没署。一条消息谈两个以上文件时，第一行署名给主对象，其余文件在正文里各自写 `md5 / 字节 / 行` 三连并注明是哪一个——把两个文件的数字混成一组，同样算没署。

2026-11-17 实测白争一轮：我方消息写「技能 634 行」，对端核到 638，双方为「文件是哪一个」核了一整轮——真实值 `wc -l` = 638，两个人盘上的文件本来就是同一个，错的只是消息里那个凭记忆写的数字。

**证明对方真读了原文的办法**：让它在回执里贴出原文片段。行号只作定位、不当证据——插入一行行号就漂，2026-11-16 双方各错过两次（说 186 实际 188、说 3393 字节实际 5467）。行号与片段冲突时，以片段为准。只说「我看了」，与没看无法区分。

**每轮产出必须是 git commit，不能只改盘上文件。** 没有 commit 的改动没有历史：下一轮的人只看得到当前状态，看不到改了什么、也说不清谁改的。判断办法只有一条——`git log --oneline -1` 能指到这次改动。做法：在分支上改，不直接动默认分支；一次提交一件事，提交信息写清为什么；`SKILL.md` 这种装在多处的文件，先 commit、再同步副本，回执里同时给 commit 号、`git diff --stat`、各处 md5 与判据 rc；PR 正文跟着提交一起变（提交表、统计数字、判据 rc 三样都要对得上）。桌面临时复制与副本同步是部署动作，不算改动凭证。

**动手前看，交回执时写。** 动手前跑 `git log --oneline -3` 与 `git status`：对方最近落过你要改的那一节，就先停手合并，别各写各的。核的人在回执里必须写一句「这次改动有没有第二处说同一件事」；写不出这句，算没核完——语义重复脚本抓不住，2026-11-16 实测同一件事被写了三段，四个判据全绿。

**合并提交后，别拿「diff 为空」当等价判据。** 合并时若顺手改了内容，diff 必然非空：2026-11-16 实测合并四笔时顺手修了一处重复，`git diff <合并前> <合并后>` 是 1 处 +1 −1，而提出方报「空」。正确判据是「diff 里每一处都能指到来源」，不是「diff 为空」。

**凭据在谁手上，就由谁执行那一行命令。** 只有对方能推送、能改 PR 正文时：发现方给命令原文，持凭据方原样执行，回贴命令、输出与执行时间；执行前双方各读一遍命令文本。对外推送不可逆，许可只能来自用户——核的人不能代用户说「可以推了」。 别人的仓只 pull 与建 PR，合并是仓主的事：`permissions.push:false` 就不要试 merge（实测返回 404 而不是 403，容易被误读成「PR 不存在」），也不要用 `--admin` 绕过。

**先验凭据能不能做成这件事，再排执行顺序。** 2026-11-16 实测两种失效：fine-grained token 对「本人不是协作者的公开仓」只有只读——`gh api repos/<owner>/<repo> -q .permissions` 得 `pull:true push:false`，建 PR 与改 PR 正文都返回 `Resource not accessible`；GCM 里存的是 OAuth 时，git 操作会弹 GUI 选账号，脚本里设了 `credential.interactive=false` 后 `git credential fill` 直接报 `Cannot prompt because user interactivity has been disabled`。修法（2026-11-17 实测）：

```bash
P=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
GIT_TERMINAL_PROMPT=0 git -c credential.helper= push \
  "https://x-access-token:$P@github.com/<owner>/<repo>.git" <branch>
unset P
```

两个细节都必须：`-c credential.helper=` 断开凭据管理器，否则它会把你写的 `x-access-token` 当成新账号存下，下次取凭据多一个候选、开始弹窗；`GIT_TERMINAL_PROMPT=0` 保证失败立刻返回。判据：push 前后各跑一次 `git credential-manager github list`，行数必须相同。

改 PR 正文不走 `gh pr edit`：它的 GraphQL 查询自带 `login` / `name` / `slug`，OAuth token 常见 scopes 缺 `read:org` 就整条失败。走 REST `PATCH /repos/<owner>/<repo>/pulls/<n>`，判据是回读一次确认 `title` 与 `body` 首行。

**收尾要两份签核文件，适用于一切改动——本机同步、判据改动、清理都算，不是只对 PR。** 各写一份 signoff.md：对象、基准 commit、核过的文件与 md5、跑过的判据与 rc、坏样本、结论。两份都要覆盖全部安装位置。判据：每份里必须出现 `md5`、`rc=`、至少一条坏样本，缺一样按未签计。**对象一变就重签**：改了任何一处内容，旧签核立即失效，双方按新版重出，不拿旧版签核覆盖新版——签核里写的 md5 与盘上对不上，那份就是废纸。**但重签不等于全清单重签**：只签本次 diff 碰到的项，未变的项写一行「未变，见 <上一份> 的 md5」，不重抄结论。判据：本份的项集覆盖本次 diff 涉及的位置；其余项引用得到上一份就算生效。

**三种失效形状，都真实发生过**：

- 核的人只回「认可」、没跑判据，下一轮就发现它没读原文。
- 改的人给的判据是恒绿的，例如用 grep 数 event: error，而真实帧是 data: {"type":"error"}。核的人必须自己造一份坏样本，确认这条判据会红。
- 双方同时改同一个文件，提交进去的是半成品。2026-11-16 实测：同一段两人各写一版，最后三段重复、花了三笔提交合并。预防办法见上面那段「动手前看，交回执时写」。

**等对方干活时**：单次 sleep 超过 40 秒容易被工具自己的超时掐断。用 15 到 20 秒一轮，每轮只查一个事实（文件出来了没有、md5 变了没有），别在等待里跑重活。

## 6 重启：你关不掉自己，让别人关

**重启 = 停止进程 + 重新启动进程。你自己发不出这两个请求**：stop 杀掉的就是发请求的那个进程，没有进程去发 activate。

让别人做。最简单的办法：**新建一个普通会话**，把技能名和下面这段一起贴给它。

建普通会话用这条（`projectId` 从 `/api/state` 的 `projects[]` 里取，常见的是 `builtin-chat`）：

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"projectId":"builtin-chat"}' "$BASE/api/sessions"
```

返回 `{"session":{"id":"...", ...}}`，取 `session.id`。新建的是草稿态，`status` 是 `draft`，也没有 `sessionPath`。

直接发消息它就自己起来，不需要先 `activate`。

**别用 `/api/sessions/anonymous` 建执行者。** 它 `noSession: true`、没有自己的 `sessionPath`，认「我是谁」时会拿到目标的路径，结论必然是「目标就是我」，于是拒绝执行；而且 stop 之后整条记录被删，`activate` 返回 `SESSION_NOT_FOUND`（HTTP 仍是 200）。

> 用 `/skill:pideck-web-api`。把会话 `<目标 sessionId>` 重启，先跑完该技能的第 2 节，再按第 0 步到第 5 步做，每步把输出贴回来。
>
> 0. **先认自己是谁**：`echo $PIDECK_SESSION_ID`。
>
>    它为空就用第 2 节那两条兜底：`$PI_SESSION_FILE` 去 `runtimes[].sessionPath` 里对，或者取 `$PIDECK_LINKED_SESSIONS_URL` 的尾段（必须先在 `sessions[]` 里查到，见第 2 节）。
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
> 4. **验**：`activate` 的返回里直接有 `runtimeGeneration` 和 `agentId`，不用再读一次 `runtimes[]`。
>
>    - 第 1 步找到了 target（目标在跑）：新代号必须比 `N` 大 1，例如 `N=3` 重启后返回 `4`。等于 `N` 说明没换进程（stop 没生效）。
>    - 第 1 步没找到 target（目标本来就没在跑）：**没有 `N` 可比**，此时改看另一个条件：「返回里有 `agentId` 且 `status` 是 `running`」——只看它起没起来，不跟一个不存在的代号比。
> 5. **发一条消息，证明它能接活**：
>    ```bash
>    curl -s -H "$AUTH" -H "Content-Type: application/json" \
>      -d '{"id":"<目标>","messages":[{"role":"user","parts":[{"type":"text","text":"重启结束，这条消息用来验证你能接活"}]}]}' \
>      "$BASE/api/chat"
>    ```
>    送达看 HTTP 200 且流里没有 `error` 帧，帧数与 `total` 都不是判据（`total` 的增量不是判据，理由见本条后面那句）。第 5 节说过，这条请求是异步入队，可能一个帧都不吐。
>
>    **别把「没吐帧」当成「没送到」。** 回 200 之后一帧不吐是正常的，重复发送会真的入队多条——实测同一段正文在一个会话里出现 3 次（`GET /messages` 里三条 user 记录逐字相同），对方要多花一轮读重复内容。两条判据都在发送那一步就能拿到：
>
>    ```bash
>    curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H "Content-Type: application/json" -d @msg.json "$BASE/api/chat"
>    # 200 = 已入队；400 = 没进队列（缺 id 或空 text，body 里有 error 字段）
>    ```
>
>    回 200 之后唯一的失败信号是流里出现 `error` 帧；没出现就是送到了，别再发一次。要看某一条进没进历史，数 `GET /messages` 里 `role: "user"` 的条数，不要用 `total`——它还会因对方的回复与注入而变大。

**第 0 步不能省，也别换成别的判法。** 别拿 `sessionPath` 或磁盘写入时间去推断自己是谁——匿名会话没有 `sessionPath`，会拿目标的路径认自己，结论正好反过来。只有 `echo $PIDECK_SESSION_ID` 可靠。

**HTTP 200 不代表做成了，必须看 body。** 三个实测形状：

| 情况 | HTTP | body |
|---|---|---|
| 停成了 | 200 | `{"result":{"ok":true,"value":{...}}}` |
| 目标本来就没在跑 | 200 | `{"result":{"ok":false,"error":{"code":"SESSION_RUNTIME_UNAVAILABLE"}}}` |
| URL 与 body 的 sessionId 不一致 / 没给 target | 400 | `{"code":"webError.runtimeTargetRequired","error":"A matching Session runtime target is required"}` |

**`runtimeGeneration` 有两种语义，`stop` 与其余命令相反。**

`restart`、`model`、`thinking` 这类命令走 `requireBoundTarget`：代号与绑定都比，传错返回 `SESSION_RUNTIME_CHANGED`，命令不执行（实测 `restart` 传 999 被拒，进程代号没变）。

`stop` 走另一条路 `resolveStopTarget`：只要有 live 绑定的 `agentId`，它就取当前代号，请求里传什么代号都不拦。实测传 999 返回 `ok:true`，目标真被停下。所以 `stop` 唯一的闸是 `agentId`，而且它比路径里的 sessionId 更权威，见第 7.1 节。

**为什么不用等目标回合结束**：如果目标正在写回复，stop 会让它断在半句。判断它忙不忙没有可靠办法——问用户最快。新开的空会话天然空闲，这是它最省事的地方。

**重启之后你是新进程**：不记得上一个进程在干什么。会话历史仍在同一个 jsonl（`runtimes[].sessionPath`），上下文不丢，但「成没成」只能由重启后的一方重读 `runtimes[]` 确认。

### 6.1 几种会让你判断错的行为

下面每条都是「看起来对、实际错」的形状。照第 6 节做之前先读一遍。

**`stop` 只认 `agentId`，`runtimeGeneration` 传错也照停。** 其余 20 个运行时动作走 `requireBoundTarget`，代号与绑定都比，传错返回 `SESSION_RUNTIME_CHANGED`。两种语义的分界见 7.1。

**第一次 `activate` 要几秒**，那是服务端拉起 pi 进程的时间，不是卡住。其余各步是百毫秒级，`发消息` 要等模型回一轮。这些是量级不是常量，换机器会变。

**空会话被 stop 会整个消失，不是变闲。** 新建 → activate → 直接 stop（中间没发过消息），3 秒后它从 `sessions[]` 里没了，之后 `activate` 返回 `SESSION_NOT_FOUND`，`/messages` 仍返回 200 加空数组。所以别拿刚建好的空会话试 stop。发过消息的会话不受影响。

**匿名会话会在空闲几分钟后自己消失。** `POST /api/sessions/anonymous` 建的会话（标题「匿名聊天 - Chat」），消失后 `activate` 返回 `SESSION_NOT_FOUND`。PiDeck 里正常新建的会话不受影响。

**`/messages` 对不存在的会话不返回 404。** 返回 200 加 `{"messages":[],"total":0,"windowStart":0,"truncated":false}`，与「存在但没消息」一模一样。要区分就看 `/api/state` 的 `sessions[]` 里有没有这个 id。

**代号与 `agentId` 一起变**，任一个变了就是换了进程，别去猜 pid。

**`total` 一次加 3 不是 1**：你发的 + assistant 的回复 + 一条注入。这是现象不是判据；判据只有 HTTP 200 加「流里没有 `error` 帧」。

**别做这两件事**：建完会话反复轮询 `runtimes[]` 等它出现（`activate` 返回时进程已经在里面）；为了拿 `total` 反复拉 `/messages`（一次几十 KB 起）。

**用完把执行者删掉**，别留在侧边栏：

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
  "$BASE/api/sessions/<执行者 id>/delete"
```

返回 `{"deleted":true}`。删除只走 `POST .../delete`，`DELETE /api/sessions/<id>` 不存在（404 `webError.apiNotFound`）。先 stop 再 delete，否则进程还占着。删一个已经不存在的 id 返回 `{"deleted":false}`，HTTP 仍是 200，那不是失败。


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
| `toolStateSequence` | 工具状态序号。只在工具状态切换时跳变，同一工具执行期间读多少次都不变；三轮实测 486 → 496 → 530，增量不固定。判断「有没有在动」看两次读是否不同，别拿差值当调用次数 |

**换模型会把思考档重置成新模型的默认值。** 本机实测：`thinking=low` 的时候调 `model` 换到另一个模型，`thinkingLevel` 变回 `high`。所以这两步要按顺序发——先 `model`，再 `thinking`。反过来先设了思考档再换模型，等于没设。

**`permission` 在 pi 后端一定失败。** 源码里只给 DSH 后端注册了这个能力，pi 会话发过去返回 `SESSION_COMMAND_FAILED`（本机实测）。要改 pi 会话的权限，走记录层的 `update` 或者界面。

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

没有「agent 自己重启自己」的捷径。曾经有过 `self-restart.mjs`：起一个脱离进程树的守卫替你 stop 再 activate。2026-11-14 删掉了——理由不是它跑不起来，是它和「不许自己停」这句冲突：两句话同时在，agent 会挑省事的那句执行。

**别做「守卫替你停」这种设计。** 它会死在两处：stop 的 body 没带 `target` 时返回 400 `webError.runtimeTargetRequired`；用 `runtimes[].status` 判断「停了吗」时，空闲进程的 status 是 `idle`，于是判定已停。

要停掉自己，stop 必须带齐 `sessionId` + `agentId` + `runtimeGeneration` 三件；能发出这个请求的应该是**另一个活着的进程**，不是守卫。让别的会话替你重启的完整任务书见本节第 0~5 步，关键就一句：目标会话不能是执行者自己。

## 9 边界

- 只读 pi 的会话文件，不要改 `~/.pi/agent/sessions/*.jsonl`。
- 端点全集以源码 `WebApiRoutes.ts` 为准；本文是 2026-11 的实测记录，不一致时信源码。比对用第 11 节的 `check-doc.mjs`，它读的是源码里的路由表。
- 没有第二个活着的窗口能接，就别停：被停之后没人发 activate，就是永久停着。
- **改了这个技能，已经在跑的会话看不到新版。** 技能是进程启动时用 `--skill <目录>` 注入的（源码 `PiProcess.ts:379`），内容在启动那一刻就进了内存。要让它生效，只能重启那个会话（第 6 节）或者新开一个。

## 9.1 每句话带来源

**区分判据只有一条：这句话会不会被别人当成事实引用。会，就必须能追到「谁说的、依据哪一版」；不会，署名只是噪声。**

三处去向，三种署名，别混着用：

| 去哪 | 署名形式 | 缺了会怎样 |
| --- | --- | --- |
| 发到另一个会话 | 第一行署名，格式与判据见 5.6 | 对端没有可比的东西，只能猜你基于哪一版 |
| 回给用户 | 每条断言标来源：`我跑过` / 对端报的 / `未验证` | 用户分不清「你核的」与「别人说的」 |
| 写进盘上（文件、commit、PR 正文、签核） | 依据版本加时间；commit 自带作者与时间，正文写「依据 `<md5>`」 | 半年后的人不知道这句话当时基于哪一版 |

**数字一律现取。** 三个真实事故，都是本机 2026-11-17 发生的：报「技能 634 行」实际 638；报「字节 30424」那是 JS 字符数、文件字节 53322；报「七处已同步」实际六处，第七处的路径名本身猜错了。

**三个人称分清：我、你、他，各自指谁要在同一句里落地。** 我＝署名行的发送者；你＝署名行的收件人；他＝用户、别的会话、仓主三者之一，每处写明是哪一个：用户就说「用户」，会话就写会话 id，仓主就写仓库全名。别写「我们这边」「对方」这类不指名的说法——收件人不止一个，指代会漂。同一节里第一次出现「对端」时写清是哪一个（会话 id 或名字），后面指同一人可以省。三种真发生过的错：把用户说的写进「我判断的」栏；把别人核过的写成「我核过」；「对端报的」不写是哪个对端。判据：删掉上下文单独读这一句，能说出三个人各是谁；说不出就重写。

**转述要标明出处。** 对端报的数字写进自己的回执时前面写「对端报的」；不标等于冒充自己核过。

**这三句不算署名**：「实测」「已验证」「我看了」——不写命令、不写文件名、不写 md5，与没说是同一件事。

**跨会话消息的完整格式见第 5.6 节**；9.1 管的是这句话该不该带来源，5.6 管的是跨会话那一行写什么。

## 9.2 说人话

**开口之前先做一次假设，不是写完再查：读者什么都不知道、只看第一屏、不记前情、不关心你试错几次。**

这一条是所有写字的起点，不是清单里的最后一项。落笔那一刻就按最差读者写：他要事先知道的东西当场给；他不认识的名字当场解释；他看不到的「刚才」，把原话重述一遍。写完再回头补，补出来的仍是作者视角——你以为补全了，其实只是把你记得的写了下来。

具体形状在下面几条里。凡是「我以为对方知道」这类判断，都按这条推翻。

**动词要有画面。** 抽象名词换成手能做的动作，读完第一屏要能说出「谁对什么做了什么」。**不止修 bug——所有操作都换**：同步、验证、回滚、提交、删除，凡是名词化的说法都算。

| 别写 | 说成 |
| --- | --- |
| 修复了这个缺陷 | 砍了一刀 |
| 重构了模块 | 推倒重写 |
| 优化了性能 | 让它快了一截 |
| 部署完成 | 装到机器上了 |
| 清理了冗余 | 砍掉没用的 |
| 同步了两边 | 对了一遍表 |
| 验证通过 | 跑了一遍，没红 |
| 回滚了改动 | 退回去 |
| 提交了 | 落了一笔 |
| 合并了两个版本 | 并成一份 |
| 撤销了那次改动 | 拿掉了 |

**同类一次砍完。**「砍一刀」是一刀把同类全砍掉，不是挨个修。同一句话写在三个地方，一次砍掉重复的那两处，比逐个改三次干净。

**对另一个会话说话，也是说话。** 它不记得上一轮、上下文随时被压缩、可能刚重启。跨会话消息与任务书一律自包含四件：要它做什么（一句）；依据（绝对路径、md5、字节）；算完成的标志；它可以拒绝的方式。不用「上一条」「刚才那个」指代前情，不写你改了几版。

**引用节号不算交代。** 写「按 5.6 办」「见第 11 节」，对方可能根本没读过这个技能、读到的是旧版、或上下文已被压缩——它不知道 5.6 是什么，也不知道 PR 模式长什么样。要它遵守的规则，把那几句规则原文抄进消息——不是只写「见 5.6」；提案与回执这类长文件仍走文件路径，见 5.6。判据：把这条消息给一个从没读过技能的新会话，它不问「5.6 是什么」就能开始干活。它一反问，就是我没交代。

**怎么查**：把这条消息单独取出来，给一个从没参与过的 agent，它能照着做完，还能说出「我不同意哪条」。做不到就重写。同类句、术语、指代前情的词、没抄正文的节号引用，都是重写的信号。

## 9.3 一切改动都进 git

**判据只有一条：`git log` 能指到这笔改动，工作区干净。**

不管改的是什么——源码、文档、技能、配置、签核文件、清理——没有提交的改动等于没有历史。三个月后没人知道谁改的、为什么改、改之前长什么样。

四件具体动作：

1. 改完立刻提交，不攒。攒着的改动会被下一次改动污染，也说不清哪一笔是为了什么。
2. 提交信息写为什么，不写「update」「fix」。
3. 有远端就推，推完用 `git ls-remote <remote> refs/heads/<branch>` 与本地 `git rev-parse HEAD` 比对——不看自己的输出，`git push` 之后跟着别的命令时 rc 会是别人的。
4. 动手前跑 `git status`：有别人的脏文件就先停，别把两件事混进一笔。

**行数不是判据。** 判「这次是追加还是替换」要看你 diff 里的 `-` 行，不是看行数变没变——把一段删掉、再添一段，行数可以一模一样，`--stat` 只显示 `1 ++ 1 --`。真发生过：把 9.4 唯一的插队反例替换成新段，735 行还是 735 行，行数没露馅，对端看 diff 才发现反例没了。判据：`git diff --numstat <旧> <新> -- <文件> | awk '{a+=$1; d+=$2} END{printf "%d %d\n", a+0, d+0}'`，得「加 减」两个数，加 > 0 且减 = 0 才是纯追加，「0 0」是没有行增删（改名也会得 0 0，但它不改变「追加还是替换」这个结论）。三个坑都踩过：`grep -c "^-"` 被 `--- a/file` 表头喂成恒 1；原样看 `--numstat` 输出，两版相同时一行都不打，「第二列是 0」这句读不到数；只聚第二列，纯追加与无改动都得 0，分不出是哪种。

**例外只有两条**：会变的值（令牌、时间戳、机器相关的路径）不进仓；大二进制不进仓，留个生成脚本。

```bash
git status --porcelain | wc -l   # 期望 0
git log --oneline -1             # 能指到这次改动
```

坏样本：改一个文件不提交，第一条就不是 0；用 `git status --porcelain | head` 会拿到 0，那是 head 的退出码，不是 git 的。

## 9.4 每来一件新事，先重排

**新任务进来时，按顺序做三件：列全、排序、只做队首。**

1. **列全**：手里所有未完成项，一项一行。漏掉的一项会变成之后某次返工。
2. **排序**：晚一周的损失 ÷ 工期。分子指不出具体会话、具体文件的就是 0；分子为 0 的事不做，并说清为什么不做。
3. **只做队首**：做完再排一次。半途插队，两件都脏。

判据：能说出现在做哪一件、为什么它在最前、其余各在第几。说不出就还没排。

**用户的话优先于另一个会话的话。** 对端回执进来时，先看用户有没有没处理的指令：有就先做用户的。对端可以等，用户的指令等成「未完成项」就是错序。反例（真发生过）：用户说「先重排优先级」，我却先去执行对端回执里的两处改动，报告里连优先级清单都没给。

反例（真发生过）：新任务一来直接插队做，手里那件停在半途，两处都不完整，之后还要花时间找接缝。

**别人的东西不进队列。** 有上游维护的仓、别人的技能、别人的 PR——没经用户明确批准，一律不碰、不报、不列进待办。判据：待办清单里出现不属于自己的仓或文件就红，一条也算。反例（真发生过）：把「上游两个技能缺说明、该报给 magpie-community/plugins」当成自己的未完成项，连列三轮，用户每次都说不归我管。

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

**四个判据在源码克隆根目录跑，rc 都得是 0：**

```bash
node resources/skills/pideck-web-api/check-doc.mjs     # 第 7 节动作表、端点数、字段
node resources/skills/pideck-web-api/check-paths.mjs   # 全文每个 /api 路径逐段对源码
node resources/skills/pideck-web-api/check-format.mjs  # 表格列数、加粗成对、代码块配对、$ 变量
node resources/skills/pideck-web-api/check-fields.mjs  # 反引号标识符逐词对源码
```

改了源码里的路由之后，还要重写台账。`--update-routes` 是**写操作，不是判据**——它的 rc=0 只表示写成功：

```bash
node resources/skills/pideck-web-api/check-doc.mjs --update-routes   # 重写 check-doc-routes.json，并打印跳过几条残缺串
```

带 `--selftest` 的是 `check-paths`、`check-format`、`check-fields` 三个，能脱离源码单独验「判据自己还对不对」（装了 PiDeck 的机器上只有这份副本，没有 `src/main`）。`check-doc` 没有自检：传 `--selftest` 会直接 rc=2 并打印「check-doc 没有自检」，因为它的每条判据都要真的路由表，源码不在就报 rc=2——那是环境不全，不是判据失败。

`check-doc.mjs` 还要读同目录的 `check-doc-routes.json`：60 条路由的台账，生成物，别手改。源码里少了一条台账里有的路由，它逐条打印并判 rc=1，所以删路由必须连台账一起改、在提交信息里说明为什么。台账缺失也判 rc=1，那是部署不全不是环境缺失。源码新增路由只提示不判红，否则每改一次源码都会红，这条判据就没人用了。残缺串（裸 `/api`、通配 `/api/*`、带中文的注释片段）不进台账，`--update-routes` 会跳过并打印跳了几条。

口径上限写在各自文件头：`check-paths` 只按段比对、抓不到顺序错；`check-doc` 抓不到模板串拼出来的路由；`check-fields` 要读全量 src，克隆不完整时用 `--src=<完整 src 目录>` 指过去，别删它求绿。

### 踩过的坑（都是实测，改这个技能时会再撞上）

**改了 SKILL.md 必须重跑技能清单，否则 CI 红。** 仓库 CI 有一条 skills-manifest drift，清单记录的 sha256 与文件不一致就失败（2026-11-16 实测日志：`[content-manifest:skills] artifact is stale`）。

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