/**
 * 输入预测（prompt suggestion）的跨进程契约。
 *
 * 语义：每个会话回合结束（agent_end）后，主进程用「本轮对话的有界正文快照」做一次
 * 一次性补全，预测用户接下来最可能输入的那一句；渲染层把它画在空输入框里，Tab / → 采纳。
 *
 * 与提示词增强的区别只在提示词与触发方式：同一条 sidecar 协议、同一个单飞语义，
 * 但必须**独立服务实例**（新 run 打断旧 run，共用实例会让预测打断增强）。
 * 事件形状与 enhance 完全一致（按 runId 配对），直接复用 EnhanceEventPayload。
 */

import type { EnhanceContextMessage } from "./enhance";

/** 预测结果的渲染层硬上限：一句话足够，过长按字符截断（不切断代理对）。 */
export const PROMPT_SUGGESTION_MAX_CHARS = 200;

/**
 * 发起一次预测。渲染层不传 userText / systemPrompt：
 * - userText 由主进程填固定触发句（渲染层无权决定模型收到的指令）；
 * - systemPrompt 只有主进程内置模板（与智能体同一收口原则）。
 */
export type PromptSuggestionRunInput = {
	provider: string;
	modelId: string;
	/** 本轮对话的有界正文快照（user/assistant 正文，不含思考/工具/附件）。 */
	context: EnhanceContextMessage[];
};

/** run 受理结果：失败分类沿用 enhance 的错误枚举，渲染层静默处理（后台功能不 toast）。 */
export type PromptSuggestionRunResult = { ok: true; runId: string } | { ok: false; errorKind: import("./enhance").EnhanceErrorKind; message: string };
