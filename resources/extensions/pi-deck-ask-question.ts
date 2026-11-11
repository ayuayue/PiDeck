/**
 * PiDeck Ask Question Extension
 *
 * 注册 ask_question 工具，让 LLM 可以向用户提问并从桌面端 UI 获取回答。
 * 使用 pi RPC Extension UI Protocol（ctx.ui.input）实现用户交互，
 * 桌面端处理 extension_ui_request/response 协议循环。
 *
 * 提问形态（2026-09 收口，用户反馈「有时批量有时不批量、有时有自定义输入有时没有」）：
 *   - 无论单问题（顶层 type/question/options）还是批量（questions 数组），一律归一为
 *     问题列表后走同一个批量信封（一次 input envelope），由桌面端展开为卡片 UI。
 *     历史上单问题走原生 RPC 弹框、批量走 Tab 卡，同一内容两种外观随模型心情漂移；
 *     现在只有一条渲染形态，模型调用方式的差异不再影响用户所见。
 *   - select 题的自定义输入框恒定显示：allowOther 参数保留（模型传值不报错）但不再
 *     参与渲染决策，「自行输入」不再时隐时现。
 *
 * select 选项支持字符串或 {label, value?, description?} 对象；description 会拼进选项
 * 显示文本，让用户在桌面端按钮上直接看到说明。
 *
 * type 推断兜底（2026-09 统计：flash 档模型约 1/6 的批量提问会省略可推导的 type，
 * 校验层硬失败导致整批重发）：type 保持 schema 可选，执行时按问题形状兜底——
 * 带 options 推断为 select（confirm 的「是/否」以 select 呈现，语义一致），
 * 不带 options 推断为 input。显式传 multi_select/confirm/editor 时原样生效。
 *
 * 覆盖 ctx.hasUI 检查，非交互模式下跳过；UI 调用包 try-catch 处理用户取消场景。
 *
 * @packageDocumentation
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

// 归一化后的选项：select 专用
interface NormalizedOption {
	/** 传给 RPC select 的显示文本（可能含 description 拼接） */
	label: string;
	/** 选中后返回的值 */
	value: string;
	description?: string;
}

// 归一化后的问题
interface NormalizedQuestion {
	id: string;
	type: "select" | "multi_select" | "confirm" | "input" | "editor";
	question: string;
	options?: NormalizedOption[];
	allowOther?: boolean;
	placeholder?: string;
	prefill?: string;
}

// 单个答案
interface Answer {
	id: string;
	type: string;
	/** multi_select 的 value 为选中项数组 */
	value: string | boolean | string[] | null;
	label?: string;
	wasCustom?: boolean;
	/** 用户在卡片上主动跳过本题（value 为 null） */
	skipped?: boolean;
}

// askOne/askBatch 需要的上下文子集：桌面端统一走批量信封后只依赖 ui.input
interface AskCtx {
	hasUI: boolean;
	ui: {
		input: (question: string, placeholder?: string) => Promise<string>;
	};
}

/**
 * RPC only supports one dialog at a time. ALL questions (single or batch) travel in
 * one input envelope, which the desktop expands into its single composer-adjacent form.
 */
export const BATCH_ASK_ENVELOPE_KEY = "__piDeckBatchAsk";

// Schema：选项可为字符串简写或对象
const OptionSchema = Type.Union([
	Type.String({ description: "Option label; value defaults to the label itself" }),
	Type.Object({
		label: Type.String({ description: "Display label for the option" }),
		value: Type.Optional(Type.String({ description: "Value returned when selected (defaults to label)" })),
		description: Type.Optional(Type.String({ description: "Optional description shown alongside the label" })),
	}),
]);

const QuestionSchema = Type.Object({
	// id 可省略：toQuestions() 按序号兑底（q1/q2/…）。flash 档模型常省略可推导字段，
	// 留在 required 会重蹈 type 省略被整批拒绝→重发的覆辙，且白耗输出 token。
	id: Type.Optional(Type.String({ description: "Short unique id for this question; auto-assigned (q1, q2, …) when omitted" })),
	type: Type.Optional(
		StringEnum(["select", "multi_select", "confirm", "input", "editor"], {
			description: "Defaults to select when options are provided, otherwise input; set it explicitly for confirm/editor/multi_select. 多选必须写 type: \"multi_select\"（不要写 multi_select: true）",
		}),
	),
	question: Type.String({ description: "The question or prompt to display" }),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options for select / multi_select type questions" })),
	placeholder: Type.Optional(Type.String({ description: "Placeholder for input/editor questions" })),
	prefill: Type.Optional(Type.String({ description: "Prefill for input/editor questions" })),
});

