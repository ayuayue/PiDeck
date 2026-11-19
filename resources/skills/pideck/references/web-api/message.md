> 节号索引：§0–§2 `connect.md` · §3–§4 `read.md` · §5–§5.5、§8 `message.md` · §5.6、§9.1–§9.4 `collaboration.md` · §6 `restart.md` · §7 `actions.md` · §9–§10 `boundaries.md` · §11 `maintenance.md` · 其余端点 `endpoints.md`

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

### 5.5 等对方干完：订阅、复用还是新开、什么时候算结束

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

**同一对象的多轮复核可以复用会话，但只有守住三条才叫复核**（[人]，无机器判据）：每轮重新现跑判据，不看上一轮的 rc；重读本轮改动的那几段，不凭记忆；不得把上一轮的任何结论当本轮依据。违反任一条，复用就等于没复核。要第三方独立判断时必须新开。

风险在「引用上一轮结论」，不在「同一个会话」——2026-11-17 实测：同一会话里靠盘上逐字比对核五行原文，与记忆无关；同一会话里复述上一轮的 rc，才是没复核。

**什么时候算结束**：对方明确写出它那边也没有了，或者逐条回应了你提的每一条。回一句「收到」不算。代价不对称——多等一轮只花一轮，早停一轮则它的修复找不到人复核。

## 8 动别的会话之前先问

这个技能能读别人的时间线、往别人的对话里发消息、停掉别人的运行时。三件事的后果都落在**另一个窗口**上。

- **读别的会话**：也要先说一声。理由不是隐私，是读取会刷新目标窗口的界面，用户会看到自己的窗口在动。
- **给别的会话发消息**：等于替用户对它说话。只在用户明确讲了「去让某个会话做某事」之后才发。
- **停或重启别的会话**：会让目标当前回合中断。发出前要拿到用户对**那一个会话**的明确同意。


**别做「守卫替你停」这种设计。** 它会死在两处：stop 的 body 没带 `target` 时返回 400 `webError.runtimeTargetRequired`；用 `runtimes[].status` 判断「停了吗」时，空闲进程的 status 是 `idle`，于是判定已停。

要停掉自己，stop 必须带齐 `sessionId` + `agentId` + `runtimeGeneration` 三件；能发出这个请求的应该是**另一个活着的进程**，不是守卫。让别的会话替你重启的完整任务书见 `restart.md` 第 6 节的第 0~5 步，关键就一句：目标会话不能是执行者自己。
