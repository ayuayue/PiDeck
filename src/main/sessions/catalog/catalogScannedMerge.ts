import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { createSessionModelPreference } from "../../../shared/modelDisplayName";
import { buildSummaryOriginKey, canonicalizeSessionPath, getImportedSessionSourceId, getSessionEnvironment, isInSubagentArtifactsDir } from "../../../shared/sessionIdentity";
import type { SessionRecord, SessionSummary } from "../../../shared/types";
import type { SessionCatalogContext, SessionCatalogEntry, SessionTitleFetcher } from "../SessionCatalog";
import { type CatalogMutation, recordFromEntry, setLocalSessionFilePath } from "./catalogEntryProjection";
import { catalogDisplayTitle, collectScannedTitles, isTitleLocked, repairedLegacyFallbackTitle, resolveTitleOrigin, scannedFileStemTitle, scannedTitleOrigin } from "./catalogTitleOwnership";

/** mergeScanned 需要的宿主持有面：条目表、草稿表、活性探针、补名读取与写事务入口。 */
export type ScannedMergeHost = {
	readonly entries: readonly SessionCatalogEntry[];
	readonly transientEntries: ReadonlyMap<string, SessionCatalogEntry>;
	readonly livenessProbe: ((sessionId: string) => boolean) | undefined;
	readonly probedFallbackTitles: Set<string>;
	readonly fetchTitle: SessionTitleFetcher | undefined;
	enqueueMutation<T>(mutate: CatalogMutation<T>): Promise<T>;
};

export type ScannedMergeOptions = {
	/**
	 * 本次并入来自用户手动导入（外置目录导入）：命中条目打上 manualProjectAssignment，
	 * 之后别的项目扫描不得把归属改回去。
	 */
	manualAssignment?: boolean;
};


/**
 * 外部删除判定的锚点：从 filePath 父目录逐级向上，返回第一个真实存在的祖先目录；
 * 一路到文件系统根都不存在（或超过爬升上限）返回 undefined。
 * 爬升上限 6：嵌套子代理会话最深结构为 <encoded>/<父会话目录>/<agentId>/run-N/session.jsonl，
 * 从 run-N 爬到 encoded 需 4 层，留 2 层余量；网络盘/移动盘掉线时 2-3 层内即到根停下。
 */
