# AgentManager 拆分计划

> 状态：**主体完成（Wave 1–4 全部落地）**。基线 commit `ef049e045`，AgentManager.ts 6756→5543 行（红线 400/600 的 11 倍→9 倍）。
> 长期目标：AgentManager 只保留「编排 + agents map 所有权」，各状态机域收口为协作者模块。

## 拆分纪律

- 每波一个域，独立可验证：typecheck + 该域契约测试 + 引用扫描（`grep -rln "AgentManager.ts" tests/` 共 62 个文件，改动方法所属域的测试必须同步改 readFileSync 目标与断言形态）。
- 协作者不反向 import AgentManager；依赖全部经构造注入（回调用窄接口）。
- 行为零变化：纯搬家 + 委托，命名保持，注释随迁。

## Wave 1（本次）：四个低耦合状态机域

| 域 | 新模块 | 迁出内容（AgentManager 行号） | 接线点 |
|----|--------|------------------------------|--------|
| RPC 实时日志广播 | `src/main/pi/rpcLiveLogTap.ts` | enqueueLiveRpcLog/flushLiveRpcLogs/dropPendingLiveRpcLogs/setRpcLogging/isRpcLogging/setRpcLogWatching + 4 字段 + 3 常量（3833-3909） | handleModelTrace 722、attachPiProcessLifecycle 4138、stop 3947-3949、stopAll 4047-4052 |
| 流式性能计时 | `src/main/pi/messagePerfTracker.ts` | ensurePerfTimer/markFirstDelta/markFirstText/settleMessagePerf + 3 字段（messagePerfByAgent/promptRequestedAtByAgent/lastPerfByAgent，5394-5474） | sendPrompt 1894、getRuntimeState 2622、clearAgentState 3289-3290、handlePiEvent 各 mark 点 |
| abort 流闸与升级 | `src/main/pi/abortStreamGateController.ts` | getStreamGate/seal/open/noteSettled/scheduleFallback/escalateAbortIfStillRunning/clearFallback/isSealed + 3 字段（streamGates/abortSettledFallbackTimers/pendingAbortEscalations，6328-6461） | abort() 2132-2155、agent_start 4557-4560、settled 4830、clearAgentState/clearStreamGate 3293/3310、stopAll 4044 |
| rewind 自动打点 | `src/main/pi/RewindCheckpointCoordinator.ts` | bumpRewindTurn/scheduleRewindCheckpoint/runRewindCheckpoint/maybePruneCurrent/Old/activeSessionIdsForRoot/recordRewindHealth + 4 字段（3606-3812） | clearAgentState 3305-3310、listCheckpoints 3528（health 读取）、agent_start 4947+（bump+prune）、tool_execution_end（schedule） |

`clearStreamGate` 保留在 AgentManager（它同时清 thinkingEmitter/messageFlush，跨域编排），内部调 controller.clear()。
`rewindHostRoot` 保留在 AgentManager（依赖 wslEnvironment 实例态），以回调注入协调器。

## 受影响契约测试（Wave 1 必改）

- tests/rpcLogViewer.test.mjs（LIVE_RPC_LOG 常量、enqueue 形态、setRpcLogWatching）
- tests/agentPerfMetrics.test.mjs（ensurePerfTimer/markFirstDelta/settleMessagePerf 形态、promptRequestedAt）
- tests/abortStreamRegression.test.mjs（escalateAbortIfStillRunning 存在性）
- tests/abortWslResilience.test.mjs（escalateAbortIfStillRunning 方法体全文扫描）
- tests/agentSettledContract.test.mjs（isAbortSettled 组合条件：recentlyAborted + abortSettledFallbackTimers）

## 远期 Wave（不在本次，后续会话）

- Wave 3：assistant 消息装配域（handleAssistantMessageEvent/upsert* 家族，~900 行，最深耦合）
- Wave 4：启动诊断队列、UI 请求/信任域、进程生命周期挂接（attachPiProcessLifecycle ~450 行）

> **Wave 2 已于同会话提前完成**（2027-02）：`src/main/pi/messageEmitBatcher.ts`（165 行）收口 flush 节流/脏标记/窗口游标/待发滑出/增量 payload 构造；AgentManager 6756→6185 行，提前达成 ≤6200 门禁；薄包装（schedule/flush/cancel/markDirtyFrom + trimRuntimeCache 调 enqueueSlideOut/displayWindowStartByAgent）保持调用点与契约测试形态。
>
> **Wave 3 已于同会话完成**（2027-02）：`src/main/pi/liveStreamChannel.ts`（267 行）收口 thinking/正文双通道缓冲、LatestByKeyEmitter 节流推送、增量基准与思考段生命周期；AgentManager 保留装配/终态写入。
>
> **Wave 4 已于同会话完成**（2027-02）：`src/main/pi/startupDiagnosticsQueue.ts`（151 行，启动期诊断暂存/首 run 落盘/扩展禁用与白名单跳过提示）、`src/main/pi/projectTrustGate.ts`（151 行，trust.json 决策/弹窗/60s 超时）、`src/main/pi/extensionUiGate.ts`（349 行，提问分发/ANSI 净化/pending 跟踪/30min 超时兜底/ask 等待结算/auto-title marker）。attachPiProcessLifecycle 保留在 AgentManager：它是事件→编排的接线层，抽出只会造就大而空的转发接口，风险大于收益（门禁已达成，无行数压力）。AgentManager 6756→5543 行。

## 门禁

- [x] Wave 1+2 完成后 AgentManager ≤ 6200 行（实际 6185），typecheck + 上表 5 测试 + abortStream/agentManager* 相关域测试全绿（13 文件 133/133）
- [x] 每域搬家后 `grep -rn "this\.<字段名>" AgentManager.ts` 归零（字段随域走；行为测试改经 messageEmit 公开面注入）
