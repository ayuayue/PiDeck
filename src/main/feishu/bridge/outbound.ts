/**
 * bridge/outbound — 飞书出站消息。
 *
 * 从 FeishuBridge.ts 原样搬出的一域：⚡ 闪电确认、交互卡片、飞书文档创建、
 * 智能文本分诊（chooseMessageMode → text/post/interactive）与它的纯文本兜底。
 *
 * 分诊搬到这里而不是留在宿主，是因为「卡片/富文本被拒后必须退到纯文本」属于
 * 出站语义：卡片权限、30KB 卡片上限、卡片语法变更都会让交互卡片整条发不出去，
 * 而 ai 会话的回复只靠这条通道交付——失败不能只 return false。
 */

import type { ChatMessage } from "../../../shared/types";
import { feishuLanguage, feishuT, type FeishuLocale } from "../FeishuI18n";
import { buildFeishuTextChildren, sanitizeFeishuUserVisibleText, splitDocTextBlocks, stripFeishuActionMarkers } from "../docActions";
import { buildMarkdownCards, buildPostMessages, chooseMessageMode, type FeishuMessageMode } from "../rich-text";
import type { LarkClient } from "../types";
import { logErr } from "./bridgeLog";

/** 协作者对宿主的最小依赖面：连接句柄 + 智能文本出口 + 时间线读取。 */
export type FeishuOutboundHost = {
	client: () => LarkClient | null;
	locale: () => FeishuLocale;
	sendSmartMessage: (chatId: string, text: string) => Promise<boolean>;
	getRuntimeMessages: (sessionId: string) => ChatMessage[];
};

export class FeishuOutbound {
	constructor(private readonly host: FeishuOutboundHost) {}

	// ===== 闪电确认 =====

	/** ⚡ 闪电确认：收到消息后立即 fire-and-forget 一条 text 回复，让用户感知 Bot 已响应 */
	async sendLightningConfirm(chatId: string, replyToMessageId?: string): Promise<void> {
		if (!this.host.client()) return;
		try {
			if (replyToMessageId) {
				await this.host.client()!.im.message.reply({
					path: { message_id: replyToMessageId },
					data: { msg_type: "text", content: JSON.stringify({ text: feishuT(this.host.locale(), "message.received") }) },
				});
			} else {
				await this.host.client()!.im.message.create({
					params: { receive_id_type: "chat_id" },
					data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: feishuT(this.host.locale(), "message.received") }) },
				});
			}
		} catch {
			/* fire-and-forget */
		}
	}

	async sendCardMessage(chatId: string, card: Record<string, unknown>): Promise<void> {
		if (!this.host.client()) return;
		try {
			await this.host.client()!.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) } });
		} catch (e) {
			logErr("[飞书 Bridge] 发送卡片失败:", e);
		}
	}

	// ===== 智能文本分诊 =====

	/**
	 * 按内容选模式发送；返回是否真的送达。
	 *
	 * 卡片/富文本失败时退到纯文本：应用缺卡片权限、卡片超过 30KB、卡片语法变更都会
	 * 让交互卡片整条被拒，而这是 ai 会话回复的主要交付通道——宁可丢格式，不能丢回复。
	 */
	async sendSmartMessage(chatId: string, text: string): Promise<boolean> {
		const client = this.host.client();
		if (!client) return false;
		const mode = chooseMessageMode(text);
		try {
			await this.sendInMode(client, chatId, text, mode);
			return true;
		} catch (e) {
			logErr("[飞书 Bridge] 发送消息失败:", e);
			if (mode === "text") return false;
			return this.sendPlainText(client, chatId, text);
		}
	}

	private async sendInMode(client: LarkClient, chatId: string, text: string, mode: FeishuMessageMode): Promise<void> {
		const language = feishuLanguage(this.host.locale());
		if (mode === "interactive") {
			for (const card of buildMarkdownCards(text, language)) {
				await client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) } });
			}
		} else if (mode === "post") {
			for (const post of buildPostMessages(text, language)) {
				await client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "post", content: JSON.stringify(post) } });
			}
		} else {
			await client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) } });
		}
	}

	/** 纯文本兜底：按段落切片，避免单条超长被拒；仍有失败就返回 false 交给上层。 */
	private async sendPlainText(client: LarkClient, chatId: string, text: string): Promise<boolean> {
		try {
			for (const chunk of splitDocTextBlocks(text, 3000)) {
				await client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: chunk }) } });
			}
			return true;
		} catch (e) {
			logErr("[飞书 Bridge] 纯文本兜底发送失败:", e);
			return false;
		}
	}

	// ===== 文件发送 & 文档创建 =====

	/**
	 * 发送 Agent 回复到飞书，并扫描执行 [SEND_FILE:] / [CREATE_DOC:] 标记。
	 */
	async sendResultFallback(chatId: string, sessionId: string, startTime: number): Promise<void> {
		const messages = this.host.getRuntimeMessages(sessionId);
		const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
		const resultText = lastAssistant?.text ?? "";
		if (!resultText.trim()) return;
		const duration = ((Date.now() - startTime) / 1000).toFixed(1);
		const cleanText = sanitizeFeishuUserVisibleText(resultText);
		if (cleanText) await this.host.sendSmartMessage(chatId, `${cleanText}\n\n${feishuT(this.host.locale(), "result.completed", { duration })}`);
	}

	/**
	 * 创建飞书文档并分享链接到聊天。
	 * 需在飞书开放平台开启 docx:document 权限。
	 */
	async createFeishuDoc(chatId: string, title: string, body = ""): Promise<string> {
		if (!this.host.client()) return feishuT(this.host.locale(), "file.bridgeNotReady");
		try {
			const resp = await this.host.client()!.request<{
				code?: number;
				msg?: string;
				data?: { document?: { document_id?: string; title?: string; url?: string } };
			}>({
				method: "POST",
				url: "https://open.feishu.cn/open-apis/docx/v1/documents",
				data: { title },
			});
			const doc = resp?.data?.document;
			if (!doc?.document_id) {
				logErr("[飞书 Bridge] 创建文档未返回 document_id:", resp);
				return feishuT(this.host.locale(), "doc.createFailed");
			}

			const children = buildFeishuTextChildren(body);
			if (children.length > 0) {
				try {
					await this.host.client()!.request({
						method: "POST",
						url: `https://open.feishu.cn/open-apis/docx/v1/documents/${doc.document_id}/blocks/${doc.document_id}/children`,
						params: { document_revision_id: -1 },
						data: { children, index: 0 },
					});
				} catch (writeError) {
					logErr("[飞书 Bridge] 写入飞书文档正文失败:", writeError);
					const docUrl = doc.url || `https://www.feishu.cn/docx/${doc.document_id}`;
					await this.host.sendSmartMessage(chatId, `📄 **${title}**\n${docUrl}\n\n${feishuT(this.host.locale(), "doc.bodyWriteFailed")}`);
					return feishuT(this.host.locale(), "doc.bodyWriteFailedResult", { title, url: docUrl });
				}
			}

			const docUrl = doc.url || `https://www.feishu.cn/docx/${doc.document_id}`;
			const preview = stripFeishuActionMarkers(body);
			await this.host.sendSmartMessage(chatId, `📄 **${title}**\n${docUrl}${preview ? `\n\n${feishuT(this.host.locale(), "doc.bodyWritten")}` : ""}`);
			return feishuT(this.host.locale(), "doc.created", { title, url: docUrl });
		} catch (e) {
			logErr("[飞书 Bridge] 创建飞书文档失败:", e);
			return feishuT(this.host.locale(), "doc.createFailed");
		}
	}
}
