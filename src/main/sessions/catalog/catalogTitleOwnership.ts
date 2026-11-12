import type { SessionSummary } from "../../../shared/types";
import { looksLikeExpandedRefBlockTitle } from "../../../shared/expandedRefBlocks";
import { looksLikeCodexSessionFileStem, looksLikePiSessionFileStem, looksLikeToolMarkerTitle, buildSummaryOriginKey } from "../../../shared/sessionIdentity";
import type { SessionCatalogContext, SessionCatalogEntry, SessionTitleFetcher, SessionTitleOrigin } from "../SessionCatalog";
import type { SessionTitleFallbackKind } from "../sessionNameLine";

/** #488：存量的 fallback 标题只有「明显是正文摘录」才值得读盘自愈——人写的名字不会这么长。 */
const FALLBACK_TITLE_PROBE_MIN_LENGTH = 120;
/** 一次扫描最多为多少条 fallback 条目读盘自愈；其余留给后续扫描，不把启动变成大批量 JSON 解析。 */
const FALLBACK_TITLE_PROBE_MAX_PER_SCAN = 32;

/** collectScannedTitles 收集的补名结果：fromSessionInfo=false 表示首条消息弱回退，所有权只算 fallback（#266）。
 *  fallbackName 是本文件的弱兜底候选（首条 user/assistant 文本），与最终 name 取谁无关：
 *  #266 存量自愈要用它比对「catalog 里存的这一行是不是当年被误锁的首句兜底」。 */
export type ScannedTitleFetch = { name: string; fromSessionInfo: boolean; fallbackName?: string };

/** legacy 存量条目的一次性探测结果：authoritative 只在真读到权威 session_info 名时才有值。
 *  firstUserText 是「文件内真首句」（可选，按需读取）：头/尾窗口兜底在系统提示很大的会话里会
 *  退化成尾部消息，指纹比对需要它才能命中当年写进 catalog 的真首句（#266）。 */
export type LegacyTitleProbe = { authoritative?: string; fallback?: string; firstUserText?: string };

/** 扫描未读正文时没有 session_info。pi JSONL 文件名是时间戳，不能当标题，否则侧栏全是日期。 */
export function scannedFileStemTitle(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	const stem = base.replace(/\.jsonl$/i, "").trim();
	if (!stem || looksLikePiSessionFileStem(stem)) return "Untitled";
	return stem;
}

/**
 * 外部删除判定的锚点：从 filePath 父目录逐级向上，返回第一个真实存在的祖先目录；
 * 一路到文件系统根都不存在（或超过爬升上限）返回 undefined。
 * 爬升上限 6：嵌套子代理会话最深结构为 <encoded>/<父会话目录>/<agentId>/run-N/session.jsonl，
 * 从 run-N 爬到 encoded 需 4 层，留 2 层余量；网络盘/移动盘掉线时 2-3 层内即到根停下。


/** 侧栏/Tab 展示用：pi 文件名时间戳不是会话名。 */
export function catalogDisplayTitle(title: string | undefined): string | undefined {
	if (!title) return undefined;
	// 工具/上下文代理的确认标记行（`[ACP] acp_status result`）不是任何人起的名字：
	// 展示层一律当没有名字（Untitled），等权威名/自动标题来替换。
	if (looksLikePiSessionFileStem(title) || looksLikeToolMarkerTitle(title)) return undefined;
	return title;
}

/** 占位标题判定：catalog 无真实名称时落成 Untitled（pi 时间戳 stem 加载时也被清成它），
 *  只有这类标题才值得读头部补名，否则每次扫描都会重复读盘。 */
export function isPlaceholderCatalogTitle(title: string | undefined): boolean {
	if (!title) return true;
	if (looksLikePiSessionFileStem(title)) return true;
	// 标记脏名同样是占位名：值得再读一次头部，让权威名/首句兜底把它换掉。
	if (looksLikeToolMarkerTitle(title)) return true;
	// 未折叠的块原文标题（`<prompt_template …>` 等历史脏数据）同样是占位名：
	// 允许首次补名把它换成用户可识别的标题，否则它会一直留在侧栏。
	if (looksLikeExpandedRefBlockTitle(title)) return true;
	return /^(?:untitled(?: session)?|new session|新会话)$/i.test(title);
}

