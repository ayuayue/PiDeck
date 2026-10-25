/**
 * 模型请求快照（RPC 日志的「模型」视图数据源）。
 *
 * 数据链路：pi 侧 `pi-deck-model-trace` 扩展（before_provider_request 钩子）→
 * 主进程端点 POST /trace/<token>（src/main/pi/modelTrace/ModelTraceServer.ts）→ AgentManager 回调 → 本模块。
 *
 * 两级存储，职责不同：
 * - **完整请求体**：每条一个文件 `<root>/model-<agentId>-<traceId>.json`（可能上百 KB）。
 *   不放环形缓冲、不进 IPC 批次；面板展开某行时按 traceId 回读单个文件。
 * - **紧凑摘要**：`buildModelTraceLogEntry` 产出的 RpcLogEntry（direction: "model"）
 *   走 RpcLogger 常规链路（落盘 rpc-*.jsonl + 实时广播），时间线上与 RPC 消息混排。
 *
 * 本模块不 import electron（rootDir 由调用方注入），可直接被 node --test 加载。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelTraceInput, ModelTraceRecord } from "../../shared/types/modelTrace";
import { readTextBounded } from "../fs/boundedTextRead";
import type { ModelTraceLogData, RpcLogEntry } from "../../shared/types/rpcLog";

/** 文件保留天数（与 RpcLogger 的 RETENTION_DAYS 对齐）。 */
const RETENTION_DAYS = 30;
/**
 * 目录总大小预算：超预算按 mtime 从旧到新淘汰。
 * 请求体远大于 RPC 日志（含图片上下文时单条可上 MB），不设总量上限会在重度会话里
 * 滚出 GB 级占用；30 天保留 + 该预算两条约束共同成立。
 */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** 每写多少次触发一次清理（保留期 + 预算）。 */
const PRUNE_EVERY_WRITES = 25;
/** traceId 合法形态（扩展生成：时间戳 36 进制 + 随机后缀）。读写两侧都校验，防路径穿越。 */
/** 单快照回读字节上限：含图片上下文的快照可达几十 MB，超限按损坏处理返回 null
 * （时间线摘要不受影响），保护面板展开时的内存。 */
