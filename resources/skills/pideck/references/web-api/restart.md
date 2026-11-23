# restart · 重启（类型版）

> 索引：§0–§2 `connect.md` · §3–§4 `read.md` · §5 `message.md` · §5.6 `collaboration.md` · §6 本文件 · §7 `actions.md` · §9–§10 `boundaries.md` · §11 `maintenance.md` · 其余 `endpoints.md`

## 6 类型

`Γ ⊢ 重启成功 : runtimeGeneration = N + 1`

| 件 | 形状 |
| --- | --- |
| 形成 | 执行者 ≠ 目标；目标当前 `agentId` 与代号 N 已取到（或目标没在跑） |
| 引入 | stop 返回 `ok:true`，activate 返回新 `agentId` 与 `runtimeGeneration` |
| 消去 | 第 4 步比对：新代号 = N+1；否则看「返回有 `agentId` 且 `status: running`」 |
| 反例 | HTTP 200 就报「重启完成」——200 有三种 body |

**重启 = stop + activate。你自己发不出这两个请求**：stop 杀掉的就是发请求的进程，没有进程去发 activate。让别人做。

### 6.1 造执行者

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"projectId":"builtin-chat"}' "$BASE/api/sessions"
```

`projectId` 从 `/api/state` 的 `projects[]` 取。返回 `{"session":{"id":"..."}}`。新建是草稿态（`status: draft`，无 `sessionPath`），直接发消息它就起来。

**别用 `/api/sessions/anonymous` 建执行者**：`noSession: true`、没有自己的 `sessionPath`，认「我是谁」时拿到目标的路径，结论必然「目标就是我」；stop 之后记录被删，activate 返回 `SESSION_NOT_FOUND`（HTTP 仍 200）。

### 6.2 任务书（整段贴给执行者，不要改写）

> 用 `/skill:pideck`，读 `references/web-api/connect.md`（第 2 节）与 `references/web-api/restart.md`（第 6 节）。把会话 `<目标 sessionId>` 重启，先跑完第 2 节，再按第 6 节的第 0 步到第 5 步做，每步把输出贴回来。
>
> 0. **先认自己是谁**：`echo $PIDECK_SESSION_ID`。为空就走第 2 节两条兜底。拿到之后比对：等于 `<目标>` 就停下——停掉的是你自己。三条路都拿不到也停下，别赌。
> 1. **取 target**：`curl -s -H "$AUTH" "$BASE/api/sessions/runtimes"`，找 `sessionId` 等于目标那项，记下 `agentId` 与 `runtimeGeneration`（记作 N）。找不到说明目标没在跑，跳到第 3 步。
> 2. **停**：
>    ```bash
>    curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
>      -d '{"target":{"sessionId":"<目标>","agentId":"<上一步的 agentId>","runtimeGeneration":<N>}}' \
>      "$BASE/api/sessions/<目标>/runtime/stop"
>    ```
>    `<N>` 连尖括号一起换成真实数字。URL 里的 `<目标>` 与 body 里的 `sessionId` 必须同一个值。
> 3. **启**：
>    ```bash
>    curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
>      "$BASE/api/sessions/<目标>/runtime/activate"
>    ```
> 4. **验**：activate 返回里直接有 `runtimeGeneration` 与 `agentId`。第 1 步找到 target 时新代号必须 = N+1（等于 N 说明没换进程）。第 1 步没找到时改看「有 `agentId` 且 `status: running`」。
> 5. **发一条消息证明能接活**：
>    ```bash
>    curl -s -H "$AUTH" -H "Content-Type: application/json" \
>      -d '{"id":"<目标>","messages":[{"role":"user","parts":[{"type":"text","text":"重启结束，这条用来验证你能接活"}]}]}' \
>      "$BASE/api/chat"
>    ```
>    送达看 HTTP 200 且流里没有 `error` 帧。**别把「没吐帧」当成「没送到」**——这条异步入队，回 200 后一帧不吐是正常的，重发会真的入队多条。

**第 0 步不能省，也不能换判法。** 别拿 `sessionPath` 或磁盘写入时间推断自己是谁——匿名会话没有 `sessionPath`，会拿目标的路径认自己，结论正好反过来。

### 6.3 反例表

| 现象 | HTTP | body | 含义 |
| --- | --- | --- | --- |
| 停成了 | 200 | `{"result":{"ok":true,"value":{...}}}` | 唯一成功形态 |
| 目标本来没在跑 | 200 | `{"result":{"ok":false,"error":{"code":"SESSION_RUNTIME_UNAVAILABLE"}}}` | 不是失败，是无需停 |
| URL 与 body 的 sessionId 不一致／没给 target | 400 | `webError.runtimeTargetRequired` | 请求形状错 |

**`runtimeGeneration` 有两种语义。** 其余 20 个运行时动作走 `requireBoundTarget`：代号与绑定都比，传错返回 `SESSION_RUNTIME_CHANGED`，命令不执行。`stop` 走 `resolveStopTarget`：只要有 live 绑定的 `agentId` 就取当前代号，传什么代号都不拦。所以 `stop` 唯一的闸是 `agentId`，且它比路径里的 sessionId 更权威。

### 6.4 会让你判断错的六种行为

| 行为 | 反例 |
| --- | --- |
| `stop` 只认 `agentId` | 以为代号传错会拦 |
| 第一次 `activate` 要几秒（拉起 pi 进程） | 当成卡住 |
| 空会话被 stop 会整个消失 | 拿刚建好的空会话试 stop |
| 匿名会话空闲几分钟后自己消失，之后 activate 返回 `SESSION_NOT_FOUND` | 拿匿名会话做长任务 |
| `/messages` 对不存在的会话返回 200 加空数组 | 用空数组判「会话不存在」——看 `sessions[]` |
| `total` 一次加 3 不是 1（你的 + 回复 + 一条注入） | 拿 `total` 当判据 |

别做这两件事：建完会话反复轮询 `runtimes[]` 等它出现（activate 返回时进程已经在了）；为拿 `total` 反复拉 `/messages`（一次几十 KB 起）。

**重启之后你是新进程**，不记得上一个进程在干什么。会话历史仍在同一份 jsonl，上下文不丢，但「成没成」只能由重启后的一方重读 `runtimes[]` 确认。

### 6.5 清理

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' \
  "$BASE/api/sessions/<执行者 id>/delete"
```

返回 `{"deleted":true}`。只走 `POST .../delete`，`DELETE /api/sessions/<id>` 不存在。先 stop 再 delete。删不存在的 id 返回 `{"deleted":false}` 且 HTTP 200——那不是失败。
