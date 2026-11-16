# GTD 收件箱（#546）实施计划

状态：**阶段 1 已落地（状态机 + 稀疏账本 + IPC），UI 未做**。

「活动」侧栏目前按最近更新时间平铺，不区分「等我拍板 / 后台在跑 / 跑完没看 / 可以收掉」。
GTD 模式的定位是把同一批会话按**是否需要人介入**重新分桶，不改变任何 pi 会话文件。

## 一、状态机

桶（按展示优先级）：`needs-you` > `pinned` > `active` > `working` > `snoozed` > `settled`。

判定顺序（`src/shared/gtdProjection.ts` 是唯一实现，纯函数、无副作用）：

| 顺序 | 条件 | 桶 | 谁触发 |
|---|---|---|---|
| 1 | 有未答复的 Ask / 审批 | needs-you | 运行时（`pendingInteraction`） |
| 2 | 运行态 `error` | needs-you | 运行时 |
| 3 | 用户置顶 | pinned | 用户 |
| 4 | 未到期的 snooze | snoozed | 用户 |
| 5 | 已结清且结清后无新活动 | settled | 用户点 ✓ |
| 6 | `starting` / `running` | working | 运行时 |
| 7 | 其余（含「跑完未查看」） | active | 默认 |

**未读**是 `active` 的附加标记，不是独立桶：`lastActivityAt > viewedAt`。
**自动复活**：结清后只要出现晚于 `settledAt` 的活动（用户发消息/助手回复），第 5 条不再命中，
会话回到 working/active——不需要额外的「重新打开」动作。

`needs-you` 压过一切，包括置顶与结清：一个已经结清但报错的会话不能被折叠区藏起来。

## 二、存储

独立稀疏账本 `<userData>/gtd-ledger.json`（`src/main/gtd/GtdLedger.ts`），**只存人类意图与水位线**：

```json
{ "version": 1, "sessions": { "<sessionId>": { "settledAt": 1760000000000, "viewedAt": ..., "snoozeUntil": ... } } }
```

- 不扩 `SessionCatalog`：分诊状态是 PiDeck 的展示意图，不是会话身份；会话被删/归档时残留一条
  空水位线无害（读取方按 sessionId 命中才算）。
- 不改写 pi 原生 JSONL。
- 原子写（tmp + rename），加载时逐条消毒（只收有限正数时间戳），条数上限 5000（超出丢最旧的）。
- 六个桶全部由「运行时快照 + 账本」实时投影，账本本身不存桶名——避免状态漂移。

## 三、分阶段

1. **阶段 1（本次）**：类型 + 投影 + 账本 + IPC（`gtd:state-get` / `gtd:state-patch`）+ 单测。
2. **阶段 2**：活动页的模式切换与分桶渲染（虚拟列表、未读圆点、hover 结清）。
3. **阶段 3**：5 秒 `Ctrl+Z` 撤回、跨区拖拽。
4. **阶段 4**：Snooze 定时（单次 `setTimeout` + `powerMonitor` 唤醒补偿）与冷启动隔离
   （只纳入有 runtime 或近期访问过的会话）。

## 四、与现有结构的边界

- 不新增 pi↔PiDeck 通道：账本走普通 IPC（`src/shared/ipc.ts` → main handler → preload）。
- `needs-you` 的判定输入来自既有运行时快照（Ask/审批/error），不复制一套运行时状态。
- 结清联动终端（提案里的「关闭已退出终端」）**不在计划内**：那要把终端生命周期接进分诊状态机，
  风险与收益不成比例；结清只改视图。
