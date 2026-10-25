// 契约测试：实时 RPC 日志面板（RpcLogPanel，右侧抽屉 rpcLog 临时面板）+ 主进程实时广播链路。
// 覆盖：
// 1) 渲染层性能红线：内存封顶 + 无筛选窗口化渲染 + 行 memo + 订阅退订 + 滚动高度链；
// 2) 主进程批量节流广播（~80ms 聚合）与退出清理；
// 3) 环形缓冲扩容（初始历史）与 data 截断、保存合并去重；
// 4) IPC 边界：get-live / save（输入校验与条数上限，保存直写自动文件）/ preload 订阅；
// 5) 抽屉承载语义：不参与项目持久化、关闭还原打开前的面板；
// 6) 开启自动打开 + 活动栏 rpcLog 专属 Tab（镜像 atom 门控显隐）；
// 7) DSH 实时广播：RpcLogLiveBroadcaster 镜像 pi 语义，IPC 观看登记按 backend 分流。
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const viewer = readFileSync("src/renderer/src/components/workspace/RpcLogPanel.tsx", "utf8");
const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const rpcLiveLogTap = readFileSync("src/main/pi/rpcLiveLogTap.ts", "utf8");
const rpcLogger = readFileSync("src/main/logging/RpcLogger.ts", "utf8");
const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const sidebarParts = readFileSync("src/renderer/src/components/sidebar/SidebarParts.tsx", "utf8");
const sidebarContent = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
const ipc = readFileSync("src/shared/ipc.ts", "utf8");

test("viewer caps total entries and windows the unfiltered render", () => {
	assert.match(viewer, /const MAX_ENTRIES = 3000;/);
	assert.match(viewer, /const WINDOW_UNFILTERED = 800;/);
	// 无筛选时只渲染最近一段；筛选态放开到全部命中
	assert.match(viewer, /renderedEntries = hasActiveFilter\s*\? visibleEntries\s*: visibleEntries\.slice\(-WINDOW_UNFILTERED\)/);
	// 窗口化提示：条数超过窗口时告知用户可用搜索/筛选查看全部
	assert.match(viewer, /rpc\.windowHint/);
});

