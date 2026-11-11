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

/** 把「多选」写成布尔意图字段（`multi_select: true`）的现场，按 multi_select 处理。 */
const MULTI_INTENT_KEYS = ["multi_select", "multiSelect", "multiselect", "multi", "multiple"] as const;

/** 把「多行文本」写成布尔意图字段的现场（`multiline: true`）——工具自己的指南就说 multi-line content，按 editor 处理。 */
const EDITOR_INTENT_KEYS = ["multiline", "multiLine", "multi_line"] as const;

/** 比对前先去掉分隔符与大小写：`multi-select` / `Multi_Select` / `multi select` 当同一个词。
 *  三个空间（type 取值、意图键取值、键名拼写）都走它归一（键名在 `isLineLikeKey` / `isMisreadMultiKey` 入口归一），
 *  否则同一个意思只因为写了空格/下划线就得出相反判决——`multiple: "single"` 判成单选、
 *  `multiple: "single choice"` 判成多选，就是这类判决翻转。 */
function normalizeTypeToken(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_-]+/g, "") : "";
}

/**
 * 把模型写下的字段名 / 取值回显进诊断日志前的整形：换行与控制字符压成单行并截断。
 *
 * 这些字符串全部来自模型，原样拼进 `console.warn` 就等于让模型往诊断日志里写行——
 * 「问题反馈」导出的日志按 `[ask_question]` 前缀逐行读（pideck-doctor 就靠这个定位），伪造一行就能把人引偏。
 *
 * 换行能真的走进日志的入口：题级 / 工具参数级的**未声明键名**（`{"mu\nltiNote": …}` 会原样到达 execute，
 * schema 没设 additionalProperties）、以及工具参数级的 `type`（`AskQuestionParams` 没声明它，`type: "SELECT\n…"`
 * 能过）。题级 `type` 是 schema 声明的 enum，非规范值在校验层就被拒——但这不改变结论：
 * **所有回显模型的文案都过这个函数**，别按「这条路径到不了」给某处开口子。
 */
