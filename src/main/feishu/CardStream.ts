/**
 * CardStream — 飞书流式卡片（简化版 v2）
 *
 * 放弃 CardKit 2.0 的 cardkit.v1.card.create + cardkit.v1.card.update，
 * 改用历史飞书桥接实现验证过的 im.v1.message.patch 方式：
 *
 * 1. im.message.create/reply 发送初始卡片（含 update_multi: true）
 * 2. im.v1.message.patch 原子替换卡片内容
 * 3. 200ms 节流，终态强制 flush
 *
 * 每次 patch 飞书都会立即重新渲染卡片，视觉上是真正的"流式"效果。
 */

import type { LarkClient } from "./types";
import { getAppLogger } from "../logging/sharedLogger";

/**
 * 刷新间隔。飞书「更新应用发送的消息卡片」对单条消息限 5 QPS，200ms 正好顶在上限，
 * 一旦碰上重试或网络抖动就会被限流；留一倍余量（2.5 QPS）比追求丝滑更划算——
 * 被限流丢掉的那次往往就是带最终正文的终态更新。
 */
const THROTTLE_MS = 400;
const MAX_UPDATE_RETRIES = 2;
/**
 * 单次更新的卡片体积上限。飞书要求更新后的卡片不超过 30KB，超限直接拒绝；
 * 留 2KB 给转义差异。超限时**主动判失败**，让上层走纯文本补发——
 * 否则卡片永远停在上一版（通常是还没正文的骨架），用户端看不到回答。
 */
export const MAX_CARD_PATCH_BYTES = 28 * 1024;

export class CardStream {
	private pendingCard: object | null = null;
	private pendingTimer: NodeJS.Timeout | null = null;
	private inFlight: Promise<void> | null = null;
	private closed = false;
	/** 最近一次 patch 是否失败（用于上层判断是否需要降级兜底） */
	public lastPatchFailed = false;
	public lastPatchError = "";

	private constructor(
		private readonly client: LarkClient,
		public readonly messageId: string,
		public readonly chatId: string,
	) {}

