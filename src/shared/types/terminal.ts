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
	/** 归属键（agent:<id> / cwd:<normalized>）：主进程按此隔离终端实例，切换项目/agent 不串台 */
	ownerKey: string;
	title: string;
	cwd: string;
	shell: TerminalShell;
	createdAt: number;
	exited?: boolean;
	exitCode?: number;
	buffer?: string;
	/** 前台进程名快照（node-pty process）：渲染层在「关闭确认=running」时据此判断是否有任务在跑 */
	frontProcess?: string;
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
	cwd: string;
};

export type TerminalTarget = TerminalAgentTarget | TerminalProjectTarget;

export type TerminalDataEvent = {
	tabId: string;
	data: string;
};

export type TerminalExitEvent = {
	tabId: string;
	exitCode?: number;
};
