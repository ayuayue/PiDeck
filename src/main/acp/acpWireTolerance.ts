/**
 * ACP 线格式宽容层：各 CLI 对 session/update 字段位形的实测偏差收拢于此。
 *
 * 目录（按 CLI 归因，改动前先看对应实测注释）：
 * - parseUsageUpdate：usage_update 字段在顶层或 usage 子对象、cost 是数字或 {amount,currency}
 *   ——opencode/kimi 等非标准但广泛流传的会话用量通知（ACP v1 规范未定义 usage_update，
 *   社区实现先各自为政再互相抄袭，字段位形两代并存）。
 * - readAcpCommandsUpdate：available_commands_update 的命令数组键，规范 SDK 是 commands，
 *   opencode 等实现实际发 availableCommands（2027-02 live smoke 实测）。
 * - readAcpSessionTitle：session_info_update 的标题键 title | sessionTitle 双读
 *   ——实现间遗留两种命名。
 * - readAcpPlanEntries：plan 的条目键 entries | plan 双读。
 *
 * 原则：只做只读兼容，不改出站协议；读不出的字段按缺省处理（不抛错、不告警）。
 * 投影器（AcpEventProjector）是唯一消费方。
 */
import type { PiCommand } from "../../shared/types/app";

/** usage_update 的宽容读取：字段位形在实现间不完全一致（顶层 or usage 子对象）。 */
export type AcpSessionUsage = {
	used?: number;
	size?: number;
	costAmount?: number;
	costCurrency?: string;
};

export function parseUsageUpdate(update: Record<string, unknown>): AcpSessionUsage | undefined {
	const nested = typeof update.usage === "object" && update.usage !== null ? (update.usage as Record<string, unknown>) : undefined;
	const pick = (key: string): unknown => update[key] ?? nested?.[key];
	const used = pick("used");
	const size = pick("size");
	const costRaw = pick("cost");
	let costAmount: number | undefined;
	let costCurrency: string | undefined;
	if (typeof costRaw === "object" && costRaw !== null) {
		const cost = costRaw as Record<string, unknown>;
		if (typeof cost.amount === "number" && Number.isFinite(cost.amount)) costAmount = cost.amount;
		if (typeof cost.currency === "string" && cost.currency) costCurrency = cost.currency;
	} else if (typeof costRaw === "number" && Number.isFinite(costRaw)) {
		costAmount = costRaw;
	}
	const usage: AcpSessionUsage = {};
	if (typeof used === "number" && Number.isFinite(used)) usage.used = used;
	if (typeof size === "number" && Number.isFinite(size) && size > 0) usage.size = size;
	if (costAmount !== undefined) usage.costAmount = costAmount;
	if (costCurrency) usage.costCurrency = costCurrency;
	return usage.used !== undefined || usage.size !== undefined || usage.costAmount !== undefined ? usage : undefined;
}

/** available_commands_update 的命令数组双键读：commands（规范）| availableCommands（opencode 实测）。 */
export function readAcpCommandsUpdate(update: Record<string, unknown>): Array<{ name?: unknown; description?: unknown }> {
	const raw = update.commands ?? update.availableCommands;
	return Array.isArray(raw) ? (raw as Array<{ name?: unknown; description?: unknown }>) : [];
}

/** commands 原始条目 → PiCommand 归一化（name 缺省为空串，description 仅在非空时携带）。 */
export function toAcpCommands(raw: Array<{ name?: unknown; description?: unknown }>): PiCommand[] {
	return raw.map((command) => ({
		name: typeof command?.name === "string" ? command.name : "",
		...(typeof command?.description === "string" && command.description ? { description: command.description } : {}),
		source: "acp",
	}));
}

/** session_info_update 标题双键读（title | sessionTitle）；空串/非字符串视为未提供。 */
export function readAcpSessionTitle(update: Record<string, unknown>): string | undefined {
	const title = update.title ?? update.sessionTitle;
	if (typeof title === "string" && title.trim()) return title.trim();
	return undefined;
}

/** plan 条目双键读（entries | plan）。 */
export function readAcpPlanEntries(update: Record<string, unknown>): Array<{ content?: unknown; status?: unknown }> {
	const raw = update.entries ?? update.plan;
	return Array.isArray(raw) ? (raw as Array<{ content?: unknown; status?: unknown }>) : [];
}
