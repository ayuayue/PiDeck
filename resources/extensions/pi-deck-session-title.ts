/**
 * PiDeck 的轻量会话标题扩展。
 *
 * 标题请求只在首轮 agent_settled 后异步发起，使用独立的最小 Context；
 * 即使主轮被中断，也根据首条 user 意图生成标题，不修改主 agent 的 prompt、消息、工具或 session transcript。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

const MAX_USER_INPUT_CHARS = 1600;
const MAX_ASSISTANT_INPUT_CHARS = 600;
const TITLE_TIMEOUT_MS = 30_000;
const MAX_TITLE_ATTEMPTS = 2;
/**
 * 标题请求的输出预算（token）。
 * 必须给推理型模型留出思考空间：这类模型会先花掉输出预算产 thinking 块再输出正文，
 * 预算太小时正文一个 token 都拿不到（stopReason="length" + 纯 thinking），自动命名静默失效
 * （2026-09-13 现场：jiyuan/deepseek-flash 默认开启推理，64 token 全被思考吃掉）。
 */
const TITLE_MAX_TOKENS = 512;
/** 首轮预算被推理吃光时的升级预算：长思考模型至少还有一轮完整的正文空间。 */
const TITLE_MAX_TOKENS_ESCALATED = 2048;
/** Main process accepts this marker only immediately before the matching session_info change. */
const AUTO_TITLE_STATUS_KEY = "pideck:auto-title";

const TITLE_SYSTEM_PROMPT = `You generate a concise title for a coding assistant conversation.
Return only one plain-text title on one line, with no explanation, quotes, Markdown, emoji, or "Title:" prefix.
Use the same language as the user's request when practical. Keep technical names that help identify the task.
Prefer a specific task summary over a generic title. Keep it within 32 characters.
Never repeat credentials, tokens, passwords, private keys, or other sensitive values.`;

const PRIVATE_KEY_RE = /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_SECRET_RE = /([?&](?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|token|secret|password)=)[^&#\s]+/gi;
const SECRET_ASSIGNMENT_RE =
	/(\b(?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|authorization|password|passwd|secret|token|cookie)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s"'`,;}\]]{4,})/gi;
const RAW_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g;
const EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;

const GENERIC_TITLES = new Set([
	"title",
	"session title",
	"conversation title",
	"new session",
	"untitled",
	"会话标题",
	"新会话",
	"未命名",
]);

type TitleRequestInput = {
	userText: string;
	assistantText?: string;
};

/**
 * 标题输入：`direct` = 消息里只有引用块（如只插了 /模板 没写正文），标签本身就是标题，
 * 不必再花一次模型请求；`request` = 把剥块后的用户文本交给标题模型概括。
 */
type TitleInput = { kind: "direct"; title: string } | ({ kind: "request" } & TitleRequestInput);

type PendingTitle = {
	controller: AbortController;
	sessionId: string;
	runtimeGeneration: number;
	nameRevision: number;
};

type TitleAuth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;

/** 从消息 content 中提取纯文本；图片、思考、工具调用等非文本块会被忽略。 */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: unknown) => {
			if (!isRecord(part)) return "";
			return part.type === "text" && typeof part.text === "string" ? part.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function messageText(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "assistant") return "";
	return extractText(message.content);
}

function normalizeInputText(text: string): string {
	return text
		.replace(/\u0000/g, " ")
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+/g, " ")
		.trim();
}

/** 在送往独立标题请求前遮蔽常见凭据格式，避免标题调用重复携带秘密。 */
export function redactSensitiveText(text: string): string {
	let redacted = text.replace(PRIVATE_KEY_RE, "[REDACTED SECRET]");
	redacted = redacted.replace(BEARER_RE, "Bearer [REDACTED]");
	redacted = redacted.replace(URL_SECRET_RE, "$1[REDACTED]");
	redacted = redacted.replace(
		SECRET_ASSIGNMENT_RE,
		(_whole: string, prefix: string) => `${prefix}[REDACTED]`,
	);
	return redacted.replace(RAW_TOKEN_RE, "[REDACTED TOKEN]");
}

