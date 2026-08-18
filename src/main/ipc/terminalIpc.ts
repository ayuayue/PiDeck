import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { SessionCommandError, SessionRuntimeTarget, TerminalShell, TerminalTarget } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";

export type TerminalIpcDeps = {
	appLogger: Pick<AppLogger, "info">;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	terminalManager: TerminalSessionManager;
	toSessionCommandIpcError: (error: SessionCommandError) => Error;
};

export function registerTerminalIpc({
	appLogger,
	sessionRuntimeCoordinator,
	terminalManager,
	toSessionCommandIpcError,
}: TerminalIpcDeps): void {
	/**
	 * 终端目标必须可落地：agent 目标校验 runtime 绑定（session/agent/generation 一致）；
	 * project 目标（引导页/未激活 agent/历史会话）不依赖 runtime，直接以 cwd 隔离。
	 */
	const requireTerminalTarget = (target: TerminalTarget) => {
		if (target.kind === "project") {
			// cwd 为渲染层传来的项目路径，仅作为 shell 启动目录与隔离键，不做额外校验
			return target;
		}
		const validated = sessionRuntimeCoordinator.validateTarget(target);
		if (!validated.ok) throw toSessionCommandIpcError(validated.error);
		return validated;
	};

	ipcMain.handle(ipcChannels.terminalList, (_event, target: TerminalTarget) => {
		requireTerminalTarget(target);
		return terminalManager.list(target);
	});
	ipcMain.handle(ipcChannels.terminalEnsure, (_event, target: TerminalTarget) => {
		requireTerminalTarget(target);
		return terminalManager.ensure(target);
	});
	ipcMain.handle(ipcChannels.terminalCreate, async (_event, target: TerminalTarget, shell?: TerminalShell) => {
		requireTerminalTarget(target);
		const result = await terminalManager.create(target, shell);
		void appLogger.info("terminal", "Terminal created", {
			kind: target.kind,
			sessionId: target.kind === "agent" ? target.sessionId : undefined,
			agentId: target.kind === "agent" ? target.agentId : undefined,
			tabId: result.id,
		});
		return result;
	});
	ipcMain.handle(
		ipcChannels.terminalInput,
		(_event, tabId: string, data: string) => {
			terminalManager.input(tabId, data);
		},
	);
	ipcMain.handle(
		ipcChannels.terminalResize,
		(_event, tabId: string, cols: number, rows: number) => {
			terminalManager.resize(tabId, cols, rows);
		},
	);
	ipcMain.handle(ipcChannels.terminalClose, (_event, tabId: string) => {
		terminalManager.close(tabId);
		void appLogger.info("terminal", "Terminal closed", { tabId });
	});
}