test("viewer rows are memoized and entry merge dedupes and caps", () => {
	assert.match(viewer, /const RpcLogRow = memo\(/);
	// mergeLogEntries：按 id 去重、时间升序、封顶 MAX_ENTRIES（内存有界）
	assert.match(viewer, /export function mergeLogEntries/);
	assert.match(viewer, /merged\.sort\(\(a, b\) => a\.time - b\.time\)/);
	assert.match(viewer, /merged\.length > MAX_ENTRIES/);
	// 每批都全量 sort 是纯浪费（实时追加天然升序）：先线性扫描确认有序，乱序才排
	assert.match(viewer, /let ordered = true;[\s\S]{0,160}if \(!ordered\) merged\.sort/);
});

test("row memo actually works: stable toggle callback, no inline arrow per row", () => {
	// 回归：`onToggle={() => handleToggleEntry(log)}` 每次都生成新函数 ⇒ memo 的 props 恒不相等，
	// 每批新日志都要重渲染全部窗口内行（日志量大时直接卡顿）。回调必须是稳定引用。
	assert.match(viewer, /onToggle=\{handleToggleEntry\}/);
	assert.doesNotMatch(viewer, /onToggle=\{\(\) => handleToggleEntry\(log\)\}/);
	assert.match(viewer, /const handleToggleEntry = useCallback\(\(log: RpcLogEntry\) => \{/);
	// 行内自己绑定 log
	assert.match(viewer, /onClick=\{\(\) => onToggle\(log\)\}/);
});

test("search haystack is cached per entry instead of re-stringifying every batch", () => {
	// 每批新日志都会重跑筛选：无条件 formatRpcLogForCopy(log) 等于对最多 MAX_ENTRIES 条
	// 重新 JSON.stringify 整个 data，是流式阶段最大的 CPU 开销之一。
	assert.match(viewer, /const searchHaystackCache = new WeakMap<RpcLogEntry, string>\(\);/);
	assert.match(viewer, /searchHaystackCache\.set\(log, built\)/);
	assert.match(viewer, /return searchHaystack\(log\)\.includes\(normalizedKeyword\)/);
	assert.doesNotMatch(viewer, /formatRpcLogForCopy\(log\)\.toLowerCase\(\)\.includes/);
});

test("log list follows the bottom with instant scroll, not a spring", () => {
	// smooth 弹簧逐帧写 scrollTop，每帧强制整个列表（最多 WINDOW_UNFILTERED 行）重排；
	// 日志这种高频小增量容器用 instant。
	assert.match(viewer, /<MessageScroller[\s\S]{0,400}smooth=\{false\}/);
});

test("viewer uses MessageScroller auto-scroll and cleans up the live subscription", () => {
	assert.match(viewer, /<MessageScroller/);
	assert.match(viewer, /followOutput=\{autoScroll\}/);
	assert.match(viewer, /onFollowChange=\{setFollowing\}/);
	assert.match(viewer, /window\.piDesktop\.rpcLogs\.onLog/);
	// 卸载必须退订，防止向已销毁组件持续推送
	assert.match(viewer, /unsubscribe\(\);/);
	// 用户脱离实时尾部时出现回底按钮
	assert.match(viewer, /!following && entries\.length > 0/);
});

test("viewer gives MessageScroller a full-height chain so the list can scroll", () => {
	// 回归：视口高度链断裂会导致列表被 DialogContent 裁成一屏、无法滚动。
	// MessageScroller 的 className 落在外层 div（min-h-0 之上补 h-full），
	// viewport（h-full overflow-y-auto）才能获得确定高度。
	assert.match(viewer, /<MessageScroller\s+className="h-full"/);
});

test("viewer gives toast feedback for save/copy/enable-logging operations", () => {
	// 保存：主进程返回写入的文件路径，toast 提示保存位置（单文件直接给路径，多文件给首个 + 数量）
	assert.match(viewer, /const paths = await window\.piDesktop\.rpcLogs\.save\(\{ entries: saveEntries \}\);/);
	assert.match(viewer, /rpc\.savedToFile/);
	assert.match(viewer, /rpc\.savedToFiles/);
	// 全部重复时明确告知无需保存
	assert.match(viewer, /rpc\.saveNoNew/);
	// 复制类操作（行内复制 / 复制全部 / 复制可见）统一 toast 已复制
	assert.match(viewer, /showNotice\(t\("common\.copied"\), 2000\)/);
	// 开启记录异步生效，成功/失败都 toast
	assert.match(viewer, /showNotice\(enabled \? t\("rpc\.loggingEnabled"\) : t\("rpc\.loggingEnableFailed"\), 2500\)/);
});

test("session context menu shares the unified rpc logging group", () => {
	const menu = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");
	// 会话菜单与 agent 菜单统一为同一套 RPC 项（toggle + 查看），不再有独立的“RPC 日志”入口
	assert.doesNotMatch(menu, /menu\.rpcLogs/);
	assert.doesNotMatch(menu, /onShowLogs/);
	assert.match(menu, /showRpcGroup = Boolean\(props\.canRpcLog\)/);
	assert.match(menu, /\{showRpcGroup && \(/);
	// 仅会话有 live runtime 时渲染 RPC 组（历史会话无日志可记/可看）
	assert.match(sidebarContent, /canRpcLog=\{Boolean\(menuSessionRuntimeAgent\)\}/);
	assert.doesNotMatch(sidebarContent, /onShowLogs/);
	// 会话菜单开启记录只给非阻塞 toast（与 agent 菜单同款；确认弹框已移除）
	assert.match(sidebarContent, /setLogging\(menuSessionRuntimeAgent\.id, true\)[\s\S]{0,220}showNotice\(enabled \? t\("rpc\.loggingEnabled"\)/);
});

test("agent context menu exposes a live log entry point next to the toggle", () => {
	const menu = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");
	assert.match(menu, /onOpenLogs\?: \(\) => void;/);
	assert.match(menu, /menu\.rpcLogView/);
	// 未启动（无 live runtime）的 agent：开启记录菜单项置灰并带原因 title
	assert.match(menu, /rpcToggleDisabled\?: boolean;/);
	assert.match(menu, /title=\{props\.rpcToggleDisabled \? t\("menu\.rpcLoggingRequiresRuntime"\) : undefined\}/);
	// 右键菜单已移除“打开日志文件夹”（日志自动落盘，面板内即可查看/保存）
	assert.doesNotMatch(menu, /rpcLogFile/);
	assert.doesNotMatch(menu, /openLogFile/);
	// 旧静态弹窗已从 SidebarParts 移除，不再导出
	assert.doesNotMatch(sidebarParts, /RpcLogModal/);
	// 日志面板挂在右侧抽屉：侧栏不再挂查看器组件，菜单只发打开命令
	assert.doesNotMatch(sidebarContent, /RpcLogViewer/);
	assert.match(sidebarContent, /controller\.openRpcLogs\(menuAgent\.id\)/);
});

test("rpc log panel lives in the workspace drawer as a transient panel with restore-on-close", () => {
	const panels = readFileSync("src/renderer/src/hooks/useWorkspacePanels.ts", "utf8");
	const surface = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
	const controller = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");
	// 面板类型包含 rpcLog；持久化白名单刻意不含它（绑定 agentId，跨重启必然失效）
	// 联合类型成员顺序不固定（sideTask 追加在 rpcLog 之后）：只要求 rpcLog 是成员之一。
	assert.match(panels, /export type WorkspaceDrawerPanel =[\s\S]{0,200}?"rpcLog"/);
	assert.match(panels, /const validPanel = panel === null \|\| validPanels\.includes\(String\(panel\)\);/);
	assert.doesNotMatch(panels, /const validPanels = \[[^\]]*rpcLog/);
	// 打开：记住打开前的面板且不写项目存档
	assert.match(panels, /if \(drawerRef\.current !== "rpcLog"\)\s*rpcLogPreviousPanelRef\.current = drawerRef\.current;/);
	// 关闭：还原打开前的面板；closeDrawer 也必须路由到还原（否则会把 null 落到用户的常驻面板选择上）
	assert.match(panels, /const closeRpcLogPanel = useCallback\(\(\) => \{[\s\S]{0,200}setDrawer\(previous \?\? null\);/);
	assert.match(panels, /if \(drawerRef\.current === "rpcLog"\) \{\s*closeRpcLogPanel\(\);\s*return;\s*\}/);
	// DrawerSurface 有 rpcLog 分支，且不被 files/sessions 的兜底分支吞掉
	assert.match(surface, /drawer === "rpcLog" && !drawerCollapsed/);
	assert.match(surface, /<RpcLogPanel agentId=\{rpcLog\.agentId\}/);
	assert.match(surface, /drawer !== "rpcLog"/);
	// 侧栏只发打开命令（宿主 App 把它变成抽屉面板），不再自持开关状态
	assert.match(controller, /openRpcLogViewerRef\.current\?\.\(agentId\);/);
	assert.doesNotMatch(controller, /closeRpcLogs/);
});

test("sidebar gates rpc logging toggle on a live runtime", () => {
	// 未启动的 agent 无 runtime：菜单置灰 + 点击兜底 toast 提示需运行中
	assert.match(sidebarContent, /menuAgentCanRpcLog/);
	// agent 菜单按 agentId 反查 runtime（AgentTab.sessionId 是 pi 自身会话 id，非 runtime key）
	assert.match(sidebarContent, /getBoundSidebarRuntimeAgentByAgentId\(controller\.catalog, menuAgent\.id\)/);
	assert.match(sidebarContent, /rpcToggleDisabled=\{!menuAgentCanRpcLog\}/);
	assert.match(sidebarContent, /menu\.rpcLoggingRequiresRuntime/);
	// 兜底分支：置灰点击不触发 onSelect，这里防御状态在菜单打开期间变化
	assert.match(sidebarContent, /if \(!menuAgentCanRpcLog\) \{\n\s+showNotice\(t\("menu\.rpcLoggingRequiresRuntime"\), 2500\);/);
});

test("panel loads are keyed on agentId only and survive a dead agent", () => {
	// 载入器 props 每次 App 渲染都换新引用（App 的 sidebarActions 未 memo）：一旦进 effect 依赖，
	// 流式期间每个渲染都会退订重订 + 重发 getLive/getLogging IPC。改回 props 直接依赖即回归。
	assert.match(viewer, /const loadersRef = useRef\(\{ loadHistory: props\.loadHistory, getLogging: props\.getLogging \}\);/);
	assert.match(viewer, /loadersRef\.current = \{ loadHistory: props\.loadHistory, getLogging: props\.getLogging \};/);
	assert.match(viewer, /\},\s*\[agentId\]\);/);
	assert.doesNotMatch(viewer, /\}, \[agentId, props\.loadHistory, props\.getLogging\]\);/);
	// 关闭 Agent 后面板仍留在抽屉里：主进程拒绝 getLive/getLogging，面板按“暂无历史”处理，
	// 不得把 SessionCommandIpcError 冒成未处理异常 toast（2026-09 UI 冒烟实测）
	assert.match(viewer, /\.catch\(\(\) => undefined\)/);
	assert.match(viewer, /catch \{\s*showNotice\(t\("rpc\.loggingEnableFailed"\), 2500\);\s*\}/);
	assert.match(viewer, /catch \{\s*showNotice\(t\("rpc\.loggingDisableFailed"\), 2500\);\s*\}/);
});

test("AgentManager batches live log broadcast and cleans up on exit", () => {
	// 广播只发生在开启记录的 agent 上：落盘与实时推送同一闸门
	// （实时广播域 2026-03 收口到 RpcLiveLogTap，AgentManager 只保留调用点）
	assert.match(agentManager, /if \(this\.rpcLiveTap\.isLogging\(agentId\)\) \{[\s\S]{0,120}this\.rpcLiveTap\.enqueue\(this\.rpcLogger\?\.push\(logEntry\) \?\? logEntry\);/);
	// 广播用环形缓冲里那份截断副本（与 getLive 初始历史同形），原始大 payload 不跨进程克隆
	assert.match(agentManager, /rpcLiveTap\.enqueue\(this\.rpcLogger\?\.push\(/);
	// 节流常量：~80ms 聚合一批，单批与缓冲都有上限（防止 IPC/内存失控）
	assert.match(rpcLiveLogTap, /FLUSH_MS = 80/);
	assert.match(rpcLiveLogTap, /MAX_BATCH = 100/);
	assert.match(rpcLiveLogTap, /MAX_PENDING = 1000/);
	// 单批超限的条目留到下一轮，不丢日志
	assert.match(rpcLiveLogTap, /if \(rest\.length > 0\) \{\n\t+this\.pendingByAgent\.set\(agentId, rest\);/);
	// 生命周期配对：stopAll dispose 定时器与聚合缓冲，agent 关闭丢弃该 agent 的待发缓冲
	assert.match(agentManager, /this\.rpcLiveTap\.dispose\(\);/);
	assert.match(agentManager, /this\.rpcLiveTap\.clearAgent\(agentId\);/);
	assert.match(rpcLiveLogTap, /clearTimeout\(this\.flushTimer\)/);
});

test("broadcast is gated on a renderer viewer, not just on logging being enabled", () => {
	// 面板没打开时，每 80ms 一批无人认领的日志照样要在主进程做结构化克隆再发 IPC，
	// 表现为整个应用（输入、流式）掉帧。观看状态由面板挂载/卸载成对登记。
	assert.match(rpcLiveLogTap, /private readonly watchingAgents = new Set<string>\(\);/);
	assert.match(rpcLiveLogTap, /enqueue\(entry: RpcLogEntry\): void \{[\s\S]{0,240}?if \(!this\.watchingAgents\.has\(entry\.agentId\)\) return;/);
	assert.match(rpcLiveLogTap, /setWatching\(agentId: string, watching: boolean\): void \{/);
	// 生命周期配对：agent 关闭（clearAgent）+ stopAll（dispose）都要清观看登记
	assert.match(rpcLiveLogTap, /this\.watchingAgents\.delete\(agentId\);/);
	assert.match(rpcLiveLogTap, /this\.watchingAgents\.clear\(\);/);
	// 面板侧：挂载登记 true，卸载登记 false（与退订同一清理路径）
	assert.match(viewer, /window\.piDesktop\.rpcLogs\.setWatching\(agentId, true\)\.catch\(\(\) => undefined\)/);
	assert.match(viewer, /return \(\) => \{[\s\S]{0,160}window\.piDesktop\.rpcLogs\.setWatching\(agentId, false\)/);
	// IPC 三处同步：通道常量 + main handler + preload
	assert.match(ipc, /rpcLogsSetWatching: "rpc-logs:set-watching"/);
	assert.match(systemIpc, /ipcMain\.handle\(ipcChannels\.rpcLogsSetWatching/);
	assert.match(systemIpc, /agentManager\.setRpcLogWatching\(agentId, watching\)/);
	assert.match(preload, /setWatching: \(agentId: string, watching: boolean\) => ipcRenderer\.invoke\(ipcChannels\.rpcLogsSetWatching/);
});

test("RpcLogger keeps a larger live ring buffer with filtered getLive and data truncation", () => {
	assert.match(rpcLogger, /const MAX_LIVE = 1000;/);
	assert.match(rpcLogger, /getLive\(agentId\?: string\)/);
	assert.match(rpcLogger, /this\.live\.filter\(\(entry\) => entry\.agentId === agentId\)/);
	// 实时缓冲副本截断大 data，文件仍写原始内容
	assert.match(rpcLogger, /private truncateForLive\(entry: RpcLogEntry\)/);
	// 落盘合并写入：行进缓冲，满水位或定时才整批 appendFile（逐条写 = 每秒上百次文件系统调用）
	assert.match(rpcLogger, /private queueWrite\(entry: RpcLogEntry\) \{/);
	assert.match(rpcLogger, /async flushPending\(\): Promise<void> \{/);
	assert.match(rpcLogger, /await appendFile\(filePath, lines\.join\(""\), "utf8"\)/);
	assert.match(rpcLogger, /this\.queueWrite\(entry\);/);
	assert.doesNotMatch(rpcLogger, /private async writeEntry\(/);
	// push 返回缓冲里那份截断副本，供主进程广播使用（原始大 payload 不跨进程克隆）
	assert.match(rpcLogger, /push\(entry: RpcLogEntry\): RpcLogEntry \{/);
	assert.match(rpcLogger, /return liveEntry;/);
	// 保存/清空之前必须先刷缓冲，否则去重读不到未落盘的自动日志（写出重复行 / 清空不生效）
	assert.match(rpcLogger, /async appendEntries[\s\S]{0,140}await this\.flushPending\(\);/);
	assert.match(rpcLogger, /async clear\(agentId\?: string\): Promise<void> \{[\s\S]{0,140}await this\.flushPending\(\);/);
	assert.match(rpcLogger, /private filePathFor\(entry: RpcLogEntry\)/);
	assert.match(rpcLogger, /private async readEntryIds\(filePath: string\)/);
});

test("退出清理把日志缓冲刷出排在建会话进程停止之后", () => {
	const mainIndex = readFileSync("src/main/index.ts", "utf8");
	assert.match(mainIndex, /quitCleanup\.register\("rpc-logs-flush", \(\) => rpcLogger\?\.flushPending\(\)\);/);
	// QuitCleanupRegistry.runAll 按登记顺序执行：pi-agents 必须在前（停进程时还会产生最后几条日志）
	const piAgentsAt = mainIndex.indexOf('quitCleanup.register("pi-agents"');
	const flushAt = mainIndex.indexOf('quitCleanup.register("rpc-logs-flush"');
	assert.ok(piAgentsAt >= 0, "pi-agents 清理登记应存在");
	assert.ok(flushAt > piAgentsAt, "刷日志缓冲必须排在停止 agent 之后，否则最后几条会丢");
});

test("systemIpc validates save payloads and merges into the auto file", () => {
	assert.match(systemIpc, /rpcLogsGetLive/);
	assert.match(systemIpc, /rpcLogsSave/);
	assert.match(systemIpc, /function isRpcLogEntry\(value: unknown\)/);
	// 渲染层数据不可信：条数上限 + 字段校验后才写盘
	assert.match(systemIpc, /\.slice\(0, 10_000\)/);
	assert.match(systemIpc, /\.filter\(\(value\): value is RpcLogEntry => isRpcLogEntry\(value\)\)/);
	// 保存不再弹目录选择：直接合并写入该 agent 的自动日志文件，返回路径供渲染层 toast
	assert.match(systemIpc, /return rpcLogger\.appendEntries\(entries\);/);
	// “打开日志文件夹”入口与保存目录选择均已从主进程移除
	assert.doesNotMatch(systemIpc, /rpcLogsOpenFile/);
	assert.doesNotMatch(systemIpc, /showSaveDialog/);
});

test("systemIpc rpc logging toggle fails loudly when runtime target is invalid", () => {
	// 此前 validateTarget 失败时 rpcLoggingSet 静默返回 enabled（假成功）：前端弹「已打开」
	// 提醒框、本地 Map 置位，主进程却从未开启记录 → 弹窗永远无数据。
	assert.match(systemIpc, /RPC log runtime target invalid/);
	assert.match(systemIpc, /code: error\.code/);
	// 校验失败返回 false（而非 enabled）：渲染层 .then(false) 走 showNotice(loggingEnableFailed)
	assert.match(systemIpc, /\/\/ target 校验失败时返回 false（而非 enabled）/);
	assert.match(systemIpc, /if \(!agentId\) return false;/);
	// 渲染层两个右键入口对 reject 补 catch，防止 invoke 异常造成静默无反馈
	assert.match(sidebarContent, /\.catch\(\(\) => showNotice\(t\("rpc\.loggingEnableFailed"\), 2500\)\)/);
});

test("preload exposes getLive/save/onLog with unsubscribe", () => {
	assert.match(preload, /rpcLogsGetLive/);
	assert.match(preload, /rpcLogsSave/);
	assert.match(preload, /onLog: \(callback: \(batch: RpcLogBatch\) => void\) =>/);
	assert.match(ipc, /rpcLogsGetLive: "rpc-logs:get-live"/);
	assert.match(ipc, /rpcLogsSave: "rpc-logs:save"/);
	// 保存接口只传条目（agentId 在条目内），返回写入的文件路径列表
	assert.match(preload, /save: \(options: \{ entries: RpcLogEntry\[\] \}\) =>/);
	assert.match(preload, /as Promise<string\[\]>/);
});

// ── 模型请求快照（pi-deck-model-trace → 桥 /model-trace → RPC 日志「模型」视图）──
// 覆盖：面板的模型筛选与展开回读、主进程同开关闸门与落盘、IPC 边界（含保存路径放行 model 方向）。
const modelTrace = readFileSync("src/main/logging/ModelTrace.ts", "utf8");
const traceTypes = readFileSync("src/shared/types/modelTrace.ts", "utf8");

test("viewer exposes a model filter and lazily loads full request bodies", () => {
	// 第四个筛选项：模型行与 stdio 两个方向分开看
	assert.match(viewer, /"all" \| "send" \| "recv" \| "model"/);
	assert.match(viewer, /rpc\.filterModel/);
	// 行配色与箭头对模型行单独一套（→/← 已被 stdio 两个方向占用）
	assert.match(viewer, /log-model/);
	assert.match(viewer, /trace\?\.kind === "response" \? "↓" : "↑"/);
	// 完整请求体不在条目里：展开时才按 traceId 回读，同一行只拉一次
	assert.match(viewer, /window\.piDesktop\.rpcLogs\s*\.getModelTrace\(\{ agentId: log\.agentId, traceId: trace\.traceId \}\)/);
	assert.match(viewer, /traceRequestedRef\.current\.has\(log\.id\)/);
	// 读不到（尚未落盘/已清理）与加载中各有提示，不留空白
	assert.match(viewer, /rpc\.modelLoading/);
	assert.match(viewer, /rpc\.modelTraceMissing/);
	// 失败允许重试，且不把拒绝冒成未处理异常
	assert.match(viewer, /traceRequestedRef\.current\.delete\(log\.id\)/);
});

test("AgentManager gates model traces behind the same rpc-logging toggle", () => {
	// 与 stdio 日志同一闸门：未开启记录的 agent 直接丢弃（不落盘、不广播）
	assert.match(agentManager, /private handleModelTrace\(agentId: string, trace: ModelTraceInput\): void \{[\s\S]{0,200}if \(!this\.rpcLiveTap\.isLogging\(agentId\)\) return;/);
	// 完整请求体落盘（request 才有）+ 紧凑条目走常规链路（落盘/实时广播）
	assert.match(agentManager, /if \(trace\.kind === "request"\) \{[\s\S]{0,200}this\.rpcLogger\?\.writeModelTrace\(agentId, trace\)/);
	assert.match(agentManager, /buildModelTraceLogEntry\(agentId, trace\)/);
	assert.match(agentManager, /this\.rpcLiveTap\.enqueue\(this\.rpcLogger\?\.push\(entry\) \?\? entry\);/);
	// 桥注册第三参把快照路由到 handler（token 与 UI 桥同生共死）
	assert.match(agentManager, /\(trace\) => this\.handleModelTrace\(agentId, trace\)/);
});

test("RpcLogger keeps full request bodies outside the ring buffer", () => {
	// 与 UI 桥同一 userData 根：logs/model-traces
	assert.match(rpcLogger, /new ModelTraceStore\(join\(app\.getPath\("userData"\), "logs", "model-traces"\)\)/);
	assert.match(rpcLogger, /async writeModelTrace\(agentId: string, request: ModelTraceRequestInput\): Promise<string>/);
	assert.match(rpcLogger, /async readModelTrace\(agentId: string, traceId: string\): Promise<ModelTraceRecord \| null>/);
	// 存储管理（设置页）与清空必须把快照一起算上，否则「清空日志」后磁盘仍占用
	assert.match(rpcLogger, /this\.modelTraces\.getSize\(agentId\)/);
	assert.match(rpcLogger, /this\.modelTraces\.clear\(agentId\)/);
});

test("ModelTraceStore keeps retention and per-file layout for full payloads", () => {
	// 每条请求体一个文件（tmp + rename 原子落盘），且 30 天保留 + 总量预算
	assert.match(modelTrace, /model-\$\{sanitizeId\(agentId\)\}-\$\{traceId\}\.json/);
	assert.match(modelTrace, /RETENTION_DAYS = 30/);
	assert.match(modelTrace, /MAX_TOTAL_BYTES = 256 \* 1024 \* 1024/);
	// traceId 进文件名：读写两侧都按白名单正则校验（防路径穿越）
	assert.match(modelTrace, /const TRACE_ID_PATTERN = \/\^\[A-Za-z0-9_-\]\{1,64\}\$\//);
	// 时间线条目：direction "model"，请求体只留 traceId 引用
	assert.match(modelTrace, /direction: "model"/);
	assert.match(modelTrace, /export function buildModelTraceLogEntry/);
	// 宿主侧唯一来源仍是 shared/types/modelTrace.ts
	assert.match(traceTypes, /export type ModelTraceRequestInput/);
	assert.match(traceTypes, /export type ModelTraceResponseInput/);
});

test("model trace IPC: on-demand read + save path accepts the model direction", () => {
	assert.match(ipc, /rpcLogsGetModelTrace: "rpc-logs:get-model-trace"/);
	assert.match(systemIpc, /ipcChannels\.rpcLogsGetModelTrace/);
	assert.match(systemIpc, /rpcLogger\.readModelTrace\(agentId, traceId\)/);
	// 渲染层来的参数不可信：类型校验通过才回读
	assert.match(systemIpc, /typeof options\?\.agentId === "string"/);
	// 保存路径必须放行 direction: "model"，否则模型行「面板看得见、落盘后没有」
	assert.match(systemIpc, /entry\.direction === "recv" \|\| entry\.direction === "model"/);
	assert.match(preload, /getModelTrace: \(options: \{ agentId: string; traceId: string \}\)/);
	assert.match(preload, /ipcChannels\.rpcLogsGetModelTrace/);
});

// ── 开启自动打开 + 抽屉活动栏 rpcLog 专属 Tab（默认隐藏，开启记录才显示）──
const appTsx = readFileSync("src/renderer/src/App.tsx", "utf8");
const rpcLogAtoms = readFileSync("src/renderer/src/atoms/rpc-log-atoms.ts", "utf8");
const zhCopy = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enCopy = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("logging mirror atom: setLogging 回执落地才写，无变化返回原引用", () => {
	// 镜像 atom：主进程 per-agent 开关的渲染层镜像，唯一写入方跟随 IPC 回执
	assert.match(rpcLogAtoms, /export const rpcLoggingAgentIdsAtom = atom<ReadonlySet<string>>\(new Set<string>\(\)\);/);
	assert.match(rpcLogAtoms, /export function toggleRpcLoggingAgent\(/);
	// 无变化返回原引用（jotai Object.is 比较，避免无谓重渲）
	assert.match(rpcLogAtoms, /if \(enabled \? ids\.has\(agentId\) : !ids\.has\(agentId\)\) return ids;/);
	// App 层 rpc.setLogging 包装：回执落地才写镜像（写早了会把开关失败误显示为已开启）
	assert.match(appTsx, /api\.rpcLogs\.setLogging\(target, enabled\)\.then\(\(receipt\) => \{/);
	assert.match(appTsx, /patchRpcLoggingAgentIds\(agentId, receipt\);/);
});

test("drawer rail gains a gated rpcLog tab: 默认隐藏，开启记录且 agent 存活才显示", () => {
	// 门控：镜像集合非空 + 目标 agent 仍有活跃 runtime（rpcLogTabTargetAgentId 计算）
	assert.match(appTsx, /const rpcLogTabTargetAgentId = useMemo\(\(\) => \{/);
	assert.match(appTsx, /rpcLogTabTargetAgentId[\s\S]{0,120}id: "rpcLog",/);
	assert.match(appTsx, /label: t\("drawer\.rpcLog"\)/);
	assert.match(appTsx, /icon: <ScrollText size=\{16\} \/>/);
	assert.match(appTsx, /active: drawer === "rpcLog"/);
	// 展开态点击是关闭还原（回到日志打开前的面板），不是清空 drawer
	assert.match(appTsx, /workspace\.drawer === "rpcLog" && !workspace\.drawerCollapsed[\s\S]{0,80}workspace\.closeRpcLogPanel\(\);/);
	// 文案双语同步（TranslationKey 由 zh-CN 推导，en-US 必须同步）
	assert.match(zhCopy, /"drawer\.rpcLog": "RPC 日志"/);
	assert.match(enCopy, /"drawer\.rpcLog": "RPC Log"/);
});

// ── DSH 实时 RPC 日志广播（与 pi 同面板同语义；主进程装配与分流）──
const dshManager = readFileSync("src/main/dsh/DshAgentManager.ts", "utf8");
const liveBroadcaster = readFileSync("src/main/logging/RpcLogLiveBroadcaster.ts", "utf8");
const mainIndex = readFileSync("src/main/index.ts", "utf8");

test("DSH 记录与实时广播共用同一次 push 截断结果，观看登记成对清理", () => {
	// 落盘与广播共用 RpcLogger.push 返回的截断副本（与 getLive 初始历史同形态）
	assert.match(dshManager, /const liveEntry = this\.rpcLogger\?\.push\(\{/);
	assert.match(dshManager, /if \(liveEntry\) this\.rpcLogLive\?\.enqueue\(liveEntry\);/);
	// 面板挂载/卸载成对登记；未注入广播器时静默（记录/落盘不受影响）
	assert.match(dshManager, /setRpcLogWatching\(agentId: string, watching: boolean\): void \{[\s\S]{0,80}this\.rpcLogLive\?\.setWatching\(agentId, watching\);/);
	// stop 丢该 agent 的待发缓冲；观看登记刻意保留（DSH agentId 跨 stop/attach 稳定）
	assert.match(dshManager, /this\.rpcLogLive\?\.dropPending\(agentId\);/);
});

test("RpcLogLiveBroadcaster 镜像 pi 的批量节流语义，边界有界", () => {
	// 常量与 pi AgentManager 一致：~80ms 聚合、单批 100、待发缓冲 1000
	assert.match(liveBroadcaster, /DEFAULT_FLUSH_MS = 80/);
	assert.match(liveBroadcaster, /MAX_BATCH = 100/);
	assert.match(liveBroadcaster, /MAX_PENDING = 1000/);
	// 观看闸门：面板没打开直接丢弃（落盘/环形缓冲不受影响）
	assert.match(liveBroadcaster, /if \(!this\.watchingAgents\.has\(entry\.agentId\)\) return;/);
	// 单批超限的余量留到下一轮，不丢日志
	assert.match(liveBroadcaster, /const rest = entries\.slice\(RpcLogLiveBroadcaster\.MAX_BATCH\);/);
	// clear 清登记/缓冲/在途定时器（配对清理，防泄漏）
	assert.match(liveBroadcaster, /clearTimeout\(this\.flushTimer\)/);
});

test("rpcLogsSetWatching 按 backend 分流；装配层给 DSH 注入广播器并配对清理", () => {
	// IPC 分流：DSH agent 走注入的广播器，pi 走 AgentManager 自带实时广播
	assert.match(systemIpc, /setDshRpcLogWatching\?\.\(agentId, watching\);/);
	assert.match(systemIpc, /agentManager\.setRpcLogWatching\(agentId, watching\);/);
	// 装配：广播器直发主窗口（agentsRpcLog 在 DIRECT_EMIT_CHANNELS 白名单内）；
	// 窗口销毁后静默丢弃
	assert.match(mainIndex, /new RpcLogLiveBroadcaster\(\{/);
	assert.match(mainIndex, /mainWindow && !mainWindow\.isDestroyed\(\)\) mainWindow\.webContents\.send\(channel, payload\);/);
	// 作为 DshAgentManager 末位可选依赖注入
	assert.match(mainIndex, /\(\) => mainCopy\("session\.dshUntitled"\),\s*rpcLogLiveBroadcaster,/);
	// 退出路径：stopAll 之后全量清空（观看登记 + 聚合缓冲 + 在途定时器）
	assert.match(mainIndex, /quitCleanup\.register\("dsh", async \(\) => \{[\s\S]{0,160}rpcLogLiveBroadcaster\.clear\(\);/);
});
