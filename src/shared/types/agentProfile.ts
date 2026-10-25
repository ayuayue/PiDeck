/**
 * 智能体（Agent Market）的跨进程契约。
 *
 * 智能体是 PiDeck 层的「提示词预设」：名称 / 简介 / 图标 / 分类 / 角色设定 / 可选模型。
 * 运行时语义分两条，边界见 AGENTS.md「提示词增强侧车」例外四：
 * - 一次性调用（划词工具、市场面板）：主进程按 agentId 取出角色设定，走提示词增强侧车
 *   同一套「一次性补全」通道；渲染层只能传 agentId，不能直接传 systemPrompt。
 * - 发送到会话：渲染层新建会话，把角色设定经 SendPromptInput.agentMessage 隐藏通道注入，
 *   对话正文仍只显示用户原文（agentMessage 对 pi 整体替换 message，对 UI 不可见）。
 */

import type { AgentBackend } from "./agent";
import type { EnhanceErrorKind } from "./enhance";

/** 市场分类：只影响列表筛选与卡片分组，不参与任何运行时行为。 */
export type AgentProfileCategory = "general" | "translation" | "writing" | "coding" | "analysis";

/** 分类的展示顺序（渲染层筛选器与编辑器下拉共用，避免两处各写一份顺序）。 */
export const AGENT_PROFILE_CATEGORIES: readonly AgentProfileCategory[] = ["general", "translation", "writing", "coding", "analysis"];

/** 一次性调用动作：v1 只做翻译；chat = 把文本原样交给智能体处理。 */
export type AgentInvokeAction = "translate" | "chat";

/** 翻译目标语言；auto = 中英自动换向（中文 → 英文，其余 → 中文）。 */
export type AgentTranslateTarget = "auto" | "zh-CN" | "en-US" | "ja-JP" | "ko-KR" | "fr-FR" | "de-DE" | "es-ES" | "ru-RU";

export const AGENT_TRANSLATE_TARGETS: readonly AgentTranslateTarget[] = ["auto", "zh-CN", "en-US", "ja-JP", "ko-KR", "fr-FR", "de-DE", "es-ES", "ru-RU"];

export type AgentModelRef = { provider: string; modelId: string };

/**
 * 智能体可指定的会话后端（「使用」新建会话时的后端）。
 * 一次性划词调用始终走 pi 模型目录（侧车是 pi ModelRuntime，DSH 模型是 host route），
 * 因此这里只开放两个对话后端；imagegen/videogen 没有提示词 agent 语义，acp 需要用户点选外部 CLI。
 */
export type AgentProfileBackend = Extract<AgentBackend, "pi" | "dsh">;

/** 编辑器里可选的智能体后端（顺序即展示顺序；缺省 = 跟随设置里的默认后端）。 */
export const AGENT_PROFILE_BACKENDS: readonly AgentProfileBackend[] = ["pi", "dsh"];

export type AgentProfile = {
	id: string;
	name: string;
	/** 市场卡片第二行，一句话说明能做什么。 */
	description: string;
	/** 卡片图标：单个 emoji；空串由渲染层回退为机器人图标。 */
	icon: string;
	/** 角色设定 / 系统提示词：一次性调用作为 system 消息，发送到会话作为 agentMessage 前缀。 */
	systemPrompt: string;
	/** 首选模型；缺省 = 跟随当前会话 / 设置链（与提示词增强同一优先级，见 shared/enhanceModelPreference）。 */
	model?: AgentModelRef;
	/** 「使用」新建会话时的 agent 后端；缺省 = 跟随设置里的默认后端。 */
	backend?: AgentProfileBackend;
	category: AgentProfileCategory;
	/** 内置智能体：不可删除，可编辑、可恢复内置原文。 */
	builtin?: boolean;
	createdAt: number;
	updatedAt: number;
	/** 一次性调用次数（市场卡片「已使用 N 次」）。 */
	usageCount: number;
	lastUsedAt?: number;
};

/** 内置翻译智能体的稳定 id：智能体种子、划词工具默认值、内置重置都按这个键定位。 */
export const BUILTIN_TRANSLATE_AGENT_ID = "builtin-translate";

/**
 * PiDeck 相关内置智能体的稳定 id（发布后不可改）：
 * - 小助手：产品功能/使用/开发/FAQ 的入门顾问
 * - 问题诊断：定位故障、读诊断报告/日志、整理可提交的 Issue
 * - 插件开发：宿主插件（Host Plugin）从脚手架到打包发布
 */
