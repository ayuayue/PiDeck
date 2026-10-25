import type { MainProcessTranslationKey } from "./i18n/mainProcessCopy";
import { mainProcessT } from "./i18n/mainProcessCopy";
import { isFileChangeToolName } from "./fileChanges.ts";

/**
 * 工具卡展开区文案（PI / DSH 共用）：整理成「工具 / 状态 / 参数 / 结果」写入 meta.detailText。
 * 渲染层 getToolDetailText 优先读这段字；主进程投影时按当前 locale 烘焙，不随语言切换重算。
 */

/** 单段 args/result/details 与整段 detailText 的首尾截断上限（与历史 PI 投影器同值）。 */
export const TOOL_DETAIL_MAX_CHARS = 8000;

/**
 * 文件类工具的 args 上限。
 *
 * 为什么单独一档（2027-02 实测）：write/edit 的 args 里带着被写文件的完整内容 /
 * 变动区域，首尾截断会把中间插进「已省略 N 字符」提示——JSON 从此不可解析，
 * 渲染层 getToolDiffTarget 取不到 file_path，该文件从「修改的文件」清单里整个消失
 * （本机 60 个会话实测丢 5.0%，213/4221，全部是 >8000 的 write/edit）。
 * 这类调用只占全部工具调用的 0.4%、平均 1886 字节，放开后一个显示窗口
 * （9 轮 / 1200 条目上限）的 args 合计也就 1MB 量级——远小于 result 的 10MB。
 * 上限仍保留，只挡异常巨型参数（整目录灌入、base64 内嵌），避免真被撑爆。
 */
export const TOOL_ARGS_FILE_CHANGE_MAX_CHARS = 1_000_000;

/**
 * 工具参数序列化为 meta.args 的统一入口（实时 upsert 与历史投影共用）。
 *
 * 文件类工具（write/edit/create/patch）用远高一档的上限，保证 JSON 可解析、
 * 「修改的文件」清单在实时与重开历史时都不会漏文件；其余工具维持 8000 截断
 * （bash/read/grep 的 args 只是命令行或路径，截断不影响功能）。
 */
export function serializeToolArgsForDelivery(toolName: string, args: unknown, translate: ToolDetailTranslate): string {
	const maxChars = isFileChangeToolName(toolName) ? TOOL_ARGS_FILE_CHANGE_MAX_CHARS : TOOL_DETAIL_MAX_CHARS;
	return truncateForDetail(safeJson(args), translate, maxChars);
}

export type ToolDetailTranslate = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

/**
 * detailText 里的状态段取真实运行态，而不是「有没有 isError」的二值：
 * 工具运行中就烘焙「运行中」，否则 start→end 之间（子进程还没吐过 stdout 时无 update 事件）
 * 展开区会一直印着「完成」，用户会把还在跑的长任务（如重定向到日志的 e2e）读成已结束（2026-10 实测误读）。
 */
export type ToolDetailStatus = "running" | "done" | "error";

/** 投影器未注入 translate 时的兜底（中文）；装配层应传入当前主进程 locale。 */
export function defaultToolDetailTranslate(key: MainProcessTranslationKey, params?: Record<string, string | number>): string {
	return mainProcessT("zh-CN", key, params);
}

export function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/**
 * 从 pi 风格 result.content[].text 抽出正文；纯字符串（DSH textFromBlocks）原样返回。
 */
export function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const text = (item as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractToolDetails(result: unknown): unknown {
	if (!result || typeof result !== "object") return undefined;
	return (result as { details?: unknown }).details;
}

function extractRawCommand(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || !("command" in args)) return undefined;
	const command = args.command;
	return typeof command === "string" ? command : undefined;
}

/**
 * pi 0.99 起工具结果自带截断信息（bash / powershell 输出 >1 MiB 时，pi 只给
 * 模型保留尾部窗口）：result.details.truncation（truncatedBy / totalLines /
 * totalBytes）与 result.details.fullOutputPath，模型可见文本尾部也带
 * "[Showing lines X-Y of N ... Full output: <path>]"。
 *
 * PiDeck 把它单独下发（meta.resultTruncation），渲染层给出可操作的完整路径提示，
 * 与自身展示层截断（meta.truncated → 「查看完整输出」读会话文件）区分开：
 * 后者丢的只是展示字节，前者丢的是 pi 没进上下文的内容。
 */
export type PiToolTruncation = {
	truncatedBy?: string;
	totalLines?: number;
	totalBytes?: number;
	fullOutputPath?: string;
};

