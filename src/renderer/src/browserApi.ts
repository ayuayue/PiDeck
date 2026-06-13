import type { PiDesktopApi } from "../../preload";
import type { AgentTab, ChatMessage, SendPromptInput } from "../../shared/types";
import { t } from "./i18n";
import { createPreviewApi } from "./previewApi";

type WebState = {
	projects: Awaited<ReturnType<PiDesktopApi["projects"]["list"]>>;
	agents: AgentTab[];
	messagesByAgent: Record<string, ChatMessage[]>;
};

const base = createPreviewApi();
let state: WebState = { projects: [], agents: [], messagesByAgent: {} };
let connected = false;
let polling = false;
let pollTimer: number | undefined;
const stateListeners = new Set<(tabs: AgentTab[]) => void>();
const messageListeners = new Set<(payload: { agentId: string; messages: ChatMessage[] }) => void>();
let lastMessages = new Map<string, string>();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		headers: { "content-type": "application/json" },
		...init,
	});
	const data = await response.json().catch(() => ({
		error: t("errors.nonJsonResponse", {
			status: response.status,
			statusText: response.statusText,
		}),
	}));
	if (!response.ok || data?.ok === false) {
		throw new Error(data?.error ?? response.statusText);
	}
	return data as T;
}

async function refreshState() {
	state = await request<WebState>("/api/state");
	connected = true;
	for (const listener of stateListeners) listener(state.agents);
	for (const [agentId, messages] of Object.entries(state.messagesByAgent)) {
		const key = JSON.stringify(messages);
		if (lastMessages.get(agentId) === key) continue;
		lastMessages.set(agentId, key);
		for (const listener of messageListeners) listener({ agentId, messages });
	}
	return state;
}

function ensurePolling() {
	if (polling) return;
	polling = true;
	void refreshState().catch(() => undefined);
	pollTimer = window.setInterval(() => {
		void refreshState().catch(() => undefined);
	}, 600);
}

function subscribe<T>(set: Set<(payload: T) => void>, callback: (payload: T) => void) {
	ensurePolling();
	set.add(callback);
	return () => {
		set.delete(callback);
		if (stateListeners.size === 0 && messageListeners.size === 0 && pollTimer) {
			window.clearInterval(pollTimer);
			pollTimer = undefined;
			polling = false;
		}
	};
}

export function createBrowserApi(): PiDesktopApi {
	return {
		...base,
		projects: {
			...base.projects,
			list: async () => {
				try {
					return (await refreshState()).projects;
				} catch {
					return connected ? state.projects : base.projects.list();
				}
			},
		},
		sessions: {
			...base.sessions,
			list: async (projectId) => {
				if (!projectId) return [];
				const result = await request<{ sessions: Awaited<ReturnType<PiDesktopApi["sessions"]["list"]>> }>(
					`/api/projects/${encodeURIComponent(projectId)}/sessions`,
				);
				return result.sessions;
			},
		},
		agents: {
			...base.agents,
			list: async () => {
				try {
					return (await refreshState()).agents;
				} catch {
					return connected ? state.agents : base.agents.list();
				}
			},
			create: async (input) => {
				const result = await request<{ agent: AgentTab }>("/api/agents", {
					method: "POST",
					body: JSON.stringify(input),
				});
				return result.agent;
			},
			stop: async (agentId) => {
				await request(`/api/agents/${encodeURIComponent(agentId)}/stop`, {
					method: "POST",
					body: "{}",
				});
				await refreshState();
			},
			abort: async (agentId) => {
				await request(`/api/agents/${encodeURIComponent(agentId)}/stop`, {
					method: "POST",
					body: "{}",
				});
				await refreshState();
			},
			prompt: async (input: SendPromptInput) => {
				await request(`/api/agents/${encodeURIComponent(input.agentId)}/prompt`, {
					method: "POST",
					body: JSON.stringify({ message: input.message, streamingBehavior: input.streamingBehavior }),
				});
				await refreshState();
			},
			runtimeState: async (agentId) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["runtimeState"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/runtime`,
				);
				return result.state;
			},
			cycleModel: async (agentId) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["cycleModel"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/cycle-model`,
					{ method: "POST", body: "{}" },
				);
				return result.state;
			},
			availableModels: async (agentId) => {
				const result = await request<{ models: Awaited<ReturnType<PiDesktopApi["agents"]["availableModels"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/models`,
				);
				return result.models;
			},
			setModel: async (agentId, provider, modelId) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["setModel"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/model`,
					{ method: "POST", body: JSON.stringify({ provider, modelId }) },
				);
				return result.state;
			},
			cycleThinking: async (agentId) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["cycleThinking"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/cycle-thinking`,
					{ method: "POST", body: "{}" },
				);
				return result.state;
			},
			setThinking: async (agentId, level) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["setThinking"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/thinking`,
					{ method: "POST", body: JSON.stringify({ level }) },
				);
				return result.state;
			},
			onState: (callback) => subscribe(stateListeners, callback),
			onMessages: (callback) => subscribe(messageListeners, callback),
		},
		settings: {
			...base.settings,
			get: async () => ({
				...(await base.settings.get()),
				webServiceEnabled: true,
			}),
		},
	};
}
