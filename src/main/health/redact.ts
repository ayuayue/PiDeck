/**
 * 诊断报告脱敏纯函数。
 *
 * 为什么独立成纯函数模块而不放在调用方里：
 * 诊断报告天生要离开用户机器（发群、贴 GitHub Issue、贴给 AI），一旦漏掉 API Key、
 * home 路径或邮箱就是不可逆泄露。把脱敏做成纯函数 + 单测，是唯一能把「不泄露」
 * 从「希望如此」变成「合并门禁」的手段，不能依赖每个调用点自觉。
 *
 * 设计原则：**宁可多脱敏，不可少脱敏**。报告里少一个路径不影响排障，多一个 Key 就是事故。
 */

export const REDACTED = "[redacted]";
export const REDACTED_EMAIL = "[email]";
export const REDACTED_PHONE = "[phone]";
export const REDACTED_USER = "<user>";
export const REDACTED_HOME = "~";

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 生成一个把 home 目录替换成 `~` 的路径脱敏器。
 *
 * 为什么用工厂而不是全局常量：home 只在主进程运行期可知（app.getPath("home")，
 * WSL 场景还会切到主机 home），纯函数必须把 home 显式传入才能单测。
 */
export function createPathMasker(home: string): (value: string) => string {
	const rules: Array<{ pattern: RegExp; replacement: string }> = [];
	const normalizedHome = typeof home === "string" ? home.trim() : "";
	if (normalizedHome) {
		// home 是权威来源：整段替换为 ~，连用户名也不保留。
		rules.push({
			pattern: new RegExp(escapeRegExp(normalizedHome), "gi"),
			replacement: REDACTED_HOME,
		});
	}
	// 兜底：日志与堆栈里可能夹着其他用户目录（WSL 的 /home/<name>、用户手动复制的别人路径），
	// 这些不在 home 精确匹配范围内，但同样属于隐私，只保留用户名以外的骨架。
	rules.push({
		pattern: /([A-Za-z]:[\\/]Users[\\/])[^\\/\s"'<>|?*]+/gi,
		replacement: `$1${REDACTED_USER}`,
	});
	rules.push({
		pattern: /(^|[^\w])\/Users\/[^/\s"'<>|?*]+/g,
		replacement: `$1/Users/${REDACTED_USER}`,
	});
	rules.push({
		pattern: /([\\/]home[\\/])[^\\/\s"'<>|?*]+/gi,
		replacement: `$1${REDACTED_USER}`,
	});
	return (value: string) => {
		if (typeof value !== "string" || !value) return "";
		return rules.reduce((acc, rule) => acc.replace(rule.pattern, rule.replacement), value);
	};
}

/**
 * 凭据清洗规则。顺序有意义：先处理带前缀的 token（更具体），
 * 再处理 `key: value` / `key=value` 这类结构化字段，最后才是邮箱/手机号。
 */
const SECRET_RULES: Array<{ pattern: RegExp; replacement: string | ((...args: string[]) => string) }> = [
	// Authorization 头：Bearer / Basic 后面的整串凭据
	{ pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${REDACTED}` },
	// 各家 API Key 的固定前缀形态
	{ pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: `sk-${REDACTED}` },
	{ pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: REDACTED },
	{ pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: REDACTED },
	{ pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: REDACTED },
	{ pattern: /\bAIza[A-Za-z0-9_-]{20,}/g, replacement: REDACTED },
	// 结构化字段：JSON 的 "apiKey": "xxx"、命令行 --token=xxx、日志 token=xxx
	// 先处理 JSON 引号包裹的键（"key": "value" 或 "key": value），再处理裸键。
	// 值要求至少 1 个字符：`"token": ""` 这种空占位符无需替换，避免无意义噪音；
	// catch-all 排除引号，避免 `""`/`''` 空串被当作裸值二次命中。
	{
		pattern: /"([^"]*(?:api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|authorization|cookie|private[-_]?key|credential)[^"]*)"\s*:\s*("(?:[^"\\]|\\.)+"|'[^']+'|[^\s"',;)}\]]+)/gi,
		replacement: (_match, key: string, value: string) => `"${key}": ${value.startsWith('"') || value.startsWith("'") ? REDACTED : `"${REDACTED}"`}`,
	},
	{
		pattern: /\b(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|authorization|cookie|private[-_]?key|credential)\b(\s*[:=]\s*)(?!\[redacted\])(?:"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
		replacement: (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
	},
	// URL query 里的敏感参数
	{
		pattern: /([?&](?:access_token|refresh_token|token|api_key|apikey|key|secret|password|sig|signature)=)[^&\s"']+/gi,
		replacement: `$1${REDACTED}`,
	},
	// URL 内嵌凭据：http://user:pass@host
	{ pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, replacement: `$1${REDACTED}@` },
	{ pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: REDACTED_EMAIL },
	{ pattern: /\b1[3-9]\d{9}\b/g, replacement: REDACTED_PHONE },
];

/** 清洗自由文本里的凭据、邮箱与手机号。 */
export function redactSecrets(value: string): string {
	if (typeof value !== "string" || !value) return "";
	return SECRET_RULES.reduce((acc, rule) => acc.replace(rule.pattern, rule.replacement as string & ((...args: string[]) => string)), value);
}

/** 报告出场的唯一入口：先遮蔽路径，再清洗凭据。 */
export function redactForReport(value: string, home: string): string {
	return redactSecrets(createPathMasker(home)(value));
}

/** 超长文本截断（日志行、堆栈等），避免单条内容撑爆报告。 */
export function truncateText(value: string, maxChars: number): string {
	const text = typeof value === "string" ? value : "";
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** detail 递归脱敏的边界：深度 / 条目数 / 单值长度，防止异常 detail 把诊断包撑爆。 */
const MAX_DETAIL_DEPTH = 4;
const MAX_DETAIL_ITEMS = 20;
const MAX_DETAIL_STRING_CHARS = 500;

/**
 * 键名命中这些词时整段替换值。
 *
 * detail 里的凭据常常是没有已知前缀的裸值（`{ token: "aBc123" }`），
 * 光靠 SECRET_RULES 的文本正则洗不到，只能按键名判定。
 */
const SENSITIVE_DETAIL_KEY = /api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|authorization|cookie|credential|private[-_]?key/i;

/**
 * 对日志 detail 做递归脱敏。
 *
 * 为什么必须脱敏而不是丢弃：detail 是错误定位的主要来源（require stack、RPC 超时的
 * 毫秒数与命令名、git 失败的原始 stderr），整列丢掉等于让诊断包不可诊断；但它同样是
 * 任意 JSON，可能夹带 home 路径、请求体甚至凭据，所以要和 message 走同一套清洗。
 *
 * 深度、条目数、单值长度三重限制保证异常 detail 不会把 zip 撑爆。
 */
export function redactDetail(value: unknown, maskPath: (value: string) => string, depth = 0, seen = new WeakSet<object>()): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return truncateText(redactSecrets(maskPath(value)), MAX_DETAIL_STRING_CHARS);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return String(value);
	// function / symbol 无法序列化，丢弃以免 JSON.stringify 产出无意义的键
	if (typeof value !== "object") return undefined;
	// 循环引用：正常日志来自 JSON.parse 不会有，但这是导出 API，不能假设调用方守规矩
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	if (depth >= MAX_DETAIL_DEPTH) return "[truncated]";
	if (Array.isArray(value)) {
		const items = value.slice(0, MAX_DETAIL_ITEMS).map((item) => redactDetail(item, maskPath, depth + 1, seen));
		if (value.length > MAX_DETAIL_ITEMS) items.push(`[...${value.length - MAX_DETAIL_ITEMS} more]`);
		return items;
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_DETAIL_ITEMS)) {
		if (SENSITIVE_DETAIL_KEY.test(key)) {
			out[key] = REDACTED;
			continue;
		}
		const redacted = redactDetail(item, maskPath, depth + 1, seen);
		if (redacted !== undefined) out[key] = redacted;
	}
	return out;
}
