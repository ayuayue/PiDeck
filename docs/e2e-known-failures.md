# e2e 已知失败清单

**用途**：进不了 CI、又暂时不修的 e2e 失败集中记在这里，避免每次重新调查。
**纪律**：新增条目必须写「现象 / 证据 / 根因判定到哪一层 / 下一步」；修好后连同条目一起删。
**判定口径**：先在**重构前的基线 commit**上复跑，确认不是近期改动引入的，再登记。

复跑单条：`npx playwright test "e2e/<file>.spec.ts:<line>" --retries=0 --workers=1 --reporter=line`
需要看主进程日志：加 `PIDECK_E2E_KEEP=1`，产物目录会打印在日志里（`profile/logs/app-*.log`）。

## 2026-11-14 全量体检基线

88 个使用 mock-pi fixture 的 spec（排除需真实 DSH/SSH 的 `dsh-restart`、`remote*Acceptance`）：

| 项 | 数字 |
|---|---|
| 用例总数 | 215 |
| passed | 173 |
| failed | 40 |
| skipped | 2 |
| 耗时 | 14.9 分钟（`--workers=3`） |

失败分布（28 个 spec）：`session-history-agent-states` 4 / `terminal-first-open` 3（**已修**，见下）/ `favorites-bulk`、`file-link-repro`、`layout-terminal`、`provider-model-setup`、`retry-status-card`、`settle-reposition`、`visual-tune-surfaces` 各 2 / 其余 18 个各 1。

两类签名占绝大多数，**与 pi/fork 无关**：

1. `.conversation` 种子行找不到（`file-link-repro`、`imagegen-composer-layout`、`branch-tree-panel`、`agent-market-bulk`）——预置会话行没渲染，属种子数据/侧栏结构变化。
2. 布局与视觉度量（`content-width`、`settle-reposition`、`tab-font-size`、`process-group-display`、`typewriter`、`visual-*`、`tmp-table-menu`）——像素/字号/间距断言，随样式迭代腐烂最快。

**mock 改动的回归对照**（2026-11-14 为 mock 补 fork 仿真时做的）：把 `e2e/mock-pi.cjs` 换回改动前版本，重跑 8 个代表 spec 的 17 个用例，结果逐条一致（14 failed / 3 passed）→ mock 改动无回归。

---

## 已修复（留档，便于同类问题快速定位）

| 日期 | 用例 | 原因 | 修法 |
|---|---|---|---|
| 2026-11-14 | `session-history-mutation`（3 条） | 删除确认文案按 running/idle 分变体、编辑/重发已改 fork 语义 | 对齐断言；mock 补真 fork |
| 2026-11-14 | `tab-context-menu:16` | `getByText("复制会话")` 子串同时命中「复制会话文件路径」 | 加 `exact: true` |
| 2026-11-14 | `terminal-first-open`（3 条） | 会话操作菜单从 Tab 栏「更多操作」并入会话头部「更多运行操作」（`SessionActionsControl`） | 定位器改到新入口；**功能本身没坏**（#333 仍可用） |

---

## `session-history-agent-states.spec.ts:53` — 流式中删除取到 idle 文案

**状态**：已知失败，`test.fail()` 标记（修好后会报「unexpectedly passed」，提醒去掉标记）。

**现象**：流式进行中删除历史消息，确认框显示 idle 变体（`删除消息会先停止 Agent…`）而不是 running 变体（`会话正在运行。删除消息会先停止 Agent…`）。功能本身正常（能停、能删），只是**文案口径偏保守**。

**已排除的三层**（都有实测）：

| 层 | 结论 | 证据 |
|---|---|---|
| 主进程 → preload → 渲染层的桥 | ✅ 通 | 窗口内直接订阅 `sessions.onRuntimeEvent`，流式中收到 7 条 `agents:runtime-state`、17 条 `agents:text-stream` |
| `runtimeStateReader.emitRuntimeState` 全量快照覆盖 `isStreaming` | ✅ **已修**（`6a3365610`） | 原来只给工具字段保留本地真值，`get_state` 不返回流式标志 → 每次刷新把 50ms 节流补丁的 `true` 打回 `false` |
| `replaceSessionRuntimesAtom` 列表快照覆盖 live 状态 | ❌ 不是它 | 整段时间只写一次，且写之前 atom 已经是 `idle` / `isStreaming=false` |

**当前卡点**：点删除那一刻，插桩打印的四路数据**全部指向空闲**——

```
{rStatus:"idle", streaming:false, turn:false, agentStatus:"idle", send:undefined}
```

而**同一时刻** composer 按钮是「停止」、时间线在流式输出。能显示「停止」的只有
`useSessionRuntimeController.isAgentBusy`：

```ts
isAgentBusy = hasActiveConversation && (activeConversationStatus === "running" || activeRuntimeState?.isStreaming)
// currentSessionRuntime 来自 sessionRuntimeBySessionIdAtomFamily(sessionKey)
// sessionKey = boundSessionIdOption ?? focusedSessionId
```

**头号嫌疑**：`boundSessionIdOption`（分栏绑定会话）与 `focusedSessionId`（聚焦会话）不是同一个 —— composer 读的是「在跑的那个」，`isAgentCurrentlyBusy()` 读的是「聚焦的那个」。

**下一步**：在 `useSessionRuntimeController` 里措桩打印 `sessionKey / currentSessionRuntime / activeRuntimeState`，与删除流程的 `currentSessionId` 对比；
若确认两者不同，则让 `isAgentCurrentlyBusy` 与 composer 同源（注入 controller 的 `isAgentBusy` 或读同一 `sessionKey`）。

**为排查做过的临时改动**（均已回退，无遗留）：`stopIfRunning` 后等待运行时解绑、`isTurnActive` 判据、agent tab status 判据。

### 同一 spec 的另外三条（未标记，仍红）

| 用例 | 现象 | 判定 |
|---|---|---|
| `after agent crash: delete and edit apply directly…` | `countOccurrences(reply1)` 期望 0 实际 1：崩溃后删除没落到时间线 | 疑似与「崩溃后 runtime target 解绑」时序有关，未查 |
| `never-started session: delete confirms, edit applies directly…` | 预置项目行（`pideck-seed-never-started-history-*`）30s 内没渲染出来 | 种子/扫描问题，与侧栏结构相关 |
| `content-area loading overlay › never-started session…` | 同上，预置项目行未出现 | 同上 |

这三条与「流式中删除」无关，属全量体检里 40 条的一部分，按集群下一轮处理。
