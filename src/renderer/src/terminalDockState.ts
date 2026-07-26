/**
 * 终端 Dock UI 状态（open / collapsed）按 owner 隔离：
 * - 有 activeAgent 时挂 agent
 * - 空项目引导页（无 agent）时挂 project
 *
 * 高度是全局一份，单独落 localStorage；open/collapsed 仅会话内记忆，
 * 避免 agents 刷新时被错误 prune 导致流式输出中途自动隐藏。
 */

export type TerminalDockOwnerKind = "agent" | "project";

export type TerminalDockOwner = {
	kind: TerminalDockOwnerKind;
	id: string;
};

export type TerminalDockState = {
	open: boolean;
	collapsed: boolean;
};

/** key 形如 `agent:<id>` / `project:<id>`，避免 agentId 与 projectId 撞车 */
export type TerminalDockStateByOwner = Record<string, TerminalDockState>;

export const TERMINAL_HEIGHT_STORAGE_KEY = "pid:terminal-dock-height";
export const TERMINAL_HEIGHT_MIN = 120;

export function terminalOwnerKey(owner: TerminalDockOwner): string {
	return `${owner.kind}:${owner.id}`;
}

/**
 * 单按钮双作用域：有 agent 优先挂 agent，否则挂当前项目。
 * 与「项目空引导页也能开终端」的产品规则对齐。
 */
export function resolveTerminalOwner(
	activeAgentId: string | undefined,
	activeProjectId: string | undefined,
): TerminalDockOwner | undefined {
	if (activeAgentId) return { kind: "agent", id: activeAgentId };
	if (activeProjectId) return { kind: "project", id: activeProjectId };
	return undefined;
}

export function parseTerminalOwnerKey(
	key: string,
): TerminalDockOwner | undefined {
	const agentPrefix = "agent:";
	const projectPrefix = "project:";
	if (key.startsWith(agentPrefix)) {
		const id = key.slice(agentPrefix.length);
		return id ? { kind: "agent", id } : undefined;
	}
	if (key.startsWith(projectPrefix)) {
		const id = key.slice(projectPrefix.length);
		return id ? { kind: "project", id } : undefined;
	}
	return undefined;
}

export function setTerminalDockOpen(
	current: TerminalDockStateByOwner,
	ownerKey: string,
	open: boolean,
): TerminalDockStateByOwner {
	return {
		...current,
		[ownerKey]: {
			open,
			collapsed: current[ownerKey]?.collapsed ?? false,
		},
	};
}

export function setTerminalDockCollapsed(
	current: TerminalDockStateByOwner,
	ownerKey: string,
	collapsed: boolean,
): TerminalDockStateByOwner {
	return {
		...current,
		[ownerKey]: {
			// 折叠默认仍视为「已打开的 Dock」，避免 collapsed 写入把 open 冲成 false
			open: current[ownerKey]?.open ?? true,
			collapsed,
		},
	};
}

/**
 * 只按对应集合裁剪：agent 键对照 liveAgentIds，project 键对照 liveProjectIds。
 * 历史 bug：用 agentId 集合 prune projectId 键，流式/状态推送时会把 open 清掉。
 */
export function pruneTerminalDockState(
	current: TerminalDockStateByOwner,
	liveAgentIds: Set<string>,
	liveProjectIds: Set<string>,
): TerminalDockStateByOwner {
	return Object.fromEntries(
		Object.entries(current).filter(([key]) => {
			const owner = parseTerminalOwnerKey(key);
			if (!owner) return false;
			if (owner.kind === "agent") return liveAgentIds.has(owner.id);
			return liveProjectIds.has(owner.id);
		}),
	);
}

/** pending agent → 真实 agent 时，把 UI 状态迁到新 id（与其它 agent 记录迁移一致） */
export function migrateTerminalDockAgentState(
	current: TerminalDockStateByOwner,
	replacementById: Map<string, string>,
	liveAgentIds: Set<string>,
): TerminalDockStateByOwner {
	const next: TerminalDockStateByOwner = {};
	for (const [key, value] of Object.entries(current)) {
		const owner = parseTerminalOwnerKey(key);
		if (!owner) continue;
		if (owner.kind === "project") {
			next[key] = value;
			continue;
		}
		const nextAgentId = replacementById.get(owner.id) ?? owner.id;
		if (!liveAgentIds.has(nextAgentId)) continue;
		next[terminalOwnerKey({ kind: "agent", id: nextAgentId })] = value;
	}
	return next;
}

/**
 * 无 agent 时 PTY 会话键按 cwd 隔离，避免多项目共用 `_project_` 串台。
 * Windows 路径统一为正斜杠 + 小写，降低盘符/分隔符差异导致的重复会话。
 */
export function projectTerminalSessionKey(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return `cwd:${normalized}`;
}

export function loadTerminalHeight(fallback: number): number {
	try {
		const raw = localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY);
		if (raw == null) return fallback;
		const value = Number(raw);
		if (!Number.isFinite(value) || value < TERMINAL_HEIGHT_MIN) return fallback;
		return value;
	} catch {
		// localStorage 不可用时退回默认高度，不影响主流程
		return fallback;
	}
}

export function saveTerminalHeight(height: number): void {
	try {
		localStorage.setItem(
			TERMINAL_HEIGHT_STORAGE_KEY,
			String(Math.max(TERMINAL_HEIGHT_MIN, Math.round(height))),
		);
	} catch {
		// 配额/隐私模式失败时静默忽略；高度仍在本会话内存中有效
	}
}