const MAX_TRACE_READ_BYTES = 64 * 1024 * 1024;
const TRACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 文件名里的 id 净化：与 RpcLogger.sanitizeAgentId 同规则。 */
function sanitizeId(value: string): string {
	return value.replace(/[^\w-.~]/g, "_");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 模型快照落盘存储（每 trace 一文件）。
 *
 * 写入走 tmp + rename：读侧要么读不到（尚未落盘/已过期），要么读到完整 JSON，
 * 不会撞见半截文件。写失败向上抛，由调用方吞掉 —— 日志功能任何故障都不影响会话。
 */
export class ModelTraceStore {
	/** 写计数：每 PRUNE_EVERY_WRITES 次触发一次清理，避免每条都扫目录。 */
	private writesSincePrune = 0;
	/** 懒建目录，构造时不碰磁盘（测试可自由注入临时目录）。 */
	private readonly rootDir: string;

	constructor(rootDir: string) {
		this.rootDir = rootDir;
	}

	/** 落盘一条完整请求快照，返回文件路径。 */
	async write(request: ModelTraceRecord): Promise<string> {
		if (!TRACE_ID_PATTERN.test(request.traceId)) throw new Error(`invalid trace id: ${request.traceId}`);
		await mkdir(this.rootDir, { recursive: true });
		const filePath = join(this.rootDir, this.fileName(request.agentId, request.traceId));
		// tmp 后缀不用 .json：目录扫描/清理都按 model-*.json 匹配，避免把中间态算进去
		const tmpPath = `${filePath}.tmp`;
		await writeFile(tmpPath, JSON.stringify(request), "utf8");
		await rename(tmpPath, filePath);
		this.writesSincePrune += 1;
		if (this.writesSincePrune >= PRUNE_EVERY_WRITES) {
			this.writesSincePrune = 0;
			await this.prune().catch(() => undefined);
		}
		return filePath;
	}

	/** 读回一条完整请求快照；不存在/损坏/非法 id 返回 null（面板展开时按需拉取）。 */
	async read(agentId: string, traceId: string): Promise<ModelTraceRecord | null> {
		if (!TRACE_ID_PATTERN.test(traceId) || !agentId) return null;
		const raw = await readTextBounded(join(this.rootDir, this.fileName(agentId, traceId)), MAX_TRACE_READ_BYTES, "tail").catch(() => null);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as ModelTraceRecord;
			return parsed?.kind === "request" && typeof parsed.payloadJson === "string" && parsed.traceId === traceId ? parsed : null;
		} catch {
			return null;
		}
	}

	/** 目录占用（可只统计某 agent），供设置页存储管理展示。 */
	async getSize(agentId?: string): Promise<number> {
		const files = await this.listFiles(agentId);
		let total = 0;
		for (const file of files) total += file.size;
		return total;
	}

	/** 清空快照文件（可只清某 agent）；与 RpcLogger.clear 配对使用。 */
	async clear(agentId?: string): Promise<void> {
		const files = await this.listFiles(agentId);
		await Promise.all(files.map((file) => unlink(join(this.rootDir, file.name)).catch(() => undefined)));
	}

	/** 删除超过保留期或超总预算（按 mtime 从旧到新淘汰）的文件。 */
	async prune(): Promise<{ removed: number }> {
		const files = (await this.listFiles()).sort((a, b) => a.mtimeMs - b.mtimeMs);
		const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
		let total = files.reduce((sum, file) => sum + file.size, 0);
		let removed = 0;
		for (const file of files) {
			const expired = file.mtimeMs < cutoff;
			if (!expired && total <= MAX_TOTAL_BYTES) break;
			await unlink(join(this.rootDir, file.name)).catch(() => undefined);
			total -= file.size;
			removed += 1;
		}
		return { removed };
	}

	private fileName(agentId: string, traceId: string): string {
		return `model-${sanitizeId(agentId)}-${traceId}.json`;
	}

	/** 列出快照文件（含 mtime/size，供清理与统计复用）。目录不存在时返回空列表。 */
	private async listFiles(agentId?: string): Promise<{ name: string; mtimeMs: number; size: number }[]> {
		const prefix = agentId ? `model-${sanitizeId(agentId)}-` : "model-";
		const entries = await readdir(this.rootDir).catch(() => [] as string[]);
		const files: { name: string; mtimeMs: number; size: number }[] = [];
		for (const name of entries) {
			if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
			const info = await stat(join(this.rootDir, name)).catch(() => null);
			if (info?.isFile()) files.push({ name, mtimeMs: info.mtimeMs, size: info.size });
		}
		return files;
	}
}

/**
 * 把桥推来的一条模型快照转成 RPC 日志条目（紧凑摘要，走 RpcLogger 常规链路）。
 *
 * summary/data 都是诊断文本（可硬编码）；完整请求体不在条目里，只留 traceId 引用。
 */
export function buildModelTraceLogEntry(agentId: string, trace: ModelTraceInput): RpcLogEntry {
	const time = Number.isFinite(trace.ts) && trace.ts > 0 ? trace.ts : Date.now();
	if (trace.kind === "request") {
		const parts: string[] = [trace.model ?? "unknown-model"];
		if (typeof trace.messageCount === "number") parts.push(`${trace.messageCount} msgs`);
		if (typeof trace.toolCount === "number") parts.push(`${trace.toolCount} tools`);
		parts.push(`${formatBytes(trace.payloadBytes)}${trace.truncated ? " (truncated)" : ""}`);
		const data: ModelTraceLogData = {
			kind: "request",
			traceId: trace.traceId,
			model: trace.model,
			provider: trace.provider,
			messageCount: trace.messageCount,
			toolCount: trace.toolCount,
			payloadBytes: trace.payloadBytes,
			truncated: trace.truncated,
		};
		return { id: randomUUID(), agentId, direction: "model", summary: parts.join(" · "), time, data };
	}
	const duration = typeof trace.durationMs === "number" && trace.durationMs >= 0 ? ` · ${(trace.durationMs / 1000).toFixed(1)}s` : "";
	const data: ModelTraceLogData = { kind: "response", traceId: trace.traceId, status: trace.status, durationMs: trace.durationMs };
	return { id: randomUUID(), agentId, direction: "model", summary: `HTTP ${trace.status}${duration}`, time, data };
}
