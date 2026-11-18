> 节号索引：§0–§2 `connect.md` · §3–§4 `read.md` · §5–§5.5、§8 `message.md` · §5.6、§9.1–§9.4 `collaboration.md` · §6 `restart.md` · §7 `actions.md` · §9–§10 `boundaries.md` · §11 `maintenance.md` · 其余端点 `endpoints.md`

## 6 重启：你关不掉自己，让别人关

**重启 = stop + activate。你自己发不出这两个请求**：stop 杀掉的就是发请求的那个进程，没有进程去发 activate。

让别人做。最简单的办法：**新建一个普通会话**，把下面这段一起贴给它。

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"projectId":"builtin-chat"}' "$BASE/api/sessions"
```

`projectId` 从 `/api/state` 的 `projects[]` 取。返回 `{"session":{"id":"..."}}`，取 `session.id`。新建是草稿态（`status: draft`，无 `sessionPath`），直接发消息它就起来，不用先 activate。

**别用 `/api/sessions/anonymous` 建执行者**：它 `noSession: true`、没有自己的 `sessionPath`，认「我是谁」时拿到目标的路径，结论必然是「目标就是我」；而且 stop 之后记录被删，activate 返回 `SESSION_NOT_FOUND`（HTTP 仍是 200）。

> 用 `/skill:pideck`，读它的 `references/web-api/connect.md`（第 2 节）与 `references/web-api/restart.md`（第 6 节）。把会话 `<目标 sessionId>` 重启，先跑完第 2 节，再按第 6 节的第 0 步到第 5 步做，每步把输出贴回来。
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