function truncateText(text: string, maxChars: number): string {
	const chars = Array.from(text);
	return chars.length <= maxChars ? text : chars.slice(0, maxChars).join("").trimEnd();
}

function prepareInputText(text: string, maxChars: number): string {
	const normalized = normalizeInputText(redactSensitiveText(text));
	return truncateText(normalized, maxChars) || "[redacted]";
}

function isCommandInput(text: string): boolean {
	return /^\s*\/[\w:-]+(?:\s|$)/.test(text);
}

/**
 * 自包含引用块的标题清洗（与 src/shared/expandedRefBlocks.ts 的 textForSessionTitle 同语义）。
 *
 * 扩展是 pi 用 `-e` 直接加载的独立文件，运行时不能 import 应用源码，所以这里必须自带一份；
 * 两侧行为一致性由 tests/piDeckSessionTitle.test.mjs 的对照用例锁定。
 * 只保留块外由用户自己写的文字：模板正文/引用全文是发给主模型的上下文，进标题就是噪声
 *（2026-10 现场：首条消息用 /模板 时 1600 字预算被模板正文吃光，用户真正说的话根本没进请求，
 * 标题变成模板里的章节名「翻译官工作规则」）。块外没有任何文字时回退到块标签（`/模板名`）。
 */
const TITLE_BLOCK_PATTERNS: ReadonlyArray<{ source: string; flags: string; label: (name: string) => string }> = [
	// 与 shared 解析层一一对应：属性名与换行要求必须一致，否则同一消息会在两侧得出不同标题。
	{ source: '<quoted_context\\s+label="([^"]*)"\\s+message_id="[^"]*">\\r?\\n[\\s\\S]*?\\r?\\n<\\/quoted_context>', flags: "g", label: (name) => `❝${name}` },
	{ source: '<referenced_session\\s+name="([^"]*)">\\r?\\n[\\s\\S]*?\\r?\\n<\\/referenced_session>', flags: "g", label: (name) => `&${name}` },
	{ source: '<skill\\b[^>]*\\bname="([^"]*)"[^>]*>[\\s\\S]*?<\\/skill>', flags: "gi", label: (name) => `/skill:${name}` },
	{ source: '<prompt_template\\b[^>]*\\bname="([^"]*)"[^>]*>[\\s\\S]*?<\\/prompt_template>', flags: "gi", label: (name) => `/${name}` },
];

/** XML 属性反转义（仅处理 PiDeck/pi 生成的四种实体，与 shared 一致）。 */
function decodeBlockAttribute(value: string): string {
	return value.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

type TitleTextBlock = { start: number; end: number; label: string };

function findTitleTextBlocks(text: string): TitleTextBlock[] {
	const blocks: TitleTextBlock[] = [];
	for (const pattern of TITLE_BLOCK_PATTERNS) {
		const re = new RegExp(pattern.source, pattern.flags);
		let match: RegExpExecArray | null;
		while ((match = re.exec(text)) !== null) {
			blocks.push({ start: match.index, end: match.index + match[0].length, label: pattern.label(decodeBlockAttribute(match[1] ?? "")) });
		}
	}
	// 与 shared 一致：排序后跳过被外层块覆盖的内层块（引用会话的正文里可能再嵌引用块）。
	blocks.sort((left, right) => left.start - right.start || right.end - left.end);
	const topLevel: TitleTextBlock[] = [];
	let coveredEnd = -1;
	for (const block of blocks) {
		if (block.start < coveredEnd) continue;
		topLevel.push(block);
		coveredEnd = block.end;
	}
	return topLevel;
}

/**
 * 从落盘的首条 user 消息里提取标题用文本。
 * blockOnly=true 表示消息里只有引用块（如只插了 /模板），此时 text 是块标签（`/模板名`）。
 */
export function titleTextFromUserInput(text: string): { text: string; blockOnly: boolean } {
	if (!text.includes("<")) return { text, blockOnly: false };
	const blocks = findTitleTextBlocks(text);
	if (blocks.length === 0) return { text, blockOnly: false };
	const outside: string[] = [];
	const labels: string[] = [];
	let cursor = 0;
	for (const block of blocks) {
		if (block.start > cursor) outside.push(text.slice(cursor, block.start));
		labels.push(block.label);
		cursor = block.end;
	}
	if (cursor < text.length) outside.push(text.slice(cursor));
	const outsideText = outside.join(" ").replace(/\s+/g, " ").trim();
	if (outsideText) return { text: outsideText, blockOnly: false };
	return { text: labels.join(" "), blockOnly: true };
}

function hasConversation(branch: readonly SessionEntry[]): boolean {
	return branch.some((entry) => entry.type === "message" && (
		entry.message.role === "user" || entry.message.role === "assistant"
	));
}

function firstMessageText(
	branch: readonly SessionEntry[],
	role: "user" | "assistant",
): string | undefined {
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== role) continue;
		const text = messageText(entry.message);
		if (text.trim()) return text;
	}
	return undefined;
}

