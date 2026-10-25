import type { AgentUiBatchQuestion, AgentUiResponse } from "../../shared/types";

/**
 * DSH 审批/提问桥的纯函数层（无副作用，可单测）。
 *
 * DSH 的 mux 流会推送两类 server-request 帧（稳定 rpcId）：
 * - approval/requested：工具调用需要用户批准（approvalId 关联 host 侧审计）
 * - question/requested：批量提问（AskUserQuestionItem[]）
 *
 * PiDeck 侧把它们映射成 agents:ui-request 通道的 confirm / batch_ask 请求
 * （渲染层复用现有 Ask 弹窗链路），应答再反向构造 DSH client-response。
 */

/** DSH approval/requested 帧的字段形状（防御性收窄）。 */
export type DshApprovalFrame = {
	requestId: string;
	sessionId: string;
	approvalId: string;
	toolName?: string;
	reason?: string;
};

/** DSH question/requested 帧的字段形状。 */
export type DshQuestionFrame = {
	requestId: string;
	sessionId: string;
	questions: DshQuestionItem[];
};

/** DSH AskUserQuestionItem 的最小形状（options 可选）。 */
export type DshQuestionItem = {
	id: string;
	question: string;
	detail?: string;
	header?: string;
	options?: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQuestionItem(value: unknown): value is DshQuestionItem {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || typeof value.question !== "string") return false;
	return true;
}

/** 校验并收窄 approval/requested 帧；形状不符返回 undefined（泵侧静默跳过）。 */
export function parseDshApprovalFrame(frame: { rpcId?: unknown; payload?: unknown } | undefined): DshApprovalFrame | undefined {
	const payload = frame?.payload;
	if (!isRecord(payload)) return undefined;
	const requestId = typeof frame?.rpcId === "string" ? frame.rpcId : "";
	const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
	const approvalId = typeof payload.approvalId === "string" ? payload.approvalId : "";
	if (!requestId || !sessionId || !approvalId) return undefined;
	return {
		requestId,
		sessionId,
		approvalId,
		toolName: typeof payload.toolName === "string" ? payload.toolName : undefined,
		reason: typeof payload.reason === "string" ? payload.reason : undefined,
	};
}

/** 校验并收窄 question/requested 帧；至少一个问题才有效。 */
export function parseDshQuestionFrame(frame: { rpcId?: unknown; payload?: unknown } | undefined): DshQuestionFrame | undefined {
	const payload = frame?.payload;
	if (!isRecord(payload)) return undefined;
	const requestId = typeof frame?.rpcId === "string" ? frame.rpcId : "";
	const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
	if (!requestId || !sessionId || !Array.isArray(payload.questions)) return undefined;
	const questions = payload.questions.filter(isQuestionItem);
	if (questions.length === 0) return undefined;
	return { requestId, sessionId, questions };
}

/** DSH 提问 → PiDeck 批量提问（confirm 无选项时降级为 confirm 类型按钮）。 */
export function batchQuestionsFromDsh(items: DshQuestionItem[]): AgentUiBatchQuestion[] {
	return items.map((item) => {
		// DSH 的 select 问题必须带 options 才能渲染选项；无 options 降级 confirm
		// （用户确认/拒绝），避免渲染成空选项的 select。
		// multiSelect 必须映射成 multi_select：渲染层的多选题不自动前进（见
		// shouldAutoAdvanceBatchAnswer），若降级成 select，末题一勾选就会立刻提交全部，
		// 用户来不及勾第二项（DSH 会话实测问题）。
		const type: AgentUiBatchQuestion["type"] = item.options?.length ? (item.multiSelect ? "multi_select" : "select") : item.multiSelect ? "select" : "confirm";
		const options = item.options?.length
			? item.options.map((option) => ({
					label: option.label,
					...(option.description ? { description: option.description } : {}),
				}))
			: undefined;
		return {
			id: item.id,
			type,
			question: item.question,
			...(options ? { options } : {}),
		};
	});
}

/** approval 请求 → PiDeck confirm 请求（标题带工具名与原因，用户可见）。 */
export function approvalUiRequest(frame: DshApprovalFrame, agentId: string): Record<string, unknown> {
	const tool = frame.toolName ?? "tool";
	return {
		agentId,
		requestId: frame.requestId,
		method: "confirm",
		title: frame.reason ? `${tool}: ${frame.reason}` : tool,
	};
}

/** question 请求 → PiDeck batch_ask 请求。 */
export function questionUiRequest(frame: DshQuestionFrame, agentId: string): Record<string, unknown> {
	return {
		agentId,
		requestId: frame.requestId,
		method: "batch_ask",
		title: "",
		batchQuestions: batchQuestionsFromDsh(frame.questions),
	};
}

/**
 * 构造「用户取消/停止」时的拒绝应答载荷（abort/stop 解阻塞 pending 帧用，D1）：
 * - approval → outcome: "rejected"（host 侧工具调用以拒绝收尾）
 * - question → 空答案数组（用户未作答）
 * 与 buildDshRespondValue 的 allowed-once/answered 分支互补。
 */
export function buildDshRejectValue(frame: DshApprovalFrame | DshQuestionFrame): Record<string, unknown> {
	if ("approvalId" in frame) {
		return {
			sessionId: frame.sessionId,
			approvalId: frame.approvalId,
			outcome: "rejected",
		};
	}
	return { sessionId: frame.sessionId, answer: { answers: [] } };
}

/**
 * 构造 DSH client-response 的应答载荷（result.value 槽）：
 * - approval → { sessionId, approvalId, outcome: "allowed-once" | "rejected" }
 * - question → { sessionId, answer: { answers: [{ id, selected, custom? }] } }
 * 返回 undefined 表示应答无法解析（调用方按拒绝处理或忽略）。
 */
export function buildDshRespondValue(frame: DshApprovalFrame | DshQuestionFrame, response: AgentUiResponse): Record<string, unknown> | undefined {
	if ("approvalId" in frame) {
		const outcome = response.confirmed === true ? "allowed-once" : "rejected";
		return {
			sessionId: frame.sessionId,
			approvalId: frame.approvalId,
			outcome,
		};
	}
	// question：渲染层 serializeBatchAnswers 提交 { answers: [{ id, type, value, label, wasCustom }] }
	const raw = typeof response.value === "string" ? response.value : "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.answers)) return undefined;
	const answers = parsed.answers
		.filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.id === "string")
		.map((item) => {
			const value = item.value;
			// 单选/多选：selected 传用户选中的 label；自定义文本走 custom 槽。
			// 多选（multi_select）的值是数组，必须整组透传，否则勾选的选项会被丢成空数组。
			if (Array.isArray(value)) {
				return { id: item.id as string, selected: value.filter((entry): entry is string => typeof entry === "string") };
			}
			if (typeof value === "string") {
				if (item.wasCustom === true) {
					return { id: item.id as string, selected: [], custom: value };
				}
				return { id: item.id as string, selected: [value] };
			}
			// 布尔（confirm 型）：label 是 "true"/"false"
			if (typeof value === "boolean") {
				return { id: item.id as string, selected: [value ? "true" : "false"] };
			}
			return { id: item.id as string, selected: [] };
		});
	return { sessionId: frame.sessionId, answer: { answers } };
}
