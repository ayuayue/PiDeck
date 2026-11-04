# ACP 重放卡顿：增量投递与分批方案

> **Status: Active plan（2026-11-04；未实现）**
> 现象：ACP 历史会话激活（`session/load` 重放）完成后页面卡一下；pi 较轻、ACP 明显。输入框丢焦点的问题已单独修掉（`81be1791b`），本文只处理「卡一下」。
> 方法沿用 `docs/agent-manager-split-plan.md` 的纪律：每阶段行为可验证、可独立上线、失败可单点回滚。

## 1. 结论先说

**卡点不是「IPC 条数太多」。** ACP 重放期已经抑制了增量 flush，握手结束时只投递一次全量（§2）。真正的成本是：

1. **一次投递的体量**——整段历史（最多 2000 条 / 8MiB 归档上限）作为一个 payload 结构化克隆进渲染进程；
2. **渲染层对 N 条做的全量工作**——`stabilizeRuntimeMessageIds` / `carryPendingUserMessages` / `reconcileRuns` 都是 O(N)，且 ACP 走的是「无 `upsertFrom`、无 `windowStart`」的全量分支；
3. **同一套渲染层，两套协议**——pi 早就换成了「增量尾部 + 窗口化 + 工具结果裁剪」，ACP 没有（§3）。

所以方案不是「再加一层节流」，而是**让 ACP 复用 pi 已有的投递协议**，把「一次性全量」拆成「窗口 + 增量」；分块投递只在测量证明还不够时才做。

## 2. 现状链路（证据）

```
session/load 请求
  └─ agent 先经 session/update 重放历史（ACP 规范）
       └─ AcpUpdatePipeline.handleSessionUpdate
            └─ if (runtime.reloading) return;   // ← 重放期完全不 flush（AcpUpdatePipeline.ts:90）
  └─ load 响应返回，握手收尾
       └─ AcpAgentManager.bootstrapRuntime
            └─ updates.flushMessages(runtime, true)  // ← 唯一一次投递（AcpAgentManager.ts:598）
                 └─ emit("agents:message", { messages: 全量数组, totalLength })  // AcpUpdatePipeline.ts:160
```

渲染层收到后的全量分支：`src/renderer/src/atoms/session-atoms.ts:1672` 起，`upsertFrom`/`windowStart` 缺失 → 走「窗口化全量 / 传统全量」替换路径。

**推论**：重放的 IPC 次数已经是 1，再谈「合并事件」没有收益；要减的是一次事件的**内容**和渲染层对它的**处理量**。

## 3. 与 pi 的协议差距

| 能力 | pi | ACP | 影响 |
|---|---|---|---|
| 增量尾部 `upsertFrom` | ✅ `buildMessageFlushPayload`（`src/main/pi/agentUtils.ts:136`） | ❌ 每次全量 | 长回合流式期间每 80ms 重传整段历史 |
| 窗口化 `windowStart` + 历史分页 | ✅ 尾部 9 轮 + 磁盘轮次分页 | ❌ 全量 | 激活即克隆全史 |
| 工具结果裁剪 `stripToolResultForDelivery` | ✅ `agentUtils.ts:191` | ❌ | 大工具输出随每次 flush 反复过 IPC |
| flush 节流 | 50ms + `MessageEmitBatcher` 合批 | 80ms 单定时器 | 次要 |

注意：ACP 的**分页读取能力已经具备**——`sessions.messages(before, pageSize)` 对 ACP 走 `acpMessagePage`（`src/main/ipc/sessionIpc.ts:1638`、`src/main/index.ts:6672`），时间线的「加载更早」可直接复用。缺口在**投递端不窗口化**。

## 4. 分阶段方案

### Phase 0：测量（✅ 已实现，待采样）

行为零改动，只加可开关的埋点。

**主进程** — `src/main/perf/messageFlushMeter.ts`（对齐 `RemoteCallMeter` 的纪律：内存 only、有界、默认静默）：

- 三个 `agents:message` 投递点统一走 `emitAgentMessageMeasured(backend, agentId, payload, emit)`：ACP `AcpUpdatePipeline.flushMessages`、pi `AgentManager` 的 `emitMessageFlush`、DSH `DshAgentManager.emitMessages`（后两者是 ACP 的对照基线）。
- 记录 `{ backend, agentId, delivered, total, bytes, upsertFrom?, windowStart?, emitMs }`；关闭时只多一次布尔判断，**不算 JSON 体积**。
- 单个 payload ≥ 256KB 立即打一行 `flush-large …`（正是重放卡顿要找的投递）；另有每 5s 一行 `flush-meter <backend> flushes=… maxBytes=… windowed=x/n incremental=x/n maxEmitMs=…` 汇总。
- 输出走主进程 console。