function lastAssistant(branch: readonly SessionEntry[]): AssistantMessage | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			return entry.message;
		}
	}
	return undefined;
}

function isIncompleteAssistant(message: AssistantMessage | undefined): boolean {
	return !message || message.stopReason === "error" || message.stopReason === "aborted";
}

function firstCompletedAssistantText(branch: readonly SessionEntry[]): string | undefined {
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (isIncompleteAssistant(entry.message)) continue;
		const text = messageText(entry.message);
		if (text.trim()) return text;
	}
	return undefined;
}

/**
 * 从首轮分支构造最小标题输入。
 * 只取首条 user 文本和少量已完成 assistant 文本，不读取 system/tools/thinking/文件内容。
 * 主轮被中断或报错时仍保留 user 意图，确保标题旁路不会因主 Agent 失败而失效。
 */
export function buildTitleInput(branch: readonly SessionEntry[]): TitleInput | undefined {
	const firstUser = firstMessageText(branch, "user");
	if (!firstUser || isCommandInput(firstUser)) return undefined;

	// /模板、/skill:、&会话、❝引用在发送前已展开成自包含块，块正文是给主模型读的上下文。
	// 标题必须先剥块：否则 1600 字预算会被模板正文吃光，用户真正说的话根本进不了请求。
	const cleaned = titleTextFromUserInput(firstUser);
	if (cleaned.blockOnly) {
		// 只插了 /模板 没写正文：模板名就是最准确的标题，不必再花一次模型请求。
		return { kind: "direct", title: cleaned.text };
	}

	const finalAssistant = lastAssistant(branch);
	const firstAssistant = isIncompleteAssistant(finalAssistant)
		? undefined
		: firstCompletedAssistantText(branch);
	return {
		kind: "request",
		userText: prepareInputText(cleaned.text, MAX_USER_INPUT_CHARS),
		...(firstAssistant
			? { assistantText: prepareInputText(firstAssistant, MAX_ASSISTANT_INPUT_CHARS) }
			: {}),
	};
}

/**
 * 判断响应是否「输出预算被推理吃光」：显式截断（stopReason="length"）且没有任何正文。
 * 只有这种情况值得升预算重发；其它空响应（模型返回空、命中清洗规则）重发结果一样。
 */
export function isOutputBudgetExhausted(response: AssistantMessage): boolean {
	return response.stopReason === "length" && extractText(response.content).trim().length === 0;
}

/** 构造独立请求的 Context；该 Context 与主 agent 的上下文完全无关。 */
export function buildTitleContext(input: TitleRequestInput): Context {
	const assistantSection = input.assistantText
		? `\n\nAssistant's first response:\n${input.assistantText}`
		: "";
	return {
		systemPrompt: TITLE_SYSTEM_PROMPT,
		messages: [{
			role: "user",
			content: `User's first request:\n${input.userText}${assistantSection}`,
			timestamp: Date.now(),
		}],
	};
}

