export type TerminalDockState = {
	open: boolean;
	collapsed: boolean;
};

export type TerminalDockStateByAgent = Record<string, TerminalDockState>;

export function setTerminalDockOpen(
	current: TerminalDockStateByAgent,
	agentId: string,
	open: boolean,
): TerminalDockStateByAgent {
	return {
		...current,
		[agentId]: {
			open,
			collapsed: current[agentId]?.collapsed ?? false,
		},
	};
}

export function setTerminalDockCollapsed(
	current: TerminalDockStateByAgent,
	agentId: string,
	collapsed: boolean,
): TerminalDockStateByAgent {
	return {
		...current,
		[agentId]: {
			open: current[agentId]?.open ?? true,
			collapsed,
		},
	};
}

export function pruneTerminalDockState(
	current: TerminalDockStateByAgent,
	activeIds: Set<string>,
): TerminalDockStateByAgent {
	return Object.fromEntries(
		Object.entries(current).filter(([agentId]) => activeIds.has(agentId)),
	);
}
