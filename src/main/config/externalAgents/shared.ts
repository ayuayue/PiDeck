/**
 * 外部 Agent 配置发现：共享解析 helper（各 agent 模块复用）。
 * 边界见 externalAgentDiscovery.ts 头注释：只读、key 只回掩码。
 */
import { readFile, stat as statFile } from "node:fs/promises";

/** 每个候选最多带出的建议模型数：有的 agent（网关型）配了几百个模型，全量导入只会把供应商列表撑爆。 */
export const MAX_SUGGESTED_MODELS = 20;

/** 读取文件上限：agent 配置都是小文件，超限视为异常内容直接放弃。 */
export const MAX_AGENT_CONFIG_BYTES = 2 * 1024 * 1024;

/** key 掩码：保留前缀 4 + 后缀 4，中间折叠；过短的 key 整体折叠避免泄露。 */
export function maskKey(key: string): string {
	if (key.length <= 8) return "•".repeat(key.length);
	return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** 截断建议模型列表（保留前 MAX_SUGGESTED_MODELS 个，顺序即对方的声明顺序）。 */
export function limitModelIds(ids: string[]): string[] {
	return ids.slice(0, MAX_SUGGESTED_MODELS);
}

/** 判定 key 是否「占位值」：本机网关工具（magpie 等）写入的是固定伪 key，导入无意义。 */
export function isPlaceholderKey(key: string): boolean {
	// magpie 网关约定 key 固定为 "magpie"；同类工具也用短常量占位。真实 API key 没有这么短的。
	return key.length < 12 || key === "magpie" || /^(test|dummy|placeholder|your[-_]?key)$/i.test(key);
}

/** 读小文件的统一入口：不存在/读失败/超上限返回 undefined（静默跳过）。
 *  先 stat 再读——agent 配置偶有异常大文件（日志误放、符号链接），超限直接放弃，避免整块读入主进程内存。
 */
export async function readSmallFile(path: string): Promise<string | undefined> {
	try {
		const stat = await statFile(path);
		if (!stat.isFile() || stat.size > MAX_AGENT_CONFIG_BYTES) return undefined;
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

export function parseJson(text: string): Record<string, unknown> | undefined {
	if (text.length > MAX_AGENT_CONFIG_BYTES) return undefined;
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string" && item.length > 0) out[key] = item;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 从任意嵌套对象里按路径取子对象（不存在/类型不符返回 undefined）。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/** pi 供应商名安全化：小写、非法字符折叠为 '-'，空则给 fallback。 */
export function safeProviderName(raw: string, fallback: string): string {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return cleaned || fallback;
}

/** host 名建议供应商名：从 baseUrl 提取 hostname（去 www 前缀）。 */
export function hostNameFromUrl(baseUrl: string, fallback: string): string {
	try {
		return safeProviderName(new URL(baseUrl).hostname.replace(/^www\./, ""), fallback);
	} catch {
		return fallback;
	}
}

/**
 * 跨 agent 的供应商名去重器：同名追加 -2/-3 后缀。
 */
export function createNameUniquer() {
	const used = new Set<string>();
	return (raw: string, fallback: string): string => {
		let name = safeProviderName(raw, fallback);
		let suffix = 2;
		while (used.has(name)) {
			const next = `${name}-${suffix}`;
			suffix += 1;
			if (next.length > 60) name = `${name.slice(0, 55)}-${suffix}`;
			else name = next;
		}
		used.add(name);
		return name;
	};
}