function echoModelText(value: unknown, maxLength = 60): string {
	const text = String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * 回显模型写下的**取值**：`JSON.stringify` 保住类型（`true` 不会变成 `"true"`），控制字符已被它转义，
 * 所以这里只处理它会原样放行的 U+2028 / U+2029（若干读日志的工具把这两个当换行），再加超长截断。
 * 不做空白折叠：回显就得是模型写的那份字面量（`"press  space"` 不许变成 `"press space"`）。
 */
function echoModelValue(value: unknown, maxLength = 120): string {
	const text = String(JSON.stringify(value) ?? value).replace(/[\u2028\u2029]/g, " ");
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** 键名 / type 取值 / 意图键取值里明确表达单选（`singleChoice`、`exclusivePick`、`"single choice"`）：本来就会渲染成
 *  select，没有降级风险，不能因为多写一个这样的冗余键把整批提问打掉；取值空间靠它把 `type: "singleChoice"` 交回
 *  形状推断，意图键取值靠它把 `multiple: "single choice"` 判成「没表达多选意图」——两个空间共用同一份词表。 */
const SINGLE_LIKE_KEY = /^(?:only|just)?(?:single|exclusive|one|1)[_\- ]?(?:choice|select(?:ion)?|pick|option|answer|item)s?(?:only)?$/i;

/** 明确的否定取值（先经 `normalizeTypeToken` 归一）：`"False"` / `"no"` / `"n/a"` 都不该被当成「表达了意图」。
 *  中文 / 口语否定同样入表：`{multiple: "否"}` 走的是 fail-open 分支（除否定词外一律算「已表达意图」），
 *  漏一个词就把明确写了「否」的题静默翻成多选卡——用户看到勾选框、模型收到数组，且零日志。
 *  英文的 disabled / never / single line 与中文「单行」同族，都表示「关掉 / 单行」而不是「开了」：
 *  `{multiple: "disabled"}` 漏进来就是勾选框，`{multiline: "single line"}` 漏进来就是多行框（方向相反，同样零纠正）。
 *  短语否定（`not multiple` / `single line only` / `非多选`）由 `OFF_PREFIXES` 收口：完整词只能挡住
 *  一模一样的取值，带后缀的否定短语照样翻形态，未知键还会把整批提问硬报错。 */
const OFF_WORDS = new Set(["false", "no", "off", "none", "null", "n/a", "na", "n", "not", "non", "negative", "without", "0", "", "否", "不", "非", "无", "没", "未", "不是", "不要", "关闭", "禁用", "禁止", "单行", "nope", "never", "disabled", "disable", "singleline", "oneline", "nah", "neither", "nor", "don't", "doesn't", "dont", "doesnt"]);

/** 否定短语的归一前缀：完整词进 `OFF_WORDS`，后面跟内容的写法（`not multiple` → `notmultiple`）在这里收口。
 *  `OFF_WORDS` 里的否定词根（含中文单字）都要能带后缀，否则「明确写了关掉 + 补一句说明」又会被 fail-open 当肯定。
 *  短词根（`no` / `not` / `off`…）必须真是独立的否定词，见 `isOffToken` 的词边界判据：裸 `startsWith`
 *  会把 `normal` / `note` / `official` 误判成否定、静默降级成单选，正是本分支要消灭的那一类。 */
const OFF_PREFIXES = [...OFF_WORDS];

/** 短否定词根：只有「自成一段（分隔符 / camelCase 边界）+ 后面还有内容」才算否定短语。 */
const SHORT_OFF_ROOTS = new Set(["not", "no", "non", "n/a", "na", "n", "off", "nah", "nor", "否", "不", "非", "无", "没", "未"]);

/** 「不是单选」= 明确要多选（`not single` / `no limit` / `non-exclusive` / `not one option`）；孤立的 `no one` / `no, only one` 是明确否定，不是双重否定。
 *  `not only one` / `not just one` 也算「不是只要一个」：它们后面没有名词，下面的 `one|only` 支要求
 *  ！接 option/choice 才命中，不收一句就会出现「带名词的判多选、不带名词的判单选」——两个说法只差一个词。
 *  带分句标点的（`no, only one`）不进本判据（见 `isOffToken` 的 `clauseAfterNegation`），仍是明确否定。 */
const NEGATED_SINGLE = /^(?:single|limit|exclusive|restrict)|^(?:one|only)\b.*\b(?:option|choice|select|pick)|^(?:only|just) one\b/;

/** 中文同义的双重否定（`不是单选` / `非单选` / `不是单行` / `不限制` / `非互斥`）：中文连写没有分隔符可切，
 *  `parts` 只有一段，英文那道 `NEGATED_SINGLE` 判据到不了，只能在这里收口，否则中文否定字的前缀会把它判成「关掉」。
 *  词表要与英文 `NEGATED_SINGLE` 对齐：英文 `non-exclusive` 判多选，中文 `非互斥` / `非排他` 漏一个就是 select（点一下即交卷）。
 *  没列 `只`：中文「不要只说一句」这类取值会被当成双重否定翻成多选，歧义比收益大。 */
const NEGATED_SINGLE_ZH = /^(?:不|非|无|没|未)(?:是)?(?:单选|单项|单行|限制|唯一|一个|互斥|排他|单一)/;

/** 中文「不限 / 无限」是「不设限制」，不是关掉意图；带后缀说明（`不限行数` / `不限量多选`）同样放行。
 *  精确词表挡不住「多加一句说明」，而中文否定字按前缀收口时这些写法会被整条关掉。 */
const NOT_OFF_PREFIXES = ["不限", "无限"];

/** 短否定词根与多选词根**全小写连写**（`notmultiple` / `nomultiline`）：没有分隔符或 camelCase 边界，
 *  `parts` 只有一段，切词判据到不了；下面第 3 道又因短根长度 < 4 跳过前缀收口。结果是
 *  `type: "notMultiple"` 判「忽略」而 `type: "notmultiple"` 翻成多选、`notMultiple: true` 忽略而
 *  `notmultiple: true` 整批硬报错——同一语义只差一个大写字母就翻转。只在后面接**词根**时判否定，
 *  `normal` / `note` / `official` / `offset` 的剩余部分不是词根，不会被误伤。 */
const NEGATED_INTENT_ROOT = /^(?:not|no|non|off|nah|nor|na|n)(?:multi|multiple|checkbox|checklist)/;

/** 归一与切词共用同一套分隔符：否则 `"no, thanks"` 归一是 `nothanks`、切词却还是 `"no,"`，
 *  短否定词根因词边界判据落空而把明确的否定当成肯定。 */
const OFF_TOKEN_SEPARATORS = /[\s_.'\-/、。，；：！？（）「」【】…·,;:!?"()]+/g;

/** 否定判据专用归一：连撇号、点号与 CJK / 全角标点一并去掉，让 `doesn't` / `does not apply` /
 *  `n.a.` 与 `na` 同判，`"单选。"` 与 `"单选"` 也同判。不动 `normalizeTypeToken`：它还服务
 *  type 别名与键名，那里的点号 / 撇号不能一律抹掉。 */
function normalizeOffToken(value: string): string {
	return value.trim().toLowerCase().replace(OFF_TOKEN_SEPARATORS, "");
}

/**
 * 一个值 / 键名有没有明确说「关掉这个意图」。三道判据，别退回裸前缀：
 * 1. 完整否定词（`OFF_WORDS`，两种归一都查）；
 * 2. 否定短语——按分隔符与 camelCase 边界切词，出现独立的否定词且后面还有内容
 *    （`not multiple` / `does not apply` / `notMultiple`）。短词根靠这条放行，
 *    所以 `normal` / `note` / `official` 不会被 `no` / `off` 前缀误伤；
 * 3. 长词根（≥4 字符）与中文否定字本身足够明确，仍按前缀收口。
 * 否定词 + 后段写着单选 / 限制的是双重否定（`not single` / `definitely not single`），说的是「不是单选」，
 * 按肯定处理；否定词不必排在首位，否则「前面多写一个词」就把明确的多选要求静默降级成单选卡。
 * 进判据前先放行「不限…」与中文双重否定，再把短否定词根与多选词根的全小写连写判成关掉
 * （这类没有分隔符可切，落不进下面第 2 道）。四个入口（type 取值 / 键名 / 已知意图键 / 未知键）都走本函数，
 * 别在某个入口另抄一份词表，否则同一个拼写只换个位置就又得出相反判决。
 */
function isOffToken(value: string): boolean {
	const token = normalizeTypeToken(value);
	const offToken = normalizeOffToken(value);
	const offPhrase = value.trim().toLowerCase();
	if (offToken === "online") return true;
	// 分句标点把「否定」和「单选」拆成两句（`no, single` / `否，single`）：那是明确说单选，
	// 不是「不是单选」的双重否定。英文与中英混写同样收口，别只认中文否定字起头的分句。
	const clauseAfterNegation = /^(?:不|非|无|没|未|否|not|no|non|off|never|without|none|nah|nor|false|nope|neither)(?:是)?\s*[，,。;；!?.]/.test(offPhrase);
	if (!clauseAfterNegation && NOT_OFF_PREFIXES.some((word) => offToken.startsWith(word))) return false;
	if (!clauseAfterNegation && NEGATED_SINGLE_ZH.test(offToken)) return false;
	// 分句否定（`no, multiple`）不走这条：后半句可能正是在说多选，由下面「分句」那一支判。
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
	// 只认「首位否定词」时，"definitely not single" / "yes, not single" 同样明确写了「不是单选」，
	// 却会落到下一行被判成关掉意图、静默降级成 select（点一下即交卷）；editor 侧同理退成单行框。
	if (!clauseAfterNegation && parts.length > 1 && offIndex >= 0 && NEGATED_SINGLE.test(parts.slice(offIndex + 1).join(" "))) return false;
	// 分句否定后写的是多选词根（`no, multiple`）时按「明确要多选」处理：分句里的否定是自己一句回答
	// （`no, single` = 单选、`no, multiple` = 多选），与上面 `clauseAfterNegation` 的口径同一套。
	// 不分句的直接连写（`notmultiple`）仍由 `NEGATED_INTENT_ROOT` 在函数开头判成否定，不在这里翻。
	// 词根只认 `MULTI_ROOT` 里的英文写法（multiple / multi* / checkbox / checklist）：中文「否，多选」
	// 因此仍按否定落成 select（改前也是 select，不是回归）；要给中文补词根得先决定键空间里
	// `多选: true` 算不算拼错键，别只改这一处。
	if (parts.length > 1 && offIndex >= 0) {
		const tail = parts.slice(offIndex + 1).join(" ");
		// 后半句自己是**否定值**（`no, not multiple`）时仍是「不是多选」，与不分句的 `not multiple` 同判，
		// 别只因为出现多选词根就翻成多选。后半句是**多行文本样**词根（`no, multiple lines`）也让它走否定：
		// `MULTI_ROOT` 会命中 `multiple`，但同一拼写作为 type 取值是 editor（`isLineLikeKey`），
		// 在这里翻成勾选卡就是「同一个词两个空间相反判决」。
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

/** 取值本身就写着「单选」（`multiple: "single"` / `"one"` / `"exclusive"`）：那不是多选意图，否则同一个词在
 *  已知键与未知键两个空间判决相反。带选择语义词的拼写（`"single choice"` / `"one option"`）归一后交给 `SINGLE_LIKE_KEY`；
 *  反序语序（`"select one"` / `"pick one"`）记在词表里——取值侧同样不能「词序改变结论」。 */
const SINGLE_WORDS = new Set(["single", "singlechoice", "单选", "单项", "单一", "互斥", "排他", "唯一", "一个", "限制", "one", "only", "onlyone", "oneonly", "singleonly", "exclusive", "selectone", "pickone", "chooseone"]);

/** 「只能选一个」族：**串首**写着数量上限是 1 的短语（`exactly one` / `just one` / `at most one` /
 *  `one of the following` / `只能选一个` / `只能选择一个` / `单选（只能选一个）`）。`SINGLE_WORDS` 是整串精确匹配，
 *  带前缀或后缀说明的写法进不去，只能在这里按**串首**收口。
 *
 *  中文支写成结构式（`只/仅/至多/最多` + 能愿动词 + 选/挑/有(+择/中/取/选) + 一/1 + 个项条）而不是逐串列：`只能选一个` /
 *  `只能选择一个` / `只允许选一个` / `只许选一个` / `只要选一个` / `至多选一个` / `最多只能选一个` 是同一个句子只差一个词，列不完（本分支就
 *  曾在同一处漏过一整族）。英文支同理只认「数量上限 + one」。
 *
 *  串首锚定是刻意的：`not only one option` / `not only one` / `不是单选` / `no one` 的否定词在开头，
 *  压根不进这条判据（双重否定由 `isOffToken` 的 `NEGATED_SINGLE` / `NEGATED_SINGLE_ZH` 处理）——
 *  否则「不是单选」会被这里的 `单选` 前缀判成单选，方向正好反过来。
 *  判据输入已把分隔符归一成空格：`exactly_one` / `at-most one` 与空格版同判，否则同一个意思只差一个
 *  下划线就得出相反结论（与本模块其它地方的归一判据同一个坑）。数量段后面写着「以上 / 或更多」时是「可多选」，中文各支用尾界排除。 */
const SINGLE_LIMIT_PHRASE = /^(?:only|just|exactly|at ?most|max(?:imum)?|limited to|up to) (?:a |an )?(?:single|one|1)\b|^maximum of (?:one|1)\b|^(?:one|1) of\b|^(?:select|pick|choose) (?:only )?(?:one|1)\b(?! *or\b)|^(?:单选|单项)(?!或(?:多选|多项|复选|多个))|^(?:只|仅|至多|最多)(?:[能可许准要得让]|允许|准许|能够|可以|只|仅){0,3} *(?:选|挑|有)(?:择|中|取|选)? *(?:一|1)(?! *[个项条]? *(?:以上|或以上|或更多|及以上)) *[个项条]?|^(?:只|仅)(?:[能可许准要得让]|允许|准许)? *(?:一|1)(?! *[个项条]? *(?:以上|或以上|或更多|及以上)) *[个项条]?|^(?:只|仅)(?:[能可许准要得让]|允许|准许)? *(?:单选|单项)/;

/** 取值本身写着「单选」：整串词表、词根正则与串首短语三种判据都要对两种归一各查一遍——`normalizeTypeToken`
 *  保留标点，`"single."` / `"单选。"` 在 `SINGLE_WORDS` 里查不到，而 `isOffToken` 用的是去标点的归一；两边不共用
 *  这份判据就会「加一个句号把单选意图翻成多选卡」。type 取值与意图键取值共用本函数。
 *  短语判据用原值（不用归一值）：它靠空白切词（`exactly one`），归一后连写会漏。 */
function isSingleLikeValue(value: string): boolean {
	// 「单选或多选都行」这类取值同时写着多选：多选是单选的上界，按多选给卡不会把用户锁死，
	// 按单选给卡却会让他根本选不了两项。中文多选词根只在这里认，不进 `MULTI_ROOT`——那个谓词还判键名，
	// `多选: true` 会因此变成「拼错键」硬报错，那是另一个决定，别在取值侧顺手改了键空间的判决。
	// 取值里带否定字时一律让路（`单选，不要多选` / `非多选` / `不限量多选`）：那几条的语义由 `isOffToken`
	// 收口，这里只看「有没有多选词根」就会把明确的否定翻成勾选卡；「至多选一个 / 最多选一个」里的「多选」是数量词的一部分，不算。
	const multiDeniedAfterSinglePhrase = SINGLE_LIMIT_PHRASE.test(value.trim().toLowerCase().replace(/[_\-\s]+/g, " ")) && /(?:报错|错误|无效|失败)/.test(value);
	if (!multiDeniedAfterSinglePhrase && /(?<!至|最)(?:多选|多项|复选)/.test(value) && !/[不非无没未否别勿禁]/.test(value)) return false;
	const token = normalizeTypeToken(value);
	const stripped = normalizeOffToken(value);
	// 短语判据走「分隔符归一成空格」的形态：`exactly_one` / `at-most one` 与 `exactly one` 同判。
	const phrase = value.trim().toLowerCase().replace(/[_\-\s]+/g, " ");
	return (
		SINGLE_WORDS.has(token) ||
		SINGLE_WORDS.has(stripped) ||
		SINGLE_LIKE_KEY.test(token) ||
		SINGLE_LIKE_KEY.test(stripped) ||
		SINGLE_LIMIT_PHRASE.test(phrase)
	);
}

/**
 * 布尔意图键的真值：未知键不经过校验层强转（原样到达 execute），可能是 true / "true" / 1 / "yes"。
 * 只有明确的否定值才算「没表达意图」——反过来判等会把 `multi_select: "yes"` 静默降级成单选，
 * 正是这次要消灭的那条路径。
 *
 * 字符串先归一再比（`"single choice"` 与 `"single-choice"` 同判），否定短语走 `isOffToken`；
 * 「写着单选」的拼写与键空间共用 `SINGLE_LIKE_KEY`：只抄一份少数派词表（`"single"`/`"单选"`）
 * 会让 `multiple: "single choice"` 变成多选卡，与本次要消灭的「静默换渲染形态」同一类，只是方向相反。
 *
 * 数组 / 对象 / 函数一律不算意图：`multiline: []` 不是「要 editor」，按真值处理会把带 options 的题
 * 静默折成纯文本、把选项整组丢掉——与本次要消灭的「静默换渲染形态」同一类，只是方向相反。
 */
function isIntentOn(value: unknown): boolean {
	if (typeof value === "string") {
		return !isOffToken(value) && !isSingleLikeValue(value);
	}
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	return false;
}

/**
 * 意图开关的取值：**与已知意图键共用同一张真值表**（`isIntentOn`）。两边各持一张表就会得出相反判决——
 * 已知键 fail-open、未知键封闭词表，于是 `{multiple: "enabled"}` 是多选卡、`{allowMultiple: "enabled"}` 却是
 * 单选卡（点一下即交卷），`{multipleLines: "enabled"}` 还会退成单行框。同一个词换一个入口换一个结论，
 * 正是本分支要消灭的那类不对称。
 *
 * 唯一的差别是非标量：`multiline: []` 不是「要 editor」，按真值处理会把带 options 的题折成纯文本、
 * 把选项整组丢掉——方向相反，同属「静默换渲染形态」。
 */
function isIntentSwitch(value: unknown): boolean {
	return typeof value === "string" || typeof value === "boolean" || typeof value === "number" ? isIntentOn(value) : false;
}

/** 键名 / type 取值里的「多选语义词根」：`multi` 后面必须紧跟选择/选项语义词，或写出完整的
 *  `multiple` / `checkbox` / `checklist`。只带 `multi` 前缀的描述性字段（`multiStepHint` /
 *  `multimediaHint` / `multiTenant`）不是多选意图：按多选猜会把整批提问抛错，显式 `type: "select"`
 *  还会被静默翻成 multi_select。 */
const MULTI_ROOT = /(?:multiple|multi(?:select|choice|pick|option|answer|line)|checkbox|checklist)/i;

/** `multi` 本身也是多选意图（`type: "multi"` / `choiceMode: "multi"`），与词根判据共用一份。 */
function hasMultiRoot(token: string): boolean {
	return token === "multi" || MULTI_ROOT.test(token);
}

/** 键名 / type 取值里的「选择题词根」：`choice` 只说「这是一道选择题」，单/多由别的词根说了算。 */
const CHOICE_ROOT = /choice/i;

/** 取值自己写着多选（`{ choiceMode: "multiple" }` / `"checkbox"`）：键名只有 choice 词根时靠它补判，
 *  否则「键名说选择、取值说多选」的写法会落成单选（点一下选项即交卷）。布尔/数字取值没有词根，不参与补判。 */
function isMultiValueWord(value: unknown): boolean {
	return typeof value === "string" && hasMultiRoot(normalizeTypeToken(value)) && !isLineLikeKey(value);
}

/** 键名 / type 取值的「多选样拼写」：**必须带多选语义词根**（`multiSelect` / `multiple` / `checkbox` / `checklist`）。
 *  同一个谓词必须同时服务两个空间：一个拼写作为 type 取值认、作为 key 却不认（或反之），两种写法就会
 *  得出相反判决，而其中一种是「静默变单选」。
 *
 *  只有 `choice` 词根的（`choice` / `choices` / `allowCustomChoice` / `showChoices` / `choiceList`）**不算多选**：
 *  它只强调「这是一道选择题」，拿它当多选会让整批提问白重发（键空间抛错，而这些写法改前本来渲染成正常
 *  的 select 卡），取值空间还会把单选题换成多选卡。`multiChoice` / `choiceMultiple` 这类带词根的照旧命中；
 *  `choiceMode: "multiple"` 靠取值补判（见 `isMultiValueWord`），不能只因为键名不带词根就丢掉。 */
function isMultiLikeToken(token: string, value?: unknown): boolean {
	return hasMultiRoot(token) || (CHOICE_ROOT.test(token) && isMultiValueWord(value));
}

/** 键名 / type 取值里「line 紧跟选择语义」（`multiLineSelect`、`multiLineChoices`）：这类拼写表达的是多选，
 *  不能按多行文本放行——放行了就会静默降级成单选，正是本次要消灭的那条路径。 */
const LINE_THEN_PICK = /lines?[_\- ]?(select|choice|options?|checkbox|picks?)/i;

/** 多行文本样的拼写判据：**line 前面必须紧跟 multi/multiple**（`multiline`、`multipleLines`、`multi_line_enabled`、
 *  `allowMultiline`、`multilineHint`）。正确写法是 `type: "editor"`，报「请改 multi_select」会把模型引向错的多选卡。
 *
 *  判据不能只写 `token.includes("line")`：`outline` / `deadline` / `headline` / `timeline` / `inline` / `pipeline` /
 *  `lineCount` 这些词只是**含有** line、跟多行文本毫无关系，却会被折成 editor（带 options 时还多一条自相矛盾的
 *  「已忽略」日志），而同一个拼写作为 type 取值又交回形状推断落成 input——又是「同一个词两个空间相反判决」，
 *  方向反过来（单行 → 多行框）。
 *  后缀（text/input/…）同样不能逐个列进正则：列不完，漏一个就是一次错误指令。
 *  反序语序（`multiSelectLines` / `multiChoiceLines`）不需要另设判据：它们没有「multi 紧跟 line」的前缀，本来就
 *  落不到 line 族，会走多选分支。 */
const LINE_LIKE_MARKER = /multi(?:ple)?lines?/;

/** 键名 / type 取值里「形似多选但语义是多行文本」（`multiline`、`multipleLines`、`multi_line_enabled`、
 *  `allowMultiline`、`multilineHint`）：正确写法是 `type: "editor"`，报「请改 multi_select」会把模型引向错的多选卡。 */
function isLineLikeKey(key: string): boolean {
	const token = normalizeTypeToken(key);
	return LINE_LIKE_MARKER.test(token) && !LINE_THEN_PICK.test(token);
}

/** 顶层单问题模式额外认识的键（工具参数级，不属于单个 question）。 */
const TOP_LEVEL_KEYS = ["questions", "review"];

/** 工具参数级真正生效的字段：`type` 与两组意图键。`question` / `options` / `placeholder` / `prefill` / `id` /
 *  `allowOther` 写在外层只会被忽略（同一句日志的后半截就写着「已忽略」），把它们列进「字段只支持 …」
 *  等于教模型写无效字段（模型真把 `options` 留在外层，选项就整组丢掉、题退成 input）。 */
const TOP_LEVEL_SUPPORTED_KEYS = ["type", ...MULTI_INTENT_KEYS, ...EDITOR_INTENT_KEYS];

/** type 的规范值：直接从 QuestionSchema 的 StringEnum 取，不另抄第二份清单（抄了就会漂移）。 */
const CANONICAL_TYPES: readonly string[] = (QuestionSchema.properties.type as unknown as { enum?: readonly string[] }).enum ?? [];

/** type 写法的规范值：规范值（含大小写/分隔符变体）收口，多选 / 多行文本样拼写收口，其余（拼错 / null / 数字）返回 undefined。
 *  规范值与拼写判断都走 `normalizeTypeToken`，否则 `type: "SELECT"` 和 `type: "multi-select"` 会得到相反的排查结论。
 *  多选样拼写不另抄别名表，而是与键空间共用 `isMultiLikeToken` / `isLineLikeKey` / `SINGLE_LIKE_KEY`：
 *  抄一张表列不全（`multiSelection` / `multiAnswers` / `checkboxGroup`…），漏一个就是「同一个拼写作为 key
 *  会被要求改写成 type: "multi_select"，作为 type 取值却静默降级成 select」——同一条静默降级路径换入口。
 *  只带 `multi` 前缀而不表达多选的写法（`multiText` / `multiStepHint`）交回形状推断：既不当成
 *  多选别名，也不拿它把整批提问抛错。 */
function canonicalTypeOf(value: unknown): NormalizedQuestion["type"] | undefined {
	const token = normalizeTypeToken(value);
	const canonical = CANONICAL_TYPES.find((type) => normalizeTypeToken(type) === token);
	if (canonical) return canonical as NormalizedQuestion["type"];
	// 顶层 `type` 不在 schema 声明里，`type: "notMultiple"` 会原样到达 execute；只按多选词根猜别名会
	// 把明确否定的写法翻成多选卡。与意图键取值共用 `isIntentOn`，别在这里另抄一份否定词表。
	if (typeof value === "string" && !isIntentOn(value)) return undefined;
	if (!isMultiLikeToken(token)) return undefined;
	// 取值侧「写着单选」由上面的 `isIntentOn` 门禁收口（它已包含 `isSingleLikeValue`），这里不再重复判断：
	// 能走到这一行的字符串值必然 `isIntentOn` 为真，再调一次恒为 false，是死代码。
	return isLineLikeKey(token) ? "editor" : "multi_select";
}

/** question 对象的已知键：schema 声明的字段 + 历史字段 allowOther + 两组布尔意图别名。 */
const QUESTION_KEYS = new Set<string>(["id", "type", "question", "options", "placeholder", "prefill", "allowOther", ...MULTI_INTENT_KEYS, ...EDITOR_INTENT_KEYS]);

/** 选择题类型：必须有非空 options 才能渲染（execute 里同一条护栏）。 */
function isPickType(type: NormalizedQuestion["type"]): boolean {
	return type === "select" || type === "multi_select";
}

/** 本题有没有可渲染的选项（`options: []` 与不写同判）：形状判据只有这一份，推断、日志一致性与
 *  「意图键不许吞选项」都走它，否则三处各写一遍就会漂。 */
function hasPickableOptions(raw: Record<string, unknown>): boolean {
	return Array.isArray(raw.options) && raw.options.length > 0;
}

/** 这道题会不会被 execute 的 options 护栏打回：选择题式（select / multi_select）却没有可渲染选项时，
 *  护栏返回「必须提供 options」，整批提问一张卡都不渲染。日志说「已按 X 处理 / 已渲染」之前必须先过这一关
 *  ——否则又是一条指向不存在渲染结果的线索（同上一轮修的多行意图那处，同一命题的剩余入口）。 */
function rejectedByOptionsGuard(type: NormalizedQuestion["type"], raw: Record<string, unknown>): boolean {
	return isPickType(type) && !hasPickableOptions(raw);
}

/** 被 options 护栏打回时的日志后缀：三处（多选意图升级 / 多行意图冲突 / 顶层 type 别名与忽略）共用一句，
 *  各写一遍就会漂成「一张卡都不显示」「会被打回」等不同说法，排查时按日志搜不全同一个现象。 */
const OPTIONS_GUARD_NOTE = "会被 execute 的「必须提供 options」护栏打回、一张卡都不渲染";

/**
 * 诊断日志里的动词：这一步之后**真的会出卡**吗。
 *
 * 飞书与 headless 在 execute 里直接返回文案——一张卡都不渲染，也走不到 options 护栏（见 execute 开头两处
 * 早退）。这两类会话里写「已按 X 渲染」「会撞护栏打回」全是指向不存在结果的假线索：排查时会按日志去找一张
 * 根本不会出现的卡。动词与护栏提示必须由同一个判据（`renderable`）决定，分开写就会像上一轮那样——多行意图
 * 那处过了 options 护栏，却没过飞书 / headless 短路。
 */
function renderVerb(renderable: boolean): string {
	return renderable ? "渲染" : "处理";
}

/** 未知键里「像多选拼错且取了肯定值」的那一类。同一谓词服务两处：
 *  题级忽略它就会静默变单选，所以报错；工具参数外层没法报错（不能连坐整批），所以折成默认 type。
 *  只有 `choice` 词根的键也不算（见 `isMultiLikeToken`）：`allowCustomChoice` / `showChoices` 说的是
 *  「这是一道选择题」，按多选报错会让一整批提问白重发——它们改前本来渲染成正常的 select 卡。
 *  键名同样先归一：`single__choice: true`（双分隔符）与 `type: "single__choice"` 必须同判，
 *  否则同一个拼写只因为多敲一个下划线就变成「多选必须写 type: multi_select」。键名自带否定前缀
 *  （`notMultiple` / `noMultiSelect`）也不是多选意图：值与键共用 `isOffToken`，否则「明确写了不是多选」
 *  的字段反而会整批硬报错。 */
function isMisreadMultiKey(key: string, value: unknown): boolean {
	const token = normalizeTypeToken(key);
	return isIntentSwitch(value) && !isOffToken(key) && isMultiLikeToken(token, value) && !isLineLikeKey(token) && !SINGLE_LIKE_KEY.test(token);
}

/** 这组字段里有没有表达「多选」：已知意图键取肯定值（`multiple: true`），或未知键像多选拼错且取肯定值
 *  （`checkbox: true`）。与 `isMisreadMultiKey` 同一个谓词，所以「多选样拼写」在两个入口不会一边认一边不认。 */
function hasMultiSignal(raw: Record<string, unknown>): boolean {
	for (const key of MULTI_INTENT_KEYS) {
		if (isIntentOn(raw[key])) return true;
	}
	return Object.entries(raw).some(([key, value]) => !QUESTION_KEYS.has(key) && isMisreadMultiKey(key, value));
}

/** 题上写了「多行文本样」的未知键并取肯定值（`multipleLines: true`、`allowMultiline: "yes"`）：
 *  唯一一份判据——`inferType` 用它决定落 editor，`checkQuestionKeys` 用同一份名单判「已消费」。
 *  两处各写一遍谓词就会漂，而漂出来的恰好是本分支要消灭的「渲染改了却报忽略」。
 *  键名自带否定前缀（`notMultiline`）与多选侧 `notMultiple` 同判：复用 `isOffToken`，别让两个谓词
 *  对同一个否定前缀一个放行、一个折成 editor。 */
function lineLikeIntentKeys(raw: Record<string, unknown>): string[] {
	return Object.keys(raw).filter((key) => !QUESTION_KEYS.has(key) && !isOffToken(key) && isLineLikeKey(key) && isIntentSwitch(raw[key]));
}

/** 模型把 `type` 写成非规范值时的排查线索。批量与单题共用同一句：这条线索只写在旧的单问题路径上时，
 *  最常见的 `questions[i]` 路径就静默收口——同一个写法在两处一个留痕一个不留，按日志搜不全同一个现象。
 *
 *  实际类型可能来自别名、意图键或形状，所以日志一律写**最终** type：`type: "SELECT"` 旁边写 `multiple: true`
 *  时渲染的是 multi_select，照抄别名会同时产出「已按 select 处理」和推断那句「已按 multi_select 处理」，
 *  两句互相矛盾（排查时按日志去找一张根本不存在的单选卡）。括号里的「规范写法」同理只能是最终 type：
 *  写回别名会变成同一轮两条日志推荐两个不同的 `type` 取值，模型照哪条改都有一半是错的。
 *  只有字符串才是「模型写了 type 但写错」；null / 数字是字段用错，替它编一条 type 日志只会误导排查。 */
function warnNonCanonicalType(raw: Record<string, unknown>, type: NormalizedQuestion["type"], where: string, renderable = true): void {
	if (typeof raw.type !== "string" || CANONICAL_TYPES.includes(raw.type)) return;
	const alias = canonicalTypeOf(raw.type);
	const guard = renderable && rejectedByOptionsGuard(type, raw) ? `，但本题没有 options，${OPTIONS_GUARD_NOTE}` : "";
	// 模型写的 type 取值走 echoModelText：换行会把这句话拆成两条日志（详见该函数 docblock）。
	const written = echoModelText(raw.type);
	console.warn(
		alias
			? `[ask_question] ${where}的 type "${written}" 不是规范写法，已按 ${type} 处理${guard}（规范写法 type: "${type}"）`
			: `[ask_question] ${where}的 type "${written}" 不是规范值（${CANONICAL_TYPES.join(" / ")}），已忽略，实际按 ${type} 处理${guard}`,
	);
}

/**
 * 推断缺省 type：显式给了就用显式的；否则看意图键，再否则看形状——带 options 是选择题（flash 档
 * 模型经常省略可推导的 type，直接硬失败会整批重发，这里按意图兜底），没有则是文本输入。
 *
 * 题级意图键推出的 multi_select/editor 不做形状兜底：它和显式 `type` 同档声明，无 options 时就跟
 * 显式 `type: "multi_select"` 一样撞 execute 的护栏（返回模型看得见的「必须提供 options」）。外层意图
 * 不同——那是推断，所以下面才按形状折叠；两处不对称是有意的，别拿形状逻辑去改题级声明。
 *
 * `fallbackType` 只由批量路径传入：题级 type 或意图键写在了工具参数外层时，那个意图不能静默丢掉
 * （多选丢成单选就是「点一下即交卷」），所以本题自己没表达 type 时按它兜底。但外层意图**只在形状
 * 不冲突时才折叠**，冲突一律让本题自己的形状说了算：
 * - 无 options 的题折成选择题式，会被 execute 的护栏整批打回、一张卡都不显示，比原来拿到的
 *   input 文本档更差（input 不存在点一下即交卷的风险）；
 * - 带 options 的题折成纯文本式，会把模型给的选项整组丢掉，用户从「点选项」退回「手打」，
 *   比改动前的形状推断（select）更糟。
 *
 * 显式 type 与多选意图**同写**时不做「显式优先」：`type: "select"` 只说了这是一道选择题，
 * 基数由 `multiple: true` / `multi_select: true` / `checkbox: true` 这类键说，两者不矛盾。
 * 按 type 走就退回「点一下选项即交卷」——正是本分支要消灭的那条路径（见 declaredTypeOf）。
 * 其余声明（`input` / `confirm` / `editor`）带多选意图不升级：这类题多半没有 options，
 * 折成多选会撞 execute 的「必须提供 options」护栏、整批打回，拿到的还不如原来的文本档。
 *
 * 「多行文本样」的未知键（`multipleLines: true` / `allowMultiline: true`）落到 editor，位置在题级意图键与
 * 形状之间：这些拼写只是形状提示，题级 `multiline: true`（已知意图键）才算声明。**键与 `type` 取值在这里
 * 故意不对称**（表驱动用例「同一拼写 × 两个空间同判」里注明了这两处）：键是形状提示，带 options 时让位给
 * 形状（`hasPickableOptions`，吞掉选项比多行框更贵）；`type: "multiline"` 是多行文本的**拼写别名**，与规范
 * `type: "editor"` 同档，按声明压掉 options。两侧都必须留一条日志（键侧见下面 `hasOptions` 那支，取值侧见
 * `explicit` 那支），否则「选项整组没了」在诊断日志里搜不到。
 */
function inferType(raw: Record<string, unknown>, fallbackType?: NormalizedQuestion["type"], where = "顶层字段", renderable = true): NormalizedQuestion["type"] {
	const verb = renderVerb(renderable);
	const explicit = explicitTypeOf(raw);
	if (explicit) {
		// 只算一次：下面「与多选意图键冲突」与「editor 压掉 options」两条 warn 必须互斥，否则
		// `{type:"editor", options:[…], multiple:true}` 会同一轮推荐 `type:"multi_select"` 与 `type:"select"`。
		const hasMultiIntentKey = MULTI_INTENT_KEYS.some((key) => isIntentOn(raw[key]));
		// 多选意图与已声明的 type 冲突时改前是完全静默的（连 warn 都没有），排查「用户点一下就交卷」时
		// 在诊断日志里看不到任何线索。两个分支都要报：一个说「升了」，一个说「没升、所以它被忽略了」
		// ——只报前者，`{type:"confirm", multiple:true}` 这种仍然零输出。
		if (explicit === "multi_select" && canonicalTypeOf(raw.type) === "select") {
			// 升级后的形态同样是选择题式：没有 options 时 execute 会把整批打回，日志不能只说「已按 multi_select 处理」。
			console.warn(
				renderable && rejectedByOptionsGuard(explicit, raw)
					? `[ask_question] ${where}的 type "select" 旁边写了多选意图键，已按 multi_select 处理，但本题没有 options，${OPTIONS_GUARD_NOTE}（多选请写 type: "multi_select" 并带上 options）`
					: `[ask_question] ${where}的 type "select" 旁边写了多选意图键，已按 multi_select 处理（多选请只写 type: "multi_select"）`,
			);
		} else if (explicit !== "multi_select" && hasMultiIntentKey) {
			// 只报**已知意图键**被忽略这一种：未知拼错键（`checkbox`）自有 checkQuestionKeys 的
			// 「忽略未知字段」那句，在这里再说一遍就是噪音；而且 `{multiline:true, checkbox:true}` 里
			// 该改的是掉 checkbox，不是“去写 type: multi_select”。
			// 理由要按本题**实际形状**写：带 options 的 `{type:"confirm", options:[…], multiple:true}` 不升级是因为
			// type 声明了别的题型（那份 options 也确实不会渲染），把「没有 options 撞栏杆」抄进日志就成了假线索。
			console.warn(
				hasPickableOptions(raw)
					? `[ask_question] ${where}的 type "${explicit}" 与多选意图键冲突，已按 ${explicit} ${verb}（本题的 options 不会渲染；多选请只写 type: "multi_select"）`
					: `[ask_question] ${where}的多选意图键被忽略（本题按 ${explicit} ${verb}：${renderable ? "没有 options，折成多选会撞 execute 的「必须提供 options」护栏" : "没有 options，本会话也没有卡片可渲染"}）；需要多选请写 type: "multi_select" 并带上 options`,
			);
		}
		// 多行文本意图键落到不是 editor 的题型上同样不许静默：`multiline` 在改前是未知字段，至少留一条「忽略未知字段」；
		// 现在它是已知意图键，被别的声明压掉时不报，「多行框没了」这件事就只剩用户看得见。
		// 声明的题型是选择题式却没给 options 时**一张卡也不渲染**（execute 的 options 护栏会整批打回），
		// 这时候说「已按 X 渲染」又是指向不存在的渲染结果——按会不会真出卡分叉。
		if (explicit !== "editor" && EDITOR_INTENT_KEYS.some((key) => isIntentOn(raw[key]))) {
			console.warn(
				renderable && rejectedByOptionsGuard(explicit, raw)
					? `[ask_question] ${where}写了多行文本意图键，本题声明的 ${explicit} 没有 options，${OPTIONS_GUARD_NOTE}（多行内容请只写 type: "editor"）`
					: `[ask_question] ${where}写了多行文本意图键，已按 ${explicit} ${verb}（多行内容请只写 type: "editor"）`,
			);
		}
		// 多行文本样的 `type` 拼写（`type: "multiline"` / `"multipleLines"`）与规范 `type: "editor"` 在取值侧
		// 都是**声明**档，一样压掉 options（键侧相反，那里是形状提示、选项优先，见本函数 docblock 的不对称说明）。
		// 压掉选项有据可依，但日志不能缺席：同名拼写作为键时这里会报「已按 select 渲染」，取值侧零输出就成了
		// 事后搜不到的坑；只给别名留痕、规范写法反而静默，排查时同样搜不到「规范写法把选项丢了」。
		// `hasPickableOptions` 在这里是唯一判据；与「多选意图键冲突」互斥——那句已经说明 options 不会渲染，
		// 再叠一条指向 `type:"select"` 的 warn 就是同一轮两条互相矛盾的改正建议。
		if (explicit === "editor" && hasPickableOptions(raw) && !hasMultiIntentKey) {
			console.warn(
				`[ask_question] ${where}的 type "${echoModelText(raw.type)}" 已按 editor ${verb}，但本题带了 options，选项不会渲染（要选项请写 type: "select"；要多行文本请只写 type: "editor" 且不要给 options）`,
			);
		}
		return explicit;
	}
	const hasOptions = hasPickableOptions(raw);
	// 「多行文本样」的未知键（`multipleLines: true` / `allowMultiline: true` / `multi_line_enabled: true`）只在
	// 无 options 时落实成 editor：模型要一段多行内容却拿到单行 input 是静默换形态；带 options 时折成纯文本
	// 又会把整组选项丢掉（与「外层纯文本式不吞选项」同一条理由），所以带 options 时继续按形状走 select。
	// 落实了就要留一条排查线索：`checkQuestionKeys` 会把这个键从「已忽略」名单里摘掉，不在这里说明
	// 「按 editor 渲染」，事后翻日志只会看到它凭空消失（或反过来以为它被丢了）。
	if (!hasOptions && lineLikeIntentKeys(raw).length > 0) {
		console.warn(`[ask_question] ${where}写了多行文本样字段，已按 editor ${verb}（多行内容请只写 type: "editor"）`);
		return "editor";
	}
	// 形状与外层意图一致时才折叠（选择题式 ↔ 有 options），冲突时按形状走。
	// `confirm` 不参与折叠：它不是「纯文本式」而是二值卡，折到无 options 的题上会把「你的名字？」渲染成
	// 「是/否」卡（改前是 input 文本档）；写在外层的 confirm 只对本题自己也声明 confirm 的情形生效。
	const foldsOuter = fallbackType !== undefined && fallbackType !== "confirm" && isPickType(fallbackType) === hasOptions;
	const resolved: NormalizedQuestion["type"] = foldsOuter && fallbackType ? fallbackType : hasOptions ? "select" : "input";
	// 题上写了多行文本意图键（`multiline: true`）但本题带 options：与上面同一条取舍，按形状/外层意图走
	// （`declaredTypeOf` 已不再让意图键吞选项）。日志不能缺席：不报就会成了「静默吞选项」那类问题。
	// 日志里的类型必须是**最终**形态：外层意图（`multi_select: true`）与本题 options 一致时这题渲染成
	// multi_select，硬写「已按 select 渲染」就是撒谎——排查时按日志去找一张根本不存在的单选卡。
	if (hasOptions && EDITOR_INTENT_KEYS.some((key) => isIntentOn(raw[key]))) {
		console.warn(`[ask_question] ${where}写了多行文本意图键，但本题带 options，已按 ${resolved} ${verb}（多行内容请写 type: "editor" 且不要给 options）`);
	}
	return resolved;
}

/** 一组字段**自己声明**的 type：规范值/别名 → 意图键 → undefined（形状推断不在这里，
 *  「像多选拼错的未知键」的猜测也不在这里——见 explicitTypeOf）。
 *  单独拆出来是因为 `checkQuestionKeys` 需要它：渲染已经由声明定死时不该再硬报错，
 *  而拿未知键的猜测去判「已声明」会自我实现（猜出来的多选替一个报错背书）。 */
function declaredTypeOf(raw: Record<string, unknown>, optionsIsShape = true): NormalizedQuestion["type"] | undefined {
	const explicit = canonicalTypeOf(raw.type);
	// `type: "select"` 只说「这是一道选择题」，基数由 `multiple: true` / `multi_select: true` /
	// `checkbox: true` 这类键说——两者不矛盾，声明优先在这里会把多选意图整条吃掉：
	// 渲染成 select，用户点第一个选项即交卷（askUi.shouldAutoAdvanceBatchAnswer），模型拿到的
	// 却是单个值，且改前连 warn 都没有。升级成 multi_select 的代价只有一项：该题不再渲染
	// select 卡恒定显示的自定义输入框（SessionRuntimeUiOverlay 的 multi_select 分支只有勾选），
	// 但比「点一下即交卷」便宜得多；不带 options 时与 select 一样撞 execute 的同一条护栏
	// （都是模型可见的报错）。
	// 反过来 `input` / `confirm` / `editor` 带多选意图**不升级**：这类题多半没有 options，折成多选
	// 会撞同一条护栏、整批打回，比原来的文本档更差（理由同 inferType 的 fallbackType）。
	if (explicit) return explicit === "select" && hasMultiSignal(raw) ? "multi_select" : explicit;
	for (const key of MULTI_INTENT_KEYS) {
		if (isIntentOn(raw[key])) return "multi_select";
	}
	for (const key of EDITOR_INTENT_KEYS) {
		// 多行文本意图键同样不许吞 options：带 options 时交回形状推断（select），与「多行文本样**未知**键
		// 带 options 时不压选项」「外层文本式意图不吞选项」同一条取舍（选项整组丢掉比多行框更贵）。
		// `optionsIsShape: false` 用于工具参数外层：那一层的 `options` 是已声明忽略的逐题字段，拿它反推
		// 形状会让外层 `multiline: true` 被自己的 stray options 吃掉（按形状落成 input），日志还会反过来
		// 声称「没有可识别的 type / 意图键」——同一个意图只因为多写一个无效字段就换了渲染形态。
		if (isIntentOn(raw[key])) return optionsIsShape && hasPickableOptions(raw) ? undefined : "editor";
	}
	return undefined;
}

/** 一组字段里写下的 type 意图：`declaredTypeOf` 的声明，再加上「像多选拼错的未知键」的猜测。
 *  单题与批量外层复用同一套判据，避免两处慢慢漂开——否则 `checkbox: true` 作为 key 在一处报错、
 *  在另一处被静默丢掉，而它作为 type 取值却是认的。 */
function explicitTypeOf(raw: Record<string, unknown>, optionsIsShape = true): NormalizedQuestion["type"] | undefined {
	const declared = declaredTypeOf(raw, optionsIsShape);
	if (declared) return declared;
	for (const [key, value] of Object.entries(raw)) {
		if (!QUESTION_KEYS.has(key) && isMisreadMultiKey(key, value)) return "multi_select";
	}
	return undefined;
}

/**
 * 未知键分两档（2026-11 复盘：一刀切硬报错会重蹈 type 硬失败导致整批重发的坑）：
 * - **像多选拼错的键**（`multiChoice: true`、`checkbox: true`…）：静默忽略会把它推断成
 *   select，而 select 卡点选项即提交（askUi.shouldAutoAdvanceBatchAnswer），用户点一下
 *   就交卷、模型也毫无反馈——所以抛错，让模型同一轮按提示改成 type: "multi_select"。
 *   不直接猜成多选，是因为提示里同时给出单选写法；而裸 `choice` / `choices` 连抛错都不做
 *   （它可能只是强调「这是选择题」，按多选拒掉一整批提问比单向更贵）。
 *   `multipleLines: true` 这类多行文本样键（isLineLikeKey）也不算多选——无 options 时按 editor 渲染。
 * - **其余未知键**（`description`、`default`…）：描述性冗余不影响渲染，只留一条 warn。
 *   被推断**消费**掉的键不在这份名单里（渲染结果已经改了，说「已忽略」就是撒谎）。
 *
 * 两种情况只降级为 warn、不抛错：本题自己声明了能认出的 type（规范值 / 别名 / 意图键，渲染已定，
 * 交给推断的余地为零——`multi_select: true` 旁边再写一个 `checkbox: true` 也属于这种，
 * 报错只会让模型把同一个要求换一种写法重发）；
 * 非交互场景（`throwOnMisreadMulti: false`——飞书/headless 的返回文案里没有卡片可渲染，
 * 抛错只会把模型引向「再调一次工具」）。warn 只进 pi 的 stderr（PiProcess 转到诊断日志），
 * 模型看不到，所以它只服务于事后排查，不承担纠正职责。
 */
function checkQuestionKeys(
	raw: Record<string, unknown>,
	where: string,
	// `applyLineLikeIntent`：这组字段上的多行文本样未知键会不会真的落实成 editor。题级 / 单问题模式是 true
	// （inferType 会看它）；批量路径的**工具参数外层**是 false（外层没有形状可推，多行样键只报忽略不折叠）
	// ——不分这两处，外层被真正丢掉的那个键会凭空从日志里消失。
	options: {
		extraKnown?: readonly string[];
		throwOnMisreadMulti?: boolean;
		applyLineLikeIntent?: boolean;
		/** 批量路径的**工具参数外层**已经声明的 type：外层与本题形状都指向多选时，渲染结果已定，不必硬报错。 */
		outerType?: NormalizedQuestion["type"];
		/** 这一层真正生效的字段（默认整套题级字段）：工具参数外层只有 `type` 与意图键生效，逐题字段写了也会被忽略。 */
		supportedKeys?: readonly string[];
		/** 这组字段里的 `options` 能不能当形状信号（默认能）：工具参数外层的 `options` 是已声明忽略的逐题字段，
		 *  必须与 `outerType` 那一侧同判，否则同一组字段在一处说「猜成多选、已消费」、另一处按 editor 渲染。 */
		optionsIsShape?: boolean;
	} = {},
): void {
	const extraKnown = options.extraKnown ?? [];
	const optionsIsShape = options.optionsIsShape ?? true;
	const unknown = Object.keys(raw).filter((key) => !QUESTION_KEYS.has(key) && !extraKnown.includes(key));
	if (unknown.length === 0) return;
	// 外层已经声明了多选、本题又带 options：按 inferType 的折叠规则渲染结果就是 multi_select，与拼错键要求的
	// 写法完全一致，并没有静默降级——此时抛错只会把一整批能渲染的提问打回、让模型重发一遍。
	// 豁免后它也不会进「已忽略」名单（下面 consumedMulti 的第二支：本题的拼错键本来就会被 explicitTypeOf
	// 猜成 multi_select，与飞书 / headless 同判）。外层写的是 `select` / 非选择题式时不豁免——那才是真正的
	// 降级风险（题级拼错键会被猜成多选，没人再提醒模型把 type 写对）。
	const decidedByOuter = options.outerType === "multi_select" && hasPickableOptions(raw);
	const misreadMulti =
		declaredTypeOf(raw, optionsIsShape) || options.throwOnMisreadMulti === false || decidedByOuter
			? []
			: unknown.filter((key) => isMisreadMultiKey(key, raw[key]));
	if (misreadMulti.length > 0) {
		// 回显模型实际写的值（可能是 1 / "true"），别硬编码成 ": true"。
		// 键名与取值都过整形（`echoModelText` / `echoModelValue`）：否则一个能把报错文案拆成两行，
		// 另一个能把几 KB 或 U+2028 / U+2029 拖进日志行。
		const written = misreadMulti.map((key) => `"${echoModelText(key)}": ${echoModelValue(raw[key])}`).join(" / ");
		throw new Error(`ask_question: ${where} 出现 ${written}；多选必须写 type: "multi_select"（单选写 type: "select"，不能写 ${written}）`);
	}
	// 已被推断**消费**的键不再说成「已忽略」，否则同一句日志里一边说「忽略 checkbox」一边说「已按
	// multi_select 处理」，或者把已经落成 editor 的多行样键说成被丢掉——撒谎的日志比没有日志更费时间。
	// 两种消费路径与推断一一对应：
	// - 多选样拼错键：被 `declaredTypeOf` 升级（`type: "select"` + `checkbox: true`），或被
	//   `explicitTypeOf` 的猜测收成默认 type（后者只可能在非交互场景走到，有 UI 时已先抛错）。
	//   声明就来自 `multi_select: true` 时不在此列——那里的 checkbox 确实没被消费，就该继续报忽略。
	// - 多行文本样未知键：在**无 options** 时把本题落成 editor（见 inferType）。带 options 时
	//   它没参与渲染（形状优先），仍然如实报「已忽略」。
	const consumedMulti =
		(canonicalTypeOf(raw.type) === "select" && declaredTypeOf(raw, optionsIsShape) === "multi_select") ||
		(!declaredTypeOf(raw, optionsIsShape) && explicitTypeOf(raw, optionsIsShape) === "multi_select")
			? unknown.filter((key) => isMisreadMultiKey(key, raw[key]))
			: [];
	// 第二个条件里的拼错键只可能在非交互场景被消费（有 UI 时上面已抛错）：飞书 / headless 的猜测
	// 确实进了 details，就不该同时被说成「已忽略」。
	const consumedLine =
		(options.applyLineLikeIntent ?? true) && !explicitTypeOf(raw, optionsIsShape) && !hasPickableOptions(raw)
			? lineLikeIntentKeys(raw).filter((key) => unknown.includes(key))
			: [];
	const consumed = [...consumedMulti, ...consumedLine];
	// `extraKnown` 只表示「放行、别当未知字段报」，不等于被消费：批量路径把外层拼错键（`checkbox: true`）
	// 折成默认 type 时靠它放行，该键确实进了渲染结果，同样不许出现在支持字段清单里。
	// （`unknown` 已经排除 extraKnown，所以上面两条 consumed* 收不到它——这是同一个命题的另一个入口。）
	const consumedExtra = extraKnown.filter((key) => isMisreadMultiKey(key, raw[key]));
	const reported = unknown.filter((key) => !consumed.includes(key));
	if (reported.length === 0) return;
	// 支持字段清单同样不能把「被吃掉的多选意图键」宣传成受支持字段名（否则模型以为 `checkbox` 是合法字段）。
	const supported = [...(options.supportedKeys ?? QUESTION_KEYS), ...extraKnown.filter((key) => !consumed.includes(key) && !consumedExtra.includes(key))];
	console.warn(`[ask_question] ${where} 忽略未知字段 ${reported.map((key) => `"${echoModelText(key)}"`).join(", ")}；字段只支持 ${supported.map((key) => echoModelText(key)).join(" / ")}`);
}

/** 原型链上的名字（`constructor` / `toString` / `__proto__`…）：当 `answers[id]` 的槽位会取到继承值。 */
const PROTOTYPE_KEY_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype));

/**
 * 给每题定 id：模型自己写的 id 优先占位，自动兜底值（`q${序号}`）避开已被占用的，仍撞车时加 `-2`/`-3` 后缀。
 *
 * 为什么必须唯一：桌面端按 id 存批量答案（`answers[question.id]`，见 SessionRuntimeUiOverlay 的
 * `answerAndAdvance`），重复 id 会让「答了第 1 题」被当成「两题都答了」——`inspectBatchAnswers`
 * 据此放行提交，`askBatch` 的 `answers.length` 检查也达标，模型于是收到一条用户根本没作答的值。
 * 触发极便宜：模型给后面某题写 `id: "q1"`，而前面未写 id 的题刚刚自动拿走了 `q1`。
 * 后缀候选同样避开**所有**显式 id：自动值不能挤掉后面的 `id: "q1"`，重复 id 的后缀也不能抢走
 * 另一题真正写下的 `dup-2`（否则模型收到一个自己从未写过的 id，而这些 id 正是它对答案的钥匙）。
 * 只剩「同一个 id 真写了两道题」这一种情形会让步：id 是写给模型看的标签，唯一比字面一致更要紧。
 *
 * 「唯一」不够：id 还要真能当答案槽位。桌面端用**普通对象**按 id 存答案（`answers[question.id]`），
 * 所以 `constructor` / `toString` / `__proto__` 这类原型链名字即使唯一也不安全：`answers["constructor"]`
 * 取到的是函数（非 null、非数组），`isBatchAnswered` 于是把没答的题当成已答，放行提交后序列化时
 * 函数又被 `JSON.stringify` 丢掉，用户真实作答被吞。空串 / 纯空白同理：`answers[""]` 与「未作答」
 * 只差一次 hasOwn，后缀还会滚成模型从未写过的 `-2`。两者都按「没写 id」处理（拿序号兜底）。
 */
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
		// 初次出现的显式 id 原样保留（`candidate === id`），其余候选先避开所有显式 id：否则第 2 题的
		// `id: "q1"` 会与第 1 题自动拿到的 `q1` 撞车，或重复 id 的后缀会抢走另一题写下的 `dup-2`
		// ——两者都不是它自己声明的。唯一性由 `used` 保证。
		// 原型链名字不管是不是显式写的都要让路（`constructor` → `constructor-2`）：它们作为答案槽位是坏的。
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
		// 题级字段写在了工具参数外层：识别得出的意图（type / 别名 / 多选·多行意图键）当作各题的默认 type
		// —— 写错层级的已知意图不能静默丢掉（多选丢成单选 → 用户点一下选项就交卷）；其余逐题字段
		// （options / placeholder…）不属于参数级，只能忽略。题上显式写的 type/意图仍然优先（inferType 先看 explicit）。
		// 先算外层意图，再报未知字段：被折成默认 type 的拼错键（`checkbox: true`）不能同时被说成「已忽略」
		// ——warn 只服务于事后排查，自相矛盾/撒谎的日志比没有日志更费时间。
		// 拼错键（`checkbox: true`）只有真的上了渲染结果才算「已消费」：外层 type 是多选（含
		// `type: "select"` 被 declaredTypeOf 升级的情形）时它不再进「已忽略」名单；`type: "input"`
		// 这类不会升级的写法不看它，它就老实留在「忽略未知字段」里。
		// 外层 `options` 是已声明忽略的逐题字段，不能当形状信号（`optionsIsShape: false`，见 declaredTypeOf）。
		const outerType = explicitTypeOf(params, false);
		// id 唯一性先算好（模型显式 id 优先占位，自动兜底值避开它们）：见 assignQuestionIds。
		// 题项形状不再整形：pi 的校验层（pi-ai 的 validateToolArguments）先用 TypeBox parse 过参数，
		// `questions: ["选哪个分支？"]` 这种字符串项在那一层就被拒（questions.0: expected object），
		// 根本到不了 execute——在这里补兼容只是给测试自己看的死代码。
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
			// 与 `outerType` 那一侧同判：外层 options 已被声明忽略，不能在这里又拿它把多行意图挡成「没声明」。
			optionsIsShape: false,
		});
		const strayTopLevelKeys = Object.keys(params).filter((key) => QUESTION_KEYS.has(key) || outerIntentKeys.includes(key));
		if (strayTopLevelKeys.length > 0) {
			const stray = strayTopLevelKeys.map((key) => echoModelText(key)).join(" / ");
			// 日志得跟着**实际折叠规则**说：`confirm` 不参与折叠（二值卡，不是纯文本档），
			// 写「已当作各题默认 type（confirm…）」会让排查时去找一批根本没改成「是/否」的题。
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
			// 飞书 / headless 分支只返回一段文案，未知键抛错会把模型引向「再调一次工具」，与那两个分支的意图相反。
			// ctx 整个缺失时也走同一条返回路径，不能在读 hasUI 时抛 TypeError。
			const hasUI = Boolean(!feishuLinked && ctx?.hasUI);
			// 第三个参数是「这张卡真的会出吗」：飞书 / headless 会在下面两处早退，直接返回文案。
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
