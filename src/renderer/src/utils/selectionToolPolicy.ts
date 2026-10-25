/**
 * 划词工具（select-text translation）的纯策略层。
 *
 * 无 DOM / React / i18n 运行时依赖：node:test 用 loadTsCommonJs 直接加载
 * （tests/selectionToolPolicy.test.mjs）。DOM 胶水（全局监听、选区快照）在
 * hooks/useSelectionTool；UI 在 components/selectionTool。
 * 这里只放「规则」：多长算划选、哪些区域不弹、浮层怎么摆放、翻译指令怎么拼。
 */
import type { AgentInvokeAction, AgentTranslateTarget } from "../../../shared/types/agentProfile";
import type { TranslationKey } from "../i18n";

/** 划选最短字符数：单个标点/单字几乎不可能是用户想翻译的内容，浮出按钮只会变成误触噪声。 */
export const SELECTION_TOOL_MIN_CHARS = 2;

/**
 * 划选文本上限（8000 字符）：与主进程 AGENT_INVOKE_TEXT_MAX_CHARS（16000）同量级但更保守——
 * 划词场景是「一段话」而不是整篇文档，超出部分截断，避免一次把整篇粘进一次性补全请求。
 */
export const SELECTION_TOOL_MAX_CHARS = 8000;

/** 工具自身 UI 的标记属性：浮出按钮与调用面板都带它，全局划选监听据此忽略工具内部（含面板内选中结果复制）。 */
export const SELECTION_TOOL_UI_ATTR = "data-selection-tool-ui";
export const SELECTION_TOOL_UI_SELECTOR = `[${SELECTION_TOOL_UI_ATTR}]`;

/**
 * mouseup 时不应重新评估选区的「交互面」：工具自身、Radix portal 菜单/弹层、时间线引用浮层。
 *
 * 场景（2026-10 用户反馈「复制后有 toast，还会出现一个单独的翻译按钮」）：
 * 选中正文 → 右键菜单点「复制」→ 「引用/翻译」浮层因 pointerdown 让位收起 → 这一下 mouseup
 * 落在 radix 菜单项上，旧实现把它当成新的划选手势，又把全局「翻译」浮钮画出来。
 * 复制不是划词，菜单/浮层上的点击不应产出选区快照。
 */
export const SELECTION_TOOL_IGNORED_MOUSEUP_SELECTOR = `${SELECTION_TOOL_UI_SELECTOR}, [data-radix-popper-content-wrapper], [role="menu"], [data-quote-toolbar], button`;

/** 该 mouseup 目标是否属于「复制/菜单/已有浮层」交互面（true = 不评估选区）。 */
export function isSelectionToolIgnoredMouseUpTarget(element: Element | null): boolean {
	if (!element) return false;
	return Boolean(element.closest(SELECTION_TOOL_IGNORED_MOUSEUP_SELECTOR));
}

/**
 * 编辑面选择器：输入框 / 原生下拉 / 任何 contenteditable 宿主（composer 富文本编辑器）。
 * 这些区域的划选属于编辑操作（拖拽选词、Ctrl+A），弹翻译按钮会直接打断输入。
 */
export const SELECTION_TOOL_EDITABLE_SELECTOR = 'input, textarea, select, option, [contenteditable]:not([contenteditable="false"])';

/** 元素自身的排除标签（与 SELECTION_TOOL_EDITABLE_SELECTOR 呼应，不依赖 closest 的祖先判定）。 */
const SELECTION_TOOL_EXCLUDED_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION"]);

/**
 * 归一化划选文本：去首尾空白；不足最小长度返回 null（调用方收起浮出按钮）；
 * 超过上限截断（保留前 N 字符，不提示——截断只发生在整篇文档级划选的边缘场景）。
 */
export function normalizeSelectionText(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed.length < SELECTION_TOOL_MIN_CHARS) return null;
	return trimmed.length > SELECTION_TOOL_MAX_CHARS ? trimmed.slice(0, SELECTION_TOOL_MAX_CHARS) : trimmed;
}

/**
 * 允许弹出划词按钮的「回复正文」范围（白名单）。
 *
 * 只认助手回复的正文根节点：
 * - `.execution-interim`：AnswerOutput（最终回答 / 中间回复 / live 正文）；
 * - `.assistant-text`：AssistantText（历史消息的正文渲染）。
 *
 * 2026-10 用户反馈：侧栏、设置、用户气泡等**非回复区域**划选也会冒出翻译浮钮，而且这些位置
 * 没有可用的点击上下文（出现了点不动）。旧实现是黑名单（任意非编辑面都允许），每新增一个面板
 * 都自动符合条件；改为白名单后新增面板默认不弹，只有回复正文才提供划词翻译。
 */