/**
 * 解析条目的所有权来源。新字段优先；旧 catalog 只有 titleLocked 时惰性推导为 legacy——
 * true 无法区分「手动」与「扩展自动」，行为按 manual（绝不把已有标题降级成可覆盖），
 * 但保留一次指纹修复机会（#266 存量被误锁的首句兜底，见 repairedLegacyFallbackTitle）。
 */
export function resolveTitleOrigin(entry: Pick<SessionCatalogEntry, "title" | "titleLocked" | "titleOrigin">): SessionTitleOrigin | undefined {
	// 标记形态的脏名永远不算所有权：现场（2026-10-14）是扩展的旁路补全被第三方上下文代理接管，
	// 一段 `[ACP] acp_status result` 被当成权威 session_info 名锁成 manual 终态，此后自动命名再也
	// 修不掉，用户看到的就是「标题老是被插件改掉」。放在最前面（覆盖已持久化的 origin），
	// 一次性放开 claimAutomaticTitle / isTitleLocked / scannedTitleOrigin 三条判定。
	if (looksLikeToolMarkerTitle(entry.title)) return undefined;
	if (entry.titleOrigin === "fallback" || entry.titleOrigin === "auto" || entry.titleOrigin === "manual" || entry.titleOrigin === "legacy") return entry.titleOrigin;
	if (entry.titleLocked === false) return undefined;
	// 缺 titleOrigin 只有 locked=true：存量条目来源未知，标成 legacy 等一次指纹修复机会（#266）。
	if (entry.titleLocked === true) return "legacy";
	return isPlaceholderCatalogTitle(entry.title) ? undefined : "legacy";
}

/** 缺省是旧 catalog：真实标题默认已由 PiDeck 确认；仅占位标题保留一次初始化机会。 */
export function isTitleLocked(entry: Pick<SessionCatalogEntry, "title" | "titleLocked" | "titleOrigin">): boolean {
	// 历史 Codex rollout 文件名标题（旧导入器拿不到会话名时的兑底产物）永远不算锁定：
	// 即使旧 catalog 曾把它写成 locked=true，也要允许重导入后的真实标题覆盖，
	// 否则存量脏标题（看起来就是一串会话 ID）永久无法修复。
	if (looksLikeCodexSessionFileStem(entry.title)) return false;
	return resolveTitleOrigin(entry) !== undefined;
}

/** 一次性写入所有权字段：titleLocked 始终是 titleOrigin 的镜像，旧读取路径不会看到半截状态。 */
export function assignTitleOrigin(entry: SessionCatalogEntry, origin: SessionTitleOrigin | undefined): void {
	if (origin) {
		entry.titleOrigin = origin;
		entry.titleLocked = true;
		return;
	}
	delete entry.titleOrigin;
	entry.titleLocked = false;
}

/**
 * #266 存量自愈的指纹判定（纯函数，可直接单测）。
 *
 * 为什么需要指纹：旧 catalog 的 titleLocked=true 条目来源不可区分——既可能是用户改名，
 * 也可能是被缺陷版本 `titleLocked: !isPlaceholderCatalogTitle(initialTitle)` 误锁的首句兜底。
 * 三条指纹同时成立才判定为后者，把误丢的权威名拿回来：
 * 1. 条目来源是 legacy（只有旧 catalog 迁移来的条目走这条路；auto/manual 不参与）；
 * 2. catalog 现存标题逐字等于本次扫描读到的弱兜底候选（首条 user/assistant 文本，或文件内真首句）——
 *    用户手动改成与首句一字不差的标题几乎不可能；
 * 3. JSONL 里存在不同的权威 session_info 名，即当年被 applyAutomaticTitle 丢弃的那个名字。
 *
 * 为什么候选有两条：头/尾窗口的兜底在系统提示很大的会话里会落到尾部消息上（真首句落在 64KB
 * 头窗口之外），只比它会让这类 #266 存量永远修不了；firstUserText 是文件内真首句（有界读取）。
 *
 * @returns 要写回的权威标题；不命中返回 undefined（保持原标题，并转终态不再探测）。
 */
