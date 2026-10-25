import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parsePrivateMemoryBytes, parsePsRssKb, parseTasklistMemoryKb } from "../src/main/process/pidMemoryParsers.ts";
import { buildDshHostMonitorRow, DSH_HOST_MONITOR_ROW_ID, isDshHostMonitorId } from "../src/main/process/dshHostMonitor.ts";
import { DSH_HOST_MONITOR_ID } from "../src/shared/types/processMetrics.ts";
import { formatBytes, formatMb } from "../src/shared/formatBytes.ts";

// ===== 纯函数：tasklist CSV / ps rss 解析 =====

test("parseTasklistMemoryKb: standard CSV row", () => {
	assert.equal(parseTasklistMemoryKb('"node.exe","12345","Console","1","32,456 K"'), 32456);
});

test("parseTasklistMemoryKb: no thousands separator", () => {
	assert.equal(parseTasklistMemoryKb('"pi.exe","99","Console","1","2048 K"'), 2048);
});

test("parseTasklistMemoryKb: rejects malformed rows", () => {
	assert.equal(parseTasklistMemoryKb(""), null);
	assert.equal(parseTasklistMemoryKb('"node.exe","1"'), null);
	assert.equal(parseTasklistMemoryKb('"node.exe","1","Console","1","not-a-size"'), null);
	// 非 K 单位（tasklist 不会出现，防御性）
	assert.equal(parseTasklistMemoryKb('"node.exe","1","Console","1","12 M"'), null);
});

test("parsePsRssKb: standard ps output", () => {
	assert.equal(parsePsRssKb("  123456\n"), 123456);
	assert.equal(parsePsRssKb("0\n"), 0);
});

test("parsePsRssKb: rejects empty/non-numeric output", () => {
	assert.equal(parsePsRssKb(""), null);
	assert.equal(parsePsRssKb("  \n"), null);
	assert.equal(parsePsRssKb("abc"), null);
	assert.equal(parsePsRssKb("-5"), null);
});

// ===== 纯函数：PowerShell PrivateMemorySize64 解析 =====

test("parsePrivateMemoryBytes: standard PS output (bytes)", () => {
	assert.equal(parsePrivateMemoryBytes("123456789\r\n"), 123456789);
	assert.equal(parsePrivateMemoryBytes("0\n"), 0);
});

test("parsePrivateMemoryBytes: strips BOM/whitespace/thousands separators", () => {
	assert.equal(parsePrivateMemoryBytes("\uFEFF  123,456,789 \r\n"), 123456789);
});

test("parsePrivateMemoryBytes: rejects empty/non-numeric output", () => {
	assert.equal(parsePrivateMemoryBytes(""), null);
	assert.equal(parsePrivateMemoryBytes("\uFEFF \r\n"), null);
	assert.equal(parsePrivateMemoryBytes("N/A"), null);
	assert.equal(parsePrivateMemoryBytes("-5"), null);
});

test("formatBytes: human readable units", () => {
	assert.equal(formatBytes(0), "0 B");
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(1024), "1.0 KB");
	assert.equal(formatBytes(1048576), "1.0 MB");
	assert.equal(formatBytes(1073741824), "1.00 GB");
	assert.equal(formatBytes(-1), "-");
	assert.equal(formatBytes(Number.NaN), "-");
});

test("buildDshHostMonitorRow uses a stable id and keeps full titles for hover", () => {
	const empty = buildDshHostMonitorRow({ pid: 4242, sessions: [] });
	assert.equal(empty.agentId, DSH_HOST_MONITOR_ROW_ID);
	assert.equal(empty.kind, "dsh-host");
	assert.equal(empty.pid, 4242);
	assert.equal(empty.sessionTitle, undefined);
	assert.equal(empty.sessionTitles, undefined);
	const named = buildDshHostMonitorRow({
		pid: 7,
		sessions: [{ title: "打包体积" }, { title: "  " }, { title: "外部会话" }],
	});
	// 单元格只放首个标题，完整列表走 sessionTitles，避免长串拼接被表格截断
	assert.equal(named.sessionTitle, "打包体积");
	assert.deepEqual(named.sessionTitles, ["打包体积", "外部会话"]);
	assert.equal(isDshHostMonitorId(DSH_HOST_MONITOR_ID), true);
	assert.equal(isDshHostMonitorId("agent-1"), false);
	assert.equal(DSH_HOST_MONITOR_ROW_ID, DSH_HOST_MONITOR_ID);
});

