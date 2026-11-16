import { stat } from "node:fs/promises";
import { isValidPiSessionFileHead } from "../../../shared/sessionIdentity";
import { cleanSessionTitleCandidate, inferSessionTitleFromLines, isCopiedParentSessionInfo, isSessionScanLine, readForkHistoryBoundary, type ForkHistoryBoundary, type SessionTitleFallbackKind, type SessionTitleInference } from "../sessionNameLine";
import { scanJsonlLines } from "../jsonlLineStream";
import type { SessionFileVersion } from "../sessionSummaryCache";
import { inferProjectPathFromFile } from "./sessionPathDerivation";
import { extractText, optionalString, readLocalFilePrefix, readLocalFileSuffix } from "./sessionSummaryRead";

/** 轻量补名读取窗口：头部用于校验会话/首条消息，尾部用于捕获 pi `/name` 追加的最新 session_info。 */
const SUMMARY_NAME_WINDOW_BYTES = 64 * 1024;
/**
 * 头尾窗口之间可能正好藏着较新的 session_info。小会话以流式方式完整扫一遍，
 * 精确复现 pi "最后一条 session_info" 语义；仍不 materialize 全文件。
 * 大会话继续受窗口上界保护，且 catalog 不会接受其外部标题反向写入。
 */
const SUMMARY_NAME_FULL_SCAN_MAX_BYTES = 1024 * 1024;
/**
 * 「文件内真首句」的有界读取上限（#266 存量自愈的第二指纹基准）。
 *
 * 系统提示动辄几百 KB，64KB 的头窗口经常还没进到第一条用户消息，于是头/尾窗口兜底会
 * 退化成「尾部某条消息」——而当年被缺陷版本锁进 catalog 的首句兜底来自实时视图的真首句。
 * 8MB 覆盖「首条用户消息之前的系统提示」这一常见量级，同时给读取量一个硬上界。
 */
export const FIRST_MESSAGE_TITLE_MAX_BYTES = 8 * 1024 * 1024;

/** 标题/子会话探测需要的宿主持有面：有界读取、路径映射与 fork 父路径解析。 */
export type SessionTitleProbeHost = {
	isWslPath(filePath: string): boolean;
	readWslFileHead(filePath: string, maxBytes?: number, signal?: AbortSignal): Promise<string>;
	readWslFileTail(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<string>;
	readWslFileVersion(filePath: string, signal?: AbortSignal): Promise<SessionFileVersion>;
	existsWslFile(filePath: string, signal?: AbortSignal): Promise<boolean>;
	/** 会话文件本体读写用的宿主路径（WSL → UNC 映射）。 */
	hostPathFor(filePath: string): string;
	resolveForkParentPath(filePath: string, forkParentSession: string, isWsl: boolean, sessionCwd?: string, signal?: AbortSignal): Promise<string | undefined>;
};

/**
 * 小会话精确取最后一条 session_info，避免头/尾两个窗口之间的最新改名被遗漏。
 * 使用流式扫描而非 readFile：即便阈值调整也不会把整份 JSONL 放进主进程堆。
 */
async function inferLatestSessionInfoFromSmallFile(host: SessionTitleProbeHost, filePath: string, end: number, boundary: ForkHistoryBoundary): Promise<string | undefined> {
	let latestName: string | undefined;
	await scanJsonlLines(
		host.hostPathFor(filePath),
		(line) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return;
			}
			if (!isSessionScanLine(parsed) || parsed.type !== "session_info") return;
			// 复制来的父会话名同样只能当弱候选（见 isCopiedParentSessionInfo）。
			if (isCopiedParentSessionInfo(parsed, boundary)) return;
			const candidate = typeof parsed.name === "string" ? parsed.name : parsed.data?.name;
			const title = cleanSessionTitleCandidate(candidate);
			if (title) latestName = title;
		},
		// Read only through the size snapshot: a concurrently growing session must not
		// turn this nominally small-file probe into an unbounded scan.
		{ end, yieldEveryLines: Number.MAX_SAFE_INTEGER },
	);
	return latestName;
}

/**
 * `includeTitle=true` 时有界读取头尾，并在小会话中精确扫描最后一个 session_info。
 * `false` 时只读取有界头部，供已锁定 catalog 记录补结构元数据而不触碰标题窗口。
 */
