# read · 读状态与找会话（类型版）

> 索引：§0–§2 `connect.md` · §3–§4 本文件 · §5 `message.md` · §5.6 `collaboration.md` · §6 `restart.md` · §7 `actions.md` · §9–§10 `boundaries.md` · §11 `maintenance.md` · 其余 `endpoints.md`

## 3 读自己（只读）：`Γ ⊢ 读到 : 有界窗口`

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/messages"   # 时间线
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/todo"       # todo
curl -s -H "$AUTH" "$BASE/api/sessions/$PIDECK_SESSION_ID/subagents"  # 子 agent
curl -s -H "$AUTH" "$BASE/api/sessions/runtimes" | head -c 300        # 进程活着没有
```

第四条给所有进程，按 `sessionId` 筛自己：`running` 正在生成，`idle` 闲着。

`/messages` 返回 `{messages, total, windowStart, truncated}`，**是有界窗口，不是全部历史**。

| 字段 | 含义 | 反例 |
| --- | --- | --- |
| `messages` | 旧到新；要末尾 N 条用 `slice(-N)` | 按数组长度推总条数 |
| `total` | 文件里的条目数，与 `messages` 基数不同 | 拿 `total` 减 `messages.length` |
| `windowStart: 0` | 没截断 | — |
| `truncated: true` | 还有更早的 | 当成全量 |

**单次 `/messages` 不吃 `?before`**（传了不生效）。翻历史：

```bash
curl -s -H "$AUTH" "$BASE/api/sessions/<目标>/messages/page?pageSize=100&before=<nextBefore>"
```

| 判据 | 反例 |
| --- | --- |
| `nextBefore` 为 `null` 即拿全 | 用「累计条数 = total」判断——翻到底也不相等 |
| `pageSize` 单位是**一轮问答**（默认 3） | 用条数推轮数 |
| `nextBefore` 非 null 时 7 个键、null 时 6 个，按字段名取 | 按下标取 |

`before`/`pageSize` 不校验：非整数当没传；负数 `before` 返回空 `messages` 且 `nextBefore: null`（像翻到底，其实参数错）；`pageSize` ≤0 退成 1 轮。

**每次返回整个窗口**，`?limit` 无视：1653 条的会话一次 226 KB，`pageSize=100` 可到 15 MB。**别拿它轮询**——判送达看 SSE 有没有 `error` 帧。

单条消息 `{id, agentId, role, text, timestamp, meta}`；assistant 多 `thinking`/`model`/`stopReason`。正文在 `text` 不在 `parts`。要原始工具调用参数只能读磁盘 jsonl（`runtimes[]` 的 `sessionPath`）。

## 4 找别的会话：`Γ ⊢ 找到 : SessionId`

```bash
curl -s -H "$AUTH" "$BASE/api/state"
```

至少四个数组：`sessions[]`、`runtimes[]`、`projects[]`、`pendingUiRequests[]`。

| 数组 | 答什么问题 | 反例 |
| --- | --- | --- |
| `sessions[]` | 有哪些会话（含没跑的） | 用它判断进程在不在 |
| `runtimes[]` | 此刻正在跑的进程 | 用 `status: idle` 推出「没在跑」——进程活着只是闲着 |

两个数组答的不是同一个问题。不在 `runtimes[]` 里只说明进程没起，消息照样送得到：服务端替你 `activate` 一次——**别为了发消息先起进程**。

`GET /api/sessions` 不存在（猜它拿到 `webError.apiNotFound`）；列会话用 `/api/state`。`POST /api/sessions` 存在，建会话见 `restart.md`。

**列表里找不到某会话 ≠ 它不存在**：先确认 `projects[]` 里有它所属的项目。

## 规则（依赖类型理论：四件缺一不算规则）

| # | 命题 | 引入（命令 → 期望） | 消去（第二入口） | 反例 |
| --- | --- | --- | --- | --- |
| R1 | `total` 与 `messages` 基数不同，不能相减 | 读一次 messages → 两字段不相等 | 翻到底后比 `nextBefore` → `null` | 用 `total - messages` 推条数 |
| R2 | 翻页只看 `nextBefore`，不看累计条数 | 传上一页 `nextBefore` → 直到 `null` | 累计条数与 `total` 仍不等（正常） | 等累计条数等于 `total` 才停 |
| R3 | `?limit` 一律无视，整窗口返回 | 带与不带 limit 各请求一次 → 体积相同 | `pageSize=100` 时体积暴涨 | 拿它轮询判消息送达 |
| R4 | `runtimes[]` 与 `sessions[]` 答不同问题 | activate 后读 runtimes → `status` 是 `idle` | 不在 runtimes 里仍能发消息 → 200 | 为发消息先起进程 |
