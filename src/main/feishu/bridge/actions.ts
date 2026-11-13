/**
 * bridge/actions — Agent 回复里的飞书动作标记扫描（[SEND_FILE:] / [CREATE_DOC:]）。
 *
 * 从 FeishuBridge.ts 原样搬出的一域：显式标记优先，未命中时只在用户明确要求发送文件
 * 的前提下自动探测回复中提到的本地文件（前 3 个）。
 */

import type { ChatMessage } from "../../../shared/types";
import { hasExplicitFeishuFileSendIntent } from "../fileIntent";
import { feishuT, type FeishuLocale } from "../FeishuI18n";
import { log } from "./bridgeLog";

/** 协作者对宿主的最小依赖面：文件/文档出口 + 智能文本出口。 */
export type FeishuActionsHost = {
	locale: () => FeishuLocale;
	sendSmartMessage: (chatId: string, text: string) => Promise<boolean>;
	sendFeishuFile: (chatId: string, filePath: string, fileName?: string) => Promise<string>;
	createFeishuDoc: (chatId: string, title: string, body?: string) => Promise<string>;
};

export class FeishuActions {
	constructor(private readonly host: FeishuActionsHost) {}

	/** 宿主入口：扫描并执行回复里的 [SEND_FILE:] / [CREATE_DOC:] 标记。 */
	processReplyActions(chatId: string, messages: ChatMessage[]): Promise<void> {
		return this.processFeishuActions(chatId, messages);
	}

	/**
	 * 扫描 Agent 回复中的 [SEND_FILE:] / [CREATE_DOC:] 标记并执行飞书操作。
	 * 如果没有标记，自动检测回复中是否提到了工作目录下的文件并尝试发送。
	 */
	private async processFeishuActions(chatId: string, messages: ChatMessage[]): Promise<void> {
		const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
		const text = lastAssistant?.text ?? "";
		if (!text) return;
		const userText = [...messages].reverse().find((m) => m.role === "user")?.text ?? "";
		const canSendFile = hasExplicitFeishuFileSendIntent(userText);

		// 1. 显式 [SEND_FILE:path] 标记
		const sendMatch = text.match(/\[SEND_FILE:([^\]]+)\]/);
		if (sendMatch) {
			const filePath = sendMatch[1].trim();
			if (!canSendFile) {
				log(`[飞书 Bridge] 忽略 SEND_FILE：用户未明确要求发送文件: ${filePath}`);
			} else {
				log(`[飞书 Bridge] 检测到 SEND_FILE: ${filePath}`);
				const result = await this.host.sendFeishuFile(chatId, filePath);
				log(`[飞书 Bridge] SEND_FILE 结果: ${result}`);
				await this.host.sendSmartMessage(chatId, result);
			}
		} else if (canSendFile) {
			// 2. 无显式标记 → 自动检测 Agent 回答中提到的文件并发送（前 3 个）
			const { existsSync } = await import("node:fs");
			const pathPattern = /(?:保存到|已生成|文件在|输出到|写入|created|saved to|written to)[：:\s]*([^\s，,\n""<>]{5,200}\.(?:md|txt|csv|json|html|pdf|png|jpg|xlsx|docx|pptx|py|ts|js))/gi;
			const autoFiles: string[] = [];
			let m: RegExpExecArray | null;
			while ((m = pathPattern.exec(text)) !== null) {
				const fp = m[1].trim();
				if (fp && existsSync(fp) && !autoFiles.includes(fp)) autoFiles.push(fp);
			}
			if (autoFiles.length > 0) {
				log(`[飞书 Bridge] 自动检测到 ${autoFiles.length} 个文件: ${autoFiles.join(", ")}`);
				for (const fp of autoFiles.slice(0, 3)) {
					const result = await this.host.sendFeishuFile(chatId, fp);
					log(`[飞书 Bridge] 自动发送文件结果: ${result}`);
					await this.host.sendSmartMessage(chatId, result);
				}
			}
		}
		const docMatch = text.match(/\[CREATE_DOC:([^\]]+)\]/);
		if (docMatch) {
			const title = docMatch[1].trim() || feishuT(this.host.locale(), "doc.defaultTitle");
			const result = await this.host.createFeishuDoc(chatId, title, text);
			// createFeishuDoc 内部失败时发了消息，这里补充发送
			if (result.startsWith("❌")) await this.host.sendSmartMessage(chatId, result);
		}
	}
}
