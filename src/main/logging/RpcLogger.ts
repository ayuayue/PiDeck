import type { RpcLogEntry } from "../../shared/types/rpcLog";
import type { ModelTraceRecord, ModelTraceRequestInput } from "../../shared/types/modelTrace";
import { readTextBounded } from "../fs/boundedTextRead";
import { ModelTraceStore } from "./ModelTrace";
import { app } from "electron";
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";

const MAX_LIVE = 1000;
/** 落盘缓冲刷出间隔：高频日志合并成整批写入（见 queueWrite） */
const FLUSH_INTERVAL_MS = 250;
/** 落盘缓冲行数水位：短时间涌入大量日志时不必等满一个间隔 */
const FLUSH_MAX_LINES = 256;
/** 每刷出多少次做一次过期文件清理（原来是每次写都 readdir 一遍目录） */
const CLEAN_EVERY_FLUSHES = 100;
/** 写入文件时 data 字段 JSON 序列化后的最大字节数，超过则截断 */
const MAX_DATA_BYTES = 2_048;
/**
 * 实时环形缓冲中单条 data 的最大字节数（仅影响内存中的缓冲副本，文件仍按原始数据落盘）。
 * 防止高频大 payload（如 prompt 全文）在缓冲里堆积把主进程内存打爆。
 */
const MAX_LIVE_DATA_BYTES = 4_096;
/** 日志文件保留天数，超过自动删除 */
const RETENTION_DAYS = 30;
/** 单文件读取字节上限：rpc 单日 jsonl 可达上百 MB，去重/查询都只关心尾部最近条目 */
const RPC_TAIL_READ_BYTES = 8 * 1024 * 1024;

