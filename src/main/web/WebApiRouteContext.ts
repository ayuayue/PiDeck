import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRuntimeState, CreateAnonymousSessionInput, CreateSessionDraftInput, ImageContent, SendSessionPromptInput, SessionRuntimeTarget, SessionUiResponseInput, UpdateSessionRecordInput } from "../../shared/types";
import { buildAgentSessionTitle, type AgentProfile } from "../../shared/types/agentProfile";
import { readBoundedFile, WEB_CORS_HEADERS } from "./WebHttpResponders";
import { ifNoneMatchHits, stateEtag } from "./WebStateEtag";
import { toWebSecurityState } from "./WebSecurityProjection";
import type { WebServiceDependencies } from "./WebServiceManager";

const CHAT_IMAGE_MAX_COUNT = 4;
const CHAT_IMAGE_MAX_BASE64_BYTES = 2 * 1024 * 1024;

/**
 * 智能体对 Web 端的投影：桌面「智能体」页的字段子集——详情面板要展示角色设定，
 * 会话页提示条只需要名字/图标。`createdAt` 这类内部记账字段没有消费方，不下发。
 */
export function toWebAgentProjection(agent: AgentProfile) {
	return {
		id: agent.id,
		name: agent.name,
		description: agent.description,
		icon: agent.icon,
		category: agent.category,
		builtin: agent.builtin === true,
		...(agent.backend ? { backend: agent.backend } : {}),
		...(agent.model ? { model: agent.model } : {}),
		...(agent.systemPrompt ? { systemPrompt: agent.systemPrompt } : {}),
		usageCount: agent.usageCount,
		updatedAt: agent.updatedAt,
	};
}

/**
 * 从 useChat 提交的 user 消息 parts 里提取图片（type=file）转 ImageContent。
 * data 兼容三种形态：data URL（data:<mime>;base64,<payload>，AI SDK v5+
 * 的 file part 把它放在 url 字段）、裸 base64；非 image/* 媒体、超限图片
 * 直接丢弃，不影响文本轮次。
 */
export function extractChatImages(parts: Array<{ type?: string; mediaType?: string; data?: string; url?: string }>): ImageContent[] {
	const images: ImageContent[] = [];
	for (const part of parts) {
		const raw = typeof part.data === "string" && part.data ? part.data : typeof part.url === "string" ? part.url : "";
		if (part.type !== "file" || !raw) continue;
		if (images.length >= CHAT_IMAGE_MAX_COUNT) break;
		let mimeType = typeof part.mediaType === "string" ? part.mediaType : "";
		let payload = raw;
		const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.*)$/s);
		if (dataUrlMatch) {
			mimeType = mimeType || dataUrlMatch[1];
			payload = dataUrlMatch[2];
		}
		if (!mimeType.startsWith("image/")) continue;
		if (payload.length > CHAT_IMAGE_MAX_BASE64_BYTES) continue;
		images.push({ type: "image", mimeType, data: payload });
	}
	return images;
}

/** 路由需要宿主提供的能力面（manager 用薄箭头函数适配；private 成员不进接口）。 */

export type WebApiRoutesPort = {
	deps: WebServiceDependencies;
	sendJson: (response: ServerResponse, body: unknown, extraHeaders?: Record<string, string>) => void;
	sendError: (response: ServerResponse, statusCode: number, code: string, error: string, params?: Record<string, string | number>) => void;
	sendNoContent: (response: ServerResponse) => void;
	readJson: <T>(request: IncomingMessage, maxBytes?: number) => Promise<T>;
	/** /api/state 载荷：这里只声明 ETag 需要的字段面，具体结构由装配层决定。 */
	getState: () => Promise<{ projects?: unknown[]; sessions?: unknown[]; runtimes?: unknown[]; pendingUiRequests?: unknown[] }>;
	queryNumber: (url: URL, key: string) => number | undefined;
	runtimeAgentIdForSession: (sessionId: string) => string | undefined;
	runtimeTargetForSession: (sessionId: string) => SessionRuntimeTarget | undefined;
	executeRestartWithProgress: (target: SessionRuntimeTarget, response: ServerResponse) => Promise<void>;
	handleStream: (sessionId: string, request: IncomingMessage, response: ServerResponse, options?: { keepAlive?: boolean }) => void;
	writeStreamError: (response: ServerResponse, errorText: string) => void;
};

/** 各路由组的公共上下文：port 的十二个能力在这里解成字段，子类只写路由体。 */
export abstract class WebApiRouteContext {
	protected readonly deps: WebServiceDependencies;
	protected readonly sendJson: WebApiRoutesPort["sendJson"];
	protected readonly sendError: WebApiRoutesPort["sendError"];
	protected readonly sendNoContent: WebApiRoutesPort["sendNoContent"];
	protected readonly readJson: WebApiRoutesPort["readJson"];
	protected readonly getState: WebApiRoutesPort["getState"];
	protected readonly queryNumber: WebApiRoutesPort["queryNumber"];
	protected readonly runtimeAgentIdForSession: WebApiRoutesPort["runtimeAgentIdForSession"];
	protected readonly runtimeTargetForSession: WebApiRoutesPort["runtimeTargetForSession"];
	protected readonly executeRestartWithProgress: WebApiRoutesPort["executeRestartWithProgress"];
	protected readonly handleStream: WebApiRoutesPort["handleStream"];
	protected readonly writeStreamError: WebApiRoutesPort["writeStreamError"];

	constructor(port: WebApiRoutesPort) {
		this.deps = port.deps;
		this.sendJson = port.sendJson;
		this.sendError = port.sendError;
		this.sendNoContent = port.sendNoContent;
		this.readJson = port.readJson;
		this.getState = port.getState;
		this.queryNumber = port.queryNumber;
		this.runtimeAgentIdForSession = port.runtimeAgentIdForSession;
		this.runtimeTargetForSession = port.runtimeTargetForSession;
		this.executeRestartWithProgress = port.executeRestartWithProgress;
		this.handleStream = port.handleStream;
		this.writeStreamError = port.writeStreamError;
	}
}
