/**
 * PiDeck Ask Question Extension
 *
 * 注册 ask_question 工具，让 LLM 可以向用户提问并从桌面端 UI 获取回答。
 * 使用 pi RPC Extension UI Protocol（ctx.ui.select/input/editor）实现用户交互，
 * 桌面端处理 extension_ui_request/response 协议循环。
 * confirm 不调用 ctx.ui.confirm：RPC 把 cancelled 也解析成 false，与「否」无法区分；
 * 改为 select(是/否)，点叉走 value:null，与 select 取消语义一致。
 *
 * 两种用法：
 *   1. 单问题模式（向后兼容）：顶层 type/question/options/placeholder/prefill/allowOther
 *   2. 批量模式：questions 数组；桌面端以 Tab 标签页一次展示全部问题
 *      （RPC 只能串行 dialog，因此批量走一次 input envelope，由桌面端展开为 Tab UI）
 *
 * select 选项支持字符串或 {label, value?, description?} 对象；description 会拼进选项
 * 显示文本，让用户在桌面端按钮上直接看到说明。allowOther（默认 true）由扩展层在
 * 选项末尾追加「✎ 自行输入...」，选中后再用 ctx.ui.input 收集自定义答案——这样桌面端
 * select 不再硬编码自定义按钮，allowOther 完全由工具调用方控制。
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
	/** allowOther 追加的「自行输入」标记 */
	isOther?: boolean;
}

// 归一化后的问题
interface NormalizedQuestion {
	id: string;
	type: "select" | "confirm" | "input" | "editor";
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
	value: string | boolean | null;
	label?: string;
	wasCustom?: boolean;
}

// askOne 需要的上下文子集：只依赖 hasUI + 四个 RPC UI 方法，便于脱离 pi 内部 ctx 类型约束
interface AskCtx {
	hasUI: boolean;
	ui: {
		select: (question: string, options: string[]) => Promise<string>;
		confirm: (question: string, description?: string) => Promise<boolean>;
		input: (question: string, placeholder?: string) => Promise<string>;
		editor: (question: string, prefill?: string) => Promise<string>;
	};
}

/**
 * 批量 envelope 协议标记。
 * RPC 只支持串行 select/confirm/input/editor，无法一次弹多个 dialog。
 * 批量时用一次 input，title 放 JSON envelope；桌面端识别后渲染 Tab 问卷，
 * 最终把全部答案 JSON 字符串作为 value 回传，扩展再解析。
 */
export const BATCH_ASK_ENVELOPE_KEY = "__piDeckBatchAsk";

// allowOther 追加项的固定文案；选中后触发 ctx.ui.input 收集自定义答案
const OTHER_LABEL = "✎ 自行输入...";

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
	type: StringEnum(["select", "confirm", "input", "editor"], { description: "Type of question to ask" }),
	question: Type.String({ description: "The question or prompt to display" }),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options for select type questions" })),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Allow custom text input for select (default: true)" }),
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
	// 审阅模式：批量模式下全部回答后进入 Submit tab 汇总确认，防误提交
	review: Type.Optional(
		Type.Boolean({
			description:
				"When true and in batch mode, shows a Submit/review tab of all answers for user confirmation before submitting. Default false.",
		}),
	),
	// 单问题模式（向后兼容）
	type: Type.Optional(
		StringEnum(["select", "confirm", "input", "editor"], {
			description: "Type of question (single-question mode; ignored when `questions` is provided)",
		}),
	),
	question: Type.Optional(Type.String({ description: "The question to show (single-question mode)" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options (single select mode)" })),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Allow custom text input for select (single mode, default: true)" }),
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

/** 拼接选项显示文本：有 description 时附在 label 后，便于桌面端按钮直接展示说明 */
function optionDisplayText(opt: NormalizedOption): string {
	return opt.description ? `${opt.label} — ${opt.description}` : opt.label;
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
			const type = (r.type as NormalizedQuestion["type"]) ?? "input";
			return {
				id: String(r.id ?? `q${i + 1}`),
				type,
				question: String(r.question ?? ""),
				options: type === "select" ? normalizeOptions(r.options) : undefined,
				// allowOther 仅对 select 有意义；未显式传 false 时按 true 处理
				allowOther: type === "select" ? r.allowOther !== false : undefined,
				placeholder: r.placeholder as string | undefined,
				prefill: r.prefill as string | undefined,
			};
		});
	}
	// 单问题模式：顶层字段
	const type = (params.type as NormalizedQuestion["type"]) ?? "input";
	return [
		{
			id: "default",
			type,
			question: String(params.question ?? ""),
			options: type === "select" ? normalizeOptions(params.options) : undefined,
			allowOther: type === "select" ? params.allowOther !== false : undefined,
			placeholder: params.placeholder as string | undefined,
			prefill: params.prefill as string | undefined,
		},
	];
}

/** 单问题结果：保持 {question,type,answer,answered} 结构，兼容历史会话反推 */
function singleResult(q: NormalizedQuestion, a: Answer, cancelled: boolean) {
	const answered = !cancelled && a.value !== null && a.value !== undefined;
	return {
		content: [
			{
				type: "text" as const,
				text: cancelled
					? `用户取消了提问: ${q.question}`
					: `用户回答: ${typeof a.value === "boolean" ? (a.value ? "是" : "否") : String(a.value ?? "")}`,
			},
		],
		details: {
			question: q.question,
			type: q.type,
			answer: cancelled ? null : a.value,
			answerLabel: a.label,
			// 显式写 answered，避免桌面端把 undefined 当成「未回答」
			answered,
			options: q.options,
			...(cancelled ? { cancelled: true } : {}),
		},
	};
}

/** 批量结果：返回结构化 questions/answers，便于 LLM 按 id 取值 */
function batchResult(qs: NormalizedQuestion[], answers: Answer[], cancelled: boolean) {
	const lines = answers.map((a) => {
		const v = typeof a.value === "boolean" ? (a.value ? "是" : "否") : String(a.value ?? "");
		return `${a.id}: ${a.wasCustom ? "(自行输入) " : ""}${v}`;
	});
	return {
		content: [
			{
				type: "text" as const,
				text:
					cancelled && answers.length === 0
						? "用户取消了问卷"
						: lines.length
							? lines.join("\n")
							: "无答案",
			},
		],
		details: { questions: qs, answers, cancelled },
	};
}

/**
 * 执行单个问题的提问。select 会按 allowOther 追加「自行输入」项；
 * 用户取消时由框架层抛出，调用方在循环里 try-catch 中断批量。
 */
async function askOne(q: NormalizedQuestion, ctx: AskCtx): Promise<Answer> {
	switch (q.type) {
		case "select": {
			const base = q.options ?? [];
			// allowOther 默认 true：追加「自行输入」项，选中后走 input 收集
			const opts: NormalizedOption[] =
				q.allowOther !== false
					? [...base, { label: OTHER_LABEL, value: "__other__", isOther: true }]
					: base;
			const labels = opts.map(optionDisplayText);
			// 循环：取消「自行输入」后回到选单，而非直接返回
			while (true) {
				const selected = await ctx.ui.select(q.question, labels);
				// 用户点叉/取消：桌面端发 value:null 或 cancelled → selected 为 null/undefined。
				// 绝不能 fallback 到 opts[0]，否则会「取消却答了第一项」。
				if (selected == null || selected === "") {
					return { id: q.id, type: q.type, value: null };
				}
				// 兼容桌面端回传显示文案 / value / OTHER_LABEL 三种形态，
				// 避免「自行输入」因文案拼接差异匹配失败而落成取消。
				const chosen =
					opts.find((o) => optionDisplayText(o) === selected) ??
					opts.find((o) => o.value === selected) ??
					opts.find((o) => o.label === selected) ??
					(selected === OTHER_LABEL || selected === "__other__"
						? opts.find((o) => o.isOther)
						: undefined);
				if (!chosen) {
					// 未知返回值也当取消，避免误绑第一项
					return { id: q.id, type: q.type, value: null };
				}
				if (chosen.isOther) {
					const custom = await ctx.ui.input(`${q.question}（自行输入）`, "");
					if (custom?.trim()) {
						return { id: q.id, type: q.type, value: custom.trim(), label: custom.trim(), wasCustom: true };
					}
					// 取消或空内容 → 继续循环，重新展示选单
					continue;
				}
				return { id: q.id, type: q.type, value: chosen.value, label: chosen.label, wasCustom: false };
			}
		}
		case "confirm": {
			// pi RPC 的 ctx.ui.confirm：cancelled 与缺省都解析为 false，和点「否」无法区分。
			// 因此 confirm 改走 select（是/否）；点叉发 value:null → selected 为 null/undefined，
			// 与 select 取消路径一致，不会误答成 false。
			const yesLabel = "是";
			const noLabel = "否";
			const selected = await ctx.ui.select(q.question, [yesLabel, noLabel]);
			if (selected == null || selected === "") {
				return { id: q.id, type: q.type, value: null };
			}
			if (selected === yesLabel) {
				return { id: q.id, type: q.type, value: true, label: yesLabel };
			}
			if (selected === noLabel) {
				return { id: q.id, type: q.type, value: false, label: noLabel };
			}
			// 未知回传当取消，避免误绑
			return { id: q.id, type: q.type, value: null };
		}
		case "editor": {
			const text = await ctx.ui.editor(q.question, q.prefill ?? "");
			return { id: q.id, type: q.type, value: text };
		}
		default: {
			// input 类型
			const text = await ctx.ui.input(q.question, q.placeholder ?? "");
			return { id: q.id, type: q.type, value: text };
		}
	}
}

/**
 * 批量：一次 envelope 交给桌面端 Tab UI。
 * 回传 value 为 JSON：{ cancelled?: true, answers: Answer[] }
 * 解析失败或用户取消 → cancelled。
 */
async function askBatch(
	questions: NormalizedQuestion[],
	review: boolean,
	ctx: AskCtx,
): Promise<{ answers: Answer[]; cancelled: boolean }> {
	// title 放 envelope；placeholder 给桌面端兜底文案（非 JSON 客户端会当普通 input）
	const envelope = JSON.stringify({
		[BATCH_ASK_ENVELOPE_KEY]: 1,
		review: review === true,
		questions,
	});
	const raw = await ctx.ui.input(envelope, "__piDeckBatchAsk__");
	if (typeof raw !== "string" || !raw.trim()) {
		return { answers: [], cancelled: true };
	}
	try {
		const parsed = JSON.parse(raw) as {
			cancelled?: boolean;
			answers?: Answer[];
		};
		if (parsed.cancelled) return { answers: parsed.answers ?? [], cancelled: true };
		const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
		// 至少要有与问题等量的有效答案，否则视为取消/半完成
		const complete =
			answers.length >= questions.length &&
			answers.every((a) => a && a.value !== null && a.value !== undefined);
		return { answers, cancelled: !complete };
	} catch {
		return { answers: [], cancelled: true };
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description: [
			"Ask the user to provide input, make a selection, or confirm an action.",
			"The tool blocks until the user responds through the desktop UI.",
			"Single question: use type/question/options/placeholder/prefill.",
			"Multiple questions: use questions:[{id,type,question,options,allowOther,...}] to ask all at once in a tabbed batch UI.",
			"For batch mode, set review:true to require a Submit/review tab before final submit (prevents accidental submit).",
		].join(" "),
		promptSnippet: "Ask the user a question (or a batch of questions) and wait for responses",
		promptGuidelines: [
			"IMPORTANT RULE: Whenever you need ANY input from the user (a choice, confirmation, text, or multi-line content), you MUST use the ask_question tool. Do NOT write questions in plain text — that forces the user to type free-form replies and breaks the desktop UI interaction flow.",
			"Use type:select with options when the user should pick from predefined choices. Options may be strings or {label, value?, description?} objects; use description to explain long options.",
			"Use type:confirm when you need a yes/no decision before proceeding (e.g. destructive operations, irreversible changes).",
			"Use type:input for short free-text responses, and type:editor for multi-line content like code or long explanations.",
			"For multiple related questions, pass a questions array instead of calling the tool repeatedly — desktop shows a tabbed batch UI and returns all answers at once.",
			"Set allowOther:false on a select question to forbid custom input (default true).",
			"For batch questions, set review:true to force a Submit review tab so the user confirms all answers before submitting.",
		],
		parameters: AskQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const record = params as Record<string, unknown>;
			const isBatch = Array.isArray(record.questions) && (record.questions as unknown[]).length > 0;
			const questions = toQuestions(record);

			// 非交互模式（headless）：不阻塞直接返回
			if (!ctx.hasUI) {
				const msg = "ask_question 无法执行：当前环境不支持交互式 UI。";
				return isBatch
					? batchResult(questions, [], true)
					: {
							content: [{ type: "text" as const, text: msg }],
							details: {
								question: questions[0].question,
								type: questions[0].type,
								answer: null,
								answered: false,
							},
						};
			}

			// select 必须有非空 options，否则桌面端无法渲染选择卡片
			for (const q of questions) {
				if (q.type === "select" && (!q.options || q.options.length === 0)) {
					const msg = `ask_question 未执行：select 类型必须提供 options（问题: ${q.question}）`;
					return isBatch
						? batchResult(questions, [], true)
						: {
								content: [{ type: "text" as const, text: msg }],
								details: {
									question: q.question,
									type: q.type,
									answer: null,
									answered: false,
									error: "select requires non-empty options",
								},
							};
				}
			}

			// 批量：一次 envelope → 桌面 Tab UI（含可选 Submit 审阅）
			if (isBatch) {
				try {
					const { answers, cancelled } = await askBatch(questions, record.review === true, ctx);
					return batchResult(questions, answers, cancelled);
				} catch {
					return batchResult(questions, [], true);
				}
			}

			// 单问题：保持原有 select/confirm/input/editor 串行协议
			try {
				const answer = await askOne(questions[0], ctx);
				// select/confirm 点叉 → value:null；input/editor 取消 → undefined。
				// 必须标 cancelled，否则 LLM 会把空答案当有效回复（confirm 更不能把取消当 false）。
				const cancelled = answer.value === null || answer.value === undefined;
				return singleResult(questions[0], answer, cancelled);
			} catch {
				return singleResult(questions[0], { id: questions[0].id, type: questions[0].type, value: null }, true);
			}
		},
	});
}
