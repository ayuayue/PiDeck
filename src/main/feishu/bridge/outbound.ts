/**
 * bridge/outbound — 飞书出站消息里「不经过智能文本分诊」的那几条通道。
 *
 * 从 FeishuBridge.ts 原样搬出的一域：⚡ 闪电确认、交互卡片、飞书文档创建、
 * 卡片降级时的纯文本补发。
 *
 * 智能文本分诊（chooseMessageMode → text/post/interactive）与它的送达结果语义仍在宿主，
 * 因为同步去重依赖真实结果决定是否记指纹。
 */

import type { ChatMessage } from "../../../shared/types";
import { feishuT, type FeishuLocale } from "../FeishuI18n";
import { buildFeishuTextChildren, sanitizeFeishuUserVisibleText, stripFeishuActionMarkers } from "../docActions";
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
