import type { PiDesktopApi } from "../../preload";
import type {
	ChatMessage,
	SessionCommandResult,
	SessionRecord,
	SessionRuntimeEvent,
	SessionRuntimeInfo,
	SessionRuntimeTarget,
} from "../../shared/types";
import { t } from "./i18n";
import { createPreviewApi } from "./previewApi";

type WebState = {
	projects: Awaited<ReturnType<PiDesktopApi["projects"]["list"]>>;
	sessions: SessionRecord[];
	runtimes: SessionRuntimeInfo[];
	messagesBySession: Record<string, ChatMessage[]>;
};

const base = createPreviewApi();
let state: WebState = {
	projects: [],
	sessions: [],
	runtimes: [],
	messagesBySession: {},
};
let connected = false;
let polling = false;
let pollTimer: number | undefined;
const runtimeListeners = new Set<(event: SessionRuntimeEvent) => void>();
let lastRuntimeBySession = new Map<string, SessionRuntimeInfo>();
let lastSessionMessages = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Vite dev 会把未知 /api/* 回退到 index.html，写入状态前必须确认是真正的 Web 服务载荷。
function isWebState(value: unknown): value is WebState {
	if (!isRecord(value)) return false;
	return (
		Array.isArray(value.projects) &&
		Array.isArray(value.sessions) &&
		Array.isArray(value.runtimes) &&
		isRecord(value.messagesBySession)
	);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		headers: { "content-type": "application/json" },
		...init,
	});
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new Error(
			t("errors.nonJsonResponse", {
				status: response.status,
				statusText: response.statusText,
			}),
		);
	}
	if (!response.ok || (isRecord(data) && data.ok === false)) {
		throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : response.statusText);
	}
	return data as T;
}

async function refreshState() {
	const nextState = await request<unknown>("/api/state");
	if (!isWebState(nextState)) {
		throw new Error("Invalid web service state payload");
	}
	state = nextState;
	connected = true;
	const nextRuntimeBySession = new Map(
		state.runtimes.map((runtime) => [runtime.sessionId, runtime]),
	);
	for (const [sessionId, previous] of lastRuntimeBySession) {
		if (nextRuntimeBySession.has(sessionId)) continue;
		lastSessionMessages.delete(sessionId);
		for (const listener of runtimeListeners) {
			listener({
				kind: "detach",
				sessionId,
				agentId: previous.agentId,
				runtimeGeneration: previous.runtimeGeneration,
				sourceChannel: "sessions:runtime-detach",
				payload: null,
			});
		}
	}
	for (const runtime of state.runtimes) {
		const previous = lastRuntimeBySession.get(runtime.sessionId);
		if (JSON.stringify(previous) !== JSON.stringify(runtime)) {
			for (const listener of runtimeListeners) {
				listener({
					sessionId: runtime.sessionId,
					agentId: runtime.agentId,
					runtimeGeneration: runtime.runtimeGeneration,
					sourceChannel: "sessions:runtime",
					payload: runtime,
				});
			}
		}
		const messages = state.messagesBySession[runtime.sessionId] ?? [];
		const messageKey = `${runtime.agentId}:${runtime.runtimeGeneration}:${JSON.stringify(messages)}`;
		if (lastSessionMessages.get(runtime.sessionId) !== messageKey) {
			lastSessionMessages.set(runtime.sessionId, messageKey);
			for (const listener of runtimeListeners) {
				listener({
					sessionId: runtime.sessionId,
					agentId: runtime.agentId,
					runtimeGeneration: runtime.runtimeGeneration,
					sourceChannel: "sessions:messages",
					payload: { agentId: runtime.agentId, messages },
				});
			}
		}
	}
	lastRuntimeBySession = nextRuntimeBySession;
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
		if (
			runtimeListeners.size === 0 &&
			pollTimer
		) {
			window.clearInterval(pollTimer);
			pollTimer = undefined;
			polling = false;
		}
	};
}

async function sessionRuntimeCommand<T>(
	target: SessionRuntimeTarget,
	action: string,
	payload: Record<string, unknown> = {},
): Promise<SessionCommandResult<T>> {
	const response = await request<{ result: SessionCommandResult<T> }>(
		`/api/sessions/${encodeURIComponent(target.sessionId)}/runtime/${action}`,
		{
			method: "POST",
			body: JSON.stringify({ target, ...payload }),
		},
	);
	return response.result;
}

export function createBrowserApi(): PiDesktopApi {
	return {
		...base,
		// Browser/Web builds cannot capture or upload audio through the desktop-only IPC domain.
		voiceTranscription: base.voiceTranscription,
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
			listCatalog: async (projectId) => {
				const result = await request<{ sessions: SessionRecord[] }>(
					`/api/projects/${encodeURIComponent(projectId)}/sessions/catalog`,
				);
				return result.sessions;
			},
			createDraft: async (input) => {
				const result = await request<{ session: SessionRecord }>("/api/sessions", {
					method: "POST",
					body: JSON.stringify(input),
				});
				void refreshState().catch(() => undefined);
				return result.session;
			},
			createAnonymous: async (input) => {
				const result = await request<{
					session: SessionRecord;
					runtime: SessionRuntimeInfo;
				}>("/api/sessions/anonymous", {
					method: "POST",
					body: JSON.stringify(input),
				});
				void refreshState().catch(() => undefined);
				return result;
			},
			updateRecord: async (sessionId, patch) => {
				const result = await request<{ session: SessionRecord }>(
					`/api/sessions/${encodeURIComponent(sessionId)}/update`,
					{ method: "POST", body: JSON.stringify(patch) },
				);
				void refreshState().catch(() => undefined);
				return result.session;
			},
			deleteRecord: async (sessionId) => {
				const result = await request<{ deleted: boolean }>(
					`/api/sessions/${encodeURIComponent(sessionId)}/delete`,
					{ method: "POST", body: "{}" },
				);
				void refreshState().catch(() => undefined);
				return result.deleted;
			},
			copyRecord: async (sessionId) => {
				const response = await request<{
					result: Awaited<ReturnType<PiDesktopApi["sessions"]["copyRecord"]>>;
				}>(`/api/sessions/${encodeURIComponent(sessionId)}/copy`, {
					method: "POST",
					body: "{}",
				});
				void refreshState().catch(() => undefined);
				return response.result;
			},
			exportRecordHtml: async (sessionId) => {
				const response = await request<{
					result: Awaited<ReturnType<PiDesktopApi["sessions"]["exportRecordHtml"]>>;
				}>(`/api/sessions/${encodeURIComponent(sessionId)}/export-html`, {
					method: "POST",
					body: "{}",
				});
				return response.result;
			},
			readRecordMessages: async (sessionId) => {
				const result = await request<{ messages: ChatMessage[] }>(
					`/api/sessions/${encodeURIComponent(sessionId)}/messages`,
				);
				return result.messages;
			},
			readRecordMessagePage: async (sessionId, before, pageSize) => {
				const params = new URLSearchParams();
				if (before !== undefined) params.set("before", String(before));
				if (pageSize !== undefined) params.set("pageSize", String(pageSize));
				const suffix = params.size ? `?${params}` : "";
				return request<Awaited<ReturnType<PiDesktopApi["sessions"]["readRecordMessagePage"]>>>(
					`/api/sessions/${encodeURIComponent(sessionId)}/messages/page${suffix}`,
				);
			},
			// Web 端没有 catalog 文件改写通道；编辑/删除/重发仍走 runtime 命令。
			editCatalogMessage: async () => ({
				ok: false as const,
				error: { code: "SESSION_COMMAND_FAILED" as const, debugDetails: "catalog message mutation is desktop-only" },
			}),
			deleteCatalogMessage: async () => ({
				ok: false as const,
				error: { code: "SESSION_COMMAND_FAILED" as const, debugDetails: "catalog message mutation is desktop-only" },
			}),
			prepareCatalogResend: async () => ({
				ok: false as const,
				error: { code: "SESSION_COMMAND_FAILED" as const, debugDetails: "catalog message mutation is desktop-only" },
			}),
			readProcessEvents: async () => [],
			readReferenceMessages: async (sessionId) => {
				const result = await request<{
					messages: Awaited<ReturnType<PiDesktopApi["sessions"]["readReferenceMessages"]>>;
				}>(`/api/sessions/${encodeURIComponent(sessionId)}/reference-messages`);
				return result.messages;
			},
			sendPrompt: async (input) => {
				const response = await request<{
					result: Awaited<ReturnType<PiDesktopApi["sessions"]["sendPrompt"]>>;
				}>(`/api/sessions/${encodeURIComponent(input.sessionId)}/prompt`, {
					method: "POST",
					body: JSON.stringify(input),
				});
				void refreshState().catch(() => undefined);
				return response.result;
			},
			onRuntimeEvent: (callback) => subscribe(runtimeListeners, callback),
			listRuntimes: async () => {
				const result = await request<{ runtimes: SessionRuntimeInfo[] }>(
					"/api/sessions/runtimes",
				);
				return result.runtimes;
			},
			activateRuntime: async (sessionId) => {
				// The web API intentionally keeps runtime activation lazy; desktop warm-up
				// must never turn a browser session switch into an implicit server spawn.
				return { ok: false, error: { code: "SESSION_NOT_FOUND", debugDetails: sessionId } };
			},
			stopRuntime: async (target) => {
				const result = await sessionRuntimeCommand<SessionRuntimeTarget>(target, "stop");
				void refreshState().catch(() => undefined);
				return result;
			},
			abortRuntime: (target) => sessionRuntimeCommand(target, "abort"),
			restartRuntime: async (target) => {
				const result = await sessionRuntimeCommand<
					Awaited<ReturnType<PiDesktopApi["sessions"]["restartRuntime"]>> extends SessionCommandResult<infer T>
						? T
						: never
				>(target, "restart");
				void refreshState().catch(() => undefined);
				return result;
			},
			compactRuntime: (target, prompt) =>
				sessionRuntimeCommand(target, "compact", { prompt }),
			getRuntimeState: (target) => sessionRuntimeCommand(target, "state"),
			listRuntimeCommands: (target) => sessionRuntimeCommand(target, "commands"),
			listRuntimeModels: (target) => sessionRuntimeCommand(target, "models"),
			exportRuntimeHtml: (target) => sessionRuntimeCommand(target, "export-html"),
			editRuntimeMessage: (target, messageId, newText) =>
				sessionRuntimeCommand(target, "edit-message", { messageId, newText }),
			deleteRuntimeMessage: (target, messageId) =>
				sessionRuntimeCommand(target, "delete-message", { messageId }),
			listRewindCheckpoints: (target) =>
				sessionRuntimeCommand(target, "rewind-list"),
			getRewindCheckpointDiff: (target, checkpointId) =>
				sessionRuntimeCommand(target, "rewind-diff", { checkpointId }),
			restoreRewindCheckpoint: (target, checkpointId, scope) =>
				sessionRuntimeCommand(target, "rewind-restore", { checkpointId, scope }),
			prepareRuntimeResend: (target, messageId) =>
				sessionRuntimeCommand(target, "prepare-resend", { messageId }),
			setRuntimeModel: (target, provider, modelId) =>
				sessionRuntimeCommand(target, "model", { provider, modelId }),
			setRuntimeThinking: (target, level) =>
				sessionRuntimeCommand(target, "thinking", { level }),
			setRuntimePermission: (target, preset) =>
				sessionRuntimeCommand(target, "permission", { preset }),
			cloneRuntime: (target) => sessionRuntimeCommand(target, "clone"),
			getRuntimeForkMessages: (target) =>
				sessionRuntimeCommand(target, "get-fork-messages"),
			forkRuntimeSession: (target, entryId) =>
				sessionRuntimeCommand(target, "fork", { entryId }),
			listDshModels: async () => [],
			discoverDshModels: async () => [],
			listDshProviders: async () => [],
			getDshStatus: async () => ({
				started: false,
				homeDir: "",
				bootError: null,
			}),
			// 浏览器/预览环境无 DSH 后端：按未安装处理（UI 走安装引导，不裸报错）。
			getDshRuntimeStatus: async () => ({ state: "notInstalled" as const }),
			onDshRuntimeStatusChanged: () => () => {},
			installDshRuntime: async () => ({ ok: false, error: "unavailable in browser" }),
			importDshRuntimeFile: async () => ({ ok: false, error: "unavailable in browser" }),
			uninstallDshRuntime: async () => ({ ok: false, error: "unavailable in browser" }),
			onDshRuntimeInstallProgress: () => () => {},
			describeDshSettings: async () => ({ writable: false, hasDocument: false, namespaces: [] }),
			updateDshSettings: async () => undefined,
			mutateDshSettings: async () => undefined,
			describeDshCredentials: async () => ({}),
			setDshCredential: async () => undefined,
			unsetDshCredential: async () => undefined,
			readDshCredential: async () => undefined,
			openDshDocument: async () => undefined,
			restartDshHost: async () => true,
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
