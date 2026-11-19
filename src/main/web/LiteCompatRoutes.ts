/**
 * PiDeck Lite 移动端兼容层。
 *
 * PiDeck Lite 的手机 App 是原生 NSGo UI，只认它自己的一套 `/api/*` JSON 契约
 * （见 Lite `internal/client/remote_client.go`）。本模块在 PiDeck 现有 Web 端口上
 * 提供对应端点，让该 App 能连接并操作 PiDeck：
 *
 * 只读：
 * - `GET /api/ping`             健康/身份
 * - `GET /api/state`            Lite Snapshot（`projects[].sessions[]`）
 * - `GET /api/session/{id}`     Lite Transcript（消息拍平为 `{role,text}`）
 * - `GET /api/session/{id}/options` 模型/思考档位
 *
 * 写入：
 * - `POST /api/sessions`             新建会话（Lite 传项目路径）
 * - `POST /api/sessions/{id}/prompt` 发消息（含图片）
 * - `POST /api/sessions/{id}/model|thinking|stop|rename|pin|answer`
 *
 * 流式：手机端没有 SSE，约每 1.5s 轮询 `/api/session/{id}`；该接口在轮询时追加
 * PiDeck `LiveStreamChannel` 的实时正文，形成打字机效果（终态落盘后自动去重）。
 *
 * 路径冲突：`/api/state`、`POST /api/sessions`、`POST /api/sessions/{id}/prompt`
 * 与 PiDeck 自己的路由同路径，仅当请求来自 Lite 客户端（Go 默认
 * `User-Agent: Go-http-client/...`）时才走本模块；其余请求原样交还 PiDeck。
 * 整体由设置开关 `webLiteCompatEnabled` 控制，默认关闭。
 *
 * 边界：不实现任务、收藏、PR、文件、Git、draft 工具、生图等扩展端点；
 * 置顶在 PiDeck 里存于设置，当前版本按成功空操作处理（不持久化）。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname, release } from "node:os";
import type { AvailableModel, ChatMessage, ImageContent, Project, SendSessionPromptInput, SessionRuntimeTarget, SessionUiResponseInput } from "../../shared/types";
import { MODEL_THINKING_LEVELS } from "../../shared/modelThinkingLevels";
import type { PendingUiRequestSnapshot } from "../sessions/SessionRuntimeCoordinator";
import type { WebPublicSession } from "./WebSessionProjection";

/** 兼容层所需的 PiDeck 状态面（与 WebServiceManager.getState 的结构对齐）。 */
export type LiteCompatState = {
	projects?: Project[];
	sessions?: WebPublicSession[];
	runtimes?: SessionRuntimeInfoLike[];
	pendingUiRequests?: PendingUiRequestSnapshot[];
};

type SessionRuntimeInfoLike = { sessionId: string; status?: string };

type LiteAsk = {
	method: string;
	title: string;
	message: string;
	options?: string[];
};

type LiteSession = {
	id: string;
	title: string;
	status: string;
	updated: number;
	external: boolean;
	pinned: boolean;
	running: boolean;
	ask?: LiteAsk;
};

type LiteProject = {
	path: string;
	name: string;
	sessions: LiteSession[];
};

export type LiteSnapshot = {
	name: string;
	version: string;
	host: string;
	projects: LiteProject[];
};

export type LiteTranscript = {
	id: string;
	title: string;
	running: boolean;
	messages: Array<{ role: string; text: string }>;
	/** 0 = 没有更早的页；POC 忽略 `?before=`，手机端因此不显示「加载更早」。 */
	before: number;
	truncated?: boolean;
	ask?: LiteAsk;
};

export type LiteOptions = {
	models: Array<{ id: string; name: string; provider: string; reasoning: boolean }>;
	model: string;
	provider: string;
	thinking: string;
	levels: string[];
	ready: boolean;
};

