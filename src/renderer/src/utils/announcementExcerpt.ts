/**
 * 公告摘要纯函数：把 markdown 正文清洗为纯文本并截断。
 *
 * 为什么需要：公告正文是外部数据。列表卡片不渲染 markdown（保持轻量 + 控制
 * 攻击面），只展示清洗后的短摘要；完整正文放「查看详情」弹窗里经 MarkdownStream
 * 的 sanitize 管线渲染。清洗是粗粒度的「够摘要用」级别：剔除结构性标记但保留
 * 文本内容，不追求完整 md 规范还原（那是渲染器的职责）。
 */

const MAX_LEN_DEFAULT = 120;

/** 清洗 markdown 结构标记（逐条规则见各 replace 注释）。 */
function stripMarkdown(source: string): string {
	return (
		source
			// 代码围栏整段删除（含内部代码，摘要不需要代码内容）；
			// 非闭合围栏（只有开头 ```）会删到文本尾，属异常 md 的降级行为
			.replace(/```[\s\S]*?(```|$)/g, "")
			// 标题标记 # 与引用标记 >（行首）
			.replace(/^#{1,6}\s+/gm, "")
			.replace(/^>\s?/gm, "")
			// 无序列表 - / * / + 与有序列表 1. 标记（行首，保留列表文本）
			.replace(/^\s*[-*+]\s+/gm, "")
			.replace(/^\s*\d+[.)]\s+/gm, "")
			// 图片 [alt](url) 整段剔除（摘要不承载图片）
			.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
			// 链接 [text](url) → text（只留可见文本）
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			// 行内强调 **bold** / *em* / _em_ / __bold__ → 内容（先处理双星再单星，
			// 避免 ** 被单星规则残留半边标记）
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/\*([^*]+)\*/g, "$1")
			.replace(/__([^_]+)__/g, "$1")
			.replace(/_([^_]+)_/g, "$1")
			// 行内代码 `code` → code
			.replace(/`([^`]+)`/g, "$1")
			// 水平线（全横线/星号/下划线行）整行剔除
			.replace(/^\s*([-*_])\1{2,}\s*$/gm, "")
			// 空白折叠：换行/多空格 → 单空格（HTML 渲染时天然折叠，这里统一语义）
			.replace(/\s+/g, " ")
			.trim()
	);
}

/**
 * 生成公告摘要：清洗 md 标记 + 空白折叠 + 超长截断（截断处补省略号）。
 * @param body 公告正文（markdown 原文）
 * @param maxLen 摘要最大字符数（按 Unicode 码点，中文一字算一字符）
 */
export function announcementExcerpt(body: string, maxLen: number = MAX_LEN_DEFAULT): string {
	const clean = stripMarkdown(body);
	if (clean.length <= maxLen) return clean;
	// 优先在词边界截断（对中文无空格文本退化为纯长度截断）
	const cut = clean.slice(0, maxLen);
	const lastSpace = cut.lastIndexOf(" ");
	const end = lastSpace > maxLen * 0.6 ? lastSpace : maxLen;
	return clean.slice(0, end).trimEnd() + "…";
}