export function extractPiToolTruncation(result: unknown): PiToolTruncation | undefined {
	if (!result || typeof result !== "object") return undefined;
	// 运行期/历史投影的 result 都把原始 details 挂在 result.details；无 details 包装时
	// （DSH 平铺结果）退回顶层查找，保持单一口径。
	const details = (result as { details?: unknown }).details;
	const source: Record<string, unknown> = details && typeof details === "object" ? (details as Record<string, unknown>) : (result as Record<string, unknown>);
	const truncation = source.truncation;
	if (!truncation || typeof truncation !== "object") return undefined;
	const t = truncation as Record<string, unknown>;
	const fullOutputPath = typeof source.fullOutputPath === "string" && source.fullOutputPath ? source.fullOutputPath : typeof t.fullOutputPath === "string" && t.fullOutputPath ? t.fullOutputPath : undefined;
	return {
		truncatedBy: typeof t.truncatedBy === "string" ? t.truncatedBy : undefined,
		totalLines: typeof t.totalLines === "number" ? t.totalLines : undefined,
		totalBytes: typeof t.totalBytes === "number" ? t.totalBytes : undefined,
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
}

/** 对超长工具文本做首尾截断，保留头部和尾部以兼顾开头信息和错误堆栈。 */
export function truncateForDetail(text: unknown, translate: ToolDetailTranslate, maxChars = TOOL_DETAIL_MAX_CHARS): string {
	// safeJson/extractToolResultText 在某些输入下可能返回 undefined（如 JSON.stringify(undefined)），
	// 必须在此归一化为字符串，否则后续 .length 访问会抛 TypeError 导致主进程未捕获异常弹窗。
	const str = typeof text === "string" ? text : text == null ? "" : String(text);
	if (str.length <= maxChars) return str;
	const keep = Math.floor(maxChars / 2);
	const omitted = str.length - keep * 2;
	return `${str.slice(0, keep)}\n` + `${translate("mainTool.truncated", { omitted, total: str.length })}\n` + str.slice(-keep);
}

/**
 * 与 truncateForDetail 同规则的整体截断，但额外返回是否截断与原始长度，
 * 供下发 meta 标记 truncated/fullLength（渲染层据此提供「查看完整输出」按需加载入口）。
 */
export function truncateDetailWithMeta(text: string, translate: ToolDetailTranslate, maxChars = TOOL_DETAIL_MAX_CHARS): { text: string; truncated: boolean; fullLength: number } {
	if (text.length <= maxChars) {
		return { text, truncated: false, fullLength: text.length };
	}
	const keep = Math.floor(maxChars / 2);
	const omitted = text.length - keep * 2;
	return {
		text: `${text.slice(0, keep)}\n` + `${translate("mainTool.truncated", { omitted, total: text.length })}\n` + text.slice(-keep),
		truncated: true,
		fullLength: text.length,
	};
}

/**
 * 把一次工具调用整理成工具卡展开区可读文案。
 * args 在 end/update 事件里可能已是序列化字符串，先反解再 stringify，避免二次编码。
 */
export function formatToolDetail(toolName: string, args: unknown, result: unknown, status: ToolDetailStatus, translate: ToolDetailTranslate): string {
	const details = extractToolDetails(result);
	let argsObj = args;
	if (typeof args === "string" && args.trim()) {
		try {
			argsObj = JSON.parse(args) as unknown;
		} catch {
			// truncated/不可解析时保持原样
		}
	}
	const argsText = argsObj ? truncateForDetail(safeJson(argsObj), translate) : "";
	const rawCommand = toolName.trim().toLowerCase() === "bash" ? extractRawCommand(argsObj) : undefined;
	const commandText = rawCommand === undefined ? "" : truncateForDetail(rawCommand, translate);
	const resultText = result ? truncateForDetail(extractToolResultText(result) || safeJson(result), translate) : "";
	const detailsText = details ? truncateForDetail(safeJson(details), translate) : "";
	const statusText = translate(status === "error" ? "mainTool.failed" : status === "running" ? "mainTool.running" : "mainTool.done");
	const argsSection = args ? (rawCommand !== undefined ? translate("mainTool.command", { command: commandText }) : translate("mainTool.arguments", { value: argsText })) : "";
	const sections = [translate("mainTool.name", { name: toolName || "tool" }), translate("mainTool.status", { status: statusText }), argsSection, result ? translate("mainTool.result", { value: resultText }) : "", details ? translate("mainTool.details", { value: detailsText }) : ""].filter(Boolean);
	return sections.join("\n\n");
}