export const SELECTION_TOOL_REPLY_SELECTOR = ".execution-interim, .assistant-text";

/**
 * 选区端点是否落在「可弹浮出按钮」的回复正文内。
 *
 * 判定规则（两端分别判，跨边界划选任一端不在回复正文内即不弹）：
 * - 必须位于 SELECTION_TOOL_REPLY_SELECTOR 内（助手回复正文）；
 * - 工具自身 UI 内一律不算（[data-selection-tool-ui] 子树，含调用面板与浮出按钮）；
 * - 编辑面（input/textarea/select/option/contenteditable 宿主）不算。
 */
export function isSelectionToolAnchorElement(element: Element | null): boolean {
	if (!element) return false;
	if (element.closest(SELECTION_TOOL_UI_SELECTOR)) return false;
	if (element.closest(SELECTION_TOOL_EDITABLE_SELECTOR)) return false;
	// 自身标签再判一次：即使选择器引擎/游离节点让 closest 没命中祖先，端点本身是输入框也绝不弹。
	if (SELECTION_TOOL_EXCLUDED_TAGS.has(element.tagName.toUpperCase())) return false;
	return Boolean(element.closest(SELECTION_TOOL_REPLY_SELECTOR));
}

/** 选区锚点矩形（fixed 定位用的视口坐标，不含 width/height 时由调用方换算）。 */
export type SelectionAnchorRect = {
	left: number;
	top: number;
	right: number;
	bottom: number;
};

export type FloatingSize = { width: number; height: number };
export type FloatingViewport = { width: number; height: number };
export type FloatingPlacement = "above" | "below";
export type FloatingPosition = { left: number; top: number; placement: FloatingPlacement };

/**
 * 浮层定位（纯函数）：贴在选区上方或下方并夹紧在视口内。
 *
 * 规则：
 * - 默认优先上方（浮出按钮的惯例位置：不遮挡正在阅读的选区）；上方放不下（含 margin）翻转到下方；
 * - 调用面板传 prefer="below"：面板高、贴下方更接近「表单顺着选区展开」的形态，
 *   下方放不下时才翻到上方；
 * - 水平以选区中心对齐，再夹紧到 [margin, viewport.width - margin - width]；
 * - 垂直最终也夹紧，保证小视口/长面板不会溢出（宁可盖住选区也不能出屏）。
 */
export function clampFloatingPosition(input: {
	anchor: SelectionAnchorRect;
	viewport: FloatingViewport;
	size: FloatingSize;
	/** 浮层与选区的间距（默认 6px）。 */
	gap?: number;
	/** 浮层与视口边缘的最小留白（默认 8px）。 */
	margin?: number;
	/** 优先方向：浮出按钮默认上方；调用面板传 below。 */
	prefer?: FloatingPlacement;
}): FloatingPosition {
	const gap = input.gap ?? 6;
	const margin = input.margin ?? 8;
	const width = Math.max(0, input.size.width);
	const height = Math.max(0, input.size.height);
	const viewportWidth = Math.max(0, input.viewport.width);
	const viewportHeight = Math.max(0, input.viewport.height);
	const minTop = margin;
	const maxTop = Math.max(minTop, viewportHeight - margin - height);
	const maxLeft = Math.max(margin, viewportWidth - margin - width);
	const aboveTop = input.anchor.top - gap - height;
	const belowTop = input.anchor.bottom + gap;
	const fitsAbove = aboveTop >= minTop;
	const fitsBelow = belowTop <= maxTop;
	const prefer = input.prefer ?? "above";
	const placement: FloatingPlacement = prefer === "below" ? (fitsBelow || !fitsAbove ? "below" : "above") : fitsAbove ? "above" : "below";
	const rawTop = placement === "above" ? aboveTop : belowTop;
	const anchorWidth = Math.max(0, input.anchor.right - input.anchor.left);
	const centeredLeft = input.anchor.left + (anchorWidth - width) / 2;
	return {
		top: Math.min(Math.max(minTop, rawTop), maxTop),
		left: Math.min(Math.max(margin, centeredLeft), maxLeft),
		placement,
	};
}

