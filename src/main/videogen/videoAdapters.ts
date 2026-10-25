import type { VideoGenProtocolFamily } from "../../shared/videoGenConfig";

/**
 * 视频生成协议适配器（纯函数，无 IO）：把「提交-轮询-下载」三段式异步协议的
 * 各族方言收敛成统一形状。IO（fetch/落盘）全部在 VideoJobRunner，这里只做构包/解析，
 * 因此可以脱离网络单测覆盖。
 *
 * 两个已验证协议族都是 TokenDance 聚合网关方言（baseUrl 指向网关根，路径从这里拼）：
 * - minimax-v2：POST /gateway/minimax/v2/video_generation；
 *   GET /gateway/minimax/v2/query/video_generation/{taskId}。
 *   网关态 queued|running|succeeded|failed|cancelled|expired，产物 task.content.url。
 *   （原生 MiniMax 方言状态值 succuess 为官方拼写错误、产物在 file.download_url——
 *   解析侧两者都认，用户把 baseUrl 指到原生 API 也不至于全军覆没。）
 * - seedance-ark：POST /gateway/ark/v3/generations/tasks；
 *   GET /gateway/ark/v3/generations/tasks/{taskId}。
 *   状态 queued|running|succeeded|failed，产物 content.video_url。
 *
 * 关键工程决策（见调研报告 §2.2）：不依赖网关的统一查询路由
 * （/gateway/v1/video/generations/{id} 跨协议直接 500「异步协议映射失败」），
 * 查询一律走各协议族专用路由。
 */

/** 提交请求（交给 runner 去 fetch）。 */
export type VideoSubmitRequest = {
	url: string;
	headers: Record<string, string>;
	body: string;
};

/** 查询请求（交给 runner 去 fetch）。 */
export type VideoQueryRequest = {
	url: string;
	headers: Record<string, string>;
};

/** 提交参数（runner 从 IPC 请求 + 供应商凭据合并而来）。 */
export type VideoSubmitParams = {
	baseUrl: string;
	apiKey: string;
	model: string;
	prompt: string;
	resolution?: string;
	duration?: string;
	ratio?: string;
};

/** 归一后的查询状态（方言同义词在 parse 阶段压平到这里）。 */
export type NormalizedVideoTaskStatus = "queued" | "running" | "succeeded" | "failed";

/** 查询响应的归一结果。 */
export type ParsedVideoQuery = { kind: "ok"; status: NormalizedVideoTaskStatus; artifactUrl?: string } | { kind: "error"; message: string };

/** 时长合法域：1-30 秒（各模型实际上限更低，这里只做防呆上限，挡误输入）。 */
export function parseVideoDurationSeconds(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw.trim());
	if (!Number.isFinite(value) || value < 1 || value > 30) return undefined;
	return Math.round(value);
}

function authHeaders(apiKey: string): Record<string, string> {
	return {
		Authorization: `Bearer ${apiKey.trim()}`,
		"Content-Type": "application/json",
	};
}