async function readHeadAndInfer(host: SessionTitleProbeHost, filePath: string, includeTitle = true): Promise<{ raw: string; name: string | undefined; nameFromSessionInfo: boolean; fallbackName?: string; fallbackKind?: SessionTitleFallbackKind; legacyFallbackName?: string } | null> {
	const isWsl = host.isWslPath(filePath);
	try {
		const windowBytes = SUMMARY_NAME_WINDOW_BYTES;
		const head = isWsl ? await host.readWslFileHead(filePath, windowBytes) : await readLocalFilePrefix(filePath, windowBytes);
		// Locked catalog records only need the bounded header for structural metadata.
		// Avoid stat/tail/full-file title work when their persisted title is already final.
		if (!includeTitle) return { raw: head, name: undefined, nameFromSessionInfo: false };
		const version = isWsl ? await host.readWslFileVersion(filePath) : await stat(filePath);
		let titleText = head;
		if (version.size > windowBytes) {
			const tail = isWsl ? await host.readWslFileTail(filePath, windowBytes) : await readLocalFileSuffix(filePath, windowBytes, version.size);
			titleText = `${head}\n${tail}`;
		}
		// 头/尾窗口边界可能截断半行；inferSessionTitleFromLines 会跳过不可解析行。
		const inferred = inferSessionTitleFromLines(titleText.split(/\r?\n/).filter(Boolean), (content) => extractText(content));
		// #488：窗口里没有 user 正文（首条用户消息单行 88KB 被 64KB 头窗口整行切掉、尾部又落在 assistant
		// thinking 上）时，兜底会退化成思考原文。有权威名时不追：标题不靠首条消息。
		const effective = !inferred.fromSessionInfo && inferred.fallbackKind !== "user" && version.size > windowBytes ? await preferUserBodyFallback(host, filePath, isWsl, version.size, inferred) : inferred;
		if (version.size <= SUMMARY_NAME_FULL_SCAN_MAX_BYTES && version.size > windowBytes) {
			const latestSessionInfoName = await inferLatestSessionInfoFromSmallFile(host, filePath, version.size, readForkHistoryBoundary(head.split(/\r?\n/).filter(Boolean)));
			if (latestSessionInfoName) {
				// 权威名赢，但弱兜底候选仍要带出去（legacy 存量条目的指纹比对基准）。
				return { raw: head, name: latestSessionInfoName, nameFromSessionInfo: true, fallbackName: effective.fallbackName, fallbackKind: effective.fallbackKind, legacyFallbackName: effective.legacyFallbackName };
			}
		}
		return { raw: head, name: effective.name, nameFromSessionInfo: effective.fromSessionInfo, fallbackName: effective.fallbackName, fallbackKind: effective.fallbackKind, legacyFallbackName: effective.legacyFallbackName };
	} catch {
		// 读不到（权限/锁定/不存在）：返回 null，调用方按 best-effort 处理，不拒绝文件。
		return null;
	}
}

/**
 * 单调续读标题前缀，直到拿到 user 正文或到上界（#488）。
 *
 * 头/尾窗口只有 64KB：首条用户消息内嵌 AGENTS.md/系统提示时单行就有几十 KB，整行不可解析 →
 * 兜底只能退到尾部某条 assistant/thinking。这里从头往后读（沿用 #266 inferFirstMessageTitle
 * 的单调前缀语义），先 256KB、必要时 SUMMARY_NAME_FULL_SCAN_MAX_BYTES，拿到 user 正文即停。
 * 注意 legacyFallbackName 保留原窗口的值：catalog 里被旧版本锁住的正是那个窗口猜出来的文本。
 */
async function preferUserBodyFallback(host: SessionTitleProbeHost, filePath: string, isWsl: boolean, fileSize: number, windowed: SessionTitleInference): Promise<SessionTitleInference> {
	const limit = Math.min(fileSize, SUMMARY_NAME_FULL_SCAN_MAX_BYTES);
	const firstStep = Math.min(SUMMARY_NAME_WINDOW_BYTES * 4, limit);
	for (const bytes of firstStep === limit ? [limit] : [firstStep, limit]) {
		try {
			const prefix = isWsl ? await host.readWslFileHead(filePath, bytes) : await readLocalFilePrefix(filePath, bytes);
			const inferred = inferSessionTitleFromLines(prefix.split(/\r?\n/).filter(Boolean), (content) => extractText(content));
			if (inferred.fallbackName && (inferred.fallbackKind === "user" || bytes === limit)) {
				return { ...windowed, name: inferred.fallbackName, fallbackName: inferred.fallbackName, fallbackKind: inferred.fallbackKind };
			}
		} catch {
			return windowed;
		}
	}
	return windowed;
}