function findExistingAncestorDir(filePath: string, maxDepth = 6): string | undefined {
	let dir = dirname(filePath);
	for (let depth = 0; depth < maxDepth; depth += 1) {
		if (existsSync(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

export async function mergeScannedIntoCatalog(host: ScannedMergeHost, projectId: string, summaries: SessionSummary[], context: SessionCatalogContext, options: ScannedMergeOptions = {}): Promise<SessionRecord[]> {
	// 新发现文件用 pi JSONL 标题初始化 catalog；一旦 catalog 已有记录，后续扫描
	// 只更新文件身份、预览和结构元数据，不能用 pi/TUI 的标题覆盖 PiDeck 名称。
	// 同一次读取仍校验会话头：invalidOrigins 收集非有效会话文件，下面据此清洗与拒绝。
	const { titles: fetchedTitles, legacyProbes: fetchedLegacyProbes, thinkingFallbackRepairs: fetchedThinkingFallbackRepairs, invalid: invalidOrigins, parents: fetchedParents, forked: fetchedForked } = await collectScannedTitles(summaries, context, host);

	// 外部删除清理（在入锁前完成磁盘探测）：mergeScanned 历史上只增改不删，
	// pi 会话文件被外部删除（pi 回收站、用户手工 rm、脚本清理）后条目会永远
	// 残留在侧栏。安全闸（缺一不可）：
	// - 仅本项目 + source=pi + backend≠dsh：dsh 会话文件由 $DSH_HOME 托管；
	// - environment=native：WSL 条目跳过——发行版未运行时 UNC existsSync 恒
	//   false，会把正常会话误删；
	// - 必须真实 existsSync 缺失（而非「不在本轮 summaries 里」），部分扫描/
	//   手动导入调用不会误判；
	// - 必须有存在的祖先目录锚点：从父目录逐级向上找第一个存在的目录，找到
	//   即「磁盘可达而文件不在」= 确定的外部删除；一路到根都不存在（磁盘/
	//   网络盘整体离线、路径临时不可达）才跳过。只看直接父目录会把嵌套子
	//   代理会话（<encoded>/<父会话目录>/<agentId>/run-N/session.jsonl）漏掉——
	//   父会话目录被整体删除后多级父目录都不在，记录永远残留并会在小窗
	//   报 ENOENT（2027-02 事故）。
	const externallyMissingIds = new Set<string>();
	for (const entry of host.entries) {
		if (entry.projectId !== projectId) continue;
		if (entry.source !== "pi" || entry.backend === "dsh") continue;
		if (entry.environment !== "native") continue;
		if (!entry.filePath) continue;
		// 活跃运行时的文件可能尚未落盘：pi 首条消息才创建 jsonl，预热激活后空闲
		// 进程甚至长期不写。有活绑定的会话「文件暂时不在」不是外部删除，跳过；
		// 运行终结后下一轮扫描按真实缺失清理（2026-10-05 事故：预热 attach 同秒
		// 扫描剔掉记录 → 闪回引导页、输入草稿丢失、发送另起新进程）。
		if (host.livenessProbe?.(entry.id)) continue;
		if (existsSync(entry.filePath)) continue;
		if (!findExistingAncestorDir(entry.filePath)) continue;
		externallyMissingIds.add(entry.id);
	}

	return host.enqueueMutation((entries) => {
		let changed = false;

		// 剔除磁盘已消失的 pi 原生条目（探测结果在入锁前算好）。
		if (externallyMissingIds.size > 0) {
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				if (!externallyMissingIds.has(entries[index]!.id)) continue;
				entries.splice(index, 1);
				changed = true;
			}
		}

		// 清洗存量脏数据：pi-subagents artifactDir="session"（默认）的产物转储
		// 曾被旧版扫描误注册成 active 条目，导致每个子代理在侧栏「嵌套 + 顶层平铺」
		// 重复显示。扫描端已排除这些文件，但 mergeScanned 只增改不删，存量条目会
		// 永远留在 catalog 里；这里按同一路径规则移除并落盘（仅 pi 来源，导入会话不受影响）。
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index]!;
			if (entry.source !== "pi" || !entry.filePath) continue;
			if (!isInSubagentArtifactsDir(entry.filePath)) continue;
			entries.splice(index, 1);
			changed = true;
		}

		// 清洗会话头校验失败的存量条目：本轮补名读取判定为非有效会话的文件
		// （transcript 等无 type 头的产物，即便不在 subagent-artifacts 目录）。
		// 仅 pi 来源；导入会话由各自导入器保证格式，不参与本校验。
		if (invalidOrigins.size > 0) {
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index]!;
				if (entry.source !== "pi") continue;
				if (!entry.originKey || !invalidOrigins.has(entry.originKey)) continue;
				entries.splice(index, 1);
				changed = true;
			}
		}

		// 防御性过滤：扫描端漏网（subagent-artifacts）或会话头校验失败的产物不得注册新条目。
		const acceptedSummaries = summaries.filter((summary) => {
			if (summary.source === "pi" && isInSubagentArtifactsDir(summary.filePath)) return false;
			if (invalidOrigins.has(buildSummaryOriginKey(summary, context))) return false;
			return true;
		});

		const byOrigin = new Map(entries.filter((entry) => entry.originKey && entry.locator?.kind !== "ssh").map((entry) => [entry.originKey!, entry]));
		const summaryById = new Map<string, SessionSummary>();

		// Restore model/thinking from the session file when the catalog lacks them.
		// (Explicit user picks are already stored on the entry and are preserved.)
		function inheritSessionMeta(entry: SessionCatalogEntry, summary: SessionSummary) {
			if (!entry.model && summary.model) {
				entry.model = createSessionModelPreference(summary.model.provider, summary.model.modelId, undefined);
				changed = true;
			}
			if (!entry.thinkingLevel && summary.thinkingLevel) {
				entry.thinkingLevel = summary.thinkingLevel;
				changed = true;
			}
		}

		for (const summary of acceptedSummaries) {
			const originKey = buildSummaryOriginKey(summary, context);
			// 标题来源优先级：summary.name（readSummary 全量路径）先于读头补名。
			// nameFromSessionInfo=false 表示首条消息弱回退，所有权只算 fallback（#266）。
			const summaryTitle = catalogDisplayTitle(summary.name);
			const fetched = fetchedTitles.get(originKey);
			const fetchedTitle = catalogDisplayTitle(fetched?.name);
			const initialAuthoritative = summaryTitle ? summary.nameFromSessionInfo !== false : fetched?.fromSessionInfo === true;
			// 平铺子代理（tintinweb 形态）父关系回补：轻量扫描不带 parentSessionPath，
			// 标题回读时若探测到父（<agent>#<8hex> + parentSession header）则用拾取值；
			// 普通会话/用户 fork 不探测到该值，保持 summary/旧值原样。
			const fetchedParent = fetchedParents.get(originKey);
			// fork 标记回填：仅头部探测确认（parentSession + 非 tintinweb 形态）时置 true；
			// 有父关系（子代理折叠）的会话不标记——fork 与子代理是两种形态。
			const fetchedForkedFlag = fetchedForked.get(originKey);
			const importedSourceId = getImportedSessionSourceId(summary);
			let entry = byOrigin.get(originKey);
			if (!entry) {
				const now = summary.updatedAt || Date.now();
				const initialTitle = summaryTitle || fetchedTitle || scannedFileStemTitle(summary.filePath);
				const initialOrigin = scannedTitleOrigin(initialTitle, initialAuthoritative);
				entry = {
					id: randomUUID(),
					projectId,
					originKey,
					// listPathSummary 没有 name；readSummary 若仍带回时间戳文件名，也不能当标题。
					// 发现时读取到的名称是初始化值；纯占位名留给一次自动/补名领取，
					// 首条消息弱回退只算 fallback（等待扩展模型标题升级）。
					title: initialTitle,
					titleLocked: initialOrigin !== undefined,
					titleOrigin: initialOrigin,
					source: summary.source ?? "pi",
					environment: getSessionEnvironment(summary),
					filePath: summary.filePath,
					wslDistro: summary.wsl ? context.wslDistro : undefined,
					wslUser: summary.wsl ? context.wslUser : undefined,
					importedSourceId,
					status: "active",
					parentSessionPath: summary.parentSessionPath ?? fetchedParent,
					forked: (summary.parentSessionPath ?? fetchedParent) ? undefined : fetchedForkedFlag,
					createdAt: now,
					updatedAt: now,
				};
				setLocalSessionFilePath(entry, summary.filePath);
				entries.push(entry);
				byOrigin.set(originKey, entry);
				changed = true;
				if (options?.manualAssignment) entry.manualProjectAssignment = true;
			} else {
				// Catalog is the display-title authority. An explicitly unlocked entry is a
				// fresh provisional session, even if its UI label is "<project> agent";
				// it may absorb exactly one initial JSONL title before becoming owned.
				const canInitializeTitle = !isTitleLocked(entry);
				const initialTitle = summaryTitle || fetchedTitle;
				// fork/copy 现场（2026-10-08）：扫描在 pi 写入 session_info 名之前的几百毫秒
				// 窗口里先索引了新文件，从首条/尾部窗口兜底猜出一个标题并锁成 fallback；
				// 随后权威名落盘，但 canInitializeTitle 把它拒之门外 → 侧栏永久停在猜出
				// 的正文上。所有权语义上 fallback 是「内容派生的猜测」，权威 session_info
				// 名是「pi/用户写下的名字」——后者必须能升级前者（fallback → manual）。
				// auto/manual/legacy 终态不动（无命中时走 ?? 兑底保持原 origin）。
				const authoritativeUpgrade = initialAuthoritative && resolveTitleOrigin(entry) === "fallback";
				const canAbsorbTitle = canInitializeTitle || authoritativeUpgrade;
				// #266 存量自愈：legacy 条目读盘探测过一次。指纹命中（catalog 存的正是弱兜底名、
				// JSONL 另有权威名）才改写标题；探测过但没命中就消费掉这一次机会，落 manual 终态，
				// 避免每次扫描都为一个不可能自愈的条目读盘。读盘失败则保持 legacy 下次再试。
				const legacyProbe = fetchedLegacyProbes.get(originKey);
				const legacyRepair = legacyProbe ? repairedLegacyFallbackTitle(entry, summaryTitle && summary.nameFromSessionInfo === true ? { ...legacyProbe, authoritative: summaryTitle } : legacyProbe) : undefined;
				// #488 存量自愈：fallback 标题若被旧版本锁成 thinking 原文，笼统可读后原地纠正（origin 保持 fallback）。
				// 排在权威名升级之后：真有 pi/用户写下的名字时以它为准。
				const thinkingFallbackRepair = fetchedThinkingFallbackRepairs.get(originKey);
				const nextTitle = legacyRepair || (canAbsorbTitle ? initialTitle : undefined) || thinkingFallbackRepair || catalogDisplayTitle(entry.title) || scannedFileStemTitle(summary.filePath);
				// rollout 文件名标题（历史导入兑底）不锁定：留一次被真实标题覆盖的机会；
				// 真实标题一旦落库即锁定，后续 pi /name 或 JSONL 变化不再反向改写。
				// 未锁定条目吸收的新标题按来源升级：权威 session_info → manual，首条消息弱回退 → fallback。
				const nextOrigin = legacyProbe ? "manual" : ((canAbsorbTitle && initialTitle ? scannedTitleOrigin(nextTitle, initialAuthoritative) : undefined) ?? resolveTitleOrigin(entry));
				const nextTitleLocked = nextOrigin !== undefined;
				// 父关系最终值：新探测值优先，缺失时保留旧值（轻量扫描恒缺省，不能清掉已持久化的父）。
				const nextParent = summary.parentSessionPath ?? fetchedParent ?? entry.parentSessionPath;
				// fork 标记同样只增补、不清空：未探测到（轻量扫描/普通会话）保留持久化值。
				const nextForked = nextParent ? entry.forked : fetchedForkedFlag || entry.forked;
				// 手动导入钉住的归属：别的项目扫描不得改回去（见 SessionCatalogEntry 注释）；
				// 用户再一次手动导入（manualAssignment）表示明确改主意，允许迁移到新项目。
				const nextProjectId = entry.manualProjectAssignment && !options?.manualAssignment && entry.projectId !== projectId ? entry.projectId : projectId;
				// 扫描快照可能早于排队期间完成的改名或新一轮活动；保留较新时间，但不因标题锁定挡住后续文件活动。
				const nextUpdatedAt = Math.max(entry.updatedAt, summary.updatedAt);
				if (
					entry.projectId !== nextProjectId ||
					entry.filePath !== summary.filePath ||
					entry.title !== nextTitle ||
					entry.titleLocked !== nextTitleLocked ||
					entry.titleOrigin !== nextOrigin ||
					entry.source !== (summary.source ?? "pi") ||
					entry.environment !== getSessionEnvironment(summary) ||
					entry.wslDistro !== (summary.wsl ? context.wslDistro : undefined) ||
					entry.wslUser !== (summary.wsl ? context.wslUser : undefined) ||
					entry.importedSourceId !== importedSourceId ||
					entry.status !== "active" ||
					entry.parentSessionPath !== nextParent ||
					entry.forked !== nextForked ||
					entry.updatedAt !== nextUpdatedAt
				) {
					entry.projectId = nextProjectId;
					entry.filePath = summary.filePath;
					entry.title = nextTitle;
					entry.titleLocked = nextTitleLocked;
					entry.titleOrigin = nextOrigin;
					entry.source = summary.source ?? "pi";
					entry.environment = getSessionEnvironment(summary);
					entry.wslDistro = summary.wsl ? context.wslDistro : undefined;
					entry.wslUser = summary.wsl ? context.wslUser : undefined;
					setLocalSessionFilePath(entry, summary.filePath);
					entry.importedSourceId = importedSourceId;
					entry.status = "active";
					// 子会话的父子关系可能随后续扫描才被识别（parent 文件出现/路径推断补全），
					// 变化必须计入 changed 才会落盘，否则重拉后仍以孤儿平铺。
					// 平铺子代理（tintinweb 形态）的父来自头部探测（fetchedParent，见上方）。
					// 注意：轻量扫描（listPathSummary）不读正文、parentSessionPath 恒为缺省，
					// 直接用缺省值覆盖会清掉上轮探测/持久化的父关系（重启后孤儿平铺）；
					// 故此处只增补、不清空——新值优先，其次保留旧值。
					entry.parentSessionPath = summary.parentSessionPath ?? fetchedParent ?? entry.parentSessionPath;
					entry.forked = nextForked;
					entry.updatedAt = nextUpdatedAt;
					changed = true;
				}
				// 只有本次是手动导入才置位（自动扫描不得清除既有置位，否则归属又会被抢走）。
				if (options?.manualAssignment && !entry.manualProjectAssignment) {
					entry.manualProjectAssignment = true;
					changed = true;
				}
			}
			summaryById.set(entry.id, summary);
			inheritSessionMeta(entry, summary);
		}

		const records = entries.filter((entry) => entry.projectId === projectId).map((entry) => recordFromEntry(entry, summaryById.get(entry.id)));
		const idByPath = new Map<string, string>();
		for (const record of records) {
			if (!record.filePath) continue;
			idByPath.set(canonicalizeSessionPath(record.filePath, record.environment), record.id);
		}
		for (const record of records) {
			if (!record.parentSessionPath) continue;
			record.parentSessionId = idByPath.get(canonicalizeSessionPath(record.parentSessionPath, record.environment));
		}
		return {
			value: records.sort((left, right) => right.updatedAt - left.updatedAt),
			changed,
		};
	}).then((records) =>
		[
			...Array.from(host.transientEntries.values())
				.filter((entry) => entry.projectId === projectId)
				.map((entry) => recordFromEntry(entry)),
			...records,
		].sort((left, right) => right.updatedAt - left.updatedAt),
	);
}
