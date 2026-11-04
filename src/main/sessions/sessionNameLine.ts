/**
 * pi 会话 JSONL 文本里的「命名规则」：旧版私有 sessionName 行 + 会话标题推断（纯函数）。
 *
 * 为什么这两件事在同一个文件：它们都是「文本里的会话名从哪来」。本地扫描/补名（SessionScanner）
 * 与远端按需标题（RemoteSessionScanner，H1）必须共用同一套规则，否则同一个文件在侧栏与远端会得到
 * 两个标题。这里只依赖 shared 的纯文本工具，不碰 electron / fs / 网络，便于直接单测。
 *
 * 历史背景（私有行）：旧版 PiDeck 重命名会话时会在 JSONL 文件头前置
 * {"sessionName":<名称>,"ts":<时间戳>}（无 type 字段）。pi 要求会话文件
 * 首条可解析记录必须是 type:"session" 头（loadEntriesFromFile 校验 entries[0]），
 * 私有行位于头部时 pi 会拒绝加载（"Session file is not a valid pi session"，exit 1），
 * 表现为桌面端「Failed to start session runtime」。新版已改为追加 pi 原生
 * session_info 记录；本模块负责识别并剔除存量私有行（#114），同时在推断标题时把它当作名字候选。
 */

import { looksLikePiSessionFileStem } from "../../shared/sessionIdentity";
import { textForSessionTitle } from "../../shared/expandedRefBlocks";

/** 判定解析后的记录是否为旧版私有 sessionName 行：有 sessionName 字符串且无 type（pi 原生记录一律有 type）。 */
export function isLegacySessionNameEntry(parsed: unknown): boolean {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
	const record = parsed as Record<string, unknown>;
	return typeof record.sessionName === "string" && typeof record.type !== "string";
}

/** 解析单行 JSON 并判定是否为旧版私有 sessionName 行；不可解析的行返回 false（原样保留）。 */
export function isLegacySessionNameLine(line: string): boolean {
	try {
		return isLegacySessionNameEntry(JSON.parse(line));
	} catch {
		return false;
	}
}

/**
 * 检测「首行被写成 <任意前缀>.jsonl{JSON} 粘连」的损坏模式，返回剥离后的首行 JSON，否则 null。
 *
 * 2026-08 用户现场：会话文件首行 = `C:\Users\...\xxx.jsonl{"type":"session",...}`（路径与 header
 * 无换行粘连）。pi 的 loadEntriesFromFile 会跳过无法解析的行、只校验 entries[0].type==="session"；
 * 该行解析失败被跳过，第二条记录（如 model_change）成为首条 → 校验失败「Session file is not a valid
 * pi session」。修复 = 保留 `{` 起的 JSON 部分。
 *
 * 只接受一种明确模式：首行含 `.jsonl{`，且 `{` 后是合法 JSON 且 type==="session" 且 id 为字符串
 * （与 pi 校验语义一致，确保与文件名同源的 header）——其余损坏形态不动，留给人工处理。
 */
export function tryRestorePathGluedHeader(head: string): string | null {
	const newline = head.indexOf("\n");
	const firstLine = newline === -1 ? head : head.slice(0, newline);
	const marker = firstLine.indexOf(".jsonl{");
	if (marker < 0) return null;
	const candidate = firstLine.slice(marker + ".jsonl{".length - 1); // 从 `{` 起
	try {
		const parsed = JSON.parse(candidate) as Record<string, unknown>;
		if (parsed.type === "session" && typeof parsed.id === "string") return candidate;
		return null;
	} catch {
		return null;
	}
}

/**
 * 剔除 JSONL 文本中的空行与旧版私有 sessionName 行，返回规范化文本
 * （\n 连接，末尾换行；文件为空或只剩私有行时返回空串）。
 * 供会话修复与重命名共用，保证两处清理口径一致；非私有行内容与顺序原样保留。
 */
export function stripLegacySessionNameLine(raw: string): string {
	const kept: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (isLegacySessionNameLine(trimmed)) continue;
		kept.push(trimmed);
	}
	return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}