test("formatMb: fixed MB unit for process monitor", () => {
	assert.equal(formatMb(0), "0.0 MB");
	assert.equal(formatMb(1048576), "1.0 MB");
	assert.equal(formatMb(524288), "0.5 MB");
	assert.equal(formatMb(123456789), "117.7 MB");
	assert.equal(formatMb(-1), "-");
	assert.equal(formatMb(Number.NaN), "-");
});

// ===== 主进程装配：进程枚举与采样链路 =====

test("ProcessMonitor uses array-form system commands with timeout", () => {
	const source = readFileSync("src/main/process/ProcessMonitor.ts", "utf8");
	// 安全规范：命令必须数组参数，禁止字符串拼接 shell
	assert.match(source, /spawn\(args\[0\], args\.slice\(1\)/);
	// Windows 用 PowerShell PrivateMemorySize64（专用内存口径，同任务管理器），
	// Linux/macOS 用 ps -o rss；固定参数数组
	assert.match(source, /\"powershell\"[\s\S]*PrivateMemorySize64/);
	assert.match(source, /\[\"ps\", \"-o\", \"rss=\", \"-p\", String\(pid\)\]/);
	// 超时兜底：采样挂死不阻塞 IPC（超时常量作为 runCollect 第二参数传入）
	assert.match(source, /timeout: timeoutMs/);
	assert.match(source, /TASKLIST_TIMEOUT_MS/);
	// 数组元素可能独占一行：用 PS_TIMEOUT_MS 出现即可（定义处已单独断言常量存在）。
	// 实参可能被格式化换行/位置变化：只断言常量被用作超时实参。
	assert.match(source, /PS_TIMEOUT_MS\)/);
});

test("ProcessMonitor assembles agent snapshot with total", () => {
	const source = readFileSync("src/main/process/ProcessMonitor.ts", "utf8");
	// 只监控 pi agent：不再采集 Electron 自身进程（用户自行在系统任务管理器/活动监视器查看）
	assert.doesNotMatch(source, /app\.getAppMetrics\(\)/);
	assert.doesNotMatch(source, /totalElectronBytes/);
	assert.match(source, /Promise\.all\(/);
	assert.match(source, /totalAgentBytes/);
	assert.match(source, /sampledAt: Date\.now\(\)/);
});

test("AgentManager exposes listAgentPids filtered to running processes", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(source, /listAgentPids\(\): Array<\{ agentId: string; pid: number \}>/);
	assert.match(source, /runtime\.process\.pid/);
	assert.match(source, /runtime\.process\.isRunning\(\)/);
});

test("PiProcess exposes pid accessor", () => {
	const source = readFileSync("src/main/pi/PiProcess.ts", "utf8");
	assert.match(source, /get pid\(\): number \| undefined/);
	assert.match(source, /return this\.proc\?\.pid;/);
});

test("DshHostProcess and DshHost expose host pid for process monitor", () => {
	const hostProcess = readFileSync("src/main/dsh/DshHostProcess.ts", "utf8");
	const host = readFileSync("src/main/dsh/DshHost.ts", "utf8");
	assert.match(hostProcess, /get pid\(\): number \| undefined/);
	assert.match(hostProcess, /this\.child\?\.pid/);
	assert.match(host, /getHostPid\(\): number \| undefined/);
	assert.match(host, /return this\.hostProcess\?\.pid/);
});

// ===== IPC / preload / UI 接线 =====

test("IPC channel + systemIpc handler + preload exposure", () => {
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	assert.match(ipc, /processMetrics: "system:process-metrics"/);
	assert.match(systemIpc, /ipcMain\.handle\(ipcChannels\.processMetrics/);
	// handler 先按 agentId 反查会话身份（进程监控表要显示是哪个会话），
	// 再交给 getProcessSnapshot 采样内存
	assert.match(systemIpc, /getSessionInfoForAgent\(\s*agent\.agentId,?\s*\)/);
	assert.match(systemIpc, /\.\.\.agent, kind: "pi" as const, \.\.\.\(sessionInfo \?\? \{\}\)/);
	assert.match(systemIpc, /getProcessSnapshot\(agents\)/);
	assert.match(systemIpc, /getDshHostPid\?\.\(\)/);
	assert.match(systemIpc, /buildDshHostMonitorRow/);
	assert.doesNotMatch(systemIpc, /getProcessSnapshot\(deps\.agentManager\.listAgentPids\(\)\)/);
	assert.match(preload, /getProcessMetrics: \(\) =>/);
	assert.match(preload, /ipcRenderer\.invoke\(ipcChannels\.processMetrics\)/);
});

test("stop-agent: full session stop chain (coordinator + detach)", () => {
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	const coordinator = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");
	const index = readFileSync("src/main/index.ts", "utf8");
	const tab = readFileSync("src/renderer/src/components/app/settings/ProcessMetricsTab.tsx", "utf8");
	// 通道 + handler：agentId 输入校验（渲染层数据不可信），走完整会话停止链路
	assert.match(ipc, /stopAgent: "system:stop-agent"/);
	assert.match(systemIpc, /ipcMain\.handle\(ipcChannels\.stopAgent/);
	assert.match(systemIpc, /typeof agentId !== "string" \|\| !agentId/);
	// 关键：不能只调 agentManager.stop（会跳过会话状态收尾 → 运行标记不熄灭）
	assert.match(systemIpc, /deps\.stopAgentFromMonitor\(agentId\)/);
	assert.match(systemIpc, /isDshHostMonitorId\(agentId\)/);
	assert.match(systemIpc, /deps\.stopDshHostFromMonitor/);
	assert.doesNotMatch(systemIpc, /deps\.agentManager\.stop\(agentId\)/);
	// coordinator 按 agentId 反查会话 → 走 stopRuntime 完整收尾（无绑定时幂等直停）
	assert.match(coordinator, /async stopAgentById\(/);
	assert.match(coordinator, /const binding = this\.getRuntimeBinding\(agentId\);/);
	assert.match(coordinator, /await this\.stopRuntime\(target\);/);
	// index.ts 装配：成功后关终端 + detach 推送（渲染层运行标记熄灭的关键）
	assert.match(index, /async function stopAgentFromMonitor\(/);
	assert.match(index, /sessionRuntimeCoordinator\.stopAgentById\(agentId\)/);
	assert.match(index, /terminalManager\.closeAgent\(agentId\);/);
	assert.match(index, /emitSessionRuntimeDetach\(result\.value\);/);
	assert.match(index, /stopAgentFromMonitor,/);
	assert.match(index, /async function stopDshHostFromMonitor\(/);
	assert.match(index, /await dshHost\.dispose\(\)/);
	assert.match(index, /stopDshHostFromMonitor,/);
	// preload 暴露
	assert.match(preload, /stopAgent: \(agentId: string\) =>/);
	assert.match(preload, /ipcRenderer\.invoke\(ipcChannels\.stopAgent, agentId\)/);
	// 渲染层：停止确认用 shadcn ConfirmDialog（AlertDialog），不用 toast 双按钮；
	// 停止后刷新快照让该行消失
	assert.match(tab, /window\.piDesktop\.system\.stopAgent\(agent\.agentId\)/);
	assert.match(tab, /setStoppingAgent\(agent\)/);
	assert.match(tab, /<ConfirmDialog\n\s*title=\{t\("config\.process\.stop"\)\}/);
	assert.match(tab, /config\.process\.stopHostConfirm/);
	assert.match(tab, /monitorRowLabel\(stoppingAgent\)/);
	assert.match(tab, /danger\n/);
	assert.match(tab, /void stopAgent\(agent\);/);
	assert.match(tab, /await refresh\(\);/);
	assert.doesNotMatch(tab, /stopConfirm.*showNotice/s);
	// 操作列：红色（destructive）带文字按钮，紧跟 agentId 而非表格最右侧
	assert.match(tab, /CircleStop/);
	assert.match(tab, /text-destructive hover:bg-destructive\/10/);
	assert.match(tab, /size="sm"/);
	// Agent 表头列序：agentId → 会话 → PID → memory → action（操作列在最右侧，列内居中）
	assert.match(tab, /config\.process\.column\.agentId.*config\.process\.column\.session.*>PID<.*config\.process\.column\.memory.*config\.process\.column\.action/s);
	assert.match(tab, /<TableCell className="text-center">/);
	// 表头「操作」也居中，与列内按钮对齐（TableHead 默认 text-left 需覆盖）
	assert.match(tab, /<TableHead className="text-center">\{t\("config\.process\.column\.action"\)\}<\/TableHead>/);
});

test("process monitor rows show the session associated with each agent", () => {
	const tab = readFileSync("src/renderer/src/components/app/settings/ProcessMetricsTab.tsx", "utf8");
	// 会话列：标题优先；DSH 多会话用摘要 + 悬停完整列表，不再把内部 id 当 tooltip
	assert.match(tab, /sessionColumnLabel\(agent\)/);
	assert.match(tab, /title=\{sessionColumnTooltip\(agent\)\}/);
	assert.match(tab, /title=\{monitorRowLabel\(agent\)\}/);
	assert.match(tab, /config\.process\.dshSessionSummary/);
	assert.match(tab, /titles\.join\("\\n"\)/);
	assert.match(tab, /max-w-56 truncate text-text-secondary/);
	assert.doesNotMatch(tab, /title=\{agent\.agentId\}/);
	assert.doesNotMatch(tab, /title=\{agent\.sessionId\}/);
	// 主进程：会话身份由 coordinator 按 agentId 反查（同源：sessionIdByAgent + catalog）
	const coordinator = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");
	assert.match(coordinator, /getSessionInfoForAgent\(/);
	assert.match(coordinator, /sessionIdByAgent\.get\(agentId\)/);
	assert.match(coordinator, /catalog\.get\(sessionId\)/);
	// 字段名必须与 AgentProcessMetric 一致（sessionTitle）：否则展开后标题丢失，UI 回落显示 id
	assert.match(coordinator, /sessionTitle: entry\?\.title/);
	const types = readFileSync("src/shared/types/processMetrics.ts", "utf8");
	assert.match(types, /sessionId\?: string/);
	assert.match(types, /sessionTitle\?: string/);
	assert.match(types, /sessionTitles\?: string\[\]/);
});

test("ProcessMetricsTab wires table columns and refresh", () => {
	const source = readFileSync("src/renderer/src/components/app/settings/ProcessMetricsTab.tsx", "utf8");
	assert.match(source, /window\.piDesktop\.system\.getProcessMetrics\(\)/);
	// 只展示 pi agent 行；不再渲染 Electron 进程表（类型/专用内存口径均已移除）
	assert.doesNotMatch(source, /processTypeLabel/);
	assert.doesNotMatch(source, /privateBytes/);
	assert.match(source, /formatMb\(agentTotal\)/);
	assert.match(source, /t\("config\.process\.refresh"\)/);
	assert.match(source, /agent\.agentId/);
	assert.match(source, /t\("config\.process\.empty"\)/);
});

test("SettingsModal registers process tab; ConfigModal no longer hosts it", () => {
	const settings = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
	const config = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	// 进程监控已从 Pi 管理界面迁入设置：SettingsModal 以 TAB_META 注册 tab
	//（labelKey 走 i18n）+ lazy ProcessMetricsTab 渲染；ConfigModal 移除。
	// labelKey 的取值已收敛到 settingsTabLayout.ts 的 SETTINGS_TAB_LABEL_KEYS
	//（命令面板 Ctrl+P 搜设置项复用同一份 key，两处各写一份迟早漂移）。
	assert.match(settings, /process: \{ labelKey: SETTINGS_TAB_LABEL_KEYS\.process/);
	const tabLayout = readFileSync("src/renderer/src/components/app/settings/settingsTabLayout.ts", "utf8");
	assert.match(tabLayout, /process: "settings\.tabs\.process"/);
	assert.match(settings, /activeTab === "process"/);
	assert.match(settings, /<TabsContent value="process"/);
	assert.match(settings, /<ProcessMetricsTab \/>/);
	assert.doesNotMatch(config, /value="process"/);
	assert.doesNotMatch(config, /ProcessMetricsTab/);
});

test("process monitor i18n keys exist in zh-CN and en-US", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	const keys = [
		"settings.tabs.process",
		"config.process.refresh",
		"config.process.agentCount",
		"config.process.agentTotal",
		"config.process.sampledAt",
		"config.process.agentSection",
		"config.process.section",
		"config.process.dshHost",
		"config.process.dshSessionSummary",
		"config.process.empty",
		"config.process.stopHostConfirm",
		"config.process.loadFailed",
		"config.process.column.memory",
		"config.process.column.agentId",
		"config.process.column.session",
		"config.process.column.action",
		"config.process.stop",
		"config.process.stopConfirm",
		"config.process.stopped",
		"config.process.stopFailed",
	];
	for (const key of keys) {
		assert.match(zh, new RegExp(`"${key}":`), `zh-CN missing ${key}`);
		assert.match(en, new RegExp(`"${key}":`), `en-US missing ${key}`);
	}
});
