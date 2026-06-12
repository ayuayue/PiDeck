import type { AgentTab } from "../../shared/types";

const DEFAULT_VISIBLE_AGENT_LIMIT = 3;

export type AgentListDisplay = {
	visibleAgents: AgentTab[];
	hasHiddenAgents: boolean;
	hiddenCount: number;
};

export function getVisibleAgentsForProject(
	agents: AgentTab[],
	isExpanded: boolean,
	visibleLimit = DEFAULT_VISIBLE_AGENT_LIMIT,
): AgentListDisplay {
	if (isExpanded || agents.length <= visibleLimit) {
		return {
			visibleAgents: agents,
			hasHiddenAgents: false,
			hiddenCount: 0,
		};
	}

	return {
		visibleAgents: agents.slice(0, visibleLimit),
		hasHiddenAgents: true,
		hiddenCount: agents.length - visibleLimit,
	};
}
