import { stat } from "node:fs/promises";
import { parseTodoSnapshotData } from "../../../shared/sessionTodo";
import type { PiSubagentEntry, SessionTodoSnapshot } from "../../../shared/types";
import type { scanJsonlLines } from "../../sessions/jsonlLineStream";
import { deriveToolSubagentEntries, isSubagentDerivationInput } from "../derivedSubagents";
import type { AppLogger } from "../../logging/AppLogger";
import type { SessionDisplayEntry, SessionDisplayIndex } from "../SessionHistoryReader";
import { isRecord } from "./sessionEntryParsing";

/**
 * 子代理/待办投影：会话文件里「非对话内容」的两类读者。
 *
 * - 子代理：pi-subagents 的 `subagents:record` + 桥接扩展的 start 锚点（索引定向读），
 *   以及不落 record 的 acp_delegate / subagent 工具（流式扫描 + 增量缓存）；
 * - 待办：`pi-deck-todo` 快照（取活动分支最后一条）。
 *
 * 两个读者都只依赖宿主提供的显示索引、定向读行、扫描器与日志。投影规则本身
 * 不碰缓存策略以外的状态，因此从宿主类里整体搬出来（行为零变化）。
 */

/** 宿主提供给子代理/待办投影的窄接口（只列这里真正读到的成员）。 */
export type SessionSubagentProjectionHost = {
	/** 显示索引（含 fork 链合并）：子代理记录按**全量条目表**扫，待办按活动分支。 */
	getDisplayIndex: (sessionPath: string) => Promise<SessionDisplayIndex>;
	/** 按条目 offset/byteLength 定向读整行并解析（并发与字节预算由宿主统一）。 */
	readRawLines: (hostPath: string, entries: SessionDisplayEntry[]) => Promise<unknown[]>;
	/** sessionPath → 宿主文件路径（派生扫描缓存的键与扫描起点）。 */
	toHostPath: (sessionPath: string) => string;
	/** 派生扫描的索引候选路径（由宿主提供：它读 display index，且调用方可替换）。 */
	scanDerivedSubagentEntriesFromIndex: (sessionPath: string, version: { size: number; mtimeMs: number } | null) => Promise<{ rawEntries: unknown[]; bytesScanned: number; endsWithNewline: boolean } | null>;
	/** 流式 JSONL 行扫描器（由宿主注入：扫描器本身是宿主侧依赖，不经协作者解析）。 */
	scanLines: typeof scanJsonlLines;
	/** 流式扫描每隔多少行让出一次事件循环（与索引重建同一节拍）。 */
	yieldEveryLines: number;
	logger?: Pick<AppLogger, "info" | "warn">;
};

export class SessionSubagentProjection {
	/** 派生结果与配对输入的增量缓存；只有完整行末尾可作为下次读取起点。 */
	private readonly derivedSubagentCache = new Map<string, { size: number; mtimeMs: number; rawEntries: unknown[]; entries: PiSubagentEntry[]; endsWithNewline: boolean }>();
	/**
	 * 子代理 start 锚点条目类型：pi-deck-subagents 桥接扩展在 subagents:created 时
	 * 落盘（写入侧见 resources/extensions/pi-deck-subagents.ts 的 START_ENTRY_TYPE）。
	 * 残留锚点（无更晚 record 覆盖）合成 stopped 条目，保留被重启终止子代理的审计痕迹。
	 */
	private static readonly SUBAGENT_START_ENTRY = "pi-deck-subagent-start";

	constructor(private readonly host: SessionSubagentProjectionHost) {}

