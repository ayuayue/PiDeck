import { stripHostInstruction } from "../feishu/docActions";

/**
 * 自动/兜底标题的清洗：把宿主注入的通道指令从标题里剥掉。
 *
 * 为什么需要：微信/飞书桥把「当前会话已连接微信…」这类指令拼在用户消息前面发给 pi，指令因此
 * 写进会话文件；pi 侧的命名扩展读到的是带指令的原文，于是侧栏标题可能变成整段指令
 * （2026-10 现场：标题 = 指令正文 + 用户原话）。中间层已经把指令从展示文本里剥掉了，
 * 标题是另一个出口，这里再剥一次兜底任何来源（扩展命名、扫描兜底、后续新通道）。
 *
 * 纯函数：剥掉后为空（整条消息只有指令）时返回空串，调用方应忽略这个标题。
 */
export function sanitizeAutomaticTitle(title: string): string {
	return stripHostInstruction(title).replace(/\s+/g, " ").trim();
}