/**
 * 有界读文件头部推断会话标题（不读完整正文、不写摘要缓存）。
 * 供 SessionCatalog 对新发现或未锁定 provisional 会话补名——轻量扫描（listPathSummary）不带 name，
 * 未打开过的 pi 会话若只在打开/重命名时才能获得标题，侧栏会一直 Untitled。
 */
export async function inferSessionNameFromFile(host: SessionTitleProbeHost, filePath: string): Promise<string | undefined> {
	return (await readHeadAndInfer(host, filePath))?.name;
}

/**
 * 从有界头部 JSONL 文本探测 pi fork/branch 会话。
 * pi 的 fork/clone（createBranchedSession / newSession({parentSession})）都会在
 * session header 写 parentSession；子代理形态（tintinweb 平铺子代理）同样带该字段，
 * 但其会话名固定 <agent>#<8hex>，据此排除——只有真正的用户 fork/分支才返回 true。
 * 该探测只产生「fork 标记」，与 parentSessionPath（子代理父关系、列表折叠）语义分离。
 */
function detectForkedFromHead(raw: string): boolean {
	let hasParentSession = false;
	let latestSessionInfoName: string | undefined;
	for (const line of raw.split(/\r?\n/).filter(Boolean)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isSessionScanLine(parsed)) continue;
		const entry = parsed;
		if (entry.type === "session") {
			hasParentSession = Boolean(optionalString(entry.parentSession ?? entry.header?.parentSession));
		} else if (entry.type === "session_info") {
			latestSessionInfoName = optionalString(entry.name ?? entry.data?.name);
		}
	}
	if (!hasParentSession) return false;
	// tintinweb 子代理（名字 <agent>#<8hex>）不是用户 fork；名字缺省（落在窗口盲区）时
	// 视为普通 fork——子代理形态会被 parentSessionPath/路径推断识别，不受影响。
	if (latestSessionInfoName && /^[^#]+#[0-9a-f]{8}$/i.test(latestSessionInfoName)) return false;
	return true;
}

/**
 * 读有界头部并同时校验会话头有效性：transcript 等无 type 头的产物会被标记
 * valid:false，供 catalog 在 mergeScanned 时拒绝索引（#168）。读不到文件时
 * 返回空对象（valid 缺省 = 不拒绝），兼容权限/锁定文件不被误删。
 * nameFromSessionInfo 只描述 title 的文件来源；catalog 仅在首次发现或未确认的
 * provisional 标题阶段采用该名称，后续 pi/TUI 改名不会覆盖 PiDeck 显示标题。
 * `includeTitle:false` 只返回头部有效性和结构元数据，不读取尾部或小文件全文。
 */
export async function inferSessionNameAndValidity(
	host: SessionTitleProbeHost,
	filePath: string,
	options: { includeTitle?: boolean; includeFirstUserText?: boolean } = {},
): Promise<{ name?: string; nameFromSessionInfo?: boolean; valid?: boolean; parentSessionPath?: string; forked?: boolean; fallbackName?: string; fallbackKind?: SessionTitleFallbackKind; legacyFallbackName?: string; firstUserText?: string }> {
	const head = await readHeadAndInfer(host, filePath, options.includeTitle !== false);
	if (!head) return {};
	const parentSessionPath = await detectFlatSubagentParentFromHead(host, filePath, head.raw);
	const forked = detectForkedFromHead(head.raw);
	// #266 存量自愈的第二指纹基准：只有真首句才和当年锁进 catalog 的标题可比。调用方仅在
	// 「窗口兜底对不上目录标题」时才要（多一次有界读），默认不读。
	const firstUserText = options.includeFirstUserText ? await inferFirstMessageTitle(host, filePath) : undefined;
	return { name: head.name, nameFromSessionInfo: head.nameFromSessionInfo, valid: isValidPiSessionFileHead(head.raw), parentSessionPath, forked: forked || undefined, fallbackName: head.fallbackName, fallbackKind: head.fallbackKind, legacyFallbackName: head.legacyFallbackName, firstUserText };
}

/**
 * 有界读取文件开头，取「文件内首条 user 文本」（其次首条 assistant 文本）。
 *
 * 与 readHeadAndInfer 的头/尾窗口不同：这里从头往后单调读，不会因为 64KB 头窗口还没读到第一条
 * 用户消息（系统提示很大时很常见）就退化成「尾部某条消息」。用于 #266 存量自愈的指纹比对——
 * 当年被锁进 catalog 的首句兜底来自实时视图的真首句，必须用同一基准才比得上。
 *
 * 读取有界（FIRST_MESSAGE_TITLE_MAX_BYTES）：超限时宁可放弃比对（保持原标题），不做无界扫描。
 */
export async function inferFirstMessageTitle(host: SessionTitleProbeHost, filePath: string, maxBytes = FIRST_MESSAGE_TITLE_MAX_BYTES): Promise<string | undefined> {
	try {
		const prefix = host.isWslPath(filePath) ? await host.readWslFileHead(filePath, maxBytes) : await readLocalFilePrefix(filePath, maxBytes);
		// 末尾可能截断半行：inferSessionTitleFromLines 会跳过不可解析行。
		return inferSessionTitleFromLines(prefix.split(/\r?\n/).filter(Boolean), (content) => extractText(content)).fallbackName;
	} catch {
		return undefined;
	}
}

/**
 * 从有界头部 JSONL 文本中探测平铺子代理（@tintinweb/pi-subagents 形态）的父会话路径。
 * 判定：session header 带 parentSession 且会话名匹配 <agent>#<8hex>。
 * 只有该形态的平铺文件会命中；用户 fork（名字是用户命名）、普通会话不被误判。
 */
async function detectFlatSubagentParentFromHead(host: SessionTitleProbeHost, filePath: string, raw: string): Promise<string | undefined> {
	// 头部截断产生的半行会被 JSON.parse 跳过，不影响本次探测。
	let forkParentSession: string | undefined;
	let latestSessionInfoName: string | undefined;
	let sessionHeaderCwd: string | undefined;
	for (const line of raw.split(/\r?\n/).filter(Boolean)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isSessionScanLine(parsed)) continue;
		const entry = parsed;
		if (entry.type === "session") {
			forkParentSession ||= optionalString(entry.parentSession ?? entry.header?.parentSession);
			sessionHeaderCwd ||= optionalString(entry.cwd ?? entry.header?.cwd);
		} else if (entry.type === "session_info") {
			latestSessionInfoName = optionalString(entry.name ?? entry.data?.name);
		}
	}
	if (!forkParentSession || !latestSessionInfoName) return undefined;
	// tintinweb 会话名 <agent>#<8hex>：名字必须落在 #8 位十六进制后缀，
	// 否则视为用户 fork / 普通会话（fork 名由用户命名，通常不含该模式）。
	if (!/^[^#]+#[0-9a-f]{8}$/i.test(latestSessionInfoName)) return undefined;
	const isWsl = host.isWslPath(filePath);
	// header cwd 缺失（旧文件）时回退按文件路径推断项目根，两种基准都覆盖不到才放弃。
	return host.resolveForkParentPath(filePath, forkParentSession, isWsl, sessionHeaderCwd ?? inferProjectPathFromFile(filePath));
}

/**
 * 有界探测平铺子代理会话（@tintinweb/pi-subagents 形态）：
 * 会话文件与父会话同目录平铺、文件名 <timestamp>_<sessionId>.jsonl，
 * 路径推断（looksLikeNestedSessionPath）无法识别；它与 pi 原生 fork/branch
 * 的文件形态完全一致（都带 parentSession header），唯一区分是 tintinweb 会
 * setSessionName("<agent>#<id前8位>")，会话名以 #8 位十六进制结尾。
 * 返回解析后的父会话路径；非 tintinweb 形态（fork/普通会话）返回 undefined。
 * 仅读头部（SUMMARY_NAME_WINDOW_BYTES），不触碰完整正文。
 */
export async function probeTintinwebSubagentParent(host: SessionTitleProbeHost, filePath: string): Promise<string | undefined> {
	const head = await readHeadAndInfer(host, filePath, false);
	if (!head) return undefined;
	return detectFlatSubagentParentFromHead(host, filePath, head.raw);
}
