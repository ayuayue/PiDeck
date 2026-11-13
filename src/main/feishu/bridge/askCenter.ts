/**
 * bridge/askCenter — 飞书端 ask/confirm 问答（extension_ui_request）。
 *
 * 从 FeishuBridge.ts 原样搬出的一域：pi 发出 extension_ui_request 后阻塞等待回答，
 * 飞书端渲染提问卡片并登记待答记录，按钮回调与纯文本回复都从这里写回 pi。
 *
 * 待答表本身留在宿主（解绑/断开要在同一处释放），这里只按窄接口读写它。
 */

import { buildAskCard, normalizeAskOption, parseAskActionValue, parseAskInputValue, tryParseBatchAskEnvelope, type AskOption, type AskUiRequest } from "../AskCard";
import type { FeishuCardActionEvent } from "../types";
import { feishuT, type FeishuLocale } from "../FeishuI18n";
import { logErr } from "./bridgeLog";

/** 飞书端待回答的 ask/confirm 请求（pi 发 extension_ui_request 后阻塞等待，必须有人回答）。 */
export type PendingAsk = {
	requestId: string;
	agentId: string;
	method: "select" | "confirm" | "input" | "editor" | "batch_ask";
	title: string;
	chatId: string;
	askedAt: number;
	/** select 的选项列表（卡片编号与此一致），供纯数字文本回复映射选项值。 */
	options?: AskOption[];
};

/** 类型守卫：extension_ui_request 的 method 是否属于可回答的对话类方法。 */
function isAskMethod(value: string): value is "select" | "confirm" | "input" | "editor" {
	return value === "select" || value === "confirm" || value === "input" || value === "editor";
}

/** 协作者对宿主的最小依赖面：待答表 + 出站消息 + pi 回答通道。 */
export type FeishuAskCenterHost = {
	locale: () => FeishuLocale;
	getBestChatId: (sessionOrAgentId: string) => string | undefined;
	sendSmartMessage: (chatId: string, text: string) => Promise<boolean>;
	sendCardMessage: (chatId: string, card: Record<string, unknown>) => Promise<void>;
	sendUIResponse: (agentId: string, requestId: string, response: { value?: string | boolean; confirmed?: boolean; cancelled?: boolean }) => void;
	pendingAsks: Map<string, PendingAsk>;
};

export class FeishuAskCenter {
	constructor(private readonly host: FeishuAskCenterHost) {}

	// ===== ask/confirm 扩展 UI 请求（飞书端问答） =====

	/**
	 * pi 发出 extension_ui_request（ask_question/confirm 等）后阻塞等待回答：
	 * 飞书端渲染提问卡片（选项按钮/确认按钮/回复文本提示），并登记 pendingAsks 供按钮回调与文本回复命中。
	 * 未绑定飞书时直接忽略——桌面端弹窗会兜底回答。
	 */
	handleRequest(agentId: string, typed: Record<string, unknown>): void {
		const rawMethod = String(typed.method ?? "");
		const requestId = String(typed.id ?? "");
		// 边界校验：只处理需要用户回答的对话类方法，notify/setWidget 等纯通知不占飞书卡片
		if (!requestId || !isAskMethod(rawMethod)) return;
		const method = rawMethod;
		const chatId = this.host.getBestChatId(agentId);
		if (!chatId) return;

		const rawTitle = String(typed.title ?? typed.question ?? "");
		const batchEnvelope = tryParseBatchAskEnvelope(rawTitle);
		// 兼容桌面端约定：✎ 开头的“自定义回答”选项只对桌面端生效，飞书端直接回复文本即可，剔除之
		const rawOptions = Array.isArray(typed.options)
			? typed.options.map(normalizeAskOption).filter((option): option is NonNullable<ReturnType<typeof normalizeAskOption>> => {
					if (!option) return false;
					const label = typeof option === "string" ? option : option.label;
					return !label.startsWith("✎");
				})
			: undefined;
		// select 无有效选项时降级为 input（与桌面端 handleUIRequest 同一规则）：
		// ask_question 的 options 可选，模型经常只问问题不给选项，降级后用户仍可回复文本作答
		const effectiveMethod: AskUiRequest["method"] = method === "select" && (!rawOptions || rawOptions.length === 0) ? "input" : method;

		const request: AskUiRequest = batchEnvelope
			? {
					requestId,
					method: "batch_ask",
					title: "",
					batchQuestions: batchEnvelope.questions,
				}
			: {
					requestId,
					method: effectiveMethod,
					title: rawTitle,
					options: rawOptions,
				};

		const key = `${chatId}:${requestId}`;
		if (this.host.pendingAsks.has(key)) return;
		this.host.pendingAsks.set(key, {
			requestId,
			agentId,
			method: request.method,
			title: request.title,
			chatId,
			askedAt: Date.now(),
			// 保存选项供「回复纯数字」映射选项值（与卡片编号列表一致）
			options: request.method === "select" ? request.options : undefined,
		});
		void this.host.sendCardMessage(chatId, buildAskCard({ request, locale: this.host.locale() })).catch((e) => logErr("[飞书 Bridge] ask 卡片发送失败:", e));
	}