// ── 会话标题推断：从 JSONL 文本到标题（纯函数） ───────────────────────
// SessionScanner（本地扫描/补名）与 RemoteSessionScanner（远端按需标题，H1）共用这一套：
// 「pi 会话的标题从哪来」只允许有一份实现。这些函数原本是 SessionScanner 的模块私有级
// 实现（inferScanNameFromLines / cleanScanTitle / extractText），远端要复用就只能复制一份，
// 所以这里把「接受文本的纯函数」抽出来共用，行为逐字不变。

/** catalog 扫描只取摘要字段；JSONL 行形态不固定，未知字段忽略。 */
export type SessionScanMessage = {
	role?: string;
	content?: unknown;
	provider?: string;
	model?: string;
	/** 生图消息标识：PiDeck 本地写入的 api=openai-images 或 imageGen 元数据 */
	api?: string;
	imageGen?: unknown;
};

export type SessionScanLine = {
	type?: string;
	customType?: string;
	/** fork/clone 产物判定用：复制来的父历史行时间戳必然早于本文件头。 */
	timestamp?: string;
	name?: string;
	sessionName?: string;
	cwd?: string;
	projectPath?: string;
	parentSession?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	codexSessionId?: string;
	sourcePath?: string;
	threadSource?: string;
	parentThreadId?: string;
	agentRole?: string;
	agentNickname?: string;
	role?: string;
	content?: unknown;
	model?: string;
	message?: SessionScanMessage;
	data?: {
		name?: string;
		cwd?: string;
		message?: SessionScanMessage;
		session?: { cwd?: string };
	};
	header?: { name?: string; cwd?: string; parentSession?: string };
	session?: { name?: string; cwd?: string };
};

export function isSessionScanLine(value: unknown): value is SessionScanLine {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 清洗会话标题候选：时间戳文件名 / 纯 untitled 不算标题；标题本身不做存储截断。 */
export function cleanSessionTitleCandidate(value?: string): string | undefined {
	const text = value?.replace(/\s+/g, " ").trim();
	// 时间戳文件名不是会话名：跳过才能回退到首条 user/assistant 文本。
	if (!text || /^untitled$/i.test(text) || looksLikePiSessionFileStem(text)) return undefined;
	// 侧栏负责视觉窗口与 hover 滚动；这里必须保留 session_info 的完整名称，尤其是末尾的 (fork)。
	return text;
}

/** fork/clone 产物头部边界：复制来的父历史行时间戳必然早于本文件头。 */
export type ForkHistoryBoundary = { parentSession: boolean; headerTimestamp?: string };

/** 在头部行序列里找本文件的 session 头，取出 parentSession 与头部时间戳。 */
export function readForkHistoryBoundary(lines: readonly string[]): ForkHistoryBoundary {
	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isSessionScanLine(parsed) || parsed.type !== "session") continue;
		return {
			parentSession: Boolean(parsed.parentSession ?? parsed.header?.parentSession),
			headerTimestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
		};
	}
	return { parentSession: false };
}

/**
 * 判定 session_info 是否属于「复制来的父会话历史」（fork/clone 产物的文件头带 parentSession，
 * 且该 name 的时间戳早于本文件头）。
 *
 * 为什么需要：pi/PiDeck 的 fork/clone 都是复制父会话文件再追加自己的 session_info；复制进来的
 * 那条是**父会话的名字**，不是本文件的名字，但读取端「取最后一条 session_info」的规则会把它
 * 当成权威名——新克隆文件在被命名前被扫描（几百毫秒竞态）就会出现「复制出来的会话名丢了
 * (fork) 后缀」或停在父名上再也升不回来（2026-10-11 复现）。这里降级为弱候选：显示兜底可用，
 * 但不能锁定所有权，等 pi 追加的权威名或 PiDeck 命令写入的标题来升级。
 * 头部截断/读不到（parentSession 或时间戳缺失）时不判定，保持旧行为。
 */
export function isCopiedParentSessionInfo(entry: SessionScanLine, boundary: ForkHistoryBoundary): boolean {
	const headerTimestamp = boundary.headerTimestamp;
	if (!boundary.parentSession || !headerTimestamp) return false;
	const timestamp = entry.timestamp;
	if (!timestamp) return false;
	return timestamp < headerTimestamp;
}

/**
 * 消息 content → 纯文本。搬自 SessionScanner 的私有 extractText，行为逐字不变：
 * 字符串原样；数组里取字符串项与对象的 text/thinking；其余忽略。
 */
