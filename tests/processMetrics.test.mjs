import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parsePsCpuTime, parsePsProcessTable, parseWindowsProcessTable } from "../src/main/process/processTableParsers.ts";
import { buildDshHostMonitorRow, DSH_HOST_MONITOR_ROW_ID, isDshHostMonitorId } from "../src/main/process/dshHostMonitor.ts";
import { DSH_HOST_MONITOR_ID } from "../src/shared/types/processMetrics.ts";
import { formatBytes, formatMb } from "../src/shared/formatBytes.ts";

import { systemIpcSource } from "./helpers/systemIpcSources.mjs";
import { preloadSource } from "./helpers/preloadSources.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";
import { agentManagerSource } from "./helpers/agentManagerSources.mjs";
// ===== 纯函数：批量采样的进程表解析 =====

test("parsePsCpuTime: hh:mm:ss / mm:ss.ss / dd- 三种 TIME 形状", () => {
	// Linux `ps -o time=`：h:mm:ss（超过 24h 加 dd- 前缀）
	assert.equal(parsePsCpuTime("00:00:05"), 5);
	assert.equal(parsePsCpuTime("1:02:03"), 3723);
	assert.equal(parsePsCpuTime("2-01:00:00"), 2 * 86400 + 3600);
	// macOS 短格式只有两段（m:ss.ss），不能当 hh:mm 解析，否则小数秒会被放大 100 倍
	assert.equal(parsePsCpuTime("0:00.05"), 0.05);
	assert.equal(parsePsCpuTime("1:23.45"), 83.45);
	assert.equal(parsePsCpuTime("  0:10  "), 10);
	for (const bad of ["", "   ", "abc", "5", "1:2:3:4", "-1:00", "10:xx"]) {
		assert.equal(parsePsCpuTime(bad), null, `should reject ${JSON.stringify(bad)}`);
	}
});

test("parsePsProcessTable: pid / rss(KB) / TIME → {memoryBytes, cpuSeconds}", () => {
	const table = parsePsProcessTable("  1234  56789 00:00:05\n 4321 1024 0:00.05\n");
	assert.equal(table.size, 2);
	assert.deepEqual(table.get(1234), { memoryBytes: 56789 * 1024, cpuSeconds: 5 });
	assert.deepEqual(table.get(4321), { memoryBytes: 1024 * 1024, cpuSeconds: 0.05 });
});

test("parsePsProcessTable: 跳过坏行而不是整批失败", () => {
	// 进程刚好退出时该 pid 的行缺失属正常；格式不合的行只能丢弃
	const table = parsePsProcessTable("\n  bad line\n0 1 2\n-5 10 00:00:01\n12 34 not-a-time\n99 77 00:00:01");
	assert.deepEqual([...table.keys()], [99]);
	assert.equal(parsePsProcessTable("").size, 0);
});