export type LiteCompatDeps = {
	getState: () => Promise<LiteCompatState>;
	readSessionMessages: (sessionId: string) => Promise<{ messages: ChatMessage[]; truncated: boolean }>;
	getAppVersion?: () => string;
	/** 运行中 agent 的实时正文（已剥 ANSI）；手机轮询时追加为末尾 assistant 消息。 */
	getLiveText?: (sessionId: string) => string;
	listProjects: () => Project[];
	listModels: () => Promise<AvailableModel[]>;
	createSession: (input: { projectId: string; title?: string }) => Promise<{ id: string; title: string }>;
	sendPrompt: (input: SendSessionPromptInput) => Promise<{ accepted: boolean; error?: string }>;
	getRuntimeTarget: (sessionId: string) => SessionRuntimeTarget | undefined;
	activateRuntime?: (sessionId: string) => Promise<unknown>;
	setModel: (target: SessionRuntimeTarget, provider: string, modelId: string, modelName?: string) => Promise<unknown>;
	setThinking: (target: SessionRuntimeTarget, level: string) => Promise<unknown>;
	stopRuntime: (target: SessionRuntimeTarget) => Promise<unknown>;
	updateSession: (sessionId: string, patch: { title?: string }) => Promise<unknown>;
	respondToUi: (input: SessionUiResponseInput) => Promise<void>;
	readJson: <T>(request: IncomingMessage, maxBytes?: number) => Promise<T>;
	sendJson: (response: ServerResponse, body: unknown) => void;
	sendError: (response: ServerResponse, statusCode: number, code: string, error: string) => void;
};

/** Lite 客户端识别：Go 默认 HTTP 客户端 UA（浏览器不会发送）。 */
export function isLiteClientUserAgent(value: string | string[] | undefined): boolean {
	const ua = Array.isArray(value) ? value[0] : value;
	return typeof ua === "string" && ua.startsWith("Go-http-client/");
}

/** `/api/ping` 回复（Lite remotePing 同形）。 */
export function toLitePing(version: string): { name: string; version: string; host: string; os: string } {
	return { name: "PiDeck", version, host: hostname(), os: `${process.platform} ${release()}` };
}

/** PiDeck 会话消息 → Lite 消息：跳过思考副本，避免手机端把推理重复显示成正文。 */
export function flattenChatMessage(message: ChatMessage): { role: string; text: string } {
	return { role: message.role, text: message.textWithoutThinking ?? message.text ?? "" };
}

/** 待回答请求 → Lite Ask。 */
export function toLiteAsk(request: PendingUiRequestSnapshot): LiteAsk {
	return {
		method: request.method,
		title: request.title,
		message: "",
		...(request.options && request.options.length > 0 ? { options: request.options } : {}),
	};
}

/** PiDeck 状态 → Lite Snapshot：按 projectId 分组，running/ask 由 runtime 与待答请求推导。 */
export function toLiteSnapshot(state: LiteCompatState, version: string): LiteSnapshot {
	const projects = state.projects ?? [];
	const sessions = state.sessions ?? [];
	const runtimes = state.runtimes ?? [];
	const runtimeBySession = new Map(runtimes.map((runtime) => [runtime.sessionId, runtime]));
	const askBySession = new Map((state.pendingUiRequests ?? []).map((request) => [request.sessionId, toLiteAsk(request)]));

	const grouped = new Map<string, LiteSession[]>();
	const pathByProject = new Map<string, string>();
	for (const session of sessions) {
		if (session.projectPath && !pathByProject.has(session.projectId)) pathByProject.set(session.projectId, session.projectPath);
		const list = grouped.get(session.projectId) ?? [];
		list.push(toLiteSession(session, runtimeBySession.get(session.id), askBySession.get(session.id)));
		grouped.set(session.projectId, list);
	}

	const knownProjectIds = new Set(projects.map((project) => project.id));
	const liteProjects: LiteProject[] = projects.map((project) => ({
		path: projectPath(project) || pathByProject.get(project.id) || "",
		name: project.name,
		sessions: sortSessions(grouped.get(project.id) ?? []),
	}));

	// 会话的 projectId 不在项目目录里（目录被移除/远端未加载）：仍归到一个合成项目，避免会话凭空消失。
	for (const [projectId, list] of grouped) {
		if (knownProjectIds.has(projectId)) continue;
		const path = pathByProject.get(projectId) ?? "";
		liteProjects.push({ path, name: path ? basenameLoose(path) : projectId, sessions: sortSessions(list) });
	}

	return { name: "PiDeck", version, host: hostname(), projects: liteProjects };
}