// 只暴露 questions 数组一条调用路径（单问题也放进数组，长度为 1）。
// 2026-09 prompt 瘦身：删掉顶层单问题字段（type/question/options 等）。
// 运行时 toQuestions() 仍兼容老模型直接传顶层字段——pi 校验层不设置
// additionalProperties:false，未声明字段不会被拒绝，执行层照常归一化。
const AskQuestionParams = Type.Object({
	questions: Type.Optional(
		Type.Array(QuestionSchema, {
			description: "One or more questions to ask in a single card. ALWAYS use this array, even for a single question.",
		}),
	),
	review: Type.Optional(
		Type.Boolean({
			description: "When true, shows a Submit/review tab of all answers for confirmation. Default false.",
		}),
	),
});

/** 把任意 options 输入归一化为 {label, value, description} 结构，兼容字符串简写 */
function normalizeOptions(options: unknown): NormalizedOption[] {
	if (!Array.isArray(options)) return [];
	return options.map((opt) => {
		// 字符串简写：label 与 value 同值
		if (typeof opt === "string") return { label: opt, value: opt };
		const o = (opt ?? {}) as { label?: string; value?: string; description?: string };
		const label = String(o.label ?? "");
		return { label, value: o.value ?? label, description: o.description };
	});
}

const MULTI_INTENT_KEYS = ["multi_select", "multiSelect", "multiselect", "multi", "multiple"] as const;

const EDITOR_INTENT_KEYS = ["multiline", "multiLine", "multi_line"] as const;

function normalizeTypeToken(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_-]+/g, "") : "";
}

/**
 */
