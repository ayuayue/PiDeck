# message · 发消息与判定送达（类型版）

> 索引：§0–§2 `connect.md` · 本文件 §5 · `collaboration.md` · `restart.md` · `actions.md` · `boundaries.md` · `maintenance.md` · `endpoints.md`

## 5 类型

`Γ ⊢ 送到 : Prop`

| 件 | 形状 |
| --- | --- |
| 形成 | 目标 sessionId ≠ 自己；`$AUTH`/`$BASE` 已设 |
| 引入 | §5.1 的 POST `/prompt` 返回 `accepted:true` |
| 消去 | 对端 jsonl 里出现该消息，替换符 0 个 |
| 反例 | `finish` 帧或 `total` 被当成送达证据 |

**发之前再认一次自己**：`echo $PIDECK_SESSION_ID`。目标 id 等于它 = 你在给自己发，然后自己等自己回。

### 5.1 `/prompt`：同步返回 accepted

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"requestId":"'"$(date +%s)"'","message":"只回两个字：收到"}' \
  "$BASE/api/sessions/<目标>/prompt"
```

期望 `{"result":{"accepted":true,...,"runtimeGeneration":3}}`。字段名是 `message` 不是 `text`；`requestId` 必填。

**中文别走命令行参数**：`curl -d "中文"` 先过终端代码页（Windows 常是 GBK），对端收到一串 U+FFFD。两处都要改：请求头带 `charset=utf-8`，正文走文件。

```bash
node -e 'const fs=require("fs");fs.writeFileSync("msg.json",JSON.stringify({requestId:String(Date.now()),message:fs.readFileSync("msg.txt","utf8")}),"utf8")'
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @msg.json "$BASE/api/sessions/<目标>/prompt"
```

判据：数对端 jsonl 里的替换符，期望 0。

```bash
node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8");console.log((t.match(/\uFFFD/g)||[]).length)' "<对端 sessionPath>"
```

**收到乱码就直说**：回「读不懂，这是原文：<逐字粘贴>」并停下等它对。按上下文猜，猜错了在记录上看不出异常。

### 5.2 `/api/chat`：要流式才用

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<目标 sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"ping"}]}]}' \
  "$BASE/api/chat"
```

帧序：`start` →（有思考时 `reasoning-delta`）→ `text-start` → `text-delta` → `text-end` → `finish` → `[DONE]`；带工具还有 `tool-input-start`／`tool-output-available`。
`-N` 必须加。不认识的帧按类型过滤，别等某个特定帧。

### 5.3 判「送到没有」只有一条

**看 `error` 帧。** 没有 error 帧就是送到了（哪怕 0 个 data 帧、`total` 没变）；有就是没送到，原因在 `errorText`。

| 观察 | 含义 |
| --- | --- |
| 400 | 没进队列（缺 `id`／无 user 项／text 空） |
| 200 + `error` 帧 | 进了但找不到会话 |
| 200 + 无 `error` 帧 | 送到 |

**`finish` 不是送达证据**：error 流里同样带 `finish` 与 `[DONE]`。

```bash
curl -sN --max-time 30 -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"<目标 sessionId>","messages":[{"role":"user","parts":[{"type":"text","text":"ping"}]}]}' \
  "$BASE/api/chat" > /tmp/chat.txt
if grep -q '"type":"error"' /tmp/chat.txt; then
  echo "FAIL 没送到：$(sed -n 's/.*"errorText":"\([^"]*\)".*/\1/p' /tmp/chat.txt | head -1)"; exit 1
fi
grep -Eq '"type":"(start|finish)"' /tmp/chat.txt || { echo "未验证：没有 start 也没有 finish"; exit 2; }
echo "PASS 没有 error 帧，且收到 start 或 finish"
```

三态：1 没送到、0 送到、2 无法判定。

### 5.4 对方在 goal 模式时

发完消息补一条 `/goal on`，**单独成一条，正文一个字都不带**。`/goal 新目标` 是覆盖，等于替用户改对方的目标。

```bash
[ "$(wc -c < msg.txt)" -eq 8 ] || { echo "msg.txt 必须正好 8 字节：/goal on，无换行无正文"; exit 1; }
```

用 `printf` 写，别用 `echo`（补换行或解释反斜杠）。

### 5.5 等对方干完

两个流别混：`/api/sessions/<id>/stream` 推消息帧；`/api/events` 推全局 `event: state`，不推消息文本，也没有心跳。

```bash
curl -sN --max-time 600 -H "$AUTH" "$BASE/api/sessions/<目标>/stream"
```

| 反例 | 为什么错 |
| --- | --- |
| 把第一帧 `event: state` 当成「对方说话了」 | 订阅不存在的 id 也会先来这一帧；消息帧一定带 `"type"` |
| 连接断了就算跑完 | 对方可能在跑长工具调用；结束证据只有 `finish` 与 `[DONE]` |
| 用 `--max-time` 掐断当结束 | 掐断只是你这边不看 |

判断它在不在动：`/api/state` 看 `isStreaming` 与 `isTurnActive`（见 `read.md`）。

**复用还是新开，判据一条**：目标会话里有没有关于被审对象的结论。有 → 新开（它记得上次判断，会顺着找理由）；没有 → 复用。新开后旧会话不要停。

多轮复核可复用，但守住三条（[人]，无机器判据）：每轮现跑判据不看上一轮 rc；重读本轮改动不看记忆；不把上一轮结论当依据。

**算结束**：对方明确写出它那边也没有了，或逐条回应了你提的每一条。「收到」不算。

## 8 动别的会话之前

| 动作 | 先决条件 | 反例 |
| --- | --- | --- |
| 读别的会话 | 先说一声（读取会刷新目标窗口界面） | 静默读，用户看到窗口自己在动 |
| 发消息 | 用户明确讲过「去让某会话做某事」 | 替用户对它说话 |
| 停／重启 | 拿到用户对**那一个会话**的明确同意 | 批量停 |

**别做「守卫替你停」**：stop 缺 `target` 返回 400 `webError.runtimeTargetRequired`；用 `runtimes[].status` 判「停了吗」时空闲进程是 `idle`，会误判已停。停自己必须带齐 `sessionId`+`agentId`+`runtimeGeneration`，且执行者必须是**另一个活着的进程**。