/** 读会话页 → Lite Transcript。`liveText` 是运行中 agent 的实时正文，作为末尾 assistant 消息追加。 */
export function toLiteTranscript(input: { sessionId: string; title?: string; running?: boolean; messages: ChatMessage[]; truncated?: boolean; ask?: LiteAsk; liveText?: string }): LiteTranscript {
	const messages = input.messages.map(flattenChatMessage);
	const liveText = input.liveText?.trim() ? input.liveText : "";
	if (liveText) {
		const last = messages[messages.length - 1];
		// 终态消息可能已经包含这段正文（message_end 与下一次轮询之间）：避免重复追加。
		const already = last?.role === "assistant" && last.text.includes(liveText);
		if (!already) messages.push({ role: "assistant", text: liveText });
	}
	return {
		id: input.sessionId,
		title: input.title ?? "",
		running: input.running ?? false,
		messages,
		before: 0,
		...(input.truncated ? { truncated: true } : {}),
		...(input.ask ? { ask: input.ask } : {}),
	};
}

/** 会话选项：模型目录 + 当前模型/思考档位。 */
export function toLiteOptions(models: AvailableModel[], session: WebPublicSession | undefined): LiteOptions {
	const provider = session?.model?.provider ?? "";
	const modelId = session?.model?.modelId ?? "";
	const current = models.find((model) => model.provider === provider && model.id === modelId);
	const levels = current?.thinkingLevels ?? current?.reasoningEfforts?.map((effort) => effort.id) ?? [...MODEL_THINKING_LEVELS];
	return {
		models: models.map((model) => ({ id: model.id, name: model.name ?? model.id, provider: model.provider, reasoning: model.reasoning === true })),
		model: modelId,
		provider,
		thinking: session?.thinkingLevel ?? "",
		levels,
		ready: models.length > 0,
	};
}

function toLiteSession(session: WebPublicSession, runtime: SessionRuntimeInfoLike | undefined, ask: LiteAsk | undefined): LiteSession {
	return {
		id: session.id,
		title: session.title,
		status: session.status,
		// Lite 的 Go 结构是 int64：updatedAt 可能带小数毫秒，必须截断，否则 encoding/json 直接报错。
		updated: Math.trunc(session.updatedAt ?? 0),
		external: false,
		pinned: false,
		running: runtime?.status === "running" || runtime?.status === "starting",
		...(ask ? { ask } : {}),
	};
}

function sortSessions(list: LiteSession[]): LiteSession[] {
	return [...list].sort((a, b) => b.updated - a.updated);
}

function projectPath(project: Project): string {
	if ("path" in project && typeof project.path === "string" && project.path) return project.path;
	if ("locator" in project && project.locator && "remotePath" in project.locator) return project.locator.remotePath;
	return "";
}