export function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (typeof item === "string") return item;
				if (item !== null && typeof item === "object") {
					const record = item as Record<string, unknown>;
					return String(record.text ?? record.thinking ?? "");
				}
				return "";
			})
			.filter(Boolean)
			.join(" ");
	}
	return "";
}

/**
 * 消息 content → **正文**（只取 text 块，thinking 一律丢弃）。
 *
 * #488：标题必须是正文——thinking 是模型的草稿本，不是任何人给会话起的名字。旧实现对
 * thinking 与 text 一视同仁（`text ?? thinking`），于是「头窗口没读到首条用户消息」时会话标题
 * 变成一段思考原文并锁进 catalog。需要含 thinking 的全文时仍用 extractTextFromContent
 * （会话引用的预算统计等场景刻意不共用，见 shared/sessionReferenceContext.ts）。
 */
export function extractBodyTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (typeof item === "string") return item;
			if (item !== null && typeof item === "object") {
				const record = item as Record<string, unknown>;
				return typeof record.text === "string" ? record.text : "";
			}
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

/** 弱兜底候选出自哪一类消息：user 正文 > assistant 正文 > thinking（后者只在一份窗口零正文时降级使用）。 */
export type SessionTitleFallbackKind = "user" | "assistant" | "thinking";

/** 标题推断结果；fromSessionInfo 只保留来源信息（与本地 readSummary 的 inferredName 同一契约）。 */
export type SessionTitleInference = {
	name?: string;
	fromSessionInfo: boolean;
	fallbackName?: string;
	/** fallbackName 的消息来源；undefined = 没有可用兜底。 */
	fallbackKind?: SessionTitleFallbackKind;
	/**
	 * 旧口径（thinking 也算正文）的兜底候选，仅供存量指纹自愈比对：catalog 里被旧版本锁成
	 * fallback 的 thinking 原文必须能对上它才算「当年猜错的那一条」（#488）。
	 */
	legacyFallbackName?: string;
};

/**
 * 从已解析的 JSONL 行序列推断会话标题（与 readSummary 的 inferredName 同一优先级：
 * session_info 名 > 旧版私有 sessionName > 首条 user 文本 > 首条 assistant 文本）。
 * 推断不出返回 name=undefined（空文件/只有 tool 消息/全是畸形行），由调用方兜底。
 *
 * @returns { name, fromSessionInfo, fallbackName }：fromSessionInfo 仅保留来源信息，供诊断与
 * 首次发现标题推断使用。PiDeck catalog 已有记录后不再接受任何 JSONL 名称反向写入。
 * fallbackName 是本文件的弱兜底候选（首条 user 文本，其次首条 assistant 文本），
 * 与最终 name 取谁无关：#266 存量自愈要用它判断 catalog 里存的这一行是不是当年被误锁的首句。
 */
