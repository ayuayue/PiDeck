/**
 * CardStream — 飞书 CardKit 2.0 流式卡片
 *
 * 参考 Proma 的 CardStream 实现：
 * 1. 先用 cardkit.v1.card.create 创建卡片模板
 * 2. 再用 im.message.create/reply 发送卡片消息
 * 3. 后续更新用 cardkit.v1.card.update + sequence 递增
 * 4. 400ms 节流，终态强制 flush
 *
 * 这比 TaskStatusCard 的 im.v1.message.patch 方式更流畅，
 * 因为 CardKit 2.0 支持增量更新，不需要每次发送完整卡片。
 */

import type { LarkClient } from "./types";

const THROTTLE_MS = 400;
const MAX_UPDATE_RETRIES = 2;

export class CardStream {
	private sequence = 1;
	private pendingCard: object | null = null;
	private pendingTimer: NodeJS.Timeout | null = null;
	private inFlight: Promise<void> | null = null;
	private closed = false;

	private constructor(
		private readonly client: LarkClient,
		private readonly cardId: string,
		public readonly messageId: string,
		public readonly chatId: string,
	) {}

	/**
	 * 创建 CardKit 2.0 卡片实例并发送到指定 chat。
	 * 返回的 CardStream 持有 card_id 和 message_id，后续可继续 update。
	 */
	static async open(
		client: LarkClient,
		chatId: string,
		initialCard: object,
		opts: { replyToMessageId?: string } = {},
	): Promise<CardStream> {
		// 1. 创建卡片模板
		const createResp = await client.request<{
			code?: number;
			data?: { card_id?: string };
			msg?: string;
		}>({
			method: "POST",
			url: "https://open.feishu.cn/open-apis/cardkit/v1/card",
			data: { type: "card_json", data: JSON.stringify(initialCard) },
		});

		const cardId = createResp.data?.card_id;
		if (!cardId) {
			throw new Error(`cardkit.card.create 未返回 card_id: ${JSON.stringify(createResp).slice(0, 200)}`);
		}

		// 2. 发送卡片消息
		const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
		let messageId: string | undefined;

		if (opts.replyToMessageId) {
			const sent = await client.im.message.reply({
				path: { message_id: opts.replyToMessageId },
				data: { msg_type: "interactive", content },
			});
			messageId = (sent as { data?: { message_id?: string } })?.data?.message_id;
		} else {
			const sent = await client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: { receive_id: chatId, msg_type: "interactive", content },
			});
			messageId = (sent as { data?: { message_id?: string } })?.data?.message_id;
		}

		if (!messageId) {
			throw new Error("发送 card 消息未返回 message_id");
		}

		return new CardStream(client, cardId, messageId, chatId);
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
		const seq = this.sequence++;

		this.inFlight = this.sendUpdate(card, seq).finally(() => {
			this.inFlight = null;
			if (this.pendingCard && !this.closed) {
				this.scheduleFlush();
			}
		});
		await this.inFlight;
	}

	private async sendUpdate(card: object, sequence: number): Promise<void> {
		let attempt = 0;
		while (true) {
			try {
				await this.client.request({
					method: "PUT",
					url: `https://open.feishu.cn/open-apis/cardkit/v1/card/${this.cardId}`,
					data: {
						card: { type: "card_json", data: JSON.stringify(card) },
						sequence,
					},
				});
				return;
			} catch (err) {
				attempt++;
				if (attempt > MAX_UPDATE_RETRIES) {
					console.error("[飞书 CardStream] cardkit.card.update 失败（已达最大重试）", {
						cardId: this.cardId, sequence,
						err: err instanceof Error ? err.message : String(err),
					});
					return;
				}
				await new Promise((r) => setTimeout(r, 200 * attempt));
			}
		}
	}
}