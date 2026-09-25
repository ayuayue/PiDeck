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
	id: Type.String({ description: "Unique identifier for this question" }),
	type: Type.Optional(
		StringEnum(["select", "multi_select", "confirm", "input", "editor"], {
			description:
				"Type of question to ask; multi_select renders checkbox options and returns an array of selected values. Optional: defaults to select when options are provided, otherwise input",
		}),
	),
	question: Type.String({ description: "The question or prompt to display" }),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options for select / multi_select type questions" })),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Accepted for compatibility but ignored: select questions always show a custom text input" }),
	),
	placeholder: Type.Optional(Type.String({ description: "Placeholder for input/editor type questions" })),
	prefill: Type.Optional(Type.String({ description: "Prefill for input/editor type questions" })),
});

const AskQuestionParams = Type.Object({
	// 批量模式
	questions: Type.Optional(
		Type.Array(QuestionSchema, {
			description:
				"Multiple questions to ask in sequence (batch mode). When provided, the single-question fields below are ignored.",
		}),
	),
	review: Type.Optional(
		Type.Boolean({
			description:
				"When true and in batch mode, shows a Submit/review tab of all answers for confirmation. Default false.",
		}),
	),
	// 单问题模式（向后兼容）
	type: Type.Optional(
		StringEnum(["select", "multi_select", "confirm", "input", "editor"], {
			description:
				"Type of question (single-question mode; ignored when `questions` is provided. Optional: defaults to select when options are provided, otherwise input)",
		}),
	),
	question: Type.Optional(Type.String({ description: "The question to show (single-question mode)" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options (single select / multi_select mode)" })),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Accepted for compatibility but ignored: select questions always show a custom text input" }),
	),
	placeholder: Type.Optional(Type.String({ description: "Placeholder (single input/editor mode)" })),
	prefill: Type.Optional(Type.String({ description: "Prefill (single input/editor mode)" })),
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

/**
 * 推断缺省 type：显式给了就用显式的；否则看形状——带 options 是选择题（flash 档模型
 * 经常省略可推导的 type，直接硬失败会整批重发，这里按意图兜底），没有则是文本输入。
 */
function inferType(raw: Record<string, unknown>): NormalizedQuestion["type"] {
	const explicit = raw.type as NormalizedQuestion["type"] | undefined;
	if (explicit) return explicit;
	return Array.isArray(raw.options) && raw.options.length > 0 ? "select" : "input";
}

/**
 * 把工具参数归一化为统一问题列表。
 * 批量模式用 questions 数组；否则回退到单问题顶层字段，保持向后兼容。
 */
function toQuestions(params: Record<string, unknown>): NormalizedQuestion[] {
	const rawQuestions = params.questions;
	if (Array.isArray(rawQuestions) && rawQuestions.length > 0) {
		return rawQuestions.map((q, i) => {
			const r = (q ?? {}) as Record<string, unknown>;
			const type = inferType(r);
			const isPickList = type === "select" || type === "multi_select";
			return {
				id: String(r.id ?? `q${i + 1}`),
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
	const type = inferType(params);
	const isPickList = type === "select" || type === "multi_select";
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

/** 批量结果：返回结构化 questions/answers，便于 LLM 按 id 取值 */
function batchResult(qs: NormalizedQuestion[], answers: Answer[], cancelled: boolean, overrideText?: string) {
	const lines = answers.map((a) => {
		// multi_select 的 value 是数组，拼接展示（如「A、C」）
		const v = Array.isArray(a.value)
			? a.value.join("、")
			: typeof a.value === "boolean"
				? (a.value ? "是" : "否")
				: String(a.value ?? "");
		return `${a.id}: ${a.wasCustom ? "(自行输入) " : ""}${v}`;
	});
	return {
		content: [
			{
				type: "text" as const,
				text:
					overrideText ??
					(cancelled && answers.length === 0
						? "用户取消了问卷"
						: lines.length
							? lines.join("\n")
							: "无答案"),
			},
		],
		details: { questions: qs, answers, cancelled },
	};
}

/** Submit the whole question list through one RPC dialog so desktop renders one card. */
async function askBatch(
	questions: NormalizedQuestion[],
	review: boolean,
	ctx: AskCtx,
): Promise<{ answers: Answer[]; cancelled: boolean }> {
	const envelope = JSON.stringify({
		[BATCH_ASK_ENVELOPE_KEY]: 1,
		review,
		questions,
	});
	const raw = await ctx.ui.input(envelope, "__piDeckBatchAsk__");
	if (typeof raw !== "string" || !raw.trim()) return { answers: [], cancelled: true };
	try {
		const parsed = JSON.parse(raw) as { cancelled?: boolean; answers?: Answer[] };
		const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
		const complete =
			!parsed.cancelled &&
			answers.length >= questions.length &&
			answers.every((answer) => {
				const value = answer?.value;
				// multi_select 空数组视为未作答
				if (value === null || value === undefined) return false;
				return !Array.isArray(value) || value.length > 0;
			});
		return { answers, cancelled: !complete };
	} catch {
		return { answers: [], cancelled: true };
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
				"Ask the user to provide input, make a selection, or confirm an action.",
				"The tool blocks until the user responds through the desktop UI.",
				"Preferred call form: questions:[{id,type,question,options,placeholder,prefill}] — one or more questions in a single card.",
				"Single-question top-level fields (type/question/options) are also accepted; both forms render the exact same card UI.",
				"The type field is optional; it defaults to select when options are provided, otherwise input. Best practice: still set select/multi_select/confirm explicitly.",
				"Set review:true to require a Submit/review tab before final submit.",
				"Use type:multi_select when the user should pick MULTIPLE items from a list — it renders checkboxes and returns an array of selected values.",
				"Every select question always shows a free-text input box under the options; there is no way to hide it.",
			].join(" "),
		promptSnippet: feishuLinked
			? "Ask the user a question directly in the reply text (Feishu session: ask_question is disabled)"
			: "Ask the user a question (or a batch of questions) and wait for responses",
		promptGuidelines: feishuLinked
			? [
				"IMPORTANT: This session is linked to Feishu; the interactive ask_question tool is disabled.",
				"When you need input from the user, write the question directly in the reply text — the user answers with a Feishu message.",
				"Do NOT call ask_question; if you do, it returns an explanation instead of a real answer.",
			]
			: [
				"IMPORTANT RULE: Whenever you need ANY input from the user (a choice, confirmation, text, or multi-line content), you MUST use the ask_question tool. Do NOT write questions in plain text — that forces the user to type free-form replies and breaks the desktop UI interaction flow.",
				"When you have more than one question, ALWAYS pass them together as a questions array in ONE call; never split related questions into repeated single calls.",
				"Use type:select with options when the user should pick from predefined choices. Options may be strings or {label, value?, description?} objects; use description to explain long options.",
				"Use type:multi_select with options when the user should pick MULTIPLE choices — checkboxes are rendered and the answer is an array of selected values.",
				"Use type:confirm when you need a yes/no decision before proceeding (e.g. destructive operations, irreversible changes).",
				"Use type:input for short free-text responses, and type:editor for multi-line content like code or long explanations.",
				"select questions always include a custom free-text input for the user; do not pass allowOther.",
				"Set review:true to force a Submit/review tab so the user confirms all answers before submitting.",
			],
				parameters: AskQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const record = params as Record<string, unknown>;
			const questions = toQuestions(record);

			// 飞书绑定会话：不弹交互卡片，直接返回指引（agent 会把问题写进回复转述给用户）
			if (feishuLinked) {
				return batchResult(questions, [], true, "ask_question 已禁用：当前会话连接了飞书，交互式提问卡片不可用。请把问题直接写入回复文本，用户会以飞书消息回答。");
			}

			// 非交互模式（headless）：不阻塞直接返回
			if (!ctx.hasUI) {
				return batchResult(questions, [], true, "ask_question 无法执行：当前环境不支持交互式 UI。");
			}

			// select / multi_select 必须有非空 options，否则桌面端无法渲染选择卡片
			for (const q of questions) {
				if ((q.type === "select" || q.type === "multi_select") && (!q.options || q.options.length === 0)) {
					return batchResult(questions, [], true, `ask_question 未执行：${q.type} 类型必须提供 options（问题: ${q.question}）`);
				}
			}

			// 单一渲染形态：无论单问题还是批量，都走同一个批量信封，桌面端只有一种卡片外观
			try {
				const { answers, cancelled } = await askBatch(questions, record.review === true, ctx);
				return batchResult(questions, answers, cancelled);
			} catch {
				return batchResult(questions, [], true);
			}
		},
	});
}
