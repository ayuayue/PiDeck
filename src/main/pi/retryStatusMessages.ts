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
 * 进行中的周期一张卡；成功描述符留给 renderer 的 toast 扫描，下一周期淘汰，失败保留。
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

	/**
	 * 当前「进行中」的重试状态卡 id（仅 status=running 算数）。
	 * 同一周期的后续事件（延迟变化等）复用运行卡；失败卡不可被下一周期改写。
	 */
	activeRetryStatusMessageId(agentId: string): string | undefined {
		const messageId = this.retryStatusMessageIds.get(agentId);
		if (!messageId) return undefined;
		const message = this.messages.get(agentId)?.find((item) => item.id === messageId);
		return message?.meta?.status === "running" ? messageId : undefined;
	}

	upsertRetryStatusMessage(agentId: string, event: Record<string, unknown>, status: "running" | "success" | "error") {
		let list = this.messages.get(agentId) ?? [];
		let messageId = this.activeRetryStatusMessageId(agentId);
		let message = messageId ? list.find((item) => item.id === messageId) : undefined;
		// 成功消息驱动 toast，不能提前删掉；新周期用新 id，既避免签名去重吞 toast，
		// 又把成功消息数量限制为一张。失败诊断仍保留供排障。
		if (!message) list = list.filter((item) => item.meta?.i18nKey !== "diagnostic.retrySucceeded");
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
			message.text = `自动重试成功，共重试 ${countText} 次`;
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
			...(reason ? { debugDetails: reason } : {}),
		};

		this.messages.set(agentId, list);
		this.host.scheduleMessageEmit(agentId, true);
	}
}
