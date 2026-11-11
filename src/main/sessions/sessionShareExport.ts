import type { ChatMessage, ImageContent } from "../../shared/types/session";
import type { SessionShareInventory, SessionShareOptions } from "../../shared/types/sessionExport";
import { createPathMasker, escapeRegExp, redactSecrets } from "../health/redact";
import { renderDshSessionHtml } from "../dsh/dshSessionHtmlExport";

export type SessionShareSource = {
	backend: "pi" | "dsh";
	title: string;
	cwd?: string;
	messages: readonly ChatMessage[];
	truncated: boolean;
};
export type SessionShareCopy = { footer: string; partialNotice: string; warning: string };

/** 工具正文按后端投影字段读取，绝不借用含参数/结果混合文本的 detailText。 */
function toolResult(message: ChatMessage): string {
	if (typeof message.meta?.fullText === "string") return message.meta.fullText;
	if (typeof message.meta?.result === "string") return message.meta.result;
	const separator = message.text.indexOf(": ");
	return separator >= 0 ? message.text.slice(separator + 2) : "";
}

/** 图片是不可自动脱敏的字节；只允许已内联的常见位图，不输出本地 blob ref 或任意 MIME。 */
function exportImages(images: readonly ImageContent[] | undefined): ImageContent[] {
	return (images ?? []).flatMap((image) => (image.data && /^(image\/(png|jpeg|gif|webp))$/i.test(image.mimeType) && /^[A-Za-z0-9+/=\r\n]+$/.test(image.data) ? [{ type: "image" as const, mimeType: image.mimeType, data: image.data }] : []));
}

/** 工作区匹配同时覆盖原路径、正反斜线、JSON 转义与 file URL 表达，先于通用 home 规则运行。 */
function workspaceMasker(cwd: string | undefined, replacement = "[workspace]"): (value: string) => string {
	const root = cwd?.replace(/[\\/]+$/, "");
	if (!root) return (value) => value;
	const variants = new Set([root, root.replace(/\\/g, "/"), root.replace(/\//g, "\\")]);
	for (const variant of [...variants]) {
		variants.add(JSON.stringify(variant).slice(1, -1));
		variants.add(encodeURI(variant));
	}
	const windows = /^[A-Za-z]:|^\\\\/.test(root);
	const pattern = new RegExp(
		`(?:${[...variants]
			.sort((a, b) => b.length - a.length)
			.map(escapeRegExp)
			.join("|")})(?=$|[\\\\/\\s\"'<>),;:\x60?#])`,
		windows ? "gi" : "g",
	);
	return (value) => value.replace(pattern, replacement);
}

/** 从明确的白名单生成一次性副本：原消息/meta/标识永不序列化进产物。 */
export function buildSessionShareHtml(source: SessionShareSource, options: SessionShareOptions, context: { home: string; exportedAt: number; copy: SessionShareCopy }): { html: string; inventory: SessionShareInventory; redactedFields: number } {
	const inventory: SessionShareInventory = { messages: source.messages.length, thinking: 0, toolArguments: 0, toolResults: 0, images: 0, systemMessages: 0, workspace: Boolean(source.cwd) };
	const maskWorkspace = workspaceMasker(source.cwd);
	const maskHome = createPathMasker(context.home);
	const maskHomeVariants = workspaceMasker(context.home, "~");
	let redactedFields = 0;
	const clean = (value: string) => {
		// 文本里也可能嵌入图片字节/标签，不能只清 images 数组后宣称已排除图片。
		let result = options.excludeImages ? value.replace(/!\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]\[[^\]]*\]|<img\b[^>]*>|data:image\/[^\s\"'<>)]*/gi, "") : value;
		if (options.excludeWorkspace || options.redactPaths) result = maskWorkspace(result);
		if (options.redactPaths) result = maskHome(maskHomeVariants(result));
		if (options.redactSecrets) result = redactSecrets(result);
		if (result !== value) redactedFields += 1;
		return result;
	};
	const messages: ChatMessage[] = [];
	for (const message of source.messages) {
		if (message.thinking) inventory.thinking += 1;
		inventory.images += message.images?.length ?? 0;
		if (message.role === "system" || message.role === "error") {
			inventory.systemMessages += 1;
			if (options.excludeSystemMessages) continue;
		}
		const images = options.excludeImages || (message.role === "tool" && options.excludeToolResults) ? [] : exportImages(message.images);
		const output: ChatMessage = { id: "", agentId: "", role: message.role, text: message.role === "tool" ? "" : clean(message.text), timestamp: message.timestamp };
		if (images.length > 0) output.images = images;
		if (!options.excludeThinking && message.thinking) output.thinking = clean(message.thinking);
		if (message.role === "tool") {
			const args = message.meta?.args;
			const result = toolResult(message);
			if (args !== undefined) inventory.toolArguments += 1;
			if (result || message.meta?.status === "done" || message.meta?.status === "error") inventory.toolResults += 1;
			// 两者都不保留时整张工具卡删除，避免 text/detailText 的摘要副本漏出同一数据。
			if (options.excludeToolArguments && options.excludeToolResults && images.length === 0) continue;
			const toolName = clean(typeof message.meta?.toolName === "string" ? message.meta.toolName : "tool");
			output.text = options.excludeToolResults ? "" : clean(result);
			output.meta = { toolName };
			if (!options.excludeToolArguments && args !== undefined) {
				const text = typeof args === "string" ? args : JSON.stringify(args, null, 2);
				if (text) output.meta.args = clean(text);
			}
			// 模板使用这个明确结果槽位，不能把带敏感信息的旧 text 当作 fallback。
			output.meta.exportResult = output.text;
		}
		if (output.role !== "tool" && !output.text.trim() && !output.thinking && !output.images?.length) continue;
		messages.push(output);
	}
	const html = renderDshSessionHtml(messages, {
		title: clean(source.title),
		...(!options.excludeWorkspace && source.cwd ? { cwd: clean(source.cwd) } : {}),
		exportedAt: context.exportedAt,
		footerText: `${context.copy.footer}\n${context.copy.warning}`,
		...(source.truncated ? { partialNotice: context.copy.partialNotice } : {}),
	});
	return { html, inventory, redactedFields };
}
