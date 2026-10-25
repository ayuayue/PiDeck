import { createHash } from "node:crypto";
import type { SessionFactsCoverage, SessionFactsResult, SessionProcessEvent, SessionProcessEventKind } from "../../shared/types/trajectory";
import type { SessionFactEntry, SessionFactIndexSnapshot } from "../pi/SessionHistoryReader";
import { MAX_EVENTS, createSessionProcessCollector, retainProcessEvents } from "./sessionProcessEvents";

/**
 * 轨迹事实读取器（pi 后端）。
 *
 * 为什么要有这一层：轨迹面板的历史入口原先直接流式扫整个会话文件，
 * 每次 token flush（~20 次/秒）都可能重扫一遍（实测 38.8MB 会话单次 117ms）。
 * 这里改为「索引选候选 → 小批读正文 → 重放」，文件没变时正文读取为 0。
 *
 * 边界（计划 docs/trajectory-session-consumer-plan.md §3.2）：
 * - 候选 ≤512、正文合计 ≤8MiB、单行 ≤1MiB；
 * - 超限只标记 coverage，不在主进程循环追数据，也不回退成全文件扫描；
 * - 提示词快照是固定项，不被事件保留上限裁掉。
 */

/** 正文候选上限（含超限/损坏项，防畸形会话靠海量小条目刷工作量）。 */
export const MAX_FACT_CANDIDATES = 512;
/** 单次事实正文读取总字节上限。 */
export const MAX_FACT_BODY_BYTES = 8 * 1024 * 1024;
/** 单行正文上限：超限跳过并标记 partial（不分配该行大小的 Buffer）。 */
export const MAX_FACT_LINE_BYTES = 1024 * 1024;
/** 主进程事实缓存：视图数与序列化量双限制。 */
export const MAX_FACT_VIEWS = 8;
export const MAX_FACT_VIEW_BYTES = 8 * 1024 * 1024;
/** 单份事实结果的序列化上限：超了先裁普通 detail，再缩事件保留量。 */
export const MAX_FACT_PAYLOAD_BYTES = 2 * 1024 * 1024;
/** 单批读取条数：读完即消费释放，禁止一次性物化全部候选行。 */
const READ_BATCH = 32;

export type TrajectoryFactsSource = {
	getSessionFactIndex: (sessionPath: string) => Promise<SessionFactIndexSnapshot>;
	readSessionFactLines: (sessionPath: string, entries: SessionFactEntry[]) => Promise<string[]>;
};

export type TrajectoryFactsReader = {
	read: (sessionPath: string) => Promise<SessionFactsResult>;
	/** 释放缓存与在途表（进程退出/设置关闭时调用）。 */
	clear: () => void;
	/** 探针/测试计数：正文读取次数与字节数（缓存命中时应为 0）。 */
	stats: () => { bodyReads: number; bodyBytes: number };
};

type CacheSlot = {
	/** 宿主 + 祖先版本指纹（祖先变化同样失效，见计划 §3.3）。 */
	fingerprint: string;
	/** 候选集合指纹（id/offset/byteLength）：普通消息追加不改变它，可复用事实。 */
	signature: string;
	/** 祖先版本指纹：祖先改版时即使候选签名相同也必须重读（正文可能已换）。 */
	ancestors: string;
	result: SessionFactsResult;
	/** 近似序列化字节（提示词正文 + detail），用于缓存字节预算。 */
	bytes: number;
};