/**
 * 应用内「原地工具栏」的宽度（浏览器划词扩展的惯用宽度 ~400px）：
 * 头部一行要同时放下 智能体下拉 / 翻译-问答切换 / 目标语言 / 复制 / 发送 / 关闭，
 * 再窄就会把动作挤成两行或截断智能体名。
 */
export const SELECTION_INLINE_WIDTH = 400;

/** 视口过窄时的下限：工具栏宁可贴满视口（减两侧留白），也不横向溢出到屏幕外。 */
export const SELECTION_INLINE_MIN_WIDTH = 300;

/** 工具栏与视口边缘的最小留白（与 clampFloatingPosition 的 margin 同档）。 */
export const SELECTION_INLINE_MARGIN = 8;

/**
 * 原地工具栏宽度（纯函数）：默认 400px，随视口收窄到可用宽度；
 * 视口比下限还窄时返回可用宽度（可能为 0），调用方由 clampFloatingPosition 兜住定位。
 */
export function resolveSelectionInlineWidth(viewportWidth: number): number {
	const available = Math.max(0, viewportWidth - SELECTION_INLINE_MARGIN * 2);
	const floor = Math.min(SELECTION_INLINE_MIN_WIDTH, available);
	return Math.max(floor, Math.min(SELECTION_INLINE_WIDTH, available));
}

/** 时间线「引用并提问」浮层的矩形形态（top/left/width/height，无 right/bottom）。 */
export type SelectionInlineRect = { top: number; left: number; width: number; height: number };

/**
 * 浮层矩形 → fixed 定位锚点：引用浮层只记宽高，工具栏定位需要四边（right/bottom 由宽高换算）。
 * 同一套换算只写在这里，避免调用点各写一份加减法。
 */
export function toSelectionAnchorRect(rect: SelectionInlineRect): SelectionAnchorRect {
	return { left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height };
}

/** 「翻译 / 问答」切换的标签 key：phase-2 原地工具栏使用 selectionTool.translate / ask（与系统浮窗同文案）。 */
export const SELECTION_INLINE_ACTION_LABEL_KEYS: Record<AgentInvokeAction, TranslationKey> = {
	translate: "selectionTool.translate",
	chat: "selectionTool.ask",
};

/** 目标语言 → i18n key 映射（面板 chips 与翻译指令共用一份，避免两处各写一份顺序/键名）。 */
export const AGENT_TRANSLATE_TARGET_LABEL_KEYS: Record<AgentTranslateTarget, TranslationKey> = {
	auto: "agentInvoke.target.auto",
	"zh-CN": "agentInvoke.target.zh-CN",
	"en-US": "agentInvoke.target.en-US",
	"ja-JP": "agentInvoke.target.ja-JP",
	"ko-KR": "agentInvoke.target.ko-KR",
	"fr-FR": "agentInvoke.target.fr-FR",
	"de-DE": "agentInvoke.target.de-DE",
	"es-ES": "agentInvoke.target.es-ES",
	"ru-RU": "agentInvoke.target.ru-RU",
};

/** 指令语言：跟随界面语言（中文界面给中文指令，其余给英文指令）。 */
export type TranslateInstructionLocale = "zh" | "en";

export type TranslateInstructionInput = {
	action: AgentInvokeAction;
	targetLanguage: AgentTranslateTarget;
	/** 目标语言的本地化名称（渲染层用 t("agentInvoke.target.*") 取；纯函数不碰词典）。 */
	targetLabel: string;
	locale: TranslateInstructionLocale;
};

/**
 * 拼在用户消息末尾的动作指令（主进程原样追加，不做二次本地化）。
 *
 * 边界：这里只能放短指令——长角色设定由主进程按 agentId 从 AgentProfileStore 解析，
 * 渲染层不得传 systemPrompt（AGENTS.md 例外四）。chat 动作不加指令（文本原样交给智能体）。
 */
export function buildTranslateInstruction(input: TranslateInstructionInput): string {
	if (input.action !== "translate") return "";
	if (input.locale === "zh") {
		return input.targetLanguage === "auto" ? "请自动判断语言方向翻译（中文译为英文，其他语言译为中文）。" : `请翻译为${input.targetLabel}。`;
	}
	return input.targetLanguage === "auto" ? "Detect the language and translate (Chinese into English, anything else into Chinese)." : `Translate into ${input.targetLabel}.`;
}