**渲染层** — `src/renderer/src/utils/perfProbe.ts`：

- `PerformanceObserver({ entryTypes: ["longtask"] })` 记录 >50ms 的任务，每 5s 一行汇总；经 `writeRuntimeLog` 落到应用日志文件，导诊断时能一起带出来。

**采样方法**

```bash
# 主进程数字（payload 体积/条数/emit 耗时）
PIDECK_PERF_LOG=1 npm run dev
```

渲染层数字默认关闭，DevTools 里执行一次后重载窗口：

```js
localStorage.setItem("pideck:perf-log", "1")
```

**产出**：同一条会话分别在 ACP / pi / DSH 下激活，记录 `maxBytes` / `maxDelivered` / `windowed` / `incremental` 与最长 longtask，填下表：

| backend | 历史条数 | 激活时 maxBytes | 投递条数 | windowed | 最长 longtask |
|---|---|---|---|---|---|
| acp | | | | | |
| pi | | | | | |
| dsh | | | | | |

**门禁**：若 ACP 实测 payload < 256KB 且最长任务 < 50ms，则本方案降级为「不做」，把资源投向别处。这是防止为了一个观感问题做跨进程改造的止损点。

#### 0.1 已采样：payload 侧（2026-11-04，本机 40 条真实 ACP 会话归档）

用 `%APPDATA%/PiDeck/acp-sessions/*.json` 复算 `flushMessages` 的实际载荷（同形对象 + JSON 体积），**渲染侧 longtask 尚未采**（需要真机跑一次，见上文开关）。

| 口径 | 超 256KB 的会话 | p50 | p90 | max |
|---|---|---|---|---|
| 现状（全量、含工具结果） | 34 / 40 | 1.86MB | 3.70MB | **7.58MB** |
| + `stripToolResultForDelivery` | 32 / 40 | 1.46MB | 2.88MB | 4.26MB |
| + 尾部 **9 轮**窗口 | 31 / 40 | 1.12MB | 2.26MB | 4.26MB |
| + 尾部 **100 条**窗口 | 10 / 40 | 0.21MB | 0.28MB | 0.39MB |
| + 尾部 200 条窗口 | 32 / 40 | 0.41MB | 0.60MB | 0.78MB |

两个结论直接改写了下文方案：

1. **payload 门禁已被击穿**：34/40 超过 256KB，p90 3.7MB、最大 7.58MB。改造值得做。
2. **「尾部 N 轮」窗口对 ACP 几乎无效**（31/40 仍超标）。原因：ACP 一轮里每次工具调用都是一条消息，单轮可达 200+ 条（本机最长 1283 条 / 6 轮）。pi 的 9 轮窗口口径在 ACP 上不成立，**必须改成按消息条数预算**（100 条 ≈ 0.21MB），并对齐轮边界避免把一轮切两半。

### Phase 1：剥离工具结果（低成本，但**不足以单独收口**）

1. 把 `buildMessageFlushPayload` / `stripToolResultForDelivery` 从 `src/main/pi/agentUtils.ts` 提到 `src/main/agents/messageFlushPayload.ts`（纯函数，零依赖），pi 侧改为从新位置导入——**行为零变化**，只是搬家。
2. `AcpUpdatePipeline` 维护 `dirtyFrom`（与 pi 的 batcher 同语义：投影改动的最早下标），`flushMessages` 用它构造 payload：
   - 有 `dirtyFrom` → 只发尾部切片 + `upsertFrom` + `totalLength`；
   - 终态 / 编辑 / 删除 / 截断 / 重载 → 仍然全量（与 pi 同一条回退规则）。
3. 投递前统一走 `stripToolResultForDelivery`（大工具输出不进 IPC，渲染层按需从快照取）。

**收益**：实测 −19%~−51%（p50 1.86MB → 1.46MB）。**但 32/40 仍超 256KB**——剥离只能减重，不能收口，所以不单独作为修复阶段，直接并入 Phase 2 的载荷构造点（同一处代码，一行的事）。
**保留价值**：`upsertFrom` 增量（Phase 1 的另一半）与重放无关，它治的是**长回合流式期间每 80ms 重传整段历史**。那是一个独立的性能问题，建议单独排期，不阻塞重放修复。
**风险**：`upsertFrom` 与渲染层合并校验（长度必须等于 `totalLength - W + cardCount`）不满足时会丢弃并等下一次全量——表现是「本轮显示延迟」而非错乱，pi 已经这样跑了两个大版本。
**验证**：`tests/acpUpdatePipeline`（新增：dirtyFrom 传播、终态全量、工具结果裁剪）+ 渲染层既有 `sessionMessageUpsert` 回归；e2e 用 mock ACP 回放一条 200 条历史。

