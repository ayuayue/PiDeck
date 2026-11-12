/**
 * 应用日志 + RPC 日志 IPC 域（自 systemIpc.ts 拆出：handler 体、通道、日志与文案逐字未改）。
 * 通道：logs:list / logs:list-page / logs:renderer-log / logs:clear / logs:open-folder / logs:size /
 * rpc-logs:*（9 条）+ preload:ready / preload:error 两个 on 事件。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AppLogLevel, AppLogQuery, SessionCommandError, SessionRuntimeTarget } from "../../shared/types";
import type { RpcLogEntry } from "../../shared/types/rpcLog";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";
import type { RpcLogger } from "../logging/RpcLogger";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";

export type SystemLogsIpcDeps = {
	appLogger: AppLogger;
	rpcLogger: RpcLogger;
	agentManager: AgentManager;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	/** Session command IPC error converter（RPC 目标校验失败时转成渲染层可读错误）。 */
	sessionCommandIpcError?: (error: SessionCommandError) => Error;
	/** DSH 后端判定（G17：RPC 日志按 backend 分流）。 */
	isDshAgent?: (agentId: string) => boolean;
	/** DSH RPC 日志开关（G17；未装配 = 无 DSH 后端）。 */
	setDshRpcLogging?: (agentId: string, enabled: boolean) => void;
	/** DSH RPC 日志状态查询（G17）。 */
	isDshRpcLogging?: (agentId: string) => boolean;
	/** DSH 实时日志观看登记（面板挂载/卸载成对调用；未装配 = 无 DSH 后端）。 */
	setDshRpcLogWatching?: (agentId: string, watching: boolean) => void;
};

