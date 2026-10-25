import { setTimeout as nodeSetTimeout } from "node:timers";
import type { ChatMessage } from "../../shared/types";
import type { VideoGenJobSnapshot, VideoGenJobStatus, VideoGenRequest, VideoGenSubmitResult } from "../../shared/types/videogen";
import type { VideoGenProtocolFamily } from "../../shared/videoGenConfig";
import { buildVideoQueryRequest, buildVideoSubmitRequest, extractVideoVendorError, parseVideoQueryResponse, parseVideoSubmitResponse, videoHttpErrorKind } from "./videoAdapters";
import { isTerminalVideoStatus, type VideoJobRecord } from "./VideoJobStore";

/**
 * 生视频任务运行器：提交 → 轮询 → 流式下载落盘 → 事件推送。
 *
 * 与生图（同步一问一答）的根本差别：视频是分钟级异步任务，主进程必须拥有任务
 * 生命周期——渲染层崩了/重启了任务照跑，恢复后凭 VideoSessionStore + 事件对账。
 *
 * 时序契约：
 * - submit 受理即持久化 user+assistant 占位消息（VideoSessionStore 按 message id
 *   后写覆盖前写），渲染层本地也乐观上屏同 id 占位；
 * - 每次状态迁移 emit 快照（渲染层按 messageId 原地更新占位）；
 * - 终态再持久化一次 assistant 消息（同 id，带 videoRef 或 errorDetail）。
 *
 * 依赖注入（fetch/sleep/now/timers）：测试在 vm 沙箱里跑，跨 realm 的全局
 * setTimeout 不可用，全部经 deps 注入（生产缺省用真实实现，显式 import
 * node:timers，见 AGENTS 测试标准 #4 的教训）。
 */

/** 轮询间隔：5s（上游生成 10s~分钟级，5s 足够跟手且不冒犯限频）。 */
const POLL_INTERVAL_MS = 5_000;
/** 轮询硬上限：从提交算起 20 分钟未成功即判超时（各家长任务普遍 <5min）。 */
const POLL_DEADLINE_MS = 20 * 60 * 1000;
/** 恢复窗口：重启后只恢复 24h 内提交的未终态任务，更旧的按超时结清。 */
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 连续查询失败容忍：网络抖动不判死，连续 10 次（≈50s）才判 network 失败。 */
const MAX_CONSECUTIVE_QUERY_ERRORS = 10;

export class VideoJobRunner {
	private readonly jobs = new Map<string, { record: VideoJobRecord; timer?: NodeJS.Timeout; cancelled: boolean; consecutiveQueryErrors?: number }>();

	constructor(
		private readonly deps: {
			loadJobs: () => Promise<VideoJobRecord[]>;
			saveJobs: (jobs: VideoJobRecord[]) => Promise<void>;
			/** 按供应商 id 取凭据（恢复轮询时回查；查不到 → 任务失败 notConfigured） */
			getCredentials: (providerId: string) => Promise<{ baseUrl: string; apiKey: string; protocol: VideoGenProtocolFamily; name?: string } | null>;
			/** 流式落盘下载响应，返回 blob ref（入参与 VideoBlobStore.putFromResponse 同构） */
			putVideo: (response: { body?: ReadableStream<Uint8Array> | null; headers?: { get(name: string): string | null } }) => Promise<string | null>;
			/** 把消息对追加进会话存储（占位/终态各一次，同 id 后写覆盖） */
			persistMessages: (sessionId: string, messages: ChatMessage[]) => Promise<void>;
			/** 任务状态事件（推渲染层） */
			emit: (snapshot: VideoGenJobSnapshot) => void;
			log: (message: string, ...args: unknown[]) => void;
			fetchImpl?: typeof fetch;
			sleep?: (ms: number) => Promise<void>;
			now?: () => number;
			setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
			clearTimer?: (timer: NodeJS.Timeout) => void;
		},
	) {}

	private get fetchImpl(): typeof fetch {
		return this.deps.fetchImpl ?? fetch;
	}

	private get now(): () => number {
		return this.deps.now ?? Date.now;
	}

	private sleep(ms: number): Promise<void> {
		return (this.deps.sleep ?? ((value: number) => new Promise<void>((resolve) => nodeSetTimeout(resolve, value))))(ms);
	}