function echoModelText(value: unknown, maxLength = 60): string {
	const text = String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function echoModelValue(value: unknown, maxLength = 120): string {
	const text = String(JSON.stringify(value) ?? value).replace(/[\u2028\u2029]/g, " ");
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

const SINGLE_LIKE_KEY = /^(?:only|just)?(?:single|exclusive|one|1)[_\- ]?(?:choice|select(?:ion)?|pick|option|answer|item)s?(?:only)?$/i;

const OFF_WORDS = new Set(["false", "no", "off", "none", "null", "n/a", "na", "n", "not", "non", "negative", "without", "0", "", "否", "不", "非", "无", "没", "未", "不是", "不要", "关闭", "禁用", "禁止", "单行", "nope", "never", "disabled", "disable", "singleline", "oneline", "nah", "neither", "nor", "don't", "doesn't", "dont", "doesnt"]);

const OFF_PREFIXES = [...OFF_WORDS];

const SHORT_OFF_ROOTS = new Set(["not", "no", "non", "n/a", "na", "n", "off", "nah", "nor", "否", "不", "非", "无", "没", "未"]);

const NEGATED_SINGLE = /^(?:single|limit|exclusive|restrict)|^(?:one|only)\b.*\b(?:option|choice|select|pick)|^(?:only|just) one\b/;

const NEGATED_SINGLE_ZH = /^(?:不|非|无|没|未)(?:是)?(?:单选|单项|单行|限制|唯一|一个|互斥|排他|单一)/;

const NOT_OFF_PREFIXES = ["不限", "无限"];

const NEGATED_INTENT_ROOT = /^(?:not|no|non|off|nah|nor|na|n)(?:multi|multiple|checkbox|checklist)/;

const OFF_TOKEN_SEPARATORS = /[\s_.'\-/、。，；：！？（）「」【】…·,;:!?"()]+/g;

function normalizeOffToken(value: string): string {
	return value.trim().toLowerCase().replace(OFF_TOKEN_SEPARATORS, "");
}

function isOffToken(value: string): boolean {
	const token = normalizeTypeToken(value);
	const offToken = normalizeOffToken(value);
	const offPhrase = value.trim().toLowerCase();
	if (offToken === "online") return true;
	const clauseAfterNegation = /^(?:不|非|无|没|未|否|not|no|non|off|never|without|none|nah|nor|false|nope|neither)(?:是)?\s*[，,。;；!?.]/.test(offPhrase);
	if (!clauseAfterNegation && NOT_OFF_PREFIXES.some((word) => offToken.startsWith(word))) return false;
	if (!clauseAfterNegation && NEGATED_SINGLE_ZH.test(offToken)) return false;
	if (!clauseAfterNegation && NEGATED_INTENT_ROOT.test(offToken)) return true;
	if (OFF_WORDS.has(token)) return true;
	if (OFF_WORDS.has(offToken)) return true;
	const parts = value
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(OFF_TOKEN_SEPARATORS)
		.filter(Boolean)
		.map((part) => part.toLowerCase());
	const isOffWord = (part: string) => OFF_WORDS.has(part) || SHORT_OFF_ROOTS.has(part);
	const offIndex = parts.findIndex(isOffWord);
	if (!clauseAfterNegation && parts.length > 1 && offIndex >= 0 && NEGATED_SINGLE.test(parts.slice(offIndex + 1).join(" "))) return false;
	if (parts.length > 1 && offIndex >= 0) {
		const tail = parts.slice(offIndex + 1).join(" ");
		const tailToken = normalizeTypeToken(tail);
		const tailDoubleNegative =
			/^(?:not|no|non|definitely not)\s+(?:single|limit|exclusive|restrict|one|only)\b/i.test(tail) || NEGATED_SINGLE_ZH.test(normalizeOffToken(tail));
		if (clauseAfterNegation && !isOffToken(tail) && (hasMultiRoot(tailToken) || tailDoubleNegative) && !isLineLikeKey(tailToken)) return false;
		return true;
	}
	return OFF_PREFIXES.some((prefix) => {
		const root = normalizeOffToken(prefix);
		if (!offToken.startsWith(root) || offToken.length <= root.length) return false;
		return root.length >= 4 || /[^\x00-\x7f]/.test(root);
	});
}

const SINGLE_WORDS = new Set(["single", "singlechoice", "单选", "单项", "单一", "互斥", "排他", "唯一", "一个", "限制", "one", "only", "onlyone", "oneonly", "singleonly", "exclusive", "selectone", "pickone", "chooseone"]);

const SINGLE_LIMIT_PHRASE = /^(?:only|just|exactly|at ?most|max(?:imum)?|limited to|up to) (?:a |an )?(?:single|one|1)\b|^maximum of (?:one|1)\b|^(?:one|1) of\b|^(?:select|pick|choose) (?:only )?(?:one|1)\b(?! *or\b)|^(?:单选|单项)(?!或(?:多选|多项|复选|多个))|^(?:只|仅|至多|最多)(?:[能可许准要得让]|允许|准许|能够|可以|只|仅){0,3} *(?:选|挑|有)(?:择|中|取|选)? *(?:一|1)(?! *[个项条]? *(?:以上|或以上|或更多|及以上)) *[个项条]?|^(?:只|仅)(?:[能可许准要得让]|允许|准许)? *(?:一|1)(?! *[个项条]? *(?:以上|或以上|或更多|及以上)) *[个项条]?|^(?:只|仅)(?:[能可许准要得让]|允许|准许)? *(?:单选|单项)/;

function isSingleLikeValue(value: string): boolean {
	const multiDeniedAfterSinglePhrase = SINGLE_LIMIT_PHRASE.test(value.trim().toLowerCase().replace(/[_\-\s]+/g, " ")) && /(?:报错|错误|无效|失败)/.test(value);
	if (!multiDeniedAfterSinglePhrase && /(?<!至|最)(?:多选|多项|复选)/.test(value) && !/[不非无没未否别勿禁]/.test(value)) return false;
	const token = normalizeTypeToken(value);
	const stripped = normalizeOffToken(value);
	const phrase = value.trim().toLowerCase().replace(/[_\-\s]+/g, " ");
	return (
		SINGLE_WORDS.has(token) ||
		SINGLE_WORDS.has(stripped) ||
		SINGLE_LIKE_KEY.test(token) ||
		SINGLE_LIKE_KEY.test(stripped) ||
		SINGLE_LIMIT_PHRASE.test(phrase)
	);
}

function isIntentOn(value: unknown): boolean {
	if (typeof value === "string") {
		return !isOffToken(value) && !isSingleLikeValue(value);
	}
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	return false;
}

function isIntentSwitch(value: unknown): boolean {
	return typeof value === "string" || typeof value === "boolean" || typeof value === "number" ? isIntentOn(value) : false;
}

const MULTI_ROOT = /(?:multiple|multi(?:select|choice|pick|option|answer|line)|checkbox|checklist)/i;

function hasMultiRoot(token: string): boolean {
	return token === "multi" || MULTI_ROOT.test(token);
}

const CHOICE_ROOT = /choice/i;

function isMultiValueWord(value: unknown): boolean {
	return typeof value === "string" && hasMultiRoot(normalizeTypeToken(value)) && !isLineLikeKey(value);
}

function isMultiLikeToken(token: string, value?: unknown): boolean {
	return hasMultiRoot(token) || (CHOICE_ROOT.test(token) && isMultiValueWord(value));
}

const LINE_THEN_PICK = /lines?[_\- ]?(select|choice|options?|checkbox|picks?)/i;

const LINE_LIKE_MARKER = /multi(?:ple)?lines?/;

function isLineLikeKey(key: string): boolean {
	const token = normalizeTypeToken(key);
	return LINE_LIKE_MARKER.test(token) && !LINE_THEN_PICK.test(token);
}

const TOP_LEVEL_KEYS = ["questions", "review"];

const TOP_LEVEL_SUPPORTED_KEYS = ["type", ...MULTI_INTENT_KEYS, ...EDITOR_INTENT_KEYS];

const CANONICAL_TYPES: readonly string[] = (QuestionSchema.properties.type as unknown as { enum?: readonly string[] }).enum ?? [];

function canonicalTypeOf(value: unknown): NormalizedQuestion["type"] | undefined {
	const token = normalizeTypeToken(value);
	const canonical = CANONICAL_TYPES.find((type) => normalizeTypeToken(type) === token);
	if (canonical) return canonical as NormalizedQuestion["type"];
	if (typeof value === "string" && !isIntentOn(value)) return undefined;
	if (!isMultiLikeToken(token)) return undefined;
	return isLineLikeKey(token) ? "editor" : "multi_select";
}

const QUESTION_KEYS = new Set<string>(["id", "type", "question", "options", "placeholder", "prefill", "allowOther", ...MULTI_INTENT_KEYS, ...EDITOR_INTENT_KEYS]);

function isPickType(type: NormalizedQuestion["type"]): boolean {
	return type === "select" || type === "multi_select";
}

function hasPickableOptions(raw: Record<string, unknown>): boolean {
	return Array.isArray(raw.options) && raw.options.length > 0;
}

function rejectedByOptionsGuard(type: NormalizedQuestion["type"], raw: Record<string, unknown>): boolean {
	return isPickType(type) && !hasPickableOptions(raw);
}

const OPTIONS_GUARD_NOTE = "会被 execute 的「必须提供 options」护栏打回、一张卡都不渲染";

function renderVerb(renderable: boolean): string {
	return renderable ? "渲染" : "处理";
}

function isMisreadMultiKey(key: string, value: unknown): boolean {
	const token = normalizeTypeToken(key);
	return isIntentSwitch(value) && !isOffToken(key) && isMultiLikeToken(token, value) && !isLineLikeKey(token) && !SINGLE_LIKE_KEY.test(token);
}

function hasMultiSignal(raw: Record<string, unknown>): boolean {
	for (const key of MULTI_INTENT_KEYS) {
		if (isIntentOn(raw[key])) return true;
	}
	return Object.entries(raw).some(([key, value]) => !QUESTION_KEYS.has(key) && isMisreadMultiKey(key, value));
}

function lineLikeIntentKeys(raw: Record<string, unknown>): string[] {
	return Object.keys(raw).filter((key) => !QUESTION_KEYS.has(key) && !isOffToken(key) && isLineLikeKey(key) && isIntentSwitch(raw[key]));
}

function warnNonCanonicalType(raw: Record<string, unknown>, type: NormalizedQuestion["type"], where: string, renderable = true): void {
	if (typeof raw.type !== "string" || CANONICAL_TYPES.includes(raw.type)) return;
	const alias = canonicalTypeOf(raw.type);
	const guard = renderable && rejectedByOptionsGuard(type, raw) ? `，但本题没有 options，${OPTIONS_GUARD_NOTE}` : "";
	const written = echoModelText(raw.type);
	console.warn(
		alias
			? `[ask_question] ${where}的 type "${written}" 不是规范写法，已按 ${type} 处理${guard}（规范写法 type: "${type}"）`
			: `[ask_question] ${where}的 type "${written}" 不是规范值（${CANONICAL_TYPES.join(" / ")}），已忽略，实际按 ${type} 处理${guard}`,
	);
}

function inferType(raw: Record<string, unknown>, fallbackType?: NormalizedQuestion["type"], where = "顶层字段", renderable = true): NormalizedQuestion["type"] {
	const verb = renderVerb(renderable);
	const explicit = explicitTypeOf(raw);
	if (explicit) {
		const hasMultiIntentKey = MULTI_INTENT_KEYS.some((key) => isIntentOn(raw[key]));
		if (explicit === "multi_select" && canonicalTypeOf(raw.type) === "select") {
			console.warn(
				renderable && rejectedByOptionsGuard(explicit, raw)
					? `[ask_question] ${where}的 type "select" 旁边写了多选意图键，已按 multi_select 处理，但本题没有 options，${OPTIONS_GUARD_NOTE}（多选请写 type: "multi_select" 并带上 options）`
					: `[ask_question] ${where}的 type "select" 旁边写了多选意图键，已按 multi_select 处理（多选请只写 type: "multi_select"）`,
			);
		} else if (explicit !== "multi_select" && hasMultiIntentKey) {
			console.warn(
				hasPickableOptions(raw)
					? `[ask_question] ${where}的 type "${explicit}" 与多选意图键冲突，已按 ${explicit} ${verb}（本题的 options 不会渲染；多选请只写 type: "multi_select"）`
					: `[ask_question] ${where}的多选意图键被忽略（本题按 ${explicit} ${verb}：${renderable ? "没有 options，折成多选会撞 execute 的「必须提供 options」护栏" : "没有 options，本会话也没有卡片可渲染"}）；需要多选请写 type: "multi_select" 并带上 options`,
			);
		}
		if (explicit !== "editor" && EDITOR_INTENT_KEYS.some((key) => isIntentOn(raw[key]))) {
			console.warn(
				renderable && rejectedByOptionsGuard(explicit, raw)
					? `[ask_question] ${where}写了多行文本意图键，本题声明的 ${explicit} 没有 options，${OPTIONS_GUARD_NOTE}（多行内容请只写 type: "editor"）`
					: `[ask_question] ${where}写了多行文本意图键，已按 ${explicit} ${verb}（多行内容请只写 type: "editor"）`,
			);
		}
		if (explicit === "editor" && hasPickableOptions(raw) && !hasMultiIntentKey) {
			console.warn(
				`[ask_question] ${where}的 type "${echoModelText(raw.type)}" 已按 editor ${verb}，但本题带了 options，选项不会渲染（要选项请写 type: "select"；要多行文本请只写 type: "editor" 且不要给 options）`,
			);
		}
		return explicit;
	}
	const hasOptions = hasPickableOptions(raw);
	if (!hasOptions && lineLikeIntentKeys(raw).length > 0) {
		console.warn(`[ask_question] ${where}写了多行文本样字段，已按 editor ${verb}（多行内容请只写 type: "editor"）`);
		return "editor";
	}
	const foldsOuter = fallbackType !== undefined && fallbackType !== "confirm" && isPickType(fallbackType) === hasOptions;
	const resolved: NormalizedQuestion["type"] = foldsOuter && fallbackType ? fallbackType : hasOptions ? "select" : "input";
	if (hasOptions && EDITOR_INTENT_KEYS.some((key) => isIntentOn(raw[key]))) {
		console.warn(`[ask_question] ${where}写了多行文本意图键，但本题带 options，已按 ${resolved} ${verb}（多行内容请写 type: "editor" 且不要给 options）`);
	}
	return resolved;
}

function declaredTypeOf(raw: Record<string, unknown>, optionsIsShape = true): NormalizedQuestion["type"] | undefined {
	const explicit = canonicalTypeOf(raw.type);
	if (explicit) return explicit === "select" && hasMultiSignal(raw) ? "multi_select" : explicit;
	for (const key of MULTI_INTENT_KEYS) {
		if (isIntentOn(raw[key])) return "multi_select";
	}
	for (const key of EDITOR_INTENT_KEYS) {
		if (isIntentOn(raw[key])) return optionsIsShape && hasPickableOptions(raw) ? undefined : "editor";
	}
	return undefined;
}

function explicitTypeOf(raw: Record<string, unknown>, optionsIsShape = true): NormalizedQuestion["type"] | undefined {
	const declared = declaredTypeOf(raw, optionsIsShape);
	if (declared) return declared;
	for (const [key, value] of Object.entries(raw)) {
		if (!QUESTION_KEYS.has(key) && isMisreadMultiKey(key, value)) return "multi_select";
	}
	return undefined;
}

function checkQuestionKeys(
	raw: Record<string, unknown>,
	where: string,
	options: {
		extraKnown?: readonly string[];
		throwOnMisreadMulti?: boolean;
		applyLineLikeIntent?: boolean;
		outerType?: NormalizedQuestion["type"];
		supportedKeys?: readonly string[];
		optionsIsShape?: boolean;
	} = {},
): void {
	const extraKnown = options.extraKnown ?? [];
	const optionsIsShape = options.optionsIsShape ?? true;
	const unknown = Object.keys(raw).filter((key) => !QUESTION_KEYS.has(key) && !extraKnown.includes(key));
	if (unknown.length === 0) return;
	const decidedByOuter = options.outerType === "multi_select" && hasPickableOptions(raw);
	const misreadMulti =
		declaredTypeOf(raw, optionsIsShape) || options.throwOnMisreadMulti === false || decidedByOuter
			? []
			: unknown.filter((key) => isMisreadMultiKey(key, raw[key]));
	if (misreadMulti.length > 0) {
		const written = misreadMulti.map((key) => `"${echoModelText(key)}": ${echoModelValue(raw[key])}`).join(" / ");
		throw new Error(`ask_question: ${where} 出现 ${written}；多选必须写 type: "multi_select"（单选写 type: "select"，不能写 ${written}）`);
	}
	const consumedMulti =
		(canonicalTypeOf(raw.type) === "select" && declaredTypeOf(raw, optionsIsShape) === "multi_select") ||
		(!declaredTypeOf(raw, optionsIsShape) && explicitTypeOf(raw, optionsIsShape) === "multi_select")
			? unknown.filter((key) => isMisreadMultiKey(key, raw[key]))
			: [];
	const consumedLine =
		(options.applyLineLikeIntent ?? true) && !explicitTypeOf(raw, optionsIsShape) && !hasPickableOptions(raw)
			? lineLikeIntentKeys(raw).filter((key) => unknown.includes(key))
			: [];
	const consumed = [...consumedMulti, ...consumedLine];
	const consumedExtra = extraKnown.filter((key) => isMisreadMultiKey(key, raw[key]));
	const reported = unknown.filter((key) => !consumed.includes(key));
	if (reported.length === 0) return;
	const supported = [...(options.supportedKeys ?? QUESTION_KEYS), ...extraKnown.filter((key) => !consumed.includes(key) && !consumedExtra.includes(key))];
	console.warn(`[ask_question] ${where} 忽略未知字段 ${reported.map((key) => `"${echoModelText(key)}"`).join(", ")}；字段只支持 ${supported.map((key) => echoModelText(key)).join(" / ")}`);
}

const PROTOTYPE_KEY_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype));

function assignQuestionIds(rawQuestions: readonly unknown[]): string[] {
	const declared = rawQuestions.map((question) => {
		const id = ((question ?? {}) as Record<string, unknown>).id;
		if (id === undefined || id === null) return undefined;
		const text = String(id);
		return text.trim() ? text : undefined;
	});
	const reserved = new Set(declared.filter((id): id is string => id !== undefined));
	const used = new Set<string>();
	return declared.map((id, index) => {
		const base = id ?? `q${index + 1}`;
		let candidate = base;
		let suffix = 2;
		while (used.has(candidate) || PROTOTYPE_KEY_NAMES.has(candidate) || (candidate !== id && reserved.has(candidate))) candidate = `${base}-${suffix++}`;
		used.add(candidate);
		return candidate;
	});
}

/**
 * 把工具参数归一化为统一问题列表。
 * 批量模式用 questions 数组；否则回退到单问题顶层字段，保持向后兼容。
 */
function toQuestions(params: Record<string, unknown>, throwOnMisreadMulti = true, renderable = true): NormalizedQuestion[] {
	const rawQuestions = params.questions;
	if (Array.isArray(rawQuestions) && rawQuestions.length > 0) {
		const outerType = explicitTypeOf(params, false);
		const ids = assignQuestionIds(rawQuestions);
		const outerIntentKeys =
			outerType === "multi_select"
				? Object.keys(params).filter((key) => !TOP_LEVEL_KEYS.includes(key) && !QUESTION_KEYS.has(key) && isMisreadMultiKey(key, params[key]))
				: [];
		checkQuestionKeys(params, "顶层字段", {
			extraKnown: [...TOP_LEVEL_KEYS, ...outerIntentKeys],
			throwOnMisreadMulti: false,
			applyLineLikeIntent: false,
			supportedKeys: TOP_LEVEL_SUPPORTED_KEYS,
			optionsIsShape: false,
		});
		const strayTopLevelKeys = Object.keys(params).filter((key) => QUESTION_KEYS.has(key) || outerIntentKeys.includes(key));
		if (strayTopLevelKeys.length > 0) {
			const stray = strayTopLevelKeys.map((key) => echoModelText(key)).join(" / ");
			const foldNote =
				outerType === "confirm"
					? "其中 type 写在外层时只对本题自己也声明 confirm 的题生效（confirm 不折叠到别的题型）"
					: `其中 type / 意图键已当作各题默认 type（${outerType}，只补本题没写 type / 意图键的题，且形状要一致：选择题式要带 options，纯文本式要没有 options）`;
			console.warn(
				outerType
					? `[ask_question] 顶层字段的 ${stray} 不属于工具参数级：${foldNote}，options / placeholder 等逐题字段已忽略；逐题写法请放进 questions[i]`
					: `[ask_question] 顶层字段的 ${stray} 不属于工具参数级，而且没有可识别的 type / 意图键，options / placeholder 等逐题字段已忽略；逐题写法请放进 questions[i]`,
			);
		}
		return rawQuestions.map((q, i) => {
			const r = (q ?? {}) as Record<string, unknown>;
			checkQuestionKeys(r, `questions[${i}]`, { throwOnMisreadMulti, outerType });
			const type = inferType(r, outerType, `questions[${i}]`, renderable);
			warnNonCanonicalType(r, type, `questions[${i}]`, renderable);
			const isPickList = isPickType(type);
			return {
				id: ids[i],
				type,
				question: String(r.question ?? ""),
				options: isPickList ? normalizeOptions(r.options) : undefined,
				// 自定义输入恒定显示（用户反馈「有时有有时没有」的根因之一）：allowOther 传值
				// 仍被 schema 接受，但不再参与渲染决策；仅 select 有此框，multi_select 多选即自由组合。
				allowOther: type === "select" ? true : undefined,
				placeholder: r.placeholder as string | undefined,
				prefill: r.prefill as string | undefined,
			};
		});
	}
	// 单问题模式：顶层字段
	checkQuestionKeys(params, "顶层字段", { extraKnown: TOP_LEVEL_KEYS, throwOnMisreadMulti });
	const type = inferType(params, undefined, "顶层字段", renderable);
	warnNonCanonicalType(params, type, "顶层字段", renderable);
	const isPickList = isPickType(type);
	return [
		{
			id: "default",
			type,
			question: String(params.question ?? ""),
			options: isPickList ? normalizeOptions(params.options) : undefined,
			allowOther: type === "select" ? true : undefined,
			placeholder: params.placeholder as string | undefined,
			prefill: params.prefill as string | undefined,
		},
	];
}

/** 有效作答：null/undefined 与空的 multi_select 数组都算没答 */
function hasAnswerValue(answer: Answer | undefined): boolean {
	const value = answer?.value;
	if (value === null || value === undefined) return false;
	return !Array.isArray(value) || value.length > 0;
}

/**
 * 批量结果：返回结构化 questions/answers，便于 LLM 按 id 取值。
 * closed：用户关闭了卡片但已答了部分题——已答内容照常交回，未答的明确标出，
 * 不让模型把空答案当成用户的选择，也不把已答内容整单丢掉。
 */
function batchResult(qs: NormalizedQuestion[], answers: Answer[], cancelled: boolean, overrideText?: string, closed = false) {
	const lines = answers.map((a) => {
		if (a.skipped) return `${a.id}: (用户跳过，未作答)`;
		if (!hasAnswerValue(a)) return `${a.id}: (未作答)`;
		// multi_select 的 value 是数组，拼接展示（如「A、C」）
		const v = Array.isArray(a.value)
			? a.value.join("、")
			: typeof a.value === "boolean"
				? (a.value ? "是" : "否")
				: String(a.value ?? "");
		return `${a.id}: ${a.wasCustom ? "(自行输入) " : ""}${v}`;
	});
	const body = lines.length ? lines.join("\n") : "无答案";
	return {
		content: [
			{
				type: "text" as const,
				text:
					overrideText ??
					(cancelled && !answers.some(hasAnswerValue)
						? "用户取消了提问"
						: closed
							? `用户关闭了提问卡，没有答完全部问题。下面逐题列出作答情况（「否」也是有效作答）；标为未作答或跳过的题不要替用户假设答案：\n${body}`
							: body),
			},
		],
		details: { questions: qs, answers, cancelled, ...(closed ? { closed: true } : {}) },
	};
}

/** Submit the whole question list through one RPC dialog so desktop renders one card. */
async function askBatch(
	questions: NormalizedQuestion[],
	review: boolean,
	ctx: AskCtx,
): Promise<{ answers: Answer[]; cancelled: boolean; closed: boolean }> {
	const envelope = JSON.stringify({
		[BATCH_ASK_ENVELOPE_KEY]: 1,
		review,
		questions,
	});
	const raw = await ctx.ui.input(envelope, "__piDeckBatchAsk__");
	if (typeof raw !== "string" || !raw.trim()) return { answers: [], cancelled: true, closed: false };
	try {
		const parsed = JSON.parse(raw) as { cancelled?: boolean; answers?: Answer[] };
		const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
		const answeredAny = answers.some(hasAnswerValue);
		// 带答案的 cancelled 信封 = 用户答了一部分后关闭卡片：已答部分有效，不算整单取消
		if (parsed.cancelled) return { answers, cancelled: !answeredAny, closed: answeredAny };
		// 主动跳过算已处理；答案条数不足（旧桌面端或异常信封）仍视为未完成
		const complete = answers.length >= questions.length && answers.every((answer) => answer?.skipped === true || hasAnswerValue(answer));
		return { answers, cancelled: !complete && !answeredAny, closed: !complete && answeredAny };
	} catch {
		return { answers: [], cancelled: true, closed: false };
	}
}

export default function (pi: ExtensionAPI) {
	// 飞书绑定会话（PiDeck spawn 时注入 PIDECK_FEISHU_LINKED=1，见 PiProcess.ts）：
	// 飞书端交互卡片体验差（按钮 4/行、最多 20 选项、文本 18 字符截断），
	// 因此注册「禁用提示版」——agent 调用时得到明确指引把问题直接写进回复，
	// 用户以飞书消息作答，而不是静默丢失提问能力。
	const feishuLinked = process.env.PIDECK_FEISHU_LINKED === "1";

	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description: feishuLinked
			? [
				"UNAVAILABLE in this session: it is linked to Feishu, where interactive ask cards are not usable.",
				"Do NOT call this tool. Write your question directly in the reply text instead;",
				"the user answers with a Feishu message.",
			].join(" ")
			: [
				"Ask the user for input, a selection, or a confirmation; blocks until the user responds through the desktop UI.",
				"Pass questions:[{type,question,options,placeholder,prefill}] — one or more questions in a single card, even for a single one; id is auto-assigned when omitted.",
				"type is optional (defaults to select with options, else input); set it explicitly for confirm/editor/multi_select.",
			].join(" "),
		promptSnippet: feishuLinked
			? "Ask the user a question directly in the reply text (Feishu session: ask_question is disabled)"
			: "Ask the user a question (or several in one call) and wait for responses",
		promptGuidelines: feishuLinked
			? [
				"IMPORTANT: This session is linked to Feishu; the interactive ask_question tool is disabled.",
				"When you need input from the user, write the question directly in the reply text — the user answers with a Feishu message.",
				"Do NOT call ask_question; if you do, it returns an explanation instead of a real answer.",
			]
			: [
				"IMPORTANT RULE: Whenever you need ANY input from the user (a choice, confirmation, text, or multi-line content), you MUST use the ask_question tool. Do NOT write questions in plain text — that forces the user to type free-form replies and breaks the desktop UI interaction flow.",
				"Pass all questions in ONE questions array per call, never split related questions into repeated calls.",
				"Types: select = pick from options (strings or {label, value?, description?}; a custom free-text input is always shown); multi_select = pick multiple, returns an array; confirm = yes/no (e.g. destructive or irreversible actions); input = short text; editor = multi-line content like code.",
			],
				parameters: AskQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const record = params as Record<string, unknown>;
			const hasUI = Boolean(!feishuLinked && ctx?.hasUI);
			const questions = toQuestions(record, hasUI, hasUI);

			// 飞书绑定会话：不弹交互卡片，直接返回指引（agent 会把问题写进回复转述给用户）
			if (feishuLinked) {
				return batchResult(questions, [], true, "ask_question 已禁用：当前会话连接了飞书，交互式提问卡片不可用。请把问题直接写入回复文本，用户会以飞书消息回答。");
			}

			// 非交互模式（headless）：不阻塞直接返回
			if (!hasUI) {
				return batchResult(questions, [], true, "ask_question 无法执行：当前环境不支持交互式 UI。");
			}

			// select / multi_select 必须有非空 options，否则桌面端无法渲染选择卡片
			for (const q of questions) {
				if (isPickType(q.type) && (!q.options || q.options.length === 0)) {
					return batchResult(questions, [], true, `ask_question 未执行：${q.type} 类型必须提供 options（问题: ${q.question}）`);
				}
			}

			// 单一渲染形态：无论单问题还是批量，都走同一个批量信封，桌面端只有一种卡片外观
			try {
				const { answers, cancelled, closed } = await askBatch(questions, record.review === true, ctx);
				return batchResult(questions, answers, cancelled, undefined, closed);
			} catch {
				return batchResult(questions, [], true);
			}
		},
	});
}
