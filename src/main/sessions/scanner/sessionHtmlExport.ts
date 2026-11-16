import { open as openFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { SessionSummary } from "../../../shared/types";
import { scanJsonlLines } from "../jsonlLineStream";

/** HTML 导出需要的宿主持有面：摘要、宿主路径与文案。 */
export type SessionHtmlExportHost = {
	readSummary(filePath: string): Promise<SessionSummary | null>;
	/** 会话文件本体读写的宿主路径（WSL → UNC 映射）。 */
	hostPathFor(filePath: string): string;
	translate(key: "session.untitled"): string;
	/** 纯文本提取：与会话预览同一口径（sessionNameLine.extractTextFromContent）。 */
	extractText(content: unknown): string;
};

/**
 * 将历史 JSONL 会话直接导出为基础 HTML，WSL 会话经 UNC 走同一条流式导出。
 *
 * 逐行转 HTML 直接落盘，不把整份会话（可能数百 MB）与整份 HTML 同时压在内存里
 * （大会话会撞主进程 384MB 堆上限）。源一律按宿主路径读（WSL → UNC），
 * 导出目标始终落在本机 download 目录，与源环境无关。
 */
export async function exportSessionHtml(host: SessionHtmlExportHost, filePath: string): Promise<{ path: string }> {
	const summary = await host.readSummary(filePath);
	if (!summary) throw new Error("会话文件无法读取");
	const title = summary.name || host.translate("session.untitled");
	const safeName = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "session";
	const targetPath = join(app.getPath("downloads"), `${safeName}-${Date.now()}.html`);
	const head = `<!doctype html><html><head><meta charset=\"utf-8\"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:920px;margin:32px auto;padding:0 20px;color:#1f2937}.msg{border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin:12px 0;background:#fff}.msg h2{margin:0 0 8px;font-size:13px;color:#64748b}.msg pre{white-space:pre-wrap;margin:0;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}</style></head><body><h1>${escapeHtml(title)}</h1><p>${new Date(summary.updatedAt).toLocaleString()} · ${summary.messageCount} messages</p>`;
	const toRow = (line: string): string => {
		try {
			// JSON.parse 本身返回 any；这里不重复标注，消费点各自判空/收窄
			const entry = JSON.parse(line);
			const message = entry?.message ?? entry?.data?.message ?? entry;
			if (!message?.role) return "";
			const text = host.extractText(message.content).trim();
			if (!text) return "";
			return `<section class=\"msg ${escapeHtml(message.role)}\"><h2>${escapeHtml(message.role)}</h2><pre>${escapeHtml(text)}</pre></section>`;
		} catch {
			return "";
		}
	};
	const handle = await openFile(targetPath, "w");
	try {
		await handle.write(head, null, "utf8");
		let batch: string[] = [];
		let batchBytes = 0;
		const flush = async () => {
			if (batch.length === 0) return;
			const payload = batch.join("\n");
			batch = [];
			batchBytes = 0;
			await handle.write(payload, null, "utf8");
		};
		await scanJsonlLines(host.hostPathFor(filePath), async (line) => {
			const row = toRow(line);
			if (!row) return;
			batch.push(row);
			batchBytes += row.length;
			if (batchBytes >= 256 * 1024) await flush();
		});
		await flush();
		await handle.write("</body></html>", null, "utf8");
	} finally {
		await handle.close();
	}
	return { path: targetPath };
}

function escapeHtml(value: string) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}