function trimBase(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * 分辨率大小写按协议族归一（实测 TokenDance 网关 2026-03：minimax-v2 收 "480P"，
 * seedance-ark 收 "480p"；用户从设置页填什么大小写都不该影响受理）。
 */
function normalizeResolution(family: VideoGenProtocolFamily, resolution: string): string {
	const trimmed = resolution.trim();
	return family === "seedance-ark" ? trimmed.toLowerCase() : trimmed.toUpperCase();
}

/** 厂商状态方言 → 归一状态。未知值返回 undefined（调用方按仍需轮询处理）。 */
export function normalizeVideoTaskStatus(raw: unknown): NormalizedVideoTaskStatus | undefined {
	if (typeof raw !== "string") return undefined;
	const value = raw.trim().toLowerCase();
	// minimax 原生方言的 "succuess" 是官方拼写错误，这里一并归一
	if (value === "succuess" || value === "succeed" || value === "succeeded" || value === "success" || value === "completed" || value === "done") return "succeeded";
	if (value === "failed" || value === "error") return "failed";
	if (value === "running" || value === "processing" || value === "preparing" || value === "generating") return "running";
	if (value === "queued" || value === "pending" || value === "waiting" || value === "created") return "queued";
	return undefined;
}

/**
 * 构建提交请求体。duration 转数字；未提供的可选参数不发（避免未知字段 400）。
 * 两个协议族的 body 都是 {model, content:[{type:"text"}], …} 形态，差异只在路径。
 */
export function buildVideoSubmitRequest(family: VideoGenProtocolFamily, params: VideoSubmitParams): VideoSubmitRequest {
	const base = trimBase(params.baseUrl);
	const content: Array<{ type: "text"; text: string }> = [{ type: "text", text: params.prompt }];
	// 只发有值的字段：各家对未知/空字段的处理不一，缺省字段由上游用模型默认
	const body: Record<string, unknown> = { model: params.model, content };
	const duration = parseVideoDurationSeconds(params.duration);
	if (params.resolution) body.resolution = normalizeResolution(family, params.resolution);
	if (duration !== undefined) body.duration = duration;
	if (params.ratio) body.ratio = params.ratio;
	const path = family === "seedance-ark" ? "/gateway/ark/v3/generations/tasks" : "/gateway/minimax/v2/video_generation";
	return {
		url: `${base}${path}`,
		headers: authHeaders(params.apiKey),
		body: JSON.stringify(body),
	};
}

/** 构建查询请求：各族专用查询路由（不走统一路由，理由见文件头）。 */
export function buildVideoQueryRequest(family: VideoGenProtocolFamily, input: { baseUrl: string; apiKey: string; taskId: string }): VideoQueryRequest {
	const base = trimBase(input.baseUrl);
	const path = family === "seedance-ark" ? `/gateway/ark/v3/generations/tasks/${encodeURIComponent(input.taskId)}` : `/gateway/minimax/v2/query/video_generation/${encodeURIComponent(input.taskId)}`;
	return { url: `${base}${path}`, headers: authHeaders(input.apiKey) };
}

/** 解析提交响应：{task_id}（minimax 网关/原生同形）或 {id}（Ark）。 */
export function parseVideoSubmitResponse(payload: unknown): { taskId: string } | { error: string } {
	if (typeof payload === "object" && payload !== null) {
		for (const key of ["task_id", "taskId", "id"]) {
			const value = Reflect.get(payload, key);
			if (typeof value === "string" && value.trim()) return { taskId: value.trim() };
		}
	}
	return { error: extractVideoVendorError(payload) || "empty submit response" };
}

/**
 * 解析查询响应：状态归一 + 产物 URL 候选位。
 * minimax 网关产物在 task.content.url（响应可能是 {task:{...}} 包裹或直接平铺），
 * 原生在 file.download_url；Ark 在 content.video_url。候选位按序探测。
 */
export function parseVideoQueryResponse(payload: unknown): ParsedVideoQuery {
	if (typeof payload !== "object" || payload === null) return { kind: "error", message: "malformed query response" };
	const root = payload as Record<string, unknown>;
	// minimax 方言可能把任务包在 task 字段里，ark 平铺；两种都探测
	const taskRoot = (typeof root.task === "object" && root.task !== null ? (root.task as Record<string, unknown>) : null) ?? root;
	const rawStatus = taskRoot.status ?? root.status;
	const status = normalizeVideoTaskStatus(rawStatus);
	if (status === undefined) return { kind: "error", message: `unknown task status: ${String(rawStatus)}` };
	if (status === "failed") {
		return { kind: "ok", status, artifactUrl: undefined };
	}
	if (status !== "succeeded") return { kind: "ok", status };
	const artifactUrl = findArtifactUrl(taskRoot) ?? findArtifactUrl(root);
	if (!artifactUrl) return { kind: "error", message: "succeeded without artifact url" };
	return { kind: "ok", status, artifactUrl };
}

/** 产物 URL 候选位探测：minimax 网关 content.url / 原生 file.download_url / ark content.video_url。 */
function findArtifactUrl(source: Record<string, unknown>): string | undefined {
	const content = source.content;
	if (typeof content === "object" && content !== null) {
		const url = Reflect.get(content, "url") ?? Reflect.get(content, "video_url");
		if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) return url.trim();
	}
	const file = source.file;
	if (typeof file === "object" && file !== null) {
		const url = Reflect.get(file, "download_url");
		if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) return url.trim();
	}
	// 兜底：artifacts 数组（webhook 文档里的形态）
	const artifacts = source.artifacts;
	if (Array.isArray(artifacts)) {
		for (const item of artifacts) {
			if (typeof item === "object" && item !== null) {
				const url = Reflect.get(item, "url");
				if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) return url.trim();
			}
		}
	}
	return undefined;
}

/** 从厂商错误响应里抽出可读文案（error.message 优先，长度截断）。 */
export function extractVideoVendorError(payload: unknown): string {
	if (typeof payload !== "object" || payload === null) return "";
	const direct = extractVideoVendorErrorFields(payload as Record<string, unknown>);
	if (direct) return direct;
	// minimax 网关方言把任务体包在 task 里，错误也随之嵌套（parseVideoQueryResponse 同样探测 task）
	const task = Reflect.get(payload, "task");
	if (typeof task === "object" && task !== null) return extractVideoVendorErrorFields(task as Record<string, unknown>);
	return "";
}

function extractVideoVendorErrorFields(source: Record<string, unknown>): string {
	const errorField = Reflect.get(source, "error");
	const candidates: unknown[] = [];
	if (typeof errorField === "object" && errorField !== null) {
		candidates.push(Reflect.get(errorField, "message"), Reflect.get(errorField, "msg"), Reflect.get(errorField, "code"));
	} else if (typeof errorField === "string") {
		candidates.push(errorField);
	}
	candidates.push(Reflect.get(source, "message"), Reflect.get(source, "msg"), Reflect.get(source, "base_resp"));
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 400);
		if (typeof candidate === "object" && candidate !== null) {
			// minimax 原生把错误放 base_resp:{status_msg}
			const message = Reflect.get(candidate, "status_msg");
			if (typeof message === "string" && message.trim()) return message.trim().slice(0, 400);
		}
	}
	return "";
}

/** HTTP 状态 → 结构化错误码（与 ImageGenErrorCode 同语义）。 */
export function videoHttpErrorKind(status: number): "invalidKey" | "badBaseUrl" | "http" {
	if (status === 401 || status === 403) return "invalidKey";
	if (status === 404 || status === 405) return "badBaseUrl";
	return "http";
}
