/**
 * DSH 会话 HTML 导出（G10）：投影式导出。
 *
 * DSH wire 没有 `export_html` RPC（pi 的官方导出），`downloads.sessionLog` 走
 * host-only HTTP 路由且返回 zstd 日志 ZIP（需字节流桥，成本高、非人类可读）。
 * 本模块把已投影的 ChatMessage[] 渲染成**自包含** HTML 文件——纯函数、可单测，
 * 视觉走 dsh-web 设计语言的静态内联等价物（暗色背景分层/边框/文字层级），
 * 不依赖任何外部资源（无 CDN/无字体/无脚本），离线可读。
 */

import type { ChatMessage, ImageContent } from "../../shared/types";

/** 导出元信息（页头展示）。 */
export type DshSessionExportMeta = {
	title: string;
	cwd?: string;
	dshSessionId?: string;
	exportedAt?: number;
};

/** 单张图片内联 data URL 的最大长度（超过则跳过并注明，防超大 HTML）。 */
export const EXPORT_IMAGE_MAX_DATA_URL_CHARS = 8_000_000;

/** HTML 转义（所有用户/模型文本必经，防注入与破坏布局）。 */
export function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 导出文件名安全化：去掉路径分隔符与文件系统非法字符，限长；空则用 fallback。 */
export function sanitizeExportFileName(title: string, fallback: string): string {
	const cleaned = title
		.replace(/[\\/:*?"<>|\r\n\t]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 60);
	// 纯分隔符/空白标题（如 "___"）视为空：回退 fallback，避免生成 "_" 文件名
	const meaningful = cleaned.replace(/_/g, "").trim();
	return `${meaningful ? cleaned : fallback}.html`;
}

/** 段落渲染（围栏外文本）：行内 code + 空行分段 + 换行转 <br>。 */
function renderParagraphs(text: string): string {
	const inlineCoded = text.replace(/`([^`\n]+)`/g, (_match, code: string) => `<code>${code}</code>`);
	return inlineCoded
		.split(/\n{2,}/)
		.map((paragraph) => `<p>${paragraph.replace(/^\n+|\n+$/g, "").replace(/\n/g, "<br>")}</p>`)
		.join("");
}

/**
 * Markdown 极简渲染（导出专用，不引依赖）：
 * - 代码围栏 ```lang ... ``` → <pre><code>（语言标注进 class）
 * - 行内 `code` → <code>
 * - 空行分段 → <p>；单换行 → <br>
 * 其余 Markdown 语法原样转义展示（导出可读性优先，不做完整解析）。
 */
export function renderExportText(value: string): string {
	const escaped = escapeHtml(value);
	// exec 循环配对开闭围栏（split 布局无法区分开闭）；围栏内不做段落/换行处理
	const fenceRe = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```\n?/g;
	let rendered = "";
	let cursor = 0;
	let match: RegExpExecArray | null;
	while ((match = fenceRe.exec(escaped)) !== null) {
		rendered += renderParagraphs(escaped.slice(cursor, match.index));
		const language = match[1] ?? "";
		// 围栏体首尾换行是标记语法的一部分（```\n...\n```），不属代码内容：裁掉
		const body = (match[2] ?? "").replace(/^\n+|\n+$/g, "");
		rendered += `<pre class="code-block"><code${language ? ` class="lang-${escapeHtml(language)}"` : ""}>${body}</code></pre>`;
		cursor = fenceRe.lastIndex;
	}
	rendered += renderParagraphs(escaped.slice(cursor));
	return rendered;
}

/** 用户消息图片（base64 data → 内联 data URL；超限跳过并注明，防超大 HTML）。 */
function renderExportImage(image: ImageContent): string {
	// DSH 会话图片始终带内联字节；缺字节（异常数据）时跳过而不是导出半截 URL
	if (!image.data) return "";
	const dataUrl = `data:${image.mimeType};base64,${image.data}`;
	if (dataUrl.length > EXPORT_IMAGE_MAX_DATA_URL_CHARS) {
		return `<div class="image-skipped">(image omitted: too large for export)</div>`;
	}
	return `<img src="${escapeHtml(dataUrl)}" alt="attached image">`;
}

/** 工具卡视图（role=tool 消息）：工具名 + 参数摘要 + 结果/全文。 */
function renderToolMessage(message: ChatMessage): string {
	const meta = message.meta as Record<string, unknown> | undefined;
	const toolName = typeof meta?.toolName === "string" ? meta.toolName : "tool";
	const status = meta?.status === "running" ? "running" : "done";
	const durationMs = typeof meta?.durationMs === "number" ? meta.durationMs : undefined;
	const args = meta?.args;
	const argsHtml = args !== undefined ? `<details class="tool-args"><summary>arguments</summary><pre>${escapeHtml(typeof args === "string" ? args : JSON.stringify(args, null, 2))}</pre></details>` : "";
	const resultText = message.text.includes(": ") ? message.text.slice(message.text.indexOf(": ") + 2) : "";
	return `<div class="tool-card ${status}">
  <div class="tool-header">
    <span class="tool-name">${escapeHtml(toolName)}</span>
    <span class="tool-status">${status}</span>
    ${durationMs !== undefined ? `<span class="tool-duration">${durationMs}ms</span>` : ""}
  </div>
  ${argsHtml}
  <div class="tool-result">${renderExportText(resultText || message.text)}</div>
</div>`;
}

/** 单条消息 → HTML（role 分派）。 */
function renderMessage(message: ChatMessage): string {
	const time = new Date(message.timestamp).toLocaleString();
	const images = (message.images ?? []).map(renderExportImage).join("");
	switch (message.role) {
		case "user":
			return `<div class="msg user">
  <div class="msg-meta"><span class="role-badge user">user</span><span class="time">${escapeHtml(time)}</span></div>
  <div class="msg-body">${renderExportText(message.text)}${images}</div>
</div>`;
		case "tool":
			return `<div class="msg tool"><div class="msg-meta"><span class="role-badge tool">tool</span><span class="time">${escapeHtml(time)}</span></div><div class="msg-body">${renderToolMessage(message)}</div></div>`;
		case "assistant":
			return `<div class="msg assistant">
  <div class="msg-meta"><span class="role-badge assistant">assistant</span><span class="time">${escapeHtml(time)}</span></div>
  ${message.thinking ? `<details class="thinking"><summary>thinking</summary><div class="thinking-body">${renderExportText(message.thinking)}</div></details>` : ""}
  <div class="msg-body">${renderExportText(message.text)}</div>
</div>`;
		default:
			// system/error：低调展示原文（错误消息保留排查价值）
			return `<div class="msg ${message.role}"><div class="msg-meta"><span class="role-badge">${escapeHtml(message.role)}</span><span class="time">${escapeHtml(time)}</span></div><div class="msg-body">${renderExportText(message.text)}</div></div>`;
	}
}

/** 导出样式：dsh-web 视觉语言的静态内联等价物（暗色分层/边框/文字层级）。 */
const EXPORT_CSS = `
:root {
  color-scheme: dark;
  --bg-1: #0d0f14;
  --bg-2: #131620;
  --bg-3: #1a1e2c;
  --border: #262b3d;
  --border-2: #333a52;
  --text-1: #e8eaf2;
  --text-2: #9aa1b5;
  --text-3: #6b7288;
  --brand: #4d7cfe;
  --success: #34d399;
  --warn: #fbbf24;
  --error: #f87171;
  --code-bg: #171a26;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg-1);
  color: var(--text-1);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  line-height: 1.6;
}
.page { max-width: 860px; margin: 0 auto; padding: 32px 20px 80px; }
.header { padding: 20px 0 24px; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
.header h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
.header .sub { color: var(--text-2); font-size: 13px; display: flex; gap: 16px; flex-wrap: wrap; }
.msg { margin: 0 0 20px; }
.msg-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.role-badge {
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  background: var(--bg-3); color: var(--text-2); border: 1px solid var(--border);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.role-badge.user { color: var(--brand); border-color: var(--brand); }
.role-badge.assistant { color: var(--success); border-color: var(--success); }
.role-badge.tool { color: var(--warn); border-color: var(--warn); }
.time { color: var(--text-3); font-size: 12px; }
.msg-body { color: var(--text-1); word-break: break-word; }
.msg-body p { margin: 0 0 10px; }
.msg-body img { max-width: 100%; border-radius: 8px; margin: 8px 0; }
.image-skipped { color: var(--text-3); font-size: 12px; padding: 6px 0; }
code {
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, monospace;
  font-size: 0.9em;
}
p code { background: var(--code-bg); padding: 1px 6px; border-radius: 4px; }
pre.code-block {
  background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px;
  padding: 12px 14px; overflow-x: auto; margin: 10px 0; font-size: 13px; line-height: 1.55;
}
.thinking { margin: 8px 0; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
.thinking summary { cursor: pointer; padding: 8px 12px; color: var(--text-2); font-size: 13px; user-select: none; }
.thinking-body { padding: 4px 14px 12px; color: var(--text-2); font-size: 13px; }
.tool-card { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); overflow: hidden; }
.tool-card.running { border-color: var(--brand); }
.tool-header { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.tool-name { font-weight: 600; font-size: 13px; font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, monospace; }
.tool-status { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--bg-3); color: var(--text-3); }
.tool-status.running { color: var(--brand); }
.tool-duration { font-size: 12px; color: var(--text-3); margin-left: auto; }
.tool-result { padding: 10px 12px; font-size: 13px; color: var(--text-2); }
.tool-result p { margin: 0 0 8px; }
.tool-args summary { cursor: pointer; padding: 6px 12px; font-size: 12px; color: var(--text-3); }
.tool-args pre { margin: 0; padding: 0 12px 10px; font-size: 12px; color: var(--text-2); overflow-x: auto; }
.footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--text-3); font-size: 12px; }
`;

/** 全量渲染：messages → 自包含 HTML 文档。 */
export function renderDshSessionHtml(messages: ChatMessage[], meta: DshSessionExportMeta): string {
	const exportedAt = new Date(meta.exportedAt ?? Date.now()).toLocaleString();
	const subItems = [meta.dshSessionId ? `session ${escapeHtml(meta.dshSessionId)}` : "", meta.cwd ? `workspace ${escapeHtml(meta.cwd)}` : "", `exported ${escapeHtml(exportedAt)}`].filter(Boolean);
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<div class="page">
  <header class="header">
    <h1>${escapeHtml(meta.title)}</h1>
    <div class="sub">${subItems.map((item) => `<span>${item}</span>`).join("")}</div>
  </header>
  <main>${messages.map(renderMessage).join("\n")}</main>
  <footer class="footer">Exported from PiDeck (DeepSeek Harness session)</footer>
</div>
</body>
</html>
`;
}