export function repairedLegacyFallbackTitle(entry: Pick<SessionCatalogEntry, "title">, probe: { authoritative?: string; fallback?: string; firstUserText?: string }): string | undefined {
	const authoritative = catalogDisplayTitle(probe.authoritative);
	if (!authoritative) return undefined;
	const title = normalizeFingerprintTitle(entry.title);
	if (!title) return undefined;
	const candidates = [probe.fallback, probe.firstUserText].map(normalizeFingerprintTitle).filter(Boolean);
	if (!candidates.some((candidate) => candidate === title)) return undefined;
	if (authoritative === entry.title) return undefined;
	return authoritative;
}

/** 指纹比对前的归一化：折叠空白并去首尾空白，避免换行/多空格造成的假阴性。 */
export function normalizeFingerprintTitle(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * #488 存量自愈：旧版本把头窗口外的首条用户消息丢掉、又让 thinking 顶替正文，于是把一段思考原文
 * 锁成了 fallback 标题（用户看到的就是「标题是一段思考」）。正文能读到后原地纠正。
 *
 * 比 #266 更严：源标签必须是 fallback（用户/扩展写下的名字不参与），现存标题必须逐字等于**旧口径**
 * （含 thinking）兜底，本次读到的兜底必须来自 user 正文且与现存标题不同——三条同时成立才改写。
 */
export function repairedThinkingFallbackTitle(lockedTitle: string, probe: { fallbackName?: string; fallbackKind?: SessionTitleFallbackKind; legacyFallbackName?: string }): string | undefined {
	if (probe.fallbackKind !== "user") return undefined;
	const fallback = catalogDisplayTitle(probe.fallbackName);
	if (!fallback) return undefined;
	const locked = normalizeFingerprintTitle(lockedTitle);
	if (!locked || normalizeFingerprintTitle(fallback) === locked) return undefined;
	if (normalizeFingerprintTitle(probe.legacyFallbackName) !== locked) return undefined;
	return fallback;
}

/**
 * 自动标题领取规则（#266）：只有未确认（undefined）或内容派生的 fallback 能被领取。
 * 扩展模型标题 "auto" 可以升级 fallback；反向（fallback 抢占已有 fallback 或终态）不可以；
 * "auto"/"manual"/"legacy" 是终态（legacy 只能被指纹修复改写），第二个自动结果一律丢弃。
 */
export function claimAutomaticTitle(entry: SessionCatalogEntry, nextTitle: string, source: "auto" | "fallback"): boolean {
	const origin = resolveTitleOrigin(entry);
	if (source === "fallback" ? origin !== undefined : origin !== undefined && origin !== "fallback") return false;
	entry.title = nextTitle;
	assignTitleOrigin(entry, source);
	return true;
}

/**
 * 扫描初始化标题的所有权：占位名与历史脏名保持未锁定（留一次初始化机会）；
 * 权威 session_info 名直接终态（manual）；首条消息弱回退只算 fallback，可被扩展自动命名覆盖（#266）。
 */
export function scannedTitleOrigin(title: string, authoritative: boolean): SessionTitleOrigin | undefined {
	if (isPlaceholderCatalogTitle(title) || looksLikeCodexSessionFileStem(title)) return undefined;
	return authoritative ? "manual" : "fallback";
}

/** collectScannedTitles 的宿主面：补名读取用到的全部 catalog 状态。
 *  #488 的 probedFallbackTitles 由宿主持有（每进程一次的去重集合），这里只读写它。 */
export type ScannedTitleProbeHost = {
	readonly entries: readonly SessionCatalogEntry[];
	readonly fetchTitle: SessionTitleFetcher | undefined;
	readonly probedFallbackTitles: Set<string>;
};

export async function collectScannedTitles(
	summaries: SessionSummary[],
	context: SessionCatalogContext,
	host: ScannedTitleProbeHost,
): Promise<{ titles: Map<string, ScannedTitleFetch>; legacyProbes: Map<string, LegacyTitleProbe>; thinkingFallbackRepairs: Map<string, string>; invalid: Set<string>; parents: Map<string, string>; forked: Map<string, boolean> }> {
	const titles = new Map<string, ScannedTitleFetch>();
	// 只收录**读取成功**的 legacy 探测：读不到（权限/锁定/WSL 抖动）时条目保持 legacy，下次扫描再试，
	// 否则一次瞬时失败就会把唯一的一次自愈机会消费掉。
	const legacyProbes = new Map<string, LegacyTitleProbe>();
	// #488：指纹命中的 fallback 重写结果（originKey → 新标题）。读不到同样不消费机会（见 worker）。
	const thinkingFallbackRepairs = new Map<string, string>();
	const invalid = new Set<string>();
	const parents = new Map<string, string>();
	const forked = new Map<string, boolean>();
	if (!host.fetchTitle) return { titles, legacyProbes, thinkingFallbackRepairs, invalid, parents, forked };
	const byOrigin = new Map(host.entries.filter((entry) => entry.originKey).map((entry) => [entry.originKey!, entry]));
	const wanted: Array<{ originKey: string; filePath: string; includeTitle: boolean; legacyProbe?: boolean; fallbackProbe?: boolean; lockedTitle?: string }> = [];
	let fallbackProbesQueued = 0;
	for (const summary of summaries) {
		const originKey = buildSummaryOriginKey(summary, context);
		const existing = byOrigin.get(originKey);
		if (existing && isTitleLocked(existing)) {
			// Existing PiDeck-owned sessions do not need title freshness. The only
			// retained disk probe repairs a legacy flat subagent's missing parent link,
			// and requests header-only metadata rather than a full title scan.
			// 例外：legacy 存量条目（#266 可能被误锁）读一次标题窗口，用「权威名 + 弱兜底候选」做指纹判定；
			// 命中即修、不命中转终态，一次读取收口，之后与其他锁定条目一样不再读盘。
			const legacy = existing.source === "pi" && resolveTitleOrigin(existing) === "legacy";
			const tintinwebOrphan = existing.source === "pi" && !existing.parentSessionPath && /^[^#]+#[0-9a-f]{8}$/i.test(existing.title);
			// #488：旧版本把 thinking 原文锁成了 fallback 标题。只探「一眼是正文摘录」的长标题（FALLBACK_TITLE_PROBE_MIN_LENGTH），
			// 每进程每条一次，且单次扫描限量（FALLBACK_TITLE_PROBE_MAX_PER_SCAN）——存量条目很多时
			// 不能让启动退化成大批量 JSON 解析，剩下的留给后续扫描。
			const thinkingFallback = existing.source === "pi" && resolveTitleOrigin(existing) === "fallback" && normalizeFingerprintTitle(existing.title).length > FALLBACK_TITLE_PROBE_MIN_LENGTH && !host.probedFallbackTitles.has(originKey) && fallbackProbesQueued < FALLBACK_TITLE_PROBE_MAX_PER_SCAN;
			if (legacy) wanted.push({ originKey, filePath: summary.filePath, includeTitle: true, legacyProbe: true, lockedTitle: existing.title });
			else if (tintinwebOrphan) wanted.push({ originKey, filePath: summary.filePath, includeTitle: false });
			else if (thinkingFallback) {
				host.probedFallbackTitles.add(originKey);
				fallbackProbesQueued += 1;
				wanted.push({ originKey, filePath: summary.filePath, includeTitle: true, fallbackProbe: true, lockedTitle: existing.title });
			}
			continue;
		}
		// readSummary 全量路径已携带初始名称，无需再次读盘。
		if (catalogDisplayTitle(summary.name)) continue;
		// New files and explicitly unlocked provisional records need one exact title
		// read; every other locked record remains entirely out of this path.
		wanted.push({ originKey, filePath: summary.filePath, includeTitle: true });
	}
	if (wanted.length === 0) return { titles, legacyProbes, thinkingFallbackRepairs, invalid, parents, forked };
	// 有界并行读头部；限制并发避免 WSL 环境一次拉起过多 wsl.exe。
	// 单个失败降级为无标题/不拒绝，不影响扫描结果。
	const CONCURRENCY = 8;
	let cursor = 0;
	const workers = Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, async () => {
		while (cursor < wanted.length) {
			const item = wanted[cursor++];
			const result = await host.fetchTitle!(item.filePath, { includeTitle: item.includeTitle, ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}), ...(context.wslUser ? { wslUser: context.wslUser } : {}) }).catch(() => undefined);
			if (!result) {
				// 读不到（文件已删/权限/WSL 抖动）：归还 #488 自愈机会，下次扫描再试。
				if (item.fallbackProbe) host.probedFallbackTitles.delete(item.originKey);
				continue;
			}
			// fallback 探测只用于原地纠错，不登记为标题（否则会绕开既有的权威名升级/锁定规则）。
			if (item.includeTitle && result.name && !item.fallbackProbe) {
				// fromSessionInfo=false 是首条消息弱回退（#266）：所有权只能算 fallback，
				// 缺省（旧 fetcher/未标记）按权威名处理，保持既有行为。
				// 权威名本身是标记脏行（第三方上下文代理把它写进了 session_info）时不采信：
				// 有弱兜底就用弱兜底（侧栏显示首句而不是日志，所有权仍算 fallback，可被扩展升级）；
				// 连弱兜底都没有就干脆不登记，让条目保持占位标题等后续命名。
				const junkMarkerName = result.nameFromSessionInfo !== false && looksLikeToolMarkerTitle(result.name);
				const scannedName = junkMarkerName ? result.fallbackName : result.name;
				if (scannedName) {
					titles.set(item.originKey, { name: scannedName, fromSessionInfo: junkMarkerName ? false : result.nameFromSessionInfo !== false, fallbackName: result.fallbackName });
				}
			}
			if (item.legacyProbe) {
				// 只有真读到 session_info 才算权威名：另一个弱兜底不能用来「修复」弱兜底。
				const authoritative = result.nameFromSessionInfo === true ? result.name : undefined;
				// #266：窗口兜底对不上目录标题时才多读一次有界前缀，取「文件内真首句」当第二指纹基准
				// （系统提示很大时窗口兜底会退化成尾部消息，只有真首句与当年写进 catalog 的标题一致）。
				const needsFirstUserText = Boolean(authoritative) && normalizeFingerprintTitle(result.fallbackName) !== normalizeFingerprintTitle(item.lockedTitle);
				// 深读失败（WSL 超时/文件被占）只降级回「窗口兜底比对」并消费掉这一次机会，不像读盘失败那样保持可重试：
				// 一条修不了的存量条目不值得每次扫描都再读 8MB。方向是安全的——最多保持原标题，不会写错。
				const firstUserText = needsFirstUserText
					? await host.fetchTitle!(item.filePath, {
							includeTitle: false,
							includeFirstUserText: true,
							...(context.wslDistro ? { wslDistro: context.wslDistro } : {}),
							...(context.wslUser ? { wslUser: context.wslUser } : {}),
						})
							.then((extra) => extra?.firstUserText)
							.catch(() => undefined)
					: undefined;
				legacyProbes.set(item.originKey, { authoritative, fallback: result.fallbackName, firstUserText });
			}
			if (item.fallbackProbe) {
				const repaired = repairedThinkingFallbackTitle(item.lockedTitle ?? "", { fallbackName: result.fallbackName, fallbackKind: result.fallbackKind, legacyFallbackName: result.legacyFallbackName });
				if (repaired) thinkingFallbackRepairs.set(item.originKey, repaired);
			}
			// valid 显式为 false 才拒绝；缺省（读不到/未校验）保留原行为
			if (result.valid === false) invalid.add(item.originKey);
			// 平铺子代理（tintinweb 形态）回补父关系：来源只推断自 filename，
			// 不以 summary 的 source 过滤，避免引用文件与扫描来源不一致时漏补。
			if (result.parentSessionPath) parents.set(item.originKey, result.parentSessionPath);
			// pi fork/branch 会话标记（parentSession header + 非 tintinweb 形态）：只在探测到
			// 才写 true，不写 false——普通会话/子代理不该反向清掉已持久化的标记。
			if (result.forked === true) forked.set(item.originKey, true);
		}
	});
	await Promise.all(workers);
	return { titles, legacyProbes, thinkingFallbackRepairs, invalid, parents, forked };
}