export function registerSystemLogsIpc(deps: SystemLogsIpcDeps): void {
	const { appLogger, rpcLogger, agentManager, sessionRuntimeCoordinator, sessionCommandIpcError, isDshAgent, setDshRpcLogging, isDshRpcLogging, setDshRpcLogWatching } = deps;

	/**
	 * IPC 边界校验：RPC 日志条目必须字段齐全，防止渲染层传伪造对象写盘。
	 * direction 允许 model —— 模型请求快照（pi-deck-model-trace 转发）在时间线里就是该方向，
	 * 漏掉会把保存路径上的模型行全部丢弃（面板看着有、落盘后没有）。
	 */
	function isRpcLogEntry(value: unknown): value is RpcLogEntry {
		if (typeof value !== "object" || value === null) return false;
		const entry = value as Record<string, unknown>;
		return typeof entry.id === "string" && typeof entry.agentId === "string" && (entry.direction === "send" || entry.direction === "recv" || entry.direction === "model") && typeof entry.summary === "string" && typeof entry.time === "number";
	}

	ipcMain.handle(ipcChannels.logsList, async (_event, query: AppLogQuery) => appLogger.list(query));
	ipcMain.handle(ipcChannels.logsListPage, async (_event, query: AppLogQuery) => appLogger.listPage(query));
	ipcMain.handle(ipcChannels.rendererLog, async (_event, level: AppLogLevel, scope: string, message: string, detail?: unknown) => {
		const safeLevel = ["debug", "info", "warn", "error"].includes(level) ? level : "info";
		await appLogger.log(safeLevel as AppLogLevel, scope, message, detail);
	});
	ipcMain.on(ipcChannels.preloadReady, (event) => {
		void appLogger.info("app", "Preload API exposed", { url: event.sender.getURL() });
	});
	ipcMain.on(ipcChannels.preloadError, (event, detail) => {
		void appLogger.error("app", "Preload API expose failed", { url: event.sender.getURL(), detail });
	});
	ipcMain.handle(ipcChannels.logsClear, async () => appLogger.clear());
	ipcMain.handle(ipcChannels.logsOpenFolder, async () => appLogger.openFolder());
	ipcMain.handle(ipcChannels.logsSize, async () => appLogger.getSize());

	// ── RPC 日志 ─────────────────────────────────────────────────────

	const resolveRpcRuntimeAgent = (target?: SessionRuntimeTarget) => {
		if (!target) return undefined;
		const validated = sessionRuntimeCoordinator.validateTarget(target);
		if (!validated.ok) {
			// 失败原因落日志：rpc 日志开关/查询/保存都会走这里，静默失败会让渲染层
			// 误以为开关已生效（此前 handler 在 undefined 时直接 return enabled 假成功）。
			const error = (validated as { ok: false; error: import("../../shared/types").SessionCommandError }).error;
			void appLogger.warn("agent", "RPC log runtime target invalid", {
				sessionId: target.sessionId,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
				code: error.code,
			});
			if (sessionCommandIpcError) throw sessionCommandIpcError(error);
			return undefined;
		}
		return target.agentId;
	};

	ipcMain.handle(ipcChannels.rpcLogsGetSize, async (_event, target?: SessionRuntimeTarget) => rpcLogger.getSize(resolveRpcRuntimeAgent(target)));
	ipcMain.handle(ipcChannels.rpcLogsGet, async (_event, options?: { target?: SessionRuntimeTarget; days?: number; limit?: number }) => rpcLogger.getFromFile({ agentId: resolveRpcRuntimeAgent(options?.target), days: options?.days, limit: options?.limit }));
	// 实时查看弹窗的初始历史：直接读主进程环形缓冲，不读磁盘
	ipcMain.handle(ipcChannels.rpcLogsGetLive, async (_event, agentId?: string) => rpcLogger.getLive(typeof agentId === "string" ? agentId : undefined));
	// 模型请求快照：时间线里只存摘要，完整请求体按需回读（展开模型行时才拉，避免大 payload 进环形缓冲）
	ipcMain.handle(ipcChannels.rpcLogsGetModelTrace, async (_event, options?: { agentId?: unknown; traceId?: unknown }) => {
		const agentId = typeof options?.agentId === "string" ? options.agentId : "";
		const traceId = typeof options?.traceId === "string" ? options.traceId : "";
		if (!agentId || !traceId) return null;
		return rpcLogger.readModelTrace(agentId, traceId);
	});
	// 实时查看弹窗“保存到文件”：直接合并写入该 agent 的自动日志文件（按 id 去重），
	// 不再弹目录选择——开启记录后日志本就自动落盘，保存只是把弹窗内容对齐到文件。
	// 返回实际写入的文件路径列表，供渲染层 toast 提示用户保存位置。
	// 渲染层传来的条目不可信，数量与字段都要校验。
	ipcMain.handle(ipcChannels.rpcLogsSave, async (_event, options?: { entries?: unknown }) => {
		const rawEntries = Array.isArray(options?.entries) ? options.entries : [];
		const entries = rawEntries
			.slice(0, 10_000) // 上限：防止一次 IPC 携带超大批次
			.filter((value): value is RpcLogEntry => isRpcLogEntry(value));
		if (entries.length === 0) return [];
		return rpcLogger.appendEntries(entries);
	});
	ipcMain.handle(ipcChannels.rpcLogsClear, async (_event, target?: SessionRuntimeTarget) => rpcLogger.clear(resolveRpcRuntimeAgent(target)));
	ipcMain.handle(ipcChannels.rpcLoggingSet, async (_event, target: SessionRuntimeTarget, enabled: boolean) => {
		const agentId = resolveRpcRuntimeAgent(target);
		// target 校验失败时返回 false（而非 enabled）：此前静默返回 enabled 会让渲染层
		// 弹「RPC 日志已打开」提醒框，实际主进程从未开启记录，导致弹窗永远无数据。
		if (!agentId) return false;
		// G17：DSH 会话的 RPC 日志走 DshAgentManager（领域调用记录），pi 走 AgentManager。
		if (isDshAgent?.(agentId)) {
			setDshRpcLogging?.(agentId, enabled);
		} else {
			agentManager.setRpcLogging(agentId, enabled);
		}
		return enabled;
	});
	ipcMain.handle(ipcChannels.rpcLoggingGet, async (_event, target: SessionRuntimeTarget) => {
		const agentId = resolveRpcRuntimeAgent(target);
		if (!agentId) return false;
		if (isDshAgent?.(agentId)) {
			return isDshRpcLogging?.(agentId) ?? false;
		}
		return agentManager.isRpcLogging(agentId);
	});
	// 实时日志面板挂载/卸载登记观看状态：没有观看者时主进程跳过广播（落盘与环形缓冲不受影响），
	// 避免重度会话里无人认领的批次每 80ms 跨一次进程克隆。
	// G17+DSH：观看登记同样按 backend 分流——DSH 经注入的 setDshRpcLogWatching 走
	// RpcLogLiveBroadcaster，pi 走 AgentManager 自带的实时广播。
	ipcMain.handle(ipcChannels.rpcLogsSetWatching, async (_event, agentId?: unknown, watching?: unknown) => {
		if (typeof agentId !== "string" || !agentId || typeof watching !== "boolean") return false;
		if (isDshAgent?.(agentId)) {
			setDshRpcLogWatching?.(agentId, watching);
		} else {
			agentManager.setRpcLogWatching(agentId, watching);
		}
		return true;
	});
}