### Phase 2：重放窗口化 + 归档分页（中风险，Phase 1 不够时做）

重放终态那次全量仍然 O(N)。改成**按消息条数预算的窗口投递**（不是 pi 的「尾部 N 轮」，理由见 §0.1）：

1. 主进程从尾部按**轮边界**向前累加，直到「≥100 条 或 ≥9 轮」即停（取先到者），只投递 `[windowStart..]` + `totalLength`；窗口必须停在轮起点，不把一轮切两半（切了工具卡会缺上下文）；
   - 100 条是实测值：p50 0.21MB / p90 0.28MB / max 0.39MB；若后续要求更严可下调到 60 条；
2. 渲染层已有的 `windowStart` 分支和「加载更早」分页直接生效（ACP 的 `sessions.messages` 已支持）；
3. **必须补版本守卫**：pi 用 `fileVersion`（会话文件 mtime:size）判断「磁盘前缀是否还属于同一份历史」；ACP 没有会话文件，需要等价物——用归档的 `mtime:size`（`AcpSessionArchive`）或投影代次作为 `archiveVersion`，版本不符时丢弃已加载的前缀并重新分页。
   - 为什么必须：CLI 侧可能压缩/改写过历史，归档副本与重放结果不一致时，前缀会和新窗口拼出「同一段对话两遍」。

**风险**：窗口化把「权威历史（CLI 重放）」和「本地归档副本」拼在一起，版本守卫写错就是重复/错位消息。**这是本方案唯一真正危险的一步**，建议单独一个 PR、单独回滚开关（`settings.acpWindowedReplay`，默认关 → 灰度）。

### Phase 3：分块投递（兜底，仅在 Phase 2 后仍超标时做）

Phase 2 的窗口预算会把 31/40 的超标会话压到 10/40；剩下的是「单轮就超过 100 条」的会话（本机最长一轮 ~200 条）。这类会话没有合法窗口能既保住整轮又保住体积，只能分块：

重放期不一次性 flush，而是每积累 K 条（建议 50）或每 16ms 投递一次增量块：

- 复用 Phase 1 的 `upsertFrom` 协议，渲染层无新代码；
- 代价：渲染次数变多（每次仍只挂 3 轮 DOM），收益随历史长度线性增长；
- 必须保序：仍在 `runtime.updateChain` 里按序 flush，末块之后补一次终态全量校准。
- 观感上还要处理「历史在长出来」：ACP 恢复条（`SessionAcpRestoreStrip`）已经是加载态，保持到末块投递完成即可，不需要新 UI。

### Phase 4：渲染层预算（可选，与后端无关）

- `reconcileRuns` / `stabilizeRuntimeMessageIds` 做一次性 O(N) 归并，改成按窗口段处理；
- 首帧只挂窗口内 3 轮（已是现状），确认 ACP 激活后没有被 `browse pin` 撑成全量。

## 5. 不变量

1. **CLI 重放仍是权威历史**；任何窗口化/分页都不得让本地归档冒充权威。
2. **不丢消息**：增量协议的失败路径只能是「等下一次全量校准」，不允许静默跳过。
3. **不新增 pi↔PiDeck 通道**：全部改动在既有 `agents:message` 载荷字段内（`upsertFrom`/`totalLength`/`windowStart` 已是既有协议）。
4. **pi 行为零变化**：Phase 1 的搬家（若做）必须是纯位移，`tests/agentManagerRuntimeCache` 等既有用例不改断言。

## 6. 验收

| 指标 | 目标 |
|---|---|
| 激活窗口内主线程最长任务 | < 50ms（200 条历史）/ < 100ms（1000 条） |
| 单次 `agents:message` payload | < 256KB（窗口化后与历史长度无关） |
| 流式期间每秒 flush 字节数 | 与历史长度无关（只随本轮增量增长） |
| 重放后消息顺序/条数 | 与 CLI 侧一致，无重复、无缺失（e2e 断言） |

## 7. 顺序与依赖（按实测调整）

```
Phase 0 采样（payload ✅ / longtask 待真机）
   └─ payload 34/40 超标 → 直接做 Phase 2（窗口化 + 顺带剥离工具结果）
        └─ 复测 ──┬─ ≤256KB → 结束
                  └─ 仍超标（单轮 >100 条的会话）→ Phase 3 分块投递
Phase 1 的增量 upsertFrom：独立性能项（长回合流式），单独排期，不阻塞上面
```

为什么不再是「Phase 1 → Phase 2」：实测剥离只把 p50 从 1.86MB 降到 1.46MB（32/40 仍超标），
单独做 Phase 1 拿不到任何可感知的改善；而它要改的载荷构造点与 Phase 2 完全重合，并进去即可。