/** 索引条目 → 过程事件（不读正文；索引已带摘要/模型/档位等元数据）。 */
function indexEvent(entry: SessionFactEntry): SessionProcessEvent | undefined {
	const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : 0;
	const ts = Number.isFinite(timestamp) ? timestamp : 0;
	let kind: SessionProcessEventKind | undefined;
	switch (entry.type) {
		case "session":
			kind = "session";
			break;
		case "session_info":
			kind = "sessionInfo";
			break;
		case "model_change":
			kind = "modelChange";
			break;
		case "thinking_level_change":
			kind = "thinkingChange";
			break;
		case "compaction":
			kind = "compaction";
			break;
		case "custom":
			kind = "custom";
			break;
		default:
			kind = entry.type.endsWith("_import") || entry.customType?.endsWith(".child-session") ? "import" : undefined;
	}
	if (!kind) return undefined;
	const model = [entry.modelChangeProvider, entry.modelChangeId].filter(Boolean).join("/");
	const summary =
		kind === "session"
			? "session"
			: kind === "sessionInfo"
				? (entry.summary ?? "session_info")
				: kind === "modelChange"
					? model || "model_change"
					: kind === "thinkingChange"
						? entry.thinkingLevel
							? `thinking ${entry.thinkingLevel}`
							: "thinking_level_change"
						: kind === "compaction"
							? (entry.summary ?? "compaction")
							: kind === "custom"
								? (entry.customType ?? "custom")
								: (entry.customType ?? entry.type);
	return {
		id: entry.id,
		kind,
		timestamp: ts,
		summary,
		...(entry.modelChangeProvider ? { provider: entry.modelChangeProvider } : {}),
		...(entry.modelChangeId ? { modelId: entry.modelChangeId } : {}),
		...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
		...(entry.customType ? { customType: entry.customType } : {}),
		...(entry.tokensBefore !== undefined ? { tokensBefore: entry.tokensBefore } : {}),
	};
}

function isPromptCandidate(entry: SessionFactEntry): boolean {
	return entry.type === "compaction" || (entry.type === "message" && entry.role === "system");
}

function factsVersion(events: SessionProcessEvent[], coverage: SessionFactsCoverage): string {
	// 只对规范化内容取指纹：源文件版本（size/mtime）由缓存层单独比较，
	// 普通消息追加但事实未变时 version 必须保持不变（渲染层据此保引用）。
	const normalized = JSON.stringify({ events, coverage });
	return createHash("sha1").update(normalized).digest("hex");
}

function ancestorsOf(index: SessionFactIndexSnapshot): string {
	return JSON.stringify((index.chainSources ?? []).map((source) => [source.hostPath, source.size, source.mtimeMs]));
}

function fingerprintOf(index: SessionFactIndexSnapshot): string {
	return JSON.stringify([index.size, index.mtimeMs, ancestorsOf(index)]);
}

function candidateSignature(entries: SessionFactEntry[]): string {
	return createHash("sha1")
		.update(JSON.stringify(entries.map((entry) => [entry.id, entry.offset, entry.byteLength])))
		.digest("hex");
}

function serializedBytes(events: SessionProcessEvent[]): number {
	return Buffer.byteLength(JSON.stringify(events), "utf8");
}

/**
 * 结果载荷收敛：普通 detail 是最大且最可丢的部分，先裁它；仍超限就缩事件保留量。
 * 提示词快照受双上限约束（≤4 份 × 256KiB），不会因这一步被当成普通 detail 丢掉。
 */
function fitPayload(events: SessionProcessEvent[], coverage: SessionFactsCoverage): SessionProcessEvent[] {
	if (serializedBytes(events) <= MAX_FACT_PAYLOAD_BYTES) return events;
	coverage.readComplete = false;
	coverage.reason = "budget";
	let trimmed = events.map((event) => (event.detail === undefined ? event : { ...event, detail: undefined }));
	if (serializedBytes(trimmed) > MAX_FACT_PAYLOAD_BYTES) {
		const prompts = trimmed.filter((event) => event.kind === "systemPrompt");
		trimmed = retainProcessEvents([...prompts, ...trimmed.filter((event) => event.kind !== "systemPrompt")], Math.max(prompts.length, 120));
		coverage.eventsTrimmed = true;
	}
	return trimmed;
}

function approximateBytes(events: SessionProcessEvent[]): number {
	let bytes = 0;
	for (const event of events) {
		bytes += 96 + (event.summary?.length ?? 0) + (event.detail?.length ?? 0) + (event.prompt?.text.length ?? 0);
		for (const tool of event.prompt?.tools ?? []) bytes += tool.length + 8;
	}
	return bytes;
}