function stripWrappingQuotes(text: string): string {
	let result = text.trim();
	for (let index = 0; index < 2; index += 1) {
		const pairs: readonly [string, string][] = [
			["\"", "\""],
			["'", "'"],
			["`", "`"],
			["“", "”"],
			["「", "」"],
			["『", "』"],
		];
		const pair = pairs.find(([left, right]) => result.startsWith(left) && result.endsWith(right));
		if (!pair) break;
		result = result.slice(pair[0].length, -pair[1].length).trim();
	}
	return result;
}

function stripMarkdownEmphasis(text: string): string {
	let result = text.trim();
	const wrappers = [
		["**", "**"],
		["__", "__"],
		["~~", "~~"],
		["*", "*"],
		["_", "_"],
	] as const;
	for (const [left, right] of wrappers) {
		if (result.startsWith(left) && result.endsWith(right) && result.length > left.length + right.length) {
			result = result.slice(left.length, -right.length).trim();
			break;
		}
	}
	return result;
}

/** 清洗模型输出，确保写入 session_info 的标题短、一行且不带模型格式噪声。 */
export function cleanTitle(raw: string): string | undefined {
	const lines = raw
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !/^```(?:text|markdown)?$/i.test(line));
	const firstLine = lines[0];
	if (!firstLine) return undefined;

	let title = stripMarkdownEmphasis(firstLine)
		.replace(/^```(?:text|markdown)?\s*/i, "")
		.replace(/```$/g, "")
		.replace(/^[#>*+\-\s]+/, "")
		.replace(/^(?:title|session title|conversation title|标题|会话标题)\s*[:：-]\s*/i, "")
		.replace(/[`]/g, "")
		.replace(EMOJI_RE, "");
	title = stripMarkdownEmphasis(stripWrappingQuotes(title))
		.replace(/\s+/g, " ")
		.replace(/^[\s:：|]+|[\s:：|]+$/g, "")
		.replace(/[.!?。！？；;，,]+$/g, "")
		.trim();
	if (!title) return undefined;
	// 模型输出也不可信：若标题本身命中凭据模式，直接丢弃而不是把脱敏占位符写进 session_info。
	const safeTitle = redactSensitiveText(title);
	if (safeTitle !== title) return undefined;
	title = safeTitle;

	// 标题长度由模型提示约束（TITLE_SYSTEM_PROMPT 要求 32 字符内），这里不再硬截断：
	// 按字符硬切会把英文单词切成碎词（2026 现场："issue" → "issu"、"remove" → "remov"），
	// 模型偶尔超长时保留完整标题更可读（侧栏/树节点由 CSS 窗口钳制，hover 可滚动查看全文）。
	if (Array.from(title).length < 2) return undefined;
	if (GENERIC_TITLES.has(title.toLocaleLowerCase())) return undefined;
	if (/^(?:title|session|conversation|untitled|new)\s*(?:title|session)?$/i.test(title)) return undefined;
	return title;
}

function readSessionId(ctx: ExtensionContext): string | undefined {
	try {
		const id = ctx.sessionManager.getSessionId();
		return id.trim() || undefined;
	} catch {
		return undefined;
	}
}

function hasSessionName(pi: ExtensionAPI): boolean {
	try {
		return Boolean(pi.getSessionName()?.trim());
	} catch {
		return false;
	}
}