function formatDate(value: Date) {
	const year = value.getFullYear();
	const month = String(value.getMonth() + 1).padStart(2, "0");
	const day = String(value.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/**
 * RPC 日志服务。
 * - 按 Agent 分文件：userData/logs/rpc/rpc-<agentId>-YYYY-MM-DD.jsonl
 * - 写入时截断大 data（超过 2KB 脱敏保存），大幅减少文件体积
 * - **落盘合并写入**：行先进内存缓冲，满 FLUSH_MAX_LINES 或到 FLUSH_INTERVAL_MS 才整批
 *   appendFile。逐条写（还带 mkdir）在流式阶段等于每秒上百次文件系统调用，会把主进程
 *   事件循环占满；因此退出前与「清空/保存」之前都必须先 flushPending()
 * - 次日自动 gzip 前一天文件，进一步压缩历史日志
 * - 超过 30 天自动清理
 * - 保持环形缓冲区（1000 条，data 按 MAX_LIVE_DATA_BYTES 截断）供实时面板拉取初始历史，
 *   push() 返回这份截断副本给广播用（原始大 payload 不跨进程克隆）
 *
 * 模型请求快照（`pi-deck-model-trace`）同属本服务的存储域：完整请求体另存
 * userData/logs/model-traces（每 trace 一文件，见 ModelTraceStore），
 * RPC 日志时间线里只放紧凑摘要。占用统计与清理因此按「RPC 日志」一个概念收口。
 */
export class RpcLogger {
	/** RPC 日志独立子目录，不和 app 日志混在一起 */
	private readonly dir = join(app.getPath("userData"), "logs", "rpc");
	/** 模型请求快照目录（完整请求体），与 rpc 目录平级 */
	private readonly modelTraces = new ModelTraceStore(join(app.getPath("userData"), "logs", "model-traces"));
	private live: RpcLogEntry[] = [];
	/** 最近写入的日期，用于触发跨日 gzip */
	private lastWriteDate = "";
	private writeQueue: Promise<void> = Promise.resolve();
	/**
	 * 待落盘的 jsonl 行，按目标文件分组（见 queueWrite）。
	 * 流式阶段 message_update 可达每秒上百条，逐条 appendFile 等于每秒上百次
	 * open/write/close + mkdir，主进程事件循环被 I/O 占满 → 整个应用卡顿。
	 */
	private pendingLines = new Map<string, string[]>();
	private pendingLineCount = 0;
	/** 缓冲里最新的日期（缓冲非空时有效），刷出时用于跨日 gzip 判定 */
	private pendingDate = "";
	private flushTimer: NodeJS.Timeout | null = null;
	/** 已刷出次数，用于按次数节流过期文件清理（原来每条写都 readdir 一遍目录） */
	private flushes = 0;

	/**
	 * 写入一条 RPC 日志，同时追加到文件与环形缓冲区。
	 *
	 * 返回环形缓冲里那份（data 已按 MAX_LIVE_DATA_BYTES 截断的）副本，供实时广播使用：
	 * 广播若用原始 entry，prompt 全文这类大 payload 会逐条走结构化克隆跨进程，
	 * 且与 getLive() 的初始历史形态不一致（历史截断、追加不截断，同一行展开内容会突变）。
	 */
	push(entry: RpcLogEntry): RpcLogEntry {
		// 环形缓冲区：保留最近 MAX_LIVE 条。缓冲里只存截断 data 的副本（见 truncateForLive），
		// 文件写入仍用原始 entry，保证完整内容可回查。
		const liveEntry = this.truncateForLive(entry);
		if (this.live.length >= MAX_LIVE) {
			this.live.splice(0, this.live.length - MAX_LIVE + 1);
		}
		this.live.push(liveEntry);

		// 落盘走合并缓冲（定时/定量刷出），不再逐条 appendFile
		this.queueWrite(entry);
		return liveEntry;
	}

	/**
	 * 序列化一条日志并按目标文件分组进落盘缓冲。
	 *
	 * 为什么合并：开启记录后每条 RPC 事件都要落盘，流式阶段 message_update 每秒上百条，
	 * 逐条写会带着 mkdir 一起做上百次文件系统调用，把主进程事件循环占满（表现为输入、
	 * 流式全卡）。合并后系统调用次数只与刷出频率有关。
	 */
	private queueWrite(entry: RpcLogEntry) {
		let line: string;
		try {
			// 截断大 data：避免文件快速膨胀（原始 entry 不进缓冲，副本才进）
			line = `${JSON.stringify(this.truncateData(entry))}\n`;
		} catch (error) {
			// 不可序列化（循环引用等）：丢这一条，日志故障不得影响会话
			console.warn("Failed to serialize RPC log:", error);
			return;
		}
		const filePath = this.filePathFor(entry);
		const group = this.pendingLines.get(filePath);
		if (group) group.push(line);
		else this.pendingLines.set(filePath, [line]);
		this.pendingLineCount += 1;
		this.pendingDate = formatDate(new Date(entry.time));
		if (this.pendingLineCount >= FLUSH_MAX_LINES) {
			void this.flushPending();
			return;
		}
		if (this.flushTimer === null) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = null;
				void this.flushPending();
			}, FLUSH_INTERVAL_MS);
		}
	}

	/**
	 * 把缓冲里的行整批追加到各自文件；实际写盘仍串在 writeQueue 上，
	 * 与 appendEntries（面板保存）的读取-去重-追加保持同一顺序。
	 */
	async flushPending(): Promise<void> {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.pendingLineCount === 0) return;
		const batches = this.pendingLines;
		const dateStr = this.pendingDate;
		this.pendingLines = new Map();
		this.pendingLineCount = 0;
		this.writeQueue = this.writeQueue
			.then(async () => {
				await mkdir(this.dir, { recursive: true });
				// 跨日 gzip：上次写入日期与本次不同才压缩（每批一次，不再逐条判目录）
				if (this.lastWriteDate && this.lastWriteDate !== dateStr) {
					const oldFiles = this.listFiles(undefined, ".jsonl").filter((f) => f.includes(`-${this.lastWriteDate}.jsonl`) && !f.endsWith(".gz"));
					for (const oldFile of oldFiles) {
						await this.gzipFile(join(this.dir, oldFile)).catch(() => undefined);
					}
				}
				this.lastWriteDate = dateStr;
				for (const [filePath, lines] of batches) {
					await appendFile(filePath, lines.join(""), "utf8");
				}
				// 过期清理按刷出次数节流（原来是每次写入 1% 概率 readdir）
				this.flushes += 1;
				if (this.flushes % CLEAN_EVERY_FLUSHES === 0) {
					await this.cleanOldFiles().catch(() => undefined);
				}
			})
			.catch((error) => {
				console.warn("Failed to write RPC log:", error);
			});
		await this.writeQueue;
	}

	/** 获取实时缓冲区（最近 MAX_LIVE 条），可选按 agentId 过滤 */
	getLive(agentId?: string): RpcLogEntry[] {
		if (!agentId) return [...this.live];
		return this.live.filter((entry) => entry.agentId === agentId);
	}

	/**
	 * 供实时查看的内存副本：data JSON 超过 MAX_LIVE_DATA_BYTES 时替换为脱敏摘要。
	 * 只影响内存缓冲，不改变落盘内容。
	 */
	private truncateForLive(entry: RpcLogEntry): RpcLogEntry {
		if (entry.data === undefined) return entry;
		let json = "";
		try {
			json = JSON.stringify(entry.data);
		} catch {
			// data 不可序列化（如循环引用）时丢弃内容，仅保留类型占位
			return { ...entry, data: { unserializable: true } };
		}
		if (json.length <= MAX_LIVE_DATA_BYTES) return entry;
		return {
			...entry,
			data: {
				truncated: true,
				size: json.length,
				preview: json.slice(0, 200),
			},
		};
	}

	/**
	 * 把弹窗保存的条目合并追加到对应 agent 的当日自动文件（按 id 去重），
	 * 返回实际写入的文件路径列表（空数组 = 全部重复、没有新条目）。
	 * 弹窗内容与自动落盘同源（开启记录后推送即落盘），去重避免重复行；
	 * 竞态说明：读取去重集合与排队写入之间若有并发 push 同 id 条目，可能写入少量重复行，幂等无害。
	 */
	async appendEntries(entries: RpcLogEntry[]): Promise<string[]> {
		// 先落盘缓冲里的自动日志：否则去重集合读不到还没写盘的同 id 行，保存会写出重复行
		await this.flushPending();
		// 按目标文件分组：同 agent 同日条目共享一次去重读取
		const byFile = new Map<string, RpcLogEntry[]>();
		for (const entry of entries) {
			const filePath = this.filePathFor(entry);
			const list = byFile.get(filePath) ?? [];
			list.push(entry);
			byFile.set(filePath, list);
		}
		const writtenFiles: string[] = [];
		for (const [filePath, group] of byFile) {
			const existingIds = await this.readEntryIds(filePath);
			const fresh = group.filter((entry) => !existingIds.has(entry.id));
			if (fresh.length === 0) continue;
			// 与 push 共用写入队列：串行追加，整批 appendFile（与自动落盘同一合并策略）
			const lines = fresh.map((entry) => `${JSON.stringify(this.truncateData(entry))}\n`).join("");
			await new Promise<void>((resolve, reject) => {
				this.writeQueue = this.writeQueue
					.then(async () => {
						await mkdir(this.dir, { recursive: true });
						await appendFile(filePath, lines, "utf8");
						this.lastWriteDate = formatDate(new Date(fresh[fresh.length - 1].time));
						resolve();
					})
					.catch((error) => reject(error));
			});
			writtenFiles.push(filePath);
		}
		return writtenFiles;
	}

	/** 条目对应的自动保存文件路径：rpc-<agentId>-YYYY-MM-DD.jsonl */
	private filePathFor(entry: RpcLogEntry): string {
		const safeAgentId = this.sanitizeAgentId(entry.agentId);
		const dateStr = formatDate(new Date(entry.time));
		return join(this.dir, `rpc-${safeAgentId}-${dateStr}.jsonl`);
	}

	/** 读取文件已有条目 id 集合；文件不存在时返回空集（视为首次写入）。
	 * 大文件只读尾部窗口：待去重的总是最近写入的条目，老条目 id 不在碰撞面内。 */
	private async readEntryIds(filePath: string): Promise<Set<string>> {
		const raw = await readTextBounded(filePath, RPC_TAIL_READ_BYTES, "tail").catch(() => "");
		if (!raw) return new Set();
		const ids = new Set<string>();
		for (const line of raw.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				ids.add((JSON.parse(line) as RpcLogEntry).id);
			} catch {
				// 跳过损坏行，不阻断去重
			}
		}
		return ids;
	}

	/** 从文件读取日志。
	 * 按 agentId 和日期范围过滤，倒序返回最近 limit 条。
	 * 只读取未压缩的 .jsonl 文件（当天和近期尚未 gzip 的），
	 * 跨日文件已被 gzip，不影响最近 7 天查询。
	 */
	async getFromFile(options?: { agentId?: string; days?: number; limit?: number }): Promise<RpcLogEntry[]> {
		await mkdir(this.dir, { recursive: true });
		const limit = Math.max(1, Math.min(options?.limit ?? 5000, 10000));
		const days = Math.max(1, options?.days ?? 7);

		const files = this.listFiles(options?.agentId, ".jsonl").sort().reverse().slice(0, days);

		const lines: string[] = [];
		for (const file of files) {
			// 只关心最近 limit 条：大文件读尾部窗口即可，避免整读上百 MB 再截断
			const raw = await readTextBounded(join(this.dir, file), RPC_TAIL_READ_BYTES, "tail").catch(() => "");
			const fileLines = raw.split(/\r?\n/).filter(Boolean);
			lines.push(...fileLines.reverse());
			if (lines.length >= limit) break;
		}

		return lines
			.slice(0, limit)
			.map((line) => {
				try {
					return JSON.parse(line) as RpcLogEntry;
				} catch {
					return null;
				}
			})
			.filter((e): e is RpcLogEntry => Boolean(e));
	}

	/**
	 * 落盘一条模型请求快照的完整请求体（每 trace 一文件）。
	 * 失败向上抛，调用方（AgentManager）吞掉 —— 日志功能不影响会话。
	 */
	async writeModelTrace(agentId: string, request: ModelTraceRequestInput): Promise<string> {
		return this.modelTraces.write({ ...request, agentId });
	}

	/** 回读一条模型请求快照（面板展开模型行时按需拉取）；缺失/非法参数返回 null。 */
	async readModelTrace(agentId: string, traceId: string): Promise<ModelTraceRecord | null> {
		return this.modelTraces.read(agentId, traceId);
	}

	/** 获取 RPC 日志文件总大小（字节），可选按 agentId 过滤，含 gzip 文件与模型快照 */
	async getSize(agentId?: string): Promise<number> {
		await mkdir(this.dir, { recursive: true });
		const files = this.listFiles(agentId);
		let total = 0;
		for (const file of files) {
			try {
				const s = await stat(join(this.dir, file));
				total += s.size;
			} catch {
				/* skip */
			}
		}
		// 模型快照（完整请求体）计入同一「RPC 日志」占用，否则重度会话里它在设置页完全隐形
		total += await this.modelTraces.getSize(agentId).catch(() => 0);
		return total;
	}

	/** 清空 RPC 日志文件（含模型快照），可选按 agentId 过滤，含 gzip 文件 */
	async clear(agentId?: string): Promise<void> {
		// 先落盘缓冲：否则删完文件后延迟刷出的批次又把日志写回来（表现为「清空没生效」）
		await this.flushPending();
		await mkdir(this.dir, { recursive: true });
		const files = this.listFiles(agentId);
		await Promise.all(files.map((file) => unlink(join(this.dir, file)).catch(() => undefined)));
		await this.modelTraces.clear(agentId).catch(() => undefined);
		if (agentId) {
			this.live = this.live.filter((e) => e.agentId !== agentId);
		} else {
			this.live = [];
		}
	}

	/** 将 agentId 中的不安全字符替换掉，避免跨目录访问 */
	private sanitizeAgentId(id: string): string {
		return id.replace(/[^\w-.~]/g, "_");
	}

	// ── 文件管理 ──

	/** 列出匹配的文件（默认同时匹配 .jsonl 和 .jsonl.gz） */
	private listFiles(agentId?: string, ext?: ".jsonl" | ".gz"): string[] {
		// 硬读目录，不缓存，保证各方法拿到最新文件列表
		const files: string[] = [];
		try {
			const entries = require("fs").readdirSync(this.dir);
			for (const entry of entries) {
				if (typeof entry !== "string") continue;
				// 只匹配 rpc-<agentId>-YYYY-MM-DD.jsonl 或 .jsonl.gz
				if (!/^rpc-[\w-]+-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(entry)) continue;
				if (agentId) {
					const prefix = `rpc-${this.sanitizeAgentId(agentId)}-`;
					if (!entry.startsWith(prefix)) continue;
				}
				if (ext === ".jsonl" && entry.endsWith(".gz")) continue;
				if (ext === ".gz" && !entry.endsWith(".gz")) continue;
				files.push(entry);
			}
		} catch {
			/* 目录不存在时返回空列表 */
		}
		return files;
	}

	/** 删除超过保留天数的文件 */
	private async cleanOldFiles() {
		const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
		const files = this.listFiles();
		for (const file of files) {
			// 从文件名提取日期：rpc-<agentId>-YYYY-MM-DD.jsonl(.gz)?
			const match = file.match(/-(\d{4}-\d{2}-\d{2})\.jsonl/);
			if (!match) continue;
			const fileDate = new Date(match[1] + "T00:00:00Z").getTime();
			if (!isNaN(fileDate) && fileDate < cutoff) {
				await unlink(join(this.dir, file)).catch(() => undefined);
			}
		}
	}

	/** 将指定文件 gzip 压缩，压缩后删除原文件 */
	private async gzipFile(filePath: string) {
		const gzPath = filePath + ".gz";
		try {
			await pipeline(createReadStream(filePath), createGzip(), createWriteStream(gzPath));
			await unlink(filePath).catch(() => undefined);
		} catch {
			await unlink(gzPath).catch(() => undefined);
		}
	}

	// ── 写入 ──

	/** 截断 data 字段：JSON 序列化超过 MAX_DATA_BYTES 时替换为脱敏摘要。 */
	private truncateData(entry: RpcLogEntry): RpcLogEntry {
		// 处理 direction === "send" 时提取精简命令
		if (entry.direction === "send") {
			const data = entry.data as Record<string, unknown> | undefined;
			if (data?.type === "bash") {
				return {
					...entry,
					data: { type: "bash", command: ((data.command as string) ?? "").slice(0, 200) },
				};
			}
		}
		return entry;
	}
}
