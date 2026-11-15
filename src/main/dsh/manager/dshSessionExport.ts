import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ToolDetailTranslate } from "../../../shared/formatToolDetail";
import type { ChatMessage } from "../../../shared/types";
import type { DshEnvelope, DshHistoryPage, DshRemoteClient } from "../dshRemoteClient";
import { collectDshExportMessages, DSH_EXPORT_MESSAGES_CODES, DshExportMessagesError, type DshExportMessagesCollection } from "../dshExportMessages";
import { renderDshSessionHtml, sanitizeExportFileName } from "../dshSessionHtmlExport";
import type { DshAgentRuntime } from "./dshAgentRuntime";
import { hydrateDshImageRefs } from "./dshImageHydration";

/**
 * 会话 HTML 导出（G10：投影式导出，DSH wire 无 export_html）的宿主出口：
 * runtime 查表、host 拉起、历史分页入口与导出目录/词典注入留在 DshAgentManager。
 */
export type DshSessionExportHost = {
	getRuntime(agentId: string): DshAgentRuntime;
	ensureClient(): Promise<DshRemoteClient>;
	historyPage(sessionId: string, options?: { beforeSeq?: number; maxMessages?: number }): Promise<DshEnvelope<DshHistoryPage>>;
	getExportDir(): string;
	readonly translate: ToolDetailTranslate;
	/** 只读导出源（宿主方法）：导出入口经它取历史，保持调用方原有的可替换接缝。 */
	readSessionExportMessages(dshSessionId: string, options: { includeImages: boolean }): Promise<{ messages: ChatMessage[]; truncated: boolean }>;
};

/** 活跃会话也从持久化历史分页读取，不能把运行时尾部窗口当成完整历史。 */
export async function exportDshAgentHtml(host: DshSessionExportHost, agentId: string): Promise<{ path: string; truncated: boolean }> {
	const runtime = host.getRuntime(agentId);
	const dshSessionId = String(runtime.sessionId);
	const collection = await host.readSessionExportMessages(dshSessionId, { includeImages: true });
	return writeSessionHtmlExport(host, collection, { title: runtime.tab.title, cwd: runtime.cwd, dshSessionId });
}

/** 历史完整导出与安全分享共用只读来源；完整导出默认回填图片。 */
export async function exportDshSessionHtml(host: DshSessionExportHost, dshSessionId: string, title: string, cwd?: string): Promise<{ path: string; truncated: boolean }> {
	const collection = await host.readSessionExportMessages(dshSessionId, { includeImages: true });
	return writeSessionHtmlExport(host, collection, { title, cwd, dshSessionId });
}

/** 只读导出源：全段单次投影保留工具全文，不做白名单过滤或脱敏。 */
export async function readDshSessionExportMessages(host: DshSessionExportHost, dshSessionId: string, options: { includeImages: boolean }): Promise<{ messages: ChatMessage[]; truncated: boolean }> {
	const client = await host.ensureClient().catch(() => {
		throw new DshExportMessagesError(DSH_EXPORT_MESSAGES_CODES.readFailed);
	});
	const collection = await collectDshExportMessages({
		agentId: `dsh:${dshSessionId}`,
		historyPage: (beforeSeq, maxMessages) => host.historyPage(dshSessionId, { beforeSeq, maxMessages }),
	});
	return options.includeImages ? { ...collection, messages: await hydrateDshImageRefs(client, dshSessionId as SessionId, collection.messages) } : collection;
}

/** 渲染 + 落盘；预算截断必须同时保留返回标志和 HTML 可见提示。 */
async function writeSessionHtmlExport(host: DshSessionExportHost, collection: DshExportMessagesCollection, meta: { title: string; cwd?: string; dshSessionId: string }): Promise<{ path: string; truncated: boolean }> {
	const dir = host.getExportDir();
	if (!dir) throw new Error("session export is not configured");
	const partialNotice = collection.truncated ? host.translate("sessionShare.partialNotice") : undefined;
	if (collection.truncated && !partialNotice?.trim()) throw new Error("DSH_EXPORT_PARTIAL_NOTICE_UNAVAILABLE");
	const html = renderDshSessionHtml(collection.messages, { ...meta, ...(partialNotice ? { partialNotice } : {}) });
	await mkdir(dir, { recursive: true });
	const fileName = sanitizeExportFileName(meta.title, meta.dshSessionId);
	const filePath = join(dir, fileName);
	await writeFile(filePath, html, "utf8");
	return { path: filePath, truncated: collection.truncated };
}