export function createTrajectoryFactsReader(deps: { source: TrajectoryFactsSource }): TrajectoryFactsReader {
	const cache = new Map<string, CacheSlot>();
	const inflight = new Map<string, Promise<SessionFactsResult>>();
	let bodyReads = 0;
	let bodyBytes = 0;

	function touch(key: string, slot: CacheSlot): void {
		cache.delete(key);
		cache.set(key, slot);
	}

	function store(key: string, slot: CacheSlot): void {
		cache.delete(key);
		cache.set(key, slot);
		let totalBytes = 0;
		for (const [id, cached] of cache) {
			totalBytes += cached.bytes;
			if (cache.size <= MAX_FACT_VIEWS && totalBytes <= MAX_FACT_VIEW_BYTES) continue;
			cache.delete(id);
			totalBytes -= cached.bytes;
		}
	}

	async function load(sessionPath: string): Promise<SessionFactsResult> {
		const index = await deps.source.getSessionFactIndex(sessionPath);
		const fingerprint = fingerprintOf(index);
		const cached = cache.get(sessionPath);
		if (cached && cached.fingerprint === fingerprint) {
			touch(sessionPath, cached);
			return cached.result;
		}

		const coverage: SessionFactsCoverage = {
			fromStart: true,
			chainComplete: !index.headerParentSession || index.chainSources !== undefined,
			readComplete: true,
			eventsTrimmed: false,
			...(index.headerParentSession && index.chainSources === undefined ? { reason: "ancestor-missing" as const } : {}),
		};

		// 普通事件直接由索引元数据生成：不读正文，也不为它们占读取预算。
		const ordinary: SessionProcessEvent[] = [];
		for (const entry of index.entries) {
			if (entry.oversized || isPromptCandidate(entry)) continue;
			const event = indexEvent(entry);
			if (event) ordinary.push(event);
		}

		const candidates = index.entries.filter(isPromptCandidate);
		const selected = candidates.slice(0, MAX_FACT_CANDIDATES);
		if (selected.length < candidates.length) {
			coverage.readComplete = false;
			coverage.reason = "budget";
		}

		const signature = candidateSignature(selected);
		const ancestors = ancestorsOf(index);
		// 普通消息尾部追加会改 size/mtime，但候选集合与祖先版本没变：事实结果可以直接复用。
		if (cached && cached.signature === signature && cached.ancestors === ancestors) {
			store(sessionPath, { fingerprint, signature, ancestors, result: cached.result, bytes: cached.bytes });
			return cached.result;
		}

		const collector = createSessionProcessCollector();
		let readBytes = 0;
		for (let cursor = 0; cursor < selected.length; cursor += READ_BATCH) {
			const batch = selected.slice(cursor, cursor + READ_BATCH);
			const readable: SessionFactEntry[] = [];
			for (const entry of batch) {
				if (entry.oversized || entry.byteLength > MAX_FACT_LINE_BYTES || readBytes + entry.byteLength > MAX_FACT_BODY_BYTES) {
					coverage.readComplete = false;
					coverage.reason = "budget";
					continue;
				}
				readBytes += entry.byteLength;
				readable.push(entry);
			}
			if (readable.length === 0) continue;
			const lines = await deps.source.readSessionFactLines(sessionPath, readable);
			bodyReads += 1;
			bodyBytes += readBytes;
			for (let offset = 0; offset < readable.length; offset += 1) {
				const line = lines[offset];
				if (line) collector.push(line, index.entries.indexOf(readable[offset]));
			}
		}

		const combined = [...ordinary, ...collector.finish()];
		let events = retainProcessEvents(combined, MAX_EVENTS);
		coverage.eventsTrimmed = events.length < combined.length;
		events = fitPayload(events, coverage);
		const version = factsVersion(events, coverage);
		const result: SessionFactsResult = { events, version, coverage };
		store(sessionPath, { fingerprint, signature, ancestors, result, bytes: approximateBytes(events) });
		return result;
	}

	return {
		read(sessionPath) {
			const pending = inflight.get(sessionPath);
			if (pending) return pending;
			const task = load(sessionPath).finally(() => {
				inflight.delete(sessionPath);
			});
			inflight.set(sessionPath, task);
			return task;
		},
		clear() {
			cache.clear();
			inflight.clear();
		},
		stats: () => ({ bodyReads, bodyBytes }),
	};
}
