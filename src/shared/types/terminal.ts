export type TerminalShell = "pwsh" | "powershell" | "cmd" | "zsh" | "bash" | "fish" | "sh" | "git-bash" | "wsl";

export type TerminalShellCandidate = {
	shell: TerminalShell;
	label: string;
	available: boolean;
	path?: string;
};

export type TerminalTab = {
	id: string;
	agentId: string;
	/** Stable owner identity (agent:<id> / project:<id>); contains no host path. */
	ownerKey: string;
	title: string;
	shell: TerminalShell;
	createdAt: number;
	exited?: boolean;
	exitCode?: number;
	buffer?: string;
};

/**
 * 终端归属目标：
 * - agent：绑定已启动的 Agent runtime（校验 sessionId/agentId/runtimeGeneration）；
 * - project：无 Agent 时的项目级终端（引导页/未激活 agent/历史会话），按项目 cwd 隔离。
 * 终端状态（open/collapsed/实例）严格按归属隔离，切换项目或 agent 不得串台。
 */
export type TerminalAgentTarget = {
	kind: "agent";
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
};

export type TerminalProjectTarget = {
	kind: "project";
	projectId: string;
};

export type TerminalTarget = TerminalAgentTarget | TerminalProjectTarget;

/** A single stable bucket key shared by main, renderer, and preview terminal routing. */
export function terminalOwnerKeyFor(target: TerminalTarget): string {
	return target.kind === "agent" ? `agent:${target.agentId}` : `project:${target.projectId}`;
}

export type TerminalDataEvent = {
	tabId: string;
	data: string;
};

export type TerminalExitEvent = {
	tabId: string;
	exitCode?: number;
};