function basenameLoose(path: string): string {
	const parts = path.split(/[\\/]+/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** 项目路径 → projectId（先精确匹配，再忽略分隔符/大小写兜底，兼容 Windows）。 */
function resolveProjectId(projects: Project[], path: string): string {
	const raw = path.trim();
	if (!raw) return "";
	const exact = projects.find((project) => projectPath(project) === raw);
	if (exact) return exact.id;
	const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const loose = projects.find((project) => normalize(projectPath(project)) === normalize(raw));
	return loose?.id ?? "";
}

/** PiDeck 运行时命令返回 `{ok:false,error}` 时取可读错误；成功返回 null。 */
function commandError(result: unknown): string | null {
	if (result && typeof result === "object" && "ok" in result && (result as { ok?: unknown }).ok === false) {
		const error = (result as { error?: unknown }).error;
		return typeof error === "string" && error ? error : "操作失败";
	}
	return null;
}

/** Lite 兼容路由：命中返回 true，否则 false（交还 PiDeck 原路由）。 */
export class LiteCompatRoutes {
	constructor(private readonly deps: LiteCompatDeps) {}

	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (request.method === "GET") return this.handleGet(url, request, response);
		if (request.method === "POST") return this.handlePost(url, request, response);
		return false;
	}

	private async handleGet(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (url.pathname === "/api/ping") {
			this.deps.sendJson(response, toLitePing(this.version()));
			return true;
		}
		if (url.pathname === "/api/state") {
			// 同路径冲突：只有 Lite 客户端拿 Lite 形状，浏览器仍走 PiDeck 原路由。
			if (!isLiteClientUserAgent(request.headers["user-agent"])) return false;
			this.deps.sendJson(response, toLiteSnapshot(await this.deps.getState(), this.version()));
			return true;
		}
		const optionsMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/options$/);
		if (optionsMatch) {
			const sessionId = decodeURIComponent(optionsMatch[1]);
			const state = await this.deps.getState();
			this.deps.sendJson(
				response,
				toLiteOptions(
					await this.deps.listModels(),
					state.sessions?.find((session) => session.id === sessionId),
				),
			);
			return true;
		}
		const transcriptMatch = url.pathname.match(/^\/api\/session\/([^/]+)$/);
		if (transcriptMatch) {
			await this.handleTranscript(decodeURIComponent(transcriptMatch[1]), response);
			return true;
		}
		return false;
	}

	private async handlePost(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const lite = isLiteClientUserAgent(request.headers["user-agent"]);

		// 与 PiDeck 同路径：只接管 Lite 客户端。
		if (url.pathname === "/api/sessions") {
			if (!lite) return false;
			await this.handleCreateSession(request, response);
			return true;
		}
		const promptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
		if (promptMatch) {
			if (!lite) return false;
			await this.handlePrompt(decodeURIComponent(promptMatch[1]), request, response);
			return true;
		}

		// 不与 PiDeck 现有路径冲突的写入口。
		const actionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(model|thinking|stop|rename|pin|answer)$/);
		if (actionMatch) {
			await this.handleSessionAction(decodeURIComponent(actionMatch[1]), actionMatch[2], request, response);
			return true;
		}
		return false;
	}

	private async handleTranscript(sessionId: string, response: ServerResponse): Promise<void> {
		try {
			const window = await this.deps.readSessionMessages(sessionId);
			const state = await this.deps.getState();
			const meta = state.sessions?.find((session) => session.id === sessionId);
			const runtime = state.runtimes?.find((item) => item.sessionId === sessionId);
			const ask = state.pendingUiRequests?.find((pending) => pending.sessionId === sessionId);
			this.deps.sendJson(
				response,
				toLiteTranscript({
					sessionId,
					title: meta?.title,
					running: runtime?.status === "running" || runtime?.status === "starting",
					messages: window.messages,
					truncated: window.truncated,
					ask: ask ? toLiteAsk(ask) : undefined,
					liveText: this.deps.getLiveText?.(sessionId),
				}),
			);
		} catch (error) {
			this.deps.sendError(response, 404, "liteCompat.sessionUnavailable", error instanceof Error ? error.message : String(error));
		}
	}

	private async handleCreateSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			const body = await this.deps.readJson<{ project?: string; title?: string }>(request);
			const projectId = resolveProjectId(this.deps.listProjects(), typeof body?.project === "string" ? body.project : "");
			if (!projectId) {
				this.deps.sendError(response, 400, "liteCompat.projectNotFound", "project not found");
				return;
			}
			const session = await this.deps.createSession({ projectId, ...(typeof body?.title === "string" && body.title.trim() ? { title: body.title.trim() } : {}) });
			this.deps.sendJson(response, { id: session.id, title: session.title });
		} catch (error) {
			this.deps.sendError(response, 400, "liteCompat.createFailed", error instanceof Error ? error.message : String(error));
		}
	}

	private async handlePrompt(sessionId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			const body = await this.deps.readJson<{ text?: string; images?: Array<{ mime?: string; data?: string }> }>(request);
			const message = typeof body?.text === "string" ? body.text : "";
			const images: ImageContent[] = [];
			for (const raw of Array.isArray(body?.images) ? body.images : []) {
				const mime = typeof raw?.mime === "string" ? raw.mime : "";
				const data = typeof raw?.data === "string" ? raw.data : "";
				if (mime.startsWith("image/") && data) images.push({ type: "image", mimeType: mime, data });
			}
			if (!message.trim() && images.length === 0) {
				this.deps.sendError(response, 400, "liteCompat.messageRequired", "message or images is required");
				return;
			}
			const result = await this.deps.sendPrompt({ sessionId, message, images, requestId: randomUUID() });
			if (result && result.accepted === false) {
				this.deps.sendError(response, 400, "liteCompat.promptRejected", result.error ?? "prompt rejected");
				return;
			}
			this.deps.sendJson(response, { ok: true });
		} catch (error) {
			this.deps.sendError(response, 400, "liteCompat.promptFailed", error instanceof Error ? error.message : String(error));
		}
	}

	private async handleSessionAction(sessionId: string, action: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			switch (action) {
				case "rename": {
					const body = await this.deps.readJson<{ title?: string }>(request);
					const title = typeof body?.title === "string" ? body.title.trim() : "";
					if (!title) {
						this.deps.sendError(response, 400, "liteCompat.titleRequired", "title is required");
						return;
					}
					await this.deps.updateSession(sessionId, { title });
					this.deps.sendJson(response, { ok: true });
					return;
				}
				case "pin": {
					// PiDeck 的置顶存在设置里，Web deps 未暴露写入口：先按成功空操作，避免手机端报错。
					this.deps.sendJson(response, { ok: true });
					return;
				}
				case "answer": {
					const state = await this.deps.getState();
					const pending = state.pendingUiRequests?.find((item) => item.sessionId === sessionId);
					if (!pending) {
						this.deps.sendError(response, 409, "liteCompat.noPendingAsk", "no pending question for this session");
						return;
					}
					const body = await this.deps.readJson<SessionUiResponseInput["response"] | null>(request);
					await this.deps.respondToUi({
						sessionId,
						requestId: pending.requestId,
						agentId: pending.agentId,
						runtimeGeneration: pending.runtimeGeneration,
						response: body && typeof body === "object" ? body : {},
					});
					this.deps.sendJson(response, { ok: true });
					return;
				}
				case "stop": {
					const target = this.deps.getRuntimeTarget(sessionId);
					if (!target) {
						// 没有运行中的 runtime：停止是空操作，直接成功（手机端可能重复点停止）。
						this.deps.sendJson(response, { ok: true });
						return;
					}
					const error = commandError(await this.deps.stopRuntime(target));
					if (error) this.deps.sendError(response, 400, "liteCompat.stopFailed", error);
					else this.deps.sendJson(response, { ok: true });
					return;
				}
				case "model": {
					const body = await this.deps.readJson<{ provider?: string; id?: string; name?: string }>(request);
					const target = await this.runtimeTarget(sessionId);
					if (!target) {
						this.deps.sendError(response, 409, "liteCompat.runtimeUnavailable", "session runtime is not available");
						return;
					}
					const error = commandError(await this.deps.setModel(target, typeof body?.provider === "string" ? body.provider : "", typeof body?.id === "string" ? body.id : "", typeof body?.name === "string" ? body.name : undefined));
					if (error) this.deps.sendError(response, 400, "liteCompat.modelFailed", error);
					else this.deps.sendJson(response, { ok: true });
					return;
				}
				case "thinking": {
					const body = await this.deps.readJson<{ level?: string }>(request);
					const target = await this.runtimeTarget(sessionId);
					if (!target) {
						this.deps.sendError(response, 409, "liteCompat.runtimeUnavailable", "session runtime is not available");
						return;
					}
					const error = commandError(await this.deps.setThinking(target, typeof body?.level === "string" ? body.level : ""));
					if (error) this.deps.sendError(response, 400, "liteCompat.thinkingFailed", error);
					else this.deps.sendJson(response, { ok: true });
					return;
				}
			}
		} catch (error) {
			this.deps.sendError(response, 400, "liteCompat.actionFailed", error instanceof Error ? error.message : String(error));
		}
	}

	/** 冷会话先激活再取 target；激活失败/仍无 runtime 返回 undefined。 */
	private async runtimeTarget(sessionId: string): Promise<SessionRuntimeTarget | undefined> {
		const existing = this.deps.getRuntimeTarget(sessionId);
		if (existing) return existing;
		if (!this.deps.activateRuntime) return undefined;
		try {
			await this.deps.activateRuntime(sessionId);
		} catch {
			return undefined;
		}
		return this.deps.getRuntimeTarget(sessionId);
	}

	private version(): string {
		return this.deps.getAppVersion?.() ?? "";
	}
}