	/**
	 * 从会话文件读取 pi-subagents 插件持久化的子代理记录。
	 *
	 * sit downAppendEntry("subagents:record", data) 写入的条目格式为
	 * {type:"custom", customType:"subagents:record", data:{id, type, description, status, …}}。
	 *
	 * 子代理记录是会话级运行审计，不随对话分支回退而丢失：fork/编辑重发后，
	 * 旁支上已完成的 record 会掉出 activeBranch（2026-08-28 实测：会话有 2 个子代理，
	 * fork 后面板只剩 1 个）。因此这里扫全量条目表（含非活跃分支），而非 activeBranch。
	 *
	 * 同时读取 pi-deck-subagents 桥接扩展落盘的 start 锚点（pi-deck-subagent-start）：
	 * 运行中被会话重启终止的子代理没有 record（插件只在完成时写），无锚点则重启后
	 * 从面板彻底消失。锚点残留（同 id 无更晚的 record 覆盖）按对账信息合成条目。
	 *
	 * #300：record 在完成时才写，运行中的子代理只剩锚点，一律合成 stopped 会让
	 * 面板在子代理实际运行期间误显「已停止」。options.liveRuntimeStartedAt 是
	 * 本代 runtime 启动时间（无活 runtime 时不传）：锚点 startedAt ≥ 它则为本代
	 * 派发、record 未落，合成 running（与 downgradeRunningStartedBefore 同一阈值
	 * 同方向）；早于它或无法对账（缺 startedAt / 无活 runtime）仍合成 stopped。
	 *
	 * IO 约束：customType 已在建索引时捕获，只对目标两类行发起磁盘读，
	 * pi-deck-todo / om.* 等高频 custom 快照零读取，IO 量恒等于目标行数（每次
	 * 子代理创建/完成才写一条）。同一子代理 id 多条时按文件 offset 升序
	 * （= 写入顺序）后写覆盖先写：start 锚点（spawn 时写）自然被 record（完成时写）
	 * 覆盖。status 不在白名单的 record 条目丢弃并记日志。
	 */
	async readSubagentRecords(sessionPath: string, options?: { liveRuntimeStartedAt?: number }): Promise<PiSubagentEntry[]> {
		const index = await this.host.getDisplayIndex(sessionPath);
		const recordEntries = [...index.entries.values()].filter((entry) => entry.type === "custom" && (entry.customType === "subagents:record" || entry.customType === SessionSubagentProjection.SUBAGENT_START_ENTRY)).sort((a, b) => a.offset - b.offset);
		if (recordEntries.length === 0) return [];

		const rawLines = await this.host.readRawLines(index.hostPath, recordEntries);
		const validStatuses = new Set<string>(["queued", "running", "completed", "steered", "aborted", "stopped", "error"]);
		const byAgentId = new Map<string, PiSubagentEntry>();
		for (let i = 0; i < rawLines.length; i++) {
			const parsed = rawLines[i];
			try {
				if (!isRecord(parsed)) continue;
				const data = isRecord(parsed.data) ? parsed.data : parsed;
				const agentId = String(data.id ?? "");
				if (!agentId) continue;
				// start 锚点无 status 字段：残留（未被更晚的 record 覆盖）说明子代理
				// 运行中被会话重启终止，合成 stopped；record 条目沿用真实 status。
				// 例外（#300）：本代活 runtime 派发的锚点是「运行中、record 未落」，
				// 合成 running，否则面板在子代理运行期间误显「已停止」。
				const isStartAnchor = recordEntries[i].customType === SessionSubagentProjection.SUBAGENT_START_ENTRY;
				let status: string;
				if (!isStartAnchor) {
					status = String(data.status ?? "");
				} else {
					const anchorStartedAt = typeof data.startedAt === "number" ? data.startedAt : undefined;
					const runtimeStartedAt = options?.liveRuntimeStartedAt;
					status = anchorStartedAt != null && runtimeStartedAt != null && anchorStartedAt >= runtimeStartedAt ? "running" : "stopped";
				}
				if (!validStatuses.has(status)) {
					void this.host.logger?.warn("agent", "Invalid subagent status in subagents:record, skipped", {
						sessionPath,
						entryId: recordEntries[i].id,
						status,
					});
					continue;
				}
				// 同 id 后写覆盖先写：文件 offset 升序遍历，循环尾的 set 自然保留最新一条
				byAgentId.set(agentId, {
					id: agentId,
					type: String(data.type ?? ""),
					description: String(data.description ?? ""),
					status: status as PiSubagentEntry["status"],
					result: typeof data.result === "string" ? data.result : undefined,
					error: typeof data.error === "string" ? data.error : undefined,
					startedAt: typeof data.startedAt === "number" ? data.startedAt : undefined,
					completedAt: typeof data.completedAt === "number" ? data.completedAt : undefined,
					// via：acp_delegate 委托桥接落盘的 record 携带，渲染层据此展示来源提示
					via: data.via === "acp-delegate" ? "acp-delegate" : undefined,
					source: "record",
				});
			} catch {
				void this.host.logger?.warn("agent", "Failed to parse subagents:record, skipped", {
					sessionPath,
					entryId: recordEntries[i].id,
				});
			}
		}
		return [...byAgentId.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
	}

	/**
	 * 流式扫描会话文件全量条目，推导不走 record/事件链的子代理运行
	 * （acp_delegate：billion-context-pi；subagent 工具：nicobailon pi-subagents）。
	 *
	 * 首次扫描全量；后续文件规范追加时只读新增尾部，并复用配对所需的消息。
	 *
	 * 这些插件不落 subagents:record / start 锚点，读取侧无法像 record 那样按
	 * customType 走索引定向读。行级预检：相关条目必然包含
	 * "acp_delegate" 或带引号的 "subagent" 字样，不含两者的行直接跳过
	 * JSON.parse。损坏行忽略。
	 */
	async readDerivedSubagentEntries(sessionPath: string): Promise<PiSubagentEntry[]> {
		const cacheKey = this.host.toHostPath(sessionPath);
		let stats: { size: number; mtimeMs: number } | null = null;
		try {
			const info = await stat(cacheKey);
			stats = { size: info.size, mtimeMs: info.mtimeMs };
		} catch {
			stats = null;
		}
		// 只有规范追加且上次扫描恰好落在完整行边界时，才复用之前的输入并读
		// 新增尾部。文件重写或上次读到残行时必须从头扫描：残行使字节 offset
		// 失配，而不能靠重复执行配对逻辑来假装它可以安全重放。
		const cached = this.derivedSubagentCache.get(cacheKey);
		if (stats && cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached.entries;
		const append = stats !== null && cached !== undefined && stats.size > cached.size && cached.endsWithNewline;
		const start = append ? cached.size : 0;
		const scan = (append ? null : await this.host.scanDerivedSubagentEntriesFromIndex(sessionPath, stats)) ?? (await this.scanDerivedSubagentEntries(sessionPath, start));
		const rawEntries = [...(append ? cached.rawEntries : []), ...(scan?.rawEntries ?? [])];
		const entries = deriveToolSubagentEntries(rawEntries);
		if (stats && scan?.endsWithNewline && start + scan.bytesScanned === stats.size) {
			this.derivedSubagentCache.set(cacheKey, { ...stats, rawEntries, entries, endsWithNewline: true });
		} else {
			// 扫描期间又追加、遇到残行或读盘失败：结果仍按原逻辑返回，但文件版本
			// 不能确认，不能把没有覆盖到结尾的扫描当成下一次安全增量点。
			this.derivedSubagentCache.delete(cacheKey);
		}
		return entries;
	}

	private async scanDerivedSubagentEntries(sessionPath: string, start = 0): Promise<{ rawEntries: unknown[]; bytesScanned: number; endsWithNewline: boolean } | null> {
		const hostPath = this.host.toHostPath(sessionPath);
		const rawEntries: unknown[] = [];
		try {
			// 流式扫描新增的尾部（首次/失效回退为全量），避免逐次轮询重复读旧内容。
			// 不整文件 readFile，避免大会话撞 V8 字符串上限/堆上限。
			// 行级预检保留：不含 "acp_delegate" / "\"subagent\"" 的行直接跳过 JSON.parse。
			const summary = await this.host.scanLines(
				hostPath,
				(line) => {
					const jsonLine = line.endsWith("\r") ? line.slice(0, -1) : line;
					if (!jsonLine.includes("acp_delegate") && !jsonLine.includes('"subagent"')) return;
					try {
						const parsed: unknown = JSON.parse(jsonLine);
						if (isSubagentDerivationInput(parsed)) rawEntries.push(parsed);
					} catch {
						// 损坏行忽略
					}
				},
				{ start, yieldEveryLines: this.host.yieldEveryLines },
			);
			return { rawEntries, bytesScanned: summary.bytesScanned, endsWithNewline: summary.endsWithNewline };
		} catch (error) {
			void this.host.logger?.warn("agent", "Failed to read session for subagent derivation", {
				sessionPath,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * 读取会话分支上最新的 pi-deck-todo 快照（todo 工具变更时 appendEntry 持久化）。
	 * 只取最后一条：分支顺序即变更顺序，末条即当前计划；clear 后的快照无 activePlan → undefined。
	 */
	async readTodoSnapshot(sessionPath: string): Promise<SessionTodoSnapshot | undefined> {
		const index = await this.host.getDisplayIndex(sessionPath);
		// 从尾部向前找，避免读出全部 custom 行只为取最后一条
		const customEntries = [...index.activeBranch].reverse().filter((entry) => entry.type === "custom" && !entry.oversized);
		for (const entry of customEntries) {
			const rawLines = await this.host.readRawLines(index.hostPath, [entry]);
			const parsed = rawLines[0];
			try {
				if (!isRecord(parsed)) continue;
				if (parsed.customType !== "pi-deck-todo") continue;
				return parseTodoSnapshotData(parsed.data);
			} catch {
				void this.host.logger?.warn("agent", "Failed to parse pi-deck-todo snapshot, skipped", {
					sessionPath,
					entryId: entry.id,
				});
			}
		}
		return undefined;
	}
}