	private schedule(timer: { record: VideoJobRecord; timer?: NodeJS.Timeout; cancelled: boolean }, callback: () => void, ms: number): void {
		const set = this.deps.setTimer ?? ((cb: () => void, value: number) => nodeSetTimeout(cb, value));
		const clear = this.deps.clearTimer ?? ((t: NodeJS.Timeout) => clearTimeout(t));
		if (timer.timer) clear(timer.timer);
		timer.timer = set(callback, ms);
	}

	/** 全部任务快照（渲染层重启恢复用）。 */
	listJobs(): VideoGenJobSnapshot[] {
		return [...this.jobs.values()].map((entry) => this.toSnapshot(entry.record));
	}

	/** 某会话的任务快照。 */
	listJobsForSession(sessionId: string): VideoGenJobSnapshot[] {
		return this.listJobs().filter((job) => job.sessionId === sessionId);
	}

	/** 提交任务：受理即持久化占位并启动轮询；失败不产生任何持久化副作用。 */
	async submit(request: VideoGenRequest): Promise<VideoGenSubmitResult> {
		const credentials = await this.deps.getCredentials(request.provider);
		if (!credentials || !credentials.baseUrl.trim() || !credentials.apiKey.trim()) {
			return { ok: false, error: "notConfigured" };
		}
		const submitRequest = buildVideoSubmitRequest(credentials.protocol, {
			baseUrl: credentials.baseUrl,
			apiKey: credentials.apiKey,
			model: request.model,
			prompt: request.prompt,
			resolution: request.resolution,
			duration: request.duration,
			ratio: request.ratio,
		});
		let response: Response;
		try {
			response = await this.fetchImpl(submitRequest.url, {
				method: "POST",
				headers: submitRequest.headers,
				body: submitRequest.body,
				signal: AbortSignal.timeout(60_000),
			});
		} catch (error) {
			this.deps.log("videogen", "submit network error", { reason: error instanceof Error ? error.message : String(error) });
			return { ok: false, error: "network" };
		}
		if (!response.ok) {
			const detail = await readVideoHttpErrorDetail(response);
			this.deps.log("videogen", "submit rejected", { status: response.status, detail });
			return { ok: false, error: videoHttpErrorKind(response.status), detail };
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = null;
		}
		const parsed = parseVideoSubmitResponse(payload);
		if ("error" in parsed) {
			return { ok: false, error: "empty", detail: parsed.error };
		}
		const jobId = randomId();
		// 渲染层乐观上屏时自带 messageId：沿用它，事件回流才能命中同一条占位；未带才本地生成。
		const messageId = request.messageId?.trim() || `vg-${jobId}`;
		const record: VideoJobRecord = {
			jobId,
			sessionId: request.sessionId ?? "",
			messageId,
			provider: request.provider,
			providerName: credentials.baseUrl,
			model: request.model,
			prompt: request.prompt,
			resolution: request.resolution,
			duration: request.duration,
			ratio: request.ratio,
			protocol: credentials.protocol,
			baseUrl: credentials.baseUrl,
			taskId: parsed.taskId,
			status: "queued",
			createdAt: this.now(),
		};
		// providerName：凭据里带展示名则用，否则回退 provider id；渲染层另从配置查全名。
		record.providerName = credentials.name?.trim() || request.provider || "video";
		this.jobs.set(jobId, { record, cancelled: false });
		await this.persistJobs();
		// 受理即持久化占位（重启后时间线仍有「生成中」可恢复；终态时同 id 覆盖）
		await this.persistJobMessages(record);
		this.deps.emit(this.toSnapshot(record));
		this.startPolling(jobId);
		return { ok: true, jobId, messageId };
	}

	/** 取消任务：停止轮询并标记 cancelled（上游可能继续执行与计费，UI 文案如实说明）。 */
	async cancel(jobId: string): Promise<boolean> {
		const entry = this.jobs.get(jobId);
		if (!entry || isTerminalVideoStatus(entry.record.status)) return false;
		entry.cancelled = true;
		entry.record.status = "cancelled";
		entry.record.finishedAt = this.now();
		await this.persistJobs();
		await this.persistJobMessages(entry.record);
		this.deps.emit(this.toSnapshot(entry.record));
		return true;
	}