test("parseWindowsProcessTable: pid;bytes;cpuMs（整数毫秒规避 locale 小数逗号）", () => {
	const table = parseWindowsProcessTable("\uFEFF  1234;56789012;500\r\n4321;2048;0\r\n");
	assert.equal(table.size, 2);
	assert.deepEqual(table.get(1234), { memoryBytes: 56789012, cpuSeconds: 0.5 });
	assert.deepEqual(table.get(4321), { memoryBytes: 2048, cpuSeconds: 0 });
	// 坏行跳过
	assert.equal(parseWindowsProcessTable("nope\n0;1;2\n7;8\n").size, 0);
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

test("ProcessMonitor 批量采样：一条命令取全部 pid 的内存 + 累计 CPU", () => {
	const source = readFileSync("src/main/process/ProcessMonitor.ts", "utf8");
	// 安全规范：命令必须数组参数，禁止字符串拼接 shell
	assert.match(source, /spawn\(args\[0\], args\.slice\(1\)/);
	// Windows 用 PowerShell PrivateMemorySize64（专用内存口径，同任务管理器）+ `$_.CPU` 累计秒；
	// Linux/macOS 用 ps -o pid=,rss=,time=
	assert.match(source, /\"powershell\"[\s\S]*PrivateMemorySize64/);
	assert.match(source, /\[\"ps\", \"-o\", \"pid=,rss=,time=\", \"-p\", pids\.join\(\",\"\)\]/);
	// 批量而不是逐 pid：pids.join 只出现一次在 ps 命令里，采样函数接收 pid 数组
	assert.match(source, /async function sampleProcessTable\(pids: number\[\]\)/);
	assert.doesNotMatch(source, /sampleProcessMemoryBytes/);
	// 超时兜底：采样挂死不阻塞 IPC
	assert.match(source, /timeout: timeoutMs/);
	assert.match(source, /PROCESS_SAMPLE_TIMEOUT_MS/);
	// 两次采样构成 CPU 差分窗口：先建 baseline，再用第二遍算占用
	assert.match(source, /const first = await sampleProcessTable\(pids\);/);
	assert.match(source, /const second = await sampleProcessTable\(pids\);/);
	assert.match(source, /sampleProcessCpu\(/);
	assert.match(source, /cpuPct: cpuPctByPid\.get\(agent\.pid\)/);
	// 内存取最新一遍（进程在窗口内退出时回落到第一遍）
	assert.match(source, /second\.get\(agent\.pid\) \?\? first\.get\(agent\.pid\)/);
});

test("ProcessMonitor assembles agent snapshot with total", () => {
	const source = readFileSync("src/main/process/ProcessMonitor.ts", "utf8");
	// 只监控 pi agent + DSH host：不再采集 Electron 自身进程（用户自行在系统任务管理器/活动监视器查看）
	assert.doesNotMatch(source, /app\.getAppMetrics\(\)/);
	assert.doesNotMatch(source, /totalElectronBytes/);
	assert.match(source, /totalAgentBytes/);
	// sampledAt 用第二遍采样的时刻，与 cpuPct 的时间窗口末端对齐
	assert.match(source, /sampledAt: secondAt/);
});

test("AgentManager exposes listAgentPids filtered to running processes", () => {
	const source = agentManagerSource;
	assert.match(source, /listAgentPids\(\): Array<\{ agentId: string; pid: number \}>/);
	assert.match(source, /runtime\.process\.pid/);
	assert.match(source, /runtime\.process\.isRunning\(\)/);
});

test("PiProcess exposes pid accessor", () => {
	const source = readFileSync("src/main/pi/PiProcess.ts", "utf8");
	assert.match(source, /get pid\(\): number \| undefined/);
	// P4.0（Phase 4）把「进程」抽成了启动面 handle：访问器现在转发到 handle.pid，而不是不再存在的 proc。
	// 契约意图不变（对外仍是一个转发到真实进程的 pid 访问器），只是目标符号随实现等价迁移。
	assert.match(source, /return this\.handle\?\.pid;/);
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
	const systemIpc = systemIpcSource;
	const preload = preloadSource;
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
	const systemIpc = systemIpcSource;
	const preload = preloadSource;
	const coordinator = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");
	const index = mainIpcSource;
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
	// Agent 表头列序：agentId → 会话 → PID → CPU → memory → action（操作列在最右侧，列内居中）
	assert.match(tab, /config\.process\.column\.agentId.*config\.process\.column\.session.*>PID<.*config\.process\.column\.cpu.*config\.process\.column\.memory.*config\.process\.column\.action/s);
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
	// CPU 列：无基线时显示 "-"，有值固定一位小数
	assert.match(source, /formatCpuPct\(agent\.cpuPct\)/);
	assert.match(source, /cpuPct == null \? "-" : `\$\{cpuPct\.toFixed\(1\)\}%`/);
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
		"config.process.column.cpu",
		"config.process.cpuHint",
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
