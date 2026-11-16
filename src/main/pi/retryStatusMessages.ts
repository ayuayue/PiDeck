import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../../shared/types";

/**
 * 自动重试状态卡域的窄接口：只列卡片写入用到的消息列表与发车回调，不新增状态。
 *
 * `messages` 与 `retryStatusMessageIds` 由宿主持有并按引用传入——后者在 clearAgentState（生命周期清理）
 * 与 addDetailedErrorMessage（失败留痕）里同样被读写，搬进本域只会把同一份状态藏一层。
 */
export interface RetryStatusMessagesHost {
	readonly messages: Map<string, ChatMessage[]>;
	readonly retryStatusMessageIds: Map<string, string>;
	scheduleMessageEmit(agentId: string, immediate?: boolean): void;
}

/**
 * 自动重试状态卡域（拆分第十一刀）：`auto_retry_start` / `auto_retry_end` 的卡片 upsert。
 *
 * 一次重试周期一张卡：已收敛（success/error）的卡片不再被下一轮改写，
 * 否则时间线上永远只剩最后一条「正在自动重试」。宿主保留同名薄包装（调用点不变）。
 */
export class RetryStatusMessages {
	constructor(private readonly host: RetryStatusMessagesHost) {}

	/** 宿主字段别名：搬出的实现保持 `this.<字段>` 原样（契约测试按此形态断言）。 */
	private get messages() {
		return this.host.messages;
	}

	private get retryStatusMessageIds() {
		return this.host.retryStatusMessageIds;
	}

	private get scheduleMessageEmit() {
		return this.host.scheduleMessageEmit;
	}

	/**
	 * 当前「进行中」的重试状态卡 id（仅 status=running 算数）。
	 * 一次重试周期一张卡：已收敛成 success/error 的卡片不允许再被下一轮重试改写，
	 * 否则时间线上永远只剩最后一条「正在自动重试」，用户看不出到底重试过几次（用户反馈）。
	 * 同一周期内的后续事件（延迟变化等）仍会复用这张运行中卡片。
	 */
	activeRetryStatusMessageId(agentId: string): string | undefined {
		const messageId = this.retryStatusMessageIds.get(agentId);
		if (!messageId) return undefined;
		const message = this.messages.get(agentId)?.find((item) => item.id === messageId);
		return message?.meta?.status === "running" ? messageId : undefined;
	}

	upsertRetryStatusMessage(agentId: string, event: Record<string, unknown>, status: "running" | "success" | "error") {
		const list = this.messages.get(agentId) ?? [];
		// 只复用仍在推进的卡片；已收敛（成功/失败）的卡片保持原样，本轮新建一张。
		let messageId = this.activeRetryStatusMessageId(agentId);
		let message = messageId ? list.find((item) => item.id === messageId) : undefined;
		if (!message) {
			messageId = randomUUID();
			message = {
				id: messageId,
				agentId,
				role: "system",
				text: "",
				timestamp: Date.now(),
			};
			list.push(message);
			this.retryStatusMessageIds.set(agentId, messageId);
		}

		const attempt = Number(event.attempt ?? message.meta?.attempt ?? 0);
		const maxAttempts = Number(event.maxAttempts ?? message.meta?.maxAttempts ?? 0);
		const delayMs = Number(event.delayMs ?? 0);
		const reasonValue = event.errorMessage ?? event.finalError ?? message.meta?.errorMessage;
		const reason = reasonValue == null ? "" : String(reasonValue);
		const delaySeconds = Math.ceil(delayMs / 1000);
		const delayText = delayMs > 0 ? `，${delaySeconds} 秒后重试` : "";
		const countText = maxAttempts > 0 ? `${attempt}/${maxAttempts}` : String(attempt || 1);
		const params = {
			attempt,
			count: countText,
			delaySeconds,
		};
		let i18nKey: string;

		if (status === "running") {
			i18nKey = delayMs > 0 ? "diagnostic.retryScheduledAfterDelay" : "diagnostic.retryScheduled";
			message.text = `正在自动重试 ${countText}${delayText}`;
		} else if (status === "success") {
			i18nKey = "diagnostic.retrySucceeded";
			message.text = `自动重试成功，共重试 ${attempt} 次`;
		} else {
			i18nKey = "diagnostic.retryFailed";
			message.text = `自动重试失败，已重试 ${countText} 次`;
		}
		message.timestamp = Date.now();
		message.meta = {
			status,
			attempt,
			maxAttempts,
			delayMs,
			errorMessage: reason,
			i18nKey,
			i18nParams: params,
			...(reason && status !== "success" ? { debugDetails: reason } : {}),
		};

		this.messages.set(agentId, list);
		this.scheduleMessageEmit(agentId, true);
	}
}
