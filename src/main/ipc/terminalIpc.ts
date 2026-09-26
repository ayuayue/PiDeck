import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { SessionCommandError, TerminalAgentTarget, TerminalShell, TerminalTarget } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function parseTerminalTarget(value: unknown): TerminalTarget {
	if (!isRecord(value) || typeof value.kind !== "string") throw new Error("INVALID_TERMINAL_TARGET");
	if (value.kind === "project") {
		if (!hasOnlyKeys(value, ["kind", "projectId"]) || typeof value.projectId !== "string" || !value.projectId.trim() || value.projectId.length > 256) {
			throw new Error("INVALID_TERMINAL_TARGET");
		}
		return { kind: "project", projectId: value.projectId };
	}
	if (value.kind === "agent") {
		const { sessionId, agentId, runtimeGeneration } = value;
		if (
			!hasOnlyKeys(value, ["kind", "sessionId", "agentId", "runtimeGeneration"]) ||
			typeof sessionId !== "string" ||
			!sessionId.trim() ||
			sessionId.length > 256 ||
			typeof agentId !== "string" ||
			!agentId.trim() ||
			agentId.length > 256 ||
			typeof runtimeGeneration !== "number" ||
			!Number.isSafeInteger(runtimeGeneration) ||
			runtimeGeneration < 1
		) {
			throw new Error("INVALID_TERMINAL_TARGET");
		}
		const target: TerminalAgentTarget = { kind: "agent", sessionId, agentId, runtimeGeneration };
		return target;
	}
	throw new Error("INVALID_TERMINAL_TARGET");
}

function parseTerminalShell(value: unknown): TerminalShell | undefined {
	if (value === undefined) return undefined;
	if (value === "pwsh" || value === "powershell" || value === "cmd" || value === "zsh" || value === "bash" || value === "fish" || value === "sh" || value === "git-bash" || value === "wsl") {
		return value;
	}
	throw new Error("INVALID_TERMINAL_SHELL");
}

function parseTerminalTabId(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 128) throw new Error("INVALID_TERMINAL_TAB_ID");
	return value;
}

function parseTerminalInput(value: unknown): string {
	if (typeof value !== "string") throw new Error("INVALID_TERMINAL_INPUT");
	return value;
}

function parseTerminalDimension(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new Error("INVALID_TERMINAL_SIZE");
	return value;
}

export type TerminalIpcDeps = {
	appLogger: Pick<AppLogger, "info">;
	projectStore: ProjectStore;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	terminalManager: TerminalSessionManager;
	toSessionCommandIpcError: (error: SessionCommandError) => Error;
};

export function registerTerminalIpc({ appLogger, projectStore, sessionRuntimeCoordinator, terminalManager, toSessionCommandIpcError }: TerminalIpcDeps): void {
	const requireTerminalTarget = (value: unknown): TerminalTarget => {
		const target = parseTerminalTarget(value);
		if (target.kind === "project") {
			const project = projectStore.get(target.projectId);
			if (!project) throw new Error("PROJECT_NOT_FOUND");
			if (project.kind === "chat") throw new Error("TERMINAL_PROJECT_UNSUPPORTED");
			return target;
		}
		const validated = sessionRuntimeCoordinator.validateTarget(target);
		if (!validated.ok) throw toSessionCommandIpcError(validated.error);
		return target;
	};

	ipcMain.handle(ipcChannels.terminalList, (_event, rawTarget: unknown) => {
		const target = requireTerminalTarget(rawTarget);
		return terminalManager.list(target);
	});
	ipcMain.handle(ipcChannels.terminalEnsure, (_event, rawTarget: unknown) => {
		const target = requireTerminalTarget(rawTarget);
		return terminalManager.ensure(target);
	});
	ipcMain.handle(ipcChannels.terminalCreate, async (_event, rawTarget: unknown, rawShell?: unknown) => {
		const target = requireTerminalTarget(rawTarget);
		const result = await terminalManager.create(target, parseTerminalShell(rawShell));
		void appLogger.info("terminal", "Terminal created", {
			kind: target.kind,
			projectId: target.kind === "project" ? target.projectId : undefined,
			sessionId: target.kind === "agent" ? target.sessionId : undefined,
			agentId: target.kind === "agent" ? target.agentId : undefined,
			tabId: result.id,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.terminalInput, (_event, rawTabId: unknown, rawData: unknown) => {
		terminalManager.input(parseTerminalTabId(rawTabId), parseTerminalInput(rawData));
	});
	ipcMain.handle(ipcChannels.terminalResize, (_event, rawTabId: unknown, rawCols: unknown, rawRows: unknown) => {
		terminalManager.resize(parseTerminalTabId(rawTabId), parseTerminalDimension(rawCols), parseTerminalDimension(rawRows));
	});
	ipcMain.handle(ipcChannels.terminalClose, (_event, rawTabId: unknown) => {
		const tabId = parseTerminalTabId(rawTabId);
		terminalManager.close(tabId);
		void appLogger.info("terminal", "Terminal closed", { tabId });
	});
	// shell 候选列表（供「选择 Shell」下拉）：只读平台探测结果，无入参可校验
	ipcMain.handle(ipcChannels.terminalShells, () => terminalManager.listShells());
}