	/** 飞书 input 组件提交回调：把输入文本作为待答 ask 的回答写回 pi。 */
	async handleInputSubmit(event: FeishuCardActionEvent, answer: string): Promise<void> {
		const pending = this.pendingForChat(event.chatId);
		if (!pending || pending.method === "confirm" || pending.method === "batch_ask") {
			// 无对应待答 ask（已超时/已处理）或 confirm/batch 不支持输入框，提示即可
			await this.host.sendSmartMessage(event.chatId, feishuT(this.host.locale(), "ask.expired"));
			return;
		}
		this.host.sendUIResponse(pending.agentId, pending.requestId, { value: answer });
		this.host.pendingAsks.delete(`${event.chatId}:${pending.requestId}`);
		await this.host.sendSmartMessage(event.chatId, feishuT(this.host.locale(), "ask.answeredInput", { answer }));
	}

	/** 查找某 chat 最早的待答 ask（同一 chat 同时至多一个，按时间取首个防异常态）。 */
	pendingForChat(chatId: string): PendingAsk | undefined {
		let earliest: PendingAsk | undefined;
		for (const pending of this.host.pendingAsks.values()) {
			if (pending.chatId !== chatId) continue;
			if (!earliest || pending.askedAt < earliest.askedAt) earliest = pending;
		}
		return earliest;
	}

	/** 清理某 agent 的所有待答 ask（agent 结束/新任务开始时调用，避免幽灵按钮）。 */
	clearForAgent(agentId: string): void {
		for (const [key, pending] of this.host.pendingAsks) {
			if (pending.agentId === agentId) this.host.pendingAsks.delete(key);
		}
	}

	/** 飞书卡片按钮回调：把选项/确认/取消写回 pi，并移除待答记录。 */
	async handleCardAction(event: FeishuCardActionEvent, action: NonNullable<ReturnType<typeof parseAskActionValue>>): Promise<void> {
		const key = `${event.chatId}:${action.requestId}`;
		const pending = this.host.pendingAsks.get(key);
		if (!pending) {
			// 超时/已处理：桌面端 sendUIResponse 已清理 pendingUIRequests，这里只提示不报错
			await this.host.sendSmartMessage(event.chatId, feishuT(this.host.locale(), "ask.expired"));
			return;
		}

		let response: { value?: string; confirmed?: boolean; cancelled?: boolean };
		let feedback: string;
		if (action.kind === "confirm") {
			response = { confirmed: action.confirmed };
			feedback = action.confirmed ? feishuT(this.host.locale(), "ask.confirmed") : feishuT(this.host.locale(), "ask.rejected");
		} else if (action.kind === "cancel") {
			response = { cancelled: true };
			feedback = feishuT(this.host.locale(), "ask.cancelled");
		} else {
			response = { value: action.option };
			feedback = feishuT(this.host.locale(), "ask.answered", { answer: action.option });
		}

		this.host.sendUIResponse(pending.agentId, pending.requestId, response);
		this.host.pendingAsks.delete(key);
		await this.host.sendSmartMessage(event.chatId, feedback);
	}
}