export function inferSessionTitleFromLines(lines: readonly string[], extractText: (content: unknown) => string = extractTextFromContent): SessionTitleInference {
	const forkBoundary = readForkHistoryBoundary(lines);
	let latestSessionInfoName: string | undefined;
	let copiedParentInfoName: string | undefined;
	let name: string | undefined;
	let firstUserText = "";
	let firstAssistantText = "";
	let firstThinkingText = "";
	let firstUserFullText = "";
	let firstAssistantFullText = "";
	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// 头部截断的半行/损坏行：跳过，不影响标题推断。
			continue;
		}
		if (!isSessionScanLine(parsed)) continue;
		const entry = parsed;
		if (entry.type === "session_info") {
			// Forked sessions may contain an older copied name; only the latest marker is authoritative.
			const candidate = typeof entry.name === "string" ? entry.name : entry.data?.name;
			// 复制来的父会话名（时间戳早于本文件头）不是本文件的名字：只能当弱候选。
			// 否则新克隆出来的文件在 PiDeck 写 (fork) 名的几百毫秒窗口里被扫描时，
			// 标题会被锁成父会话名（没有 (fork) 后缀）或首条消息，且大文件下再也升不回来。
			if (isCopiedParentSessionInfo(entry, forkBoundary)) copiedParentInfoName ??= candidate;
			else latestSessionInfoName = candidate;
		} else {
			name ||= entry.sessionName || entry.name || entry.data?.name || entry.header?.name || entry.session?.name;
		}
		const nested = entry.message ?? entry.data?.message;
		const message: SessionScanMessage = nested ?? { role: entry.role, content: entry.content };
		if (message.role) {
			// 正文（只看 text 块）与含 thinking 的全文分开收集：标题取正文，thinking 只在整份窗口
			// 一个正文都没有时降级使用；全文另外留一份，作为旧版本误锁标题的指纹基准（#488）。
			const body = extractBodyTextFromContent(message.content).trim();
			const full = extractText(message.content).trim();
			if (message.role === "user") {
				if (body) {
					if (!firstUserText) firstUserText = body;
				} else if (full && !firstThinkingText) {
					firstThinkingText = full;
				}
				if (full && !firstUserFullText) firstUserFullText = full;
			} else if (message.role === "assistant") {
				if (body) {
					if (!firstAssistantText) firstAssistantText = body;
				} else if (full && !firstThinkingText) {
					firstThinkingText = full;
				}
				if (full && !firstAssistantFullText) firstAssistantFullText = full;
			}
		}
	}
	// 取出 clean 前先保留来源标记：清洗后也可能是 timestamp/stem，
	// 此时它不再能作为 session_info 标题使用。
	// 弱候选的次序仍是「本文件 session_info 名 > 复制来的父会话名 > 其它字段名」：
	// 复制来的父名虽然不能当权威名，但作为显示兜底仍比首条消息更像会话名。
	const authoritativeInfoName = cleanSessionTitleCandidate(latestSessionInfoName);
	// 旧版私有 sessionName 行（无 type）与 header/session 名字字段仍按历史上「名字即权威」处理：
	// dev 的 fork 降级只针对**复制来的父会话 session_info**（它不会进入 name），不能顺手改变
	// 旧数据的 catalog 所有权语义（#266 存量自愈依赖 fromSessionInfo）。
	const namedFieldInfoName = cleanSessionTitleCandidate(name);
	const infoName = authoritativeInfoName || cleanSessionTitleCandidate(copiedParentInfoName) || namedFieldInfoName;
	// 首条 user 可能是展开后的 `/模板名` / `&会话引用` 块：先剥块正文，只拿用户自己写的字当回退标题，
	// 否则重开/扫描会把 `<prompt_template …>` 原文写回 catalog（与 inferTitleFromMessages 同一套清洗）。
	// 弱兜底候选先算出来，权威名赢的时候也要带出去（#266 指纹修复的比对基准）。
	// 优先级 user 正文 > assistant 正文 > thinking：思考原文只在一份窗口没有任何正文时兜底（#488）。
	const userCandidate = cleanSessionTitleCandidate(textForSessionTitle(firstUserText));
	const assistantCandidate = cleanSessionTitleCandidate(firstAssistantText);
	const thinkingCandidate = cleanSessionTitleCandidate(textForSessionTitle(firstThinkingText));
	const fallback = userCandidate || assistantCandidate || thinkingCandidate;
	const fallbackKind: SessionTitleFallbackKind | undefined = userCandidate ? "user" : assistantCandidate ? "assistant" : thinkingCandidate ? "thinking" : undefined;
	// 旧口径兜底（thinking 也算正文）：只在需要判断「catalog 里存的这一行是不是当年猜错的 thinking」时用。
	const legacyFallbackName = cleanSessionTitleCandidate(textForSessionTitle(firstUserFullText)) || cleanSessionTitleCandidate(firstAssistantFullText);
	const trailing = { fallbackName: fallback, fallbackKind, legacyFallbackName };
	if (infoName) return { name: infoName, fromSessionInfo: Boolean(authoritativeInfoName || namedFieldInfoName), ...trailing };
	if (fallback) return { name: fallback, fromSessionInfo: false, ...trailing };
	return { name: undefined, fromSessionInfo: false, ...trailing };
}

/**
 * 有界头文本 → 标题推断（远端按需标题通道 H1 的入口；本地头窗口推断同样走它）。
 * 行边界可能被截断（半行 JSON 解析失败即跳过），所以调用方不需要先对齐行。
 */
export function inferSessionTitleFromHeadText(text: string, extractText: (content: unknown) => string = extractTextFromContent): SessionTitleInference {
	return inferSessionTitleFromLines(text.split(/\r?\n/).filter(Boolean), extractText);
}
