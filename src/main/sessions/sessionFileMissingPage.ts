import type { SessionMessagePage } from "../../shared/types";

/**
 * 会话文件不存在时的空页判定。
 *
 * 为什么需要专态而不是直接 reject：新建会话（尤其是微信/飞书桥在第一条消息之前建好的会话）
 * 在 pi 首次写入前根本没有文件，而会话记录已经可以点开——按普通读取失败处理会让用户看到
 * 「会话历史加载失败 + ENOENT: no such file or directory」，把「还没有内容」报成故障，
 * 并把人引向「文件被删/路径失效」的错误方向（2026-10 微信 /new 会话反馈）。
 *
 * 只认「文件不存在（ENOENT/ENOTDIR）」这一种可解释原因：其余错误（权限、解析、损坏）
 * 继续由调用方抛出，保留明确的失败反馈（2026-08 生图会话缺文件结论）。
 */
export function missingSessionFilePage(error: unknown): SessionMessagePage | null {
	const code = (error as { code?: unknown } | null)?.code;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (code !== "ENOENT" && code !== "ENOTDIR" && !/\bENOENT\b|\bENOTDIR\b/.test(message)) return null;
	return { messages: [], total: 0, nextBefore: null, unavailable: "file-missing" };
}