async function withTimeout<T>(
	task: Promise<T>,
	controller: AbortController,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error("session title request timed out"));
		}, timeoutMs);
	});
	try {
		return await Promise.race([task, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function requestTitle(
	model: NonNullable<ExtensionContext["model"]>,
	input: TitleRequestInput,
	controller: AbortController,
	authPromise: Promise<TitleAuth | undefined>,
): Promise<string | undefined> {
	const startedAt = Date.now();
	try {
		// 认证在 session_start/agent_start 预热；中断发生在主模型请求尚未完成时，
		// 直接在 agent_settled 再取认证可能与主请求争用同一凭据解析链，导致旁路超时。
		const auth = await withTimeout(authPromise, controller, TITLE_TIMEOUT_MS);
		if (!auth?.ok) return undefined;

		// OAuth/凭据可能为当前请求提供临时 baseUrl（例如 Copilot）；不能只传 apiKey，
		// 否则独立标题请求会落到模型的旧端点并失败。模型对象只在本次旁路调用中覆盖。
		const titleModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		// 两次尝试共享同一个 TITLE_TIMEOUT_MS 总预算：升级重发不会让旁路拖得更久。
		for (const budget of [TITLE_MAX_TOKENS, TITLE_MAX_TOKENS_ESCALATED]) {
			const remaining = Math.max(1, TITLE_TIMEOUT_MS - (Date.now() - startedAt));
			const response = await withTimeout(
				Promise.resolve().then(() => completeSimple(titleModel, buildTitleContext(input), {
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal: controller.signal,
					maxTokens: budget,
					maxRetries: 0,
					timeoutMs: remaining,
				})),
				controller,
				remaining,
			);
			if (response.stopReason === "error" || response.stopReason === "aborted") return undefined;
			const title = cleanTitle(extractText(response.content));
			if (title || budget >= TITLE_MAX_TOKENS_ESCALATED) return title;
			if (!isOutputBudgetExhausted(response)) return undefined;
		}
		return undefined;
	} catch {
		// 标题是非关键的旁路请求：认证失败、超时、取消或模型异常都回落到 PiDeck 原有标题。
		return undefined;
	}
}

/** PiDeck 内置扩展入口。 */
export default function piDeckSessionTitle(pi: ExtensionAPI): void {
	// PiDeck 总是显式注入 0/1；未由 PiDeck 启动时默认开启，便于直接调试扩展。
	const enabled = process.env.PIDECK_AUTO_SESSION_TITLE !== "0";
	let sessionId: string | undefined;
	let runtimeGeneration = 0;
	let eligible = false;
	let titleAttempts = 0;
	let agentRunGeneration = 0;
	let titleAttemptRunGeneration: number | undefined;
	let manualNameTouched = false;
	let nameRevision = 0;
	let pending: PendingTitle | undefined;
	let applyingAutoTitle = false;
	let authCache: {
		modelKey: string;
		promise: Promise<TitleAuth | undefined>;
	} | undefined;

	const modelKey = (model: NonNullable<ExtensionContext["model"]>): string =>
		`${model.provider}\u0000${model.id}\u0000${model.api}`;

	const primeAuth = (
		ctx: ExtensionContext,
		model: NonNullable<ExtensionContext["model"]>,
		refresh: boolean,
	): Promise<TitleAuth | undefined> => {
		const key = modelKey(model);
		if (!refresh && authCache?.modelKey === key) return authCache.promise;
		const promise = Promise.resolve()
			.then(() => ctx.modelRegistry.getApiKeyAndHeaders(model))
			.catch(() => undefined);
		authCache = { modelKey: key, promise };
		return promise;
	};

	const cancelPending = () => {
		const current = pending;
		pending = undefined;
		current?.controller.abort();
	};

	/** Mark this exact name so PiDeck can distinguish our auto rename from /name or TUI writes. */
	const markAutomaticTitle = (ctx: ExtensionContext, title: string) => {
		try {
			ctx.ui.setStatus(AUTO_TITLE_STATUS_KEY, title);
		} catch {
			// A non-interactive host can reject status UI; the pi session rename still proceeds.
		}
	};

	pi.on("session_start", (event, ctx) => {
		cancelPending();
		runtimeGeneration += 1;
		sessionId = readSessionId(ctx);
		titleAttempts = 0;
		authCache = undefined;
		agentRunGeneration = 0;
		titleAttemptRunGeneration = undefined;
		manualNameTouched = false;
		nameRevision = 0;

		let branch: readonly SessionEntry[] = [];
		try {
			branch = ctx.sessionManager.getBranch();
		} catch {
			// 会话尚未完全绑定时按不可自动命名处理，避免误把恢复会话当新会话。
		}
		const freshReason = event.reason === "new" || event.reason === "startup";
		eligible = enabled && freshReason && !hasConversation(branch) && !hasSessionName(pi);
		if (eligible && ctx.model) primeAuth(ctx, ctx.model, false);
	});

	pi.on("model_select", (_event, ctx) => {
		if (enabled && eligible && ctx.model) primeAuth(ctx, ctx.model, true);
	});

	pi.on("session_info_changed", (_event, _ctx) => {
		if (applyingAutoTitle) return;
		// 任何外部 session_info 变化都视为用户/宿主介入，包括清空标题；手动意图优先于自动命名。
		manualNameTouched = true;
		nameRevision += 1;
		cancelPending();
	});

	pi.on("session_shutdown", (_event, _ctx) => {
		// 只取消标题旁路请求，不调用 ctx.abort()，绝不影响主 agent 的工作。
		cancelPending();
		runtimeGeneration += 1;
		sessionId = undefined;
		eligible = false;
		authCache = undefined;
		titleAttempts = MAX_TITLE_ATTEMPTS;
		manualNameTouched = true;
	});

	pi.on("agent_start", (_event, ctx) => {
		// 用真实 agent run 作为重试边界，避免重复 settled 事件消耗标题请求次数。
		agentRunGeneration += 1;
		if (enabled && eligible && ctx.model) {
			// 首轮复用启动阶段的预热结果；标题失败后的下一轮强制重新解析凭据。
			primeAuth(ctx, ctx.model, titleAttempts > 0);
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (
			!enabled
			|| !eligible
			|| titleAttempts >= MAX_TITLE_ATTEMPTS
			|| pending
			|| titleAttemptRunGeneration === agentRunGeneration
		) return;
		if (manualNameTouched || hasSessionName(pi)) return;

		// Anonymous sessions can receive their durable id only after the first prompt;
		// prefer the live value at settle time and retain the startup snapshot as fallback.
		const currentSessionId = readSessionId(ctx) ?? sessionId;
		if (currentSessionId) sessionId = currentSessionId;
		const model = ctx.model;
		if (!currentSessionId || !model) return;
		const authPromise = primeAuth(ctx, model, false);

		let branch: readonly SessionEntry[];
		try {
			branch = ctx.sessionManager.getBranch();
		} catch {
			return;
		}
		const input = buildTitleInput(branch);
		if (!input) return;

		if (input.kind === "direct") {
			// 消息里只有引用块（只插了 /模板 没写正文）：标签本身就是最准确的标题。
			// 直接命名，不消耗模型请求，也不再受推理模型输出预算/超时影响。
			titleAttempts += 1;
			titleAttemptRunGeneration = agentRunGeneration;
			applyingAutoTitle = true;
			try {
				markAutomaticTitle(ctx, input.title);
				pi.setSessionName(input.title);
			} catch {
				// session 已在销毁/替换时，丢弃即可。
			} finally {
				applyingAutoTitle = false;
			}
			return;
		}

		titleAttempts += 1;
		titleAttemptRunGeneration = agentRunGeneration;
		const request: PendingTitle = {
			controller: new AbortController(),
			sessionId: currentSessionId,
			runtimeGeneration,
			nameRevision,
		};
		pending = request;

		const isCurrent = () => {
			if (pending !== request || !eligible || manualNameTouched) return false;
			if (runtimeGeneration !== request.runtimeGeneration || sessionId !== request.sessionId) return false;
			if (nameRevision !== request.nameRevision || hasSessionName(pi)) return false;
			return readSessionId(ctx) === request.sessionId;
		};

		void requestTitle(model, input, request.controller, authPromise)
			.then((title) => {
				if (!title || !isCurrent()) return;
				applyingAutoTitle = true;
				try {
					markAutomaticTitle(ctx, title);
					pi.setSessionName(title);
				} catch {
					// session 已在销毁/替换时，丢弃旁路结果即可。
				} finally {
					applyingAutoTitle = false;
					pending = undefined;
				}
			})
			.catch(() => undefined)
			.finally(() => {
				if (pending === request) pending = undefined;
			});
	});
}
