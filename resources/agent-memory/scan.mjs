/**
 * 写入前的内容扫描（移植 pi-hermes-memory 的 `_scan_memory_content`）。
 *
 * 记忆内容会被注入进**未来每一个会话的系统提示**，所以它等价于「一段长期生效的指令」。
 * 三条闸门按顺序判定，命中即拒写：
 *  1. 不可见/控制字符：零宽字符、双向文本控制符、BOM 等，肉眼看不见却能改变文本顺序，
 *     是「留后门指令」的经典载体。
 *  2. 提示注入话术：明显的「忽略此前的指令」类短语。误报代价可控（用户换个说法即可），
 *     漏报代价是整个后续会话被劫持。
 *  3. 凭据形态：API key / 私钥 / 令牌。记忆会跨会话保留并进入模型上下文，
 *     这里必须挡住，不能指望用户自己想起来。
 *
 * 返回 `{ code, detail }` 而不是成品文案：文案由工具层按语言决定，扫描器只管判定。
 */

/** 零宽与双向控制字符（UTF-16 码元值，避免源码里出现不可见字符本身）。 */
const INVISIBLE_CODE_POINTS = new Set([
	0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

/** 除换行与制表符外的 C0/C1 控制字符。 */
function isControlCharacter(codePoint) {
	if (codePoint === 0x0a || codePoint === 0x09) return false;
	return (codePoint >= 0x00 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/** 提示注入话术：中英各取最常见的几种指令覆盖句式。 */
const INJECTION_PATTERNS = [
	/\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|messages?)/i,
	/\bdisregard\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i,
	/\bforget\s+(?:all\s+|everything\s+)?(?:your\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?)/i,
	/\byou\s+are\s+now\s+(?:a|an|the)\s+(?:different|new)\b/i,
	/\b(?:system|developer)\s*:\s*you\s+(?:must|should|will)\b/i,
	/\boverride\s+(?:your\s+)?(?:safety|system)\b/i,
	/(?:忽略|无视|忘记)(?:掉)?(?:之前|此前|上面|以上|前面)的?(?:所有)?(?:指令|指示|规则|提示词|要求)/,
	/(?:现在|从此)(?:开始)?(?:你|你是)(?:一个|一名)?(?:新的|不同的)/,
	/(?:不要|别再)(?:遵守|执行)(?:你的)?(?:系统)?(?:提示|指令|规则)/,
];

/** 凭据形态：只认「高置信度」的那几种，宁可漏掉弱特征也不误杀正常文本。 */
const SECRET_PATTERNS = [
	/\bsk-[A-Za-z0-9_-]{20,}\b/,
	/\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
	/\bghp_[A-Za-z0-9]{20,}\b/,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
	/\bAIza[0-9A-Za-z_-]{30,}\b/,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
	/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
	/\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password)\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{16,}/i,
];

/**
 * 扫描一段准备写入的记忆内容。
 * @param {unknown} content
 * @returns {{ code: string, detail?: string } | null} 命中时返回错误码，通过时返回 null。
 */
export function scanMemoryContent(content) {
	if (typeof content !== "string" || content.trim().length === 0) return { code: "memory-content-empty" };

	for (const character of content) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (INVISIBLE_CODE_POINTS.has(codePoint)) return { code: "memory-content-invisible-chars", detail: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}` };
		if (isControlCharacter(codePoint)) return { code: "memory-content-control-chars", detail: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}` };
	}

	for (const pattern of INJECTION_PATTERNS) {
		if (pattern.test(content)) return { code: "memory-content-injection" };
	}

	for (const pattern of SECRET_PATTERNS) {
		const match = pattern.exec(content);
		if (match) {
			// 只回形态，不回原文：错误信息也会进日志与模型上下文。
			return { code: "memory-content-secret", detail: pattern.source.slice(0, 24) };
		}
	}

	return null;
}
