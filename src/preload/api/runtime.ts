/**
 * preload runtime 域：运行时：应用/RPC 日志、pi 安装与命令、ACP、终端。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { subscribe } from "./ipcHelpers";
import type { AppLogEntry, AppLogPage, AppLogQuery, NpmAvailabilityResult, PiCliUpdateResult, PiInstallExecResult, PiInstallStatus, PiInstallation, PiReleaseNotesPayload, PiRuntimeNodeInstallResult, PiRuntimeNodeStatus, PiUpdateCheckResult, SessionRuntimeTarget, TerminalDataEvent, TerminalExitEvent, TerminalShell, TerminalTab, TerminalTarget } from "../../shared/types";
import type { AcpToolConfig, AcpToolInput, AcpToolValidation } from "../../shared/types/acp";
import type { ModelTraceRecord } from "../../shared/types/modelTrace";
import type { RpcLogBatch, RpcLogEntry } from "../../shared/types/rpcLog";

export const runtimeApi = {
	logs: {
		list: (query?: AppLogQuery) => ipcRenderer.invoke(ipcChannels.logsList, query ?? {}) as Promise<AppLogEntry[]>,
		listPage: (query?: AppLogQuery) => ipcRenderer.invoke(ipcChannels.logsListPage, query ?? {}) as Promise<AppLogPage>,
		clear: () => ipcRenderer.invoke(ipcChannels.logsClear) as Promise<void>,
		openFolder: () => ipcRenderer.invoke(ipcChannels.logsOpenFolder) as Promise<void>,
		getSize: () => ipcRenderer.invoke(ipcChannels.logsSize) as Promise<number>,
	},
	rpcLogs: {
		getSize: (target?: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.rpcLogsGetSize, target) as Promise<number>,
		get: (options?: { target?: SessionRuntimeTarget; days?: number; limit?: number }) => ipcRenderer.invoke(ipcChannels.rpcLogsGet, options) as Promise<RpcLogEntry[]>,
		/** 实时查看弹窗初始历史：主进程环形缓冲（按 agentId 过滤） */
		getLive: (agentId?: string) => ipcRenderer.invoke(ipcChannels.rpcLogsGetLive, agentId) as Promise<RpcLogEntry[]>,
		/** 模型请求快照的完整请求体（面板展开模型行时按 traceId 回读；缺失返回 null） */
		getModelTrace: (options: { agentId: string; traceId: string }) => ipcRenderer.invoke(ipcChannels.rpcLogsGetModelTrace, options) as Promise<ModelTraceRecord | null>,
		/** 把弹窗中的日志条目合并写入该 agent 的自动日志文件（按 id 去重），返回写入的文件路径列表 */
		save: (options: { entries: RpcLogEntry[] }) => ipcRenderer.invoke(ipcChannels.rpcLogsSave, options) as Promise<string[]>,
		/** 订阅主进程批量推送的实时日志（按 agent 聚合，~80ms 一次），返回退订函数 */
		onLog: (callback: (batch: RpcLogBatch) => void) => subscribe<{ agentId: string; entries: RpcLogEntry[] }>(ipcChannels.agentsRpcLog, callback),
		clear: (target?: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.rpcLogsClear, target) as Promise<void>,
		setLogging: (target: SessionRuntimeTarget, enabled: boolean) => ipcRenderer.invoke(ipcChannels.rpcLoggingSet, target, enabled) as Promise<boolean>,
		getLogging: (target: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.rpcLoggingGet, target) as Promise<boolean>,
		/** 登记「该 agent 的实时日志面板是否在看」：主进程据此决定是否广播（面板挂载 true / 卸载 false） */
		setWatching: (agentId: string, watching: boolean) => ipcRenderer.invoke(ipcChannels.rpcLogsSetWatching, agentId, watching) as Promise<boolean>,
	},
	pi: {
		/**
		 * 检测 pi 环境。`force` = 忽略 WSL 探测缓存重新扫描，
		 * 用于用户显式点「检测环境」或刚改过 WSL 配置（否则负缓存 TTL 内看不到新装好的 pi）。
		 */
		check: (force?: boolean) => ipcRenderer.invoke(ipcChannels.piCheck, force === true) as Promise<PiInstallStatus>,
		/** 验证用户手动输入的 pi 路径，通过后主进程会自动保存到 settings.customPiPath */
		/**
		 * 验证用户手动输入的 pi 路径，通过后主进程会自动保存到 settings.customPiPath。
		 * `activate=false`：只校验不改「当前使用」（编辑备选路径时用）。
		 */
		checkCustom: (customPath: string, activate?: boolean) => ipcRenderer.invoke(ipcChannels.piCheckCustom, customPath, activate !== false) as Promise<PiInstallStatus>,
		/**
		 * 列出系统上探测到的全部 pi 安装（含官方安装器的 managed 安装）。
		 * `forceShellProbe` = 额外跑一次交互式登录 shell 反查（用户显式点「从终端再找一次」）。
		 */
		listInstallations: (forceShellProbe?: boolean) => ipcRenderer.invoke(ipcChannels.piInstallations, forceShellProbe === true) as Promise<PiInstallation[]>,
		/** 打开文件选择器挑一个 pi 可执行文件（稀有/自定义安装）；取消返回 null */
		chooseExecutable: () => ipcRenderer.invoke(ipcChannels.piChooseExecutable) as Promise<string | null>,
		/** 保存用户自加的 pi 候选路径列表；返回落盘后的列表与「当前使用是否被一并清空」 */
		setCustomPaths: (paths: readonly string[]) => ipcRenderer.invoke(ipcChannels.piSetCustomPaths, [...paths]) as Promise<{ paths: string[]; clearedActive: boolean }>,
		checkUpdate: () => ipcRenderer.invoke(ipcChannels.piUpdateCheck) as Promise<PiUpdateCheckResult>,
		update: () => ipcRenderer.invoke(ipcChannels.piUpdate) as Promise<PiCliUpdateResult>,
		/** pi CLI 更新日志：点「更新详情」时按需拉取 (current, latest] 区间的 changelog 条目。 */
		releaseNotes: (options: { latestVersion: string; currentVersion?: string }) => ipcRenderer.invoke(ipcChannels.piReleaseNotes, options) as Promise<PiReleaseNotesPayload>,
		/** 执行安装命令（如 npm install -g pi）并返回执行结果 */
		execInstall: (command: string) => ipcRenderer.invoke(ipcChannels.piExecInstall, command) as Promise<PiInstallExecResult>,
		/** 检查 npm 是否可用 */
		checkNpm: () => ipcRenderer.invoke(ipcChannels.piCheckNpm) as Promise<NpmAvailabilityResult>,
		/** 环境引导：检测便携 Node 副本 + 系统 node 状态 */
		runtimeNodeCheck: () => ipcRenderer.invoke(ipcChannels.piRuntimeNodeCheck) as Promise<PiRuntimeNodeStatus>,
		/** 环境引导：安装便携 Node 到 userData（镜像回退 + sha256 校验，主进程内完成） */
		runtimeNodeInstall: () => ipcRenderer.invoke(ipcChannels.piRuntimeNodeInstall) as Promise<PiRuntimeNodeInstallResult>,
		/** 环境引导：全局安装 pi（收紧通道：只传镜像布尔意图，命令由主进程拼接） */
		runtimePiInstall: (useMirror: boolean) => ipcRenderer.invoke(ipcChannels.piRuntimePiInstall, useMirror === true) as Promise<PiInstallExecResult>,
	},
	acp: {
		/** ACP agent CLI 工具登记表（settings.acpTools 只读快照）。 */
		listTools: () => ipcRenderer.invoke(ipcChannels.acpToolsList) as Promise<AcpToolConfig[]>,
		/** 保存整表（逐条消毒后落盘），返回服务端规范化后的表。 */
		saveTools: (tools: AcpToolInput[]) => ipcRenderer.invoke(ipcChannels.acpToolsSave, tools) as Promise<AcpToolConfig[]>,
		/** 单条表单校验（不落盘；渲染层即时反馈）。 */
		validateTool: (input: AcpToolInput) => ipcRenderer.invoke(ipcChannels.acpToolValidate, input) as Promise<AcpToolValidation>,
		/** 检测预设工具安装状态/版本（只读）。 */
		detectTool: (presetId: import("../../shared/acpToolPresets").AcpToolPresetId) => ipcRenderer.invoke(ipcChannels.acpToolDetect, presetId) as Promise<import("../../shared/types/acp").AcpToolStatus>,
		/** npm 全局安装（进度经 onLifecycleEvent 推送）；manual 形态会 reject，渲染层引导官网。 */
		installTool: (presetId: import("../../shared/acpToolPresets").AcpToolPresetId) => ipcRenderer.invoke(ipcChannels.acpToolInstall, presetId) as Promise<{ ok: boolean; output: string }>,
		/** npm 全局卸载。 */
		uninstallTool: (presetId: import("../../shared/acpToolPresets").AcpToolPresetId) => ipcRenderer.invoke(ipcChannels.acpToolUninstall, presetId) as Promise<{ ok: boolean; output: string }>,
		/** 安装/卸载进度行与结算推送；返回退订函数。 */
		onLifecycleEvent: (callback: (event: import("../../shared/types/acp").AcpLifecycleEvent) => void) => subscribe(ipcChannels.acpLifecycleEvent, callback),
		/** 查询 acp 会话的配置枚举（模型/思考档/模式；agent 未提供时 null）。 */
		getSessionConfig: (agentId: string) => ipcRenderer.invoke(ipcChannels.acpSessionConfigGet, agentId) as Promise<import("../../shared/types/acp").AcpSessionConfigOption[] | null>,
		/** 下发 session/set_config_option，返回 agent 回传的整表。 */
		setSessionConfig: (agentId: string, optionId: string, value: string | boolean) => ipcRenderer.invoke(ipcChannels.acpSessionConfigSet, { agentId, optionId, value }) as Promise<import("../../shared/types/acp").AcpSessionConfigOption[]>,
		/** configOptions 变更推送（按 agentId 隔离）；返回退订函数。 */
		onSessionConfigChanged: (callback: (event: import("../../shared/types/acp").AcpSessionConfigChangedEvent) => void) => subscribe(ipcChannels.acpSessionConfigChanged, callback),
	},
	terminal: {
		list: (target: TerminalTarget) => ipcRenderer.invoke(ipcChannels.terminalList, target) as Promise<TerminalTab[]>,
		ensure: (target: TerminalTarget) => ipcRenderer.invoke(ipcChannels.terminalEnsure, target) as Promise<TerminalTab[]>,
		create: (target: TerminalTarget, shell?: TerminalShell) => ipcRenderer.invoke(ipcChannels.terminalCreate, target, shell) as Promise<TerminalTab>,
		input: (tabId: string, data: string) => ipcRenderer.invoke(ipcChannels.terminalInput, tabId, data) as Promise<void>,
		acknowledge: (tabId: string, sequence: number) => ipcRenderer.invoke(ipcChannels.terminalAcknowledge, tabId, sequence) as Promise<void>,
		resize: (tabId: string, cols: number, rows: number) => ipcRenderer.invoke(ipcChannels.terminalResize, tabId, cols, rows) as Promise<void>,
		close: (tabId: string) => ipcRenderer.invoke(ipcChannels.terminalClose, tabId) as Promise<void>,
		shells: () => ipcRenderer.invoke(ipcChannels.terminalShells) as Promise<{ shell: string; label: string; available: boolean }[]>,
		fonts: () => ipcRenderer.invoke(ipcChannels.terminalFonts) as Promise<string[]>,
		onData: (callback: (payload: TerminalDataEvent) => void) => subscribe(ipcChannels.terminalData, callback),
		onExit: (callback: (payload: TerminalExitEvent) => void) => subscribe(ipcChannels.terminalExit, callback),
	},
};
