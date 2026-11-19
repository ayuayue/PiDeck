> 节号索引：§0–§2 `connect.md` · §3–§4 `read.md` · §5–§5.5、§8 `message.md` · §5.6、§9.1–§9.4 `collaboration.md` · §6 `restart.md` · §7 `actions.md` · §9–§10 `boundaries.md` · §11 `maintenance.md` · 其余端点 `endpoints.md`

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