export const BUILTIN_PIDECK_HELPER_AGENT_ID = "builtin-pideck-helper";
export const BUILTIN_PIDECK_DIAGNOSTIC_AGENT_ID = "builtin-pideck-diagnostic";
export const BUILTIN_PIDECK_PLUGIN_DEV_AGENT_ID = "builtin-pideck-plugin-dev";

/** 字段上限：编辑器、IPC 边界、存储归一化共用同一组常量，避免三处漂移。 */
export const AGENT_PROFILE_NAME_MAX_CHARS = 60;
export const AGENT_PROFILE_DESCRIPTION_MAX_CHARS = 300;
export const AGENT_PROFILE_ICON_MAX_CHARS = 16;
export const AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS = 16_000;
export const AGENT_INVOKE_TEXT_MAX_CHARS = 16_000;
export const AGENT_INVOKE_INSTRUCTION_MAX_CHARS = 500;

/** 市场全局设置：划词工具开关、默认智能体与会话绑定（存 agent-profiles.json，与智能体同一次写入）。 */
export type AgentMarketSettings = {
	/** 应用内划词：关闭后渲染层不再监听划选、也不显示浮出按钮。 */
	selectionToolEnabled: boolean;
	/** 系统级划词（全局快捷键 + 独立浮窗）：默认开，受快捷键冲突/平台能力影响时可关。 */
	systemSelectionEnabled: boolean;
	/** 划词工具默认智能体；null / 指向已删除的智能体时回退内置翻译智能体。 */
	selectionToolAgentId: string | null;
	/**
	 * 会话 → 智能体绑定（sessionId → agentId）。
	 * 「使用」智能体时写入；绑定的会话每次发送都会由主进程把角色设定拼进
	 * SendPromptInput.agentMessage（对 UI 隐藏），因此对话时间线只显示用户输入。
	 */
	sessionAgentBindings: Record<string, string>;
};

/** agentProfiles:bind-session 入参：agentId=null 表示解除绑定。 */
export type BindAgentSessionInput = { sessionId: string; agentId: string | null };

export type AgentProfileSnapshot = {
	revision: number;
	agents: AgentProfile[];
	settings: AgentMarketSettings;
	/** 用户拖拽出的展示顺序（只存 id）；空数组 = 未自定义 = 按默认规则排序。 */
	agentOrder: string[];
};

export type CreateAgentProfileInput = {
	name: string;
	description?: string;
	icon?: string;
	systemPrompt: string;
	category?: AgentProfileCategory;
	model?: AgentModelRef;
	backend?: AgentProfileBackend;
};

export type UpdateAgentProfileInput = Partial<CreateAgentProfileInput>;
/** 设置 patch：会话绑定只能经 bindSession 改（避免一次 settings 保存误覆盖全部绑定）。 */
export type UpdateAgentMarketSettingsInput = Partial<Omit<AgentMarketSettings, "sessionAgentBindings">>;
export type AgentChangedEvent = { revision: number };

/**
 * 一次性调用入参（渲染层 → 主进程）。
 *
 * model 必须是渲染层已解析好的 provider/modelId（解析链复用 resolveEnhanceTargetModel：
 * 智能体模型 > 当前会话模型 > 设置 > 引导页偏好），主进程只校验形态，不再查设置。
 */
export type AgentInvokeInput = {
	agentId: string;
	/** 待处理文本（划词选中文本或面板输入）。 */
	text: string;
	action?: AgentInvokeAction;
	/** 仅 action=translate 时生效；缺省 auto。 */
	targetLanguage?: AgentTranslateTarget;
	/** 动作附加指令：渲染层按当前 locale 生成，主进程只做长度校验后拼到用户消息末尾。 */
	instruction?: string;
	model: AgentModelRef;
};

/** 一次调用的状态流转：受理 → 流式增量 → 终态（done / error / aborted）。 */
export type AgentInvokeEventPayload = { runId: string; phase: "started" } | { runId: string; phase: "delta"; text: string } | { runId: string; phase: "done"; text: string } | { runId: string; phase: "aborted" } | { runId: string; phase: "error"; errorKind: EnhanceErrorKind; message: string };

/** agentProfiles:invoke 的返回：受理后事件经 agentProfiles:invoke-event 推送（按 runId 配对）。 */
export type AgentInvokeResult = { ok: true; runId: string } | { ok: false; errorKind: EnhanceErrorKind; message: string };

/** 内置智能体判定（市场 UI 用来禁用删除 / 显示徽标）。 */
export function isBuiltinAgent(profile: AgentProfile): boolean {
	return profile.builtin === true;
}