	/**
	 * 发送初始卡片并返回 CardStream。
	 * 只调用一次 im.message.create/reply，后续更新用 im.v1.message.patch。
	 */
	static async open(client: LarkClient, chatId: string, initialCard: object, opts: { replyToMessageId?: string } = {}): Promise<CardStream> {
		let messageId: string | undefined;

		if (opts.replyToMessageId) {
			const sent = await client.im.message.reply({
				path: { message_id: opts.replyToMessageId },
				data: { msg_type: "interactive", content: JSON.stringify(initialCard) },
			});
			messageId = (sent as { data?: { message_id?: string } })?.data?.message_id;
		} else {
			const sent = await client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(initialCard) },
			});
			messageId = (sent as { data?: { message_id?: string } })?.data?.message_id;
		}

		if (!messageId) {
			throw new Error("发送卡片消息未返回 message_id");
		}

		return new CardStream(client, messageId, chatId);
	}

	/** 排队一次更新，实际请求会在 THROTTLE_MS 后合并发送 */
	update(card: object): void {
		if (this.closed) return;
		this.pendingCard = card;
		this.scheduleFlush();
	}

	/** 立刻刷新到最新 pending 卡片，终态必调 */
	async flush(card?: object): Promise<void> {
		if (this.closed) return;
		if (card) this.pendingCard = card;
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
		await this.drain();
	}

	/** 关闭，禁止后续更新 */
	async close(): Promise<void> {
		this.closed = true;
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
		if (this.inFlight) {
			await this.inFlight.catch(() => {});
		}
	}

	private scheduleFlush(): void {
		if (this.pendingTimer || this.inFlight) return;
		this.pendingTimer = setTimeout(() => {
			this.pendingTimer = null;
			this.drain().catch(() => {
				// 非终态更新失败由 lastPatchFailed 标记记录，
				// 终态 flush 会走 handleAgentEvent 的显式路径
			});
		}, THROTTLE_MS);
		this.pendingTimer.unref?.();
	}

	private async drain(): Promise<void> {
		if (this.inFlight) {
			await this.inFlight.catch(() => {});
		}
		if (!this.pendingCard || this.closed) return;

		const card = this.pendingCard;
		this.pendingCard = null;

		this.inFlight = this.sendUpdate(card).finally(() => {
			this.inFlight = null;
			if (this.pendingCard && !this.closed) {
				this.scheduleFlush();
			}
		});
		await this.inFlight;
	}

	private async sendUpdate(card: object): Promise<void> {
		const content = JSON.stringify(card);
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > MAX_CARD_PATCH_BYTES) {
			this.lastPatchFailed = true;
			this.lastPatchError = `卡片内容 ${bytes} 字节超过 ${MAX_CARD_PATCH_BYTES} 字节上限`;
			getAppLogger()?.error("feishu", "CardStream payload too large", { messageId: this.messageId, bytes, limit: MAX_CARD_PATCH_BYTES });
			throw new Error(`CardStream patch 跳过: ${this.lastPatchError}`);
		}
		let attempt = 0;
		let lastErr: unknown;
		while (true) {
			try {
				const response = await this.client.im.v1.message.patch({
					path: { message_id: this.messageId },
					data: { content },
				});
				// SDK 只把 HTTP 错误变成异常，业务失败是 200 + code≠0；不查 code 会把
				// 「更新被拒」当成功，上层就不会补发纯文本，回复静默丢失。
				const rejected = describePatchRejection(response);
				if (rejected) throw new Error(rejected);
				this.lastPatchFailed = false;
				this.lastPatchError = "";
				return;
			} catch (err) {
				lastErr = err;
				attempt++;
				if (attempt > MAX_UPDATE_RETRIES) {
					const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
					// 尝试提取飞书 API 错误详情
					let apiDetail = "";
					if (lastErr && typeof lastErr === "object" && "code" in (lastErr as Record<string, unknown>)) {
						const e = lastErr as Record<string, unknown>;
						apiDetail = ` [API code=${e.code}, msg=${e.msg}]`;
					}
					this.lastPatchFailed = true;
					this.lastPatchError = errMsg + apiDetail;
					// 终态失败必须落 appLogger（打包版 stdout 不落盘，流式卡片更新静默丢失是
					// 飞书域排障盲区）；console 保留供 dev 终端可见（AGENTS.md 日志规范）。
					getAppLogger()?.error("feishu", "CardStream patch failed after retries", {
						messageId: this.messageId,
						cardSize: JSON.stringify(card).length,
						error: errMsg + apiDetail,
					});
					console.error("[飞书 CardStream] patch 失败（已达最大重试）", {
						messageId: this.messageId,
						cardSize: JSON.stringify(card).length,
						err: errMsg + apiDetail,
					});
					throw new Error(`CardStream patch 失败: ${errMsg}${apiDetail}`);
				}
				getAppLogger()?.warn("feishu", "CardStream patch retry", {
					attempt,
					max: MAX_UPDATE_RETRIES,
					messageId: this.messageId,
					error: lastErr instanceof Error ? lastErr.message : String(lastErr),
				});
				console.warn(`[飞书 CardStream] patch 重试 ${attempt}/${MAX_UPDATE_RETRIES}:`, lastErr instanceof Error ? lastErr.message : String(lastErr));
				await new Promise((r) => setTimeout(r, 200 * attempt));
			}
		}
	}
}

/** 业务失败在响应体里：`{ code, msg }`；`code === 0`（或没有 code 字段）视为成功。 */
function describePatchRejection(response: unknown): string | undefined {
	if (!response || typeof response !== "object") return undefined;
	const { code, msg } = response as { code?: unknown; msg?: unknown };
	if (typeof code !== "number" || code === 0) return undefined;
	return `patch 被拒 code=${code}${typeof msg === "string" && msg ? ` msg=${msg}` : ""}`;
}