	/** 重启恢复：载入未终态任务（24h 窗口内）继续轮询，更旧的按超时结清。 */
	async resume(): Promise<number> {
		const stored = await this.deps.loadJobs();
		let resumed = 0;
		for (const record of stored) {
			this.jobs.set(record.jobId, { record, cancelled: false });
		}
		const now = this.now();
		for (const record of stored) {
			if (isTerminalVideoStatus(record.status)) continue;
			if (now - record.createdAt > RESUME_WINDOW_MS) {
				record.status = "timeout";
				record.finishedAt = now;
				await this.persistJobMessages(record);
				this.deps.emit(this.toSnapshot(record));
				continue;
			}
			this.startPolling(record.jobId);
			resumed += 1;
		}
		if (resumed > 0 || stored.length > 0) {
			await this.persistJobs();
		}
		return resumed;
	}

	private startPolling(jobId: string): void {
		const entry = this.jobs.get(jobId);
		if (!entry) return;
		this.schedule(entry, () => void this.pollOnce(jobId), POLL_INTERVAL_MS);
	}

	private async pollOnce(jobId: string): Promise<void> {
		const entry = this.jobs.get(jobId);
		if (!entry || entry.cancelled || isTerminalVideoStatus(entry.record.status)) return;
		const record = entry.record;
		if (this.now() - record.createdAt > POLL_DEADLINE_MS) {
			record.status = "timeout";
			record.finishedAt = this.now();
			await this.finishJob(jobId);
			return;
		}
		const credentials = await this.deps.getCredentials(record.provider);
		if (!credentials) {
			record.status = "failed";
			record.errorDetail = "provider config missing";
			record.finishedAt = this.now();
			await this.finishJob(jobId);
			return;
		}
		const query = buildVideoQueryRequest(credentials.protocol, { baseUrl: record.baseUrl, apiKey: credentials.apiKey, taskId: record.taskId });
		let response: Response;
		try {
			response = await this.fetchImpl(query.url, { method: "GET", headers: query.headers, signal: AbortSignal.timeout(30_000) });
		} catch (error) {
			this.deps.log("videogen", "query network error", { jobId, reason: error instanceof Error ? error.message : String(error) });
			this.bumpQueryErrors(jobId, 0);
			return;
		}
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				record.status = "failed";
				record.errorDetail = await readVideoHttpErrorDetail(response);
				record.finishedAt = this.now();
				await this.finishJob(jobId);
				return;
			}
			if (response.status === 404) {
				// 任务不存在：网关侧已清理或 taskId 失效，等价 generationFailed
				record.status = "failed";
				record.errorDetail = "task not found";
				record.finishedAt = this.now();
				await this.finishJob(jobId);
				return;
			}
			this.bumpQueryErrors(jobId, 0);
			return;
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = null;
		}
		const parsed = parseVideoQueryResponse(payload);
		if (parsed.kind === "error") {
			this.bumpQueryErrors(jobId, 0);
			return;
		}
		this.bumpQueryErrors(jobId, -1);
		if (parsed.status === "failed") {
			record.status = "failed";
			record.errorDetail = extractVideoVendorError(payload) || "generation failed";
			record.finishedAt = this.now();
			await this.finishJob(jobId);
			return;
		}
		if (parsed.status === "succeeded" && parsed.artifactUrl) {
			const videoRef = await this.downloadArtifact(parsed.artifactUrl);
			if (!videoRef) {
				record.status = "failed";
				record.errorDetail = "video download failed";
				record.finishedAt = this.now();
				await this.finishJob(jobId);
				return;
			}
			record.status = "succeeded";
			record.videoRef = videoRef;
			record.finishedAt = this.now();
			await this.finishJob(jobId);
			return;
		}
		// queued / running：状态变化才 emit（轮询每 5s 一次，无变化不刷渲染层）
		if (record.status !== parsed.status) {
			record.status = parsed.status;
			await this.persistJobs();
			this.deps.emit(this.toSnapshot(record));
		}
		this.schedule(entry, () => void this.pollOnce(jobId), POLL_INTERVAL_MS);
	}

	/** 连续查询失败计数：抖动容错（<MAX 不判死），恢复后清零。-1 表示显式清零。 */
	private bumpQueryErrors(jobId: string, reset: number): void {
		const entry = this.jobs.get(jobId);
		if (!entry) return;
		if (reset < 0) {
			entry.consecutiveQueryErrors = 0;
			this.schedule(entry, () => void this.pollOnce(jobId), POLL_INTERVAL_MS);
			return;
		}
		entry.consecutiveQueryErrors = (entry.consecutiveQueryErrors ?? 0) + 1;
		if (entry.consecutiveQueryErrors >= MAX_CONSECUTIVE_QUERY_ERRORS) {
			entry.record.status = "failed";
			entry.record.errorDetail = "network";
			entry.record.finishedAt = this.now();
			void this.finishJob(jobId);
			return;
		}
		this.schedule(entry, () => void this.pollOnce(jobId), POLL_INTERVAL_MS);
	}

	/** 流式下载产物并落盘。 */
	private async downloadArtifact(url: string): Promise<string | null> {
		try {
			const response = await this.fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(300_000) });
			if (!response.ok) {
				this.deps.log("videogen", "artifact download rejected", { status: response.status });
				return null;
			}
			return await this.deps.putVideo(response);
		} catch (error) {
			this.deps.log("videogen", "artifact download error", { reason: error instanceof Error ? error.message : String(error) });
			return null;
		}
	}

	/** 终态收口：持久化任务表 + 消息 + 事件。 */
	private async finishJob(jobId: string): Promise<void> {
		const entry = this.jobs.get(jobId);
		if (!entry) return;
		await this.persistJobs();
		await this.persistJobMessages(entry.record);
		this.deps.emit(this.toSnapshot(entry.record));
	}

	private async persistJobs(): Promise<void> {
		await this.deps.saveJobs([...this.jobs.values()].map((entry) => entry.record));
	}

	/** 持久化任务的 user+assistant 消息对（占位与终态共用 message id，后写覆盖）。 */
	private async persistJobMessages(record: VideoJobRecord): Promise<void> {
		if (!record.sessionId) return;
		const meta = {
			videoGen: {
				status: record.status === "succeeded" ? "complete" : record.status === "queued" ? "queued" : record.status === "running" ? "generating" : "error",
				prompt: record.prompt,
				jobId: record.jobId,
				resolution: record.resolution,
				duration: record.duration,
				ratio: record.ratio,
				videoRef: record.videoRef,
				errorDetail: record.errorDetail,
			},
		};
		const messages: ChatMessage[] = [
			{
				id: `${record.messageId}-u`,
				agentId: "",
				role: "user",
				text: record.prompt,
				timestamp: record.createdAt,
			},
			{
				id: record.messageId,
				agentId: "",
				role: "assistant",
				text: "",
				stopReason: "stop",
				timestamp: record.finishedAt ?? record.createdAt,
				meta,
				videos: record.videoRef ? [{ type: "video", ref: record.videoRef, mimeType: "video/mp4" }] : undefined,
			},
		];
		try {
			await this.deps.persistMessages(record.sessionId, messages);
		} catch (error) {
			// 消息落盘失败不改变任务终态（产物已在 blobs，任务表已存）
			this.deps.log("videogen", "persist messages failed", { jobId: record.jobId, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private toSnapshot(record: VideoJobRecord): VideoGenJobSnapshot {
		return {
			jobId: record.jobId,
			sessionId: record.sessionId,
			provider: record.provider,
			providerName: record.providerName,
			model: record.model,
			prompt: record.prompt,
			resolution: record.resolution,
			duration: record.duration,
			ratio: record.ratio,
			status: record.status,
			videoRef: record.videoRef,
			errorDetail: record.errorDetail,
			createdAt: record.createdAt,
			finishedAt: record.finishedAt,
			messageId: record.messageId,
		};
	}
}

/** 读取非 2xx 响应的可读 detail（截断，脱 key）。 */
async function readVideoHttpErrorDetail(response: { status: number; text: () => Promise<string> }): Promise<string> {
	let body = "";
	try {
		body = await response.text();
	} catch {
		body = "";
	}
	const vendor = extractVideoVendorError(safeJsonParse(body)) || body.replace(/\s+/g, " ").slice(0, 400);
	const combined = vendor ? `${response.status}: ${vendor}` : String(response.status);
	return combined.slice(0, 800);
}

function safeJsonParse(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

function randomId(): string {
	return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
}
