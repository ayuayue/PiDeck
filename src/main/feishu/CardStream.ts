/**
 * CardStream — 飞书流式卡片（简化版 v2）
 *
 * 放弃 CardKit 2.0 的 cardkit.v1.card.create + cardkit.v1.card.update，
 * 改用 Proma/pi-feishu-lark 的 im.v1.message.patch 方式：
 *
 * 1. im.message.create/reply 发送初始卡片（含 update_multi: true）
 * 2. im.v1.message.patch 原子替换卡片内容
 * 3. 200ms 节流，终态强制 flush
 *
 * 每次 patch 飞书都会立即重新渲染卡片，视觉上是真正的"流式"效果。
 */

import type { LarkClient } from "./types";

const THROTTLE_MS = 200;
const MAX_UPDATE_RETRIES = 2;

export class CardStream {
	private pendingCard: object | null = null;
	private pendingTimer: NodeJS.Timeout | null = null;
	private inFlight: Promise<void> | null = null;
	private closed = false;

	private constructor(
		private readonly client: LarkClient,
		public readonly messageId: string,
		public readonly chatId: string,
	) {}

	/**
	 * 发送初始卡片并返回 CardStream。
	 * 只调用一次 im.message.create/reply，后续更新用 im.v1.message.patch。
	 */
	static async open(
		client: LarkClient,
		chatId: string,
		initialCard: object,
		opts: { replyToMessageId?: string } = {},
	): Promise<CardStream> {
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
			void this.drain();
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
		let attempt = 0;
		while (true) {
			try {
				await this.client.im.v1.message.patch({
					path: { message_id: this.messageId },
					data: { content: JSON.stringify(card) },
				});
				return;
			} catch (err) {
				attempt++;
				if (attempt > MAX_UPDATE_RETRIES) {
					console.error("[飞书 CardStream] patch 失败（已达最大重试）", {
						messageId: this.messageId,
						err: err instanceof Error ? err.message : String(err),
					});
					return;
				}
				await new Promise((r) => setTimeout(r, 200 * attempt));
			}
		}
	}
}
