/**
 * Markdown 标题锚点（README 目录跳转）。
 *
 * 现象：README/长文档开头的目录是 `- [架构](#架构)` 这类页内链接，点击后没有反应——
 * 渲染链里既没有给标题写 `id`（streamdown 不带 rehype-slug），链接本身又被当成
 * 普通外链交给 `onOpenExternal`。
 *
 * 这里只做「标题 → GitHub 兼容 slug id」这一步（纯函数 + 一个 rehype 插件），
 * 点击后的页内滚动在 `utils/markdownAnchorScroll.ts`，两边的 id 口径必须一致，
 * 因此本模块同时导出 `anchorIdFromHref` 供链接侧复用。
 *
 * slug 规则对齐 github-slugger（GitHub 生成目录锚点的实现），因为文档里的锚点
 * 是作者按 GitHub 上的效果手写的：小写 → 去掉非字母/数字/组合符/连接符（`-`、`_`）
 * 与空格之外的一切 → 空格换 `-`；同名标题依次追加 `-1`、`-2`。
 */

/** hast 节点的最小结构：只用到遍历/写 id 必需字段（类型名从 hast 取会退化成字面量）。 */
type HastNode = {
	type: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
	value?: string;
};

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * 与 github-slugger 等价：保留 Unicode 字母/数字/组合符（重音等）/
 * `Pc`（含 `_`）/ `-` / ASCII 空格，其余（标点、符号、emoji、CJK 标点）全部丢弃。
 */
const NON_SLUG_PATTERN = /[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu;

/** 标题文本 → slug（不去重；去重见 rehypeHeadingAnchors 内的 occurrences）。 */
export function githubHeadingSlug(text: string): string {
	return text.toLowerCase().replace(NON_SLUG_PATTERN, "").replace(/ /g, "-");
}

/** 拼出标题里参与 slug 的纯文本（含行内代码 / 链接 / 强调，忽略图片 alt——与 rehype-slug 口径一致）。 */
function headingText(node: HastNode): string {
	if (node.type === "text") return node.value ?? "";
	const children = node.children;
	if (!children || children.length === 0) return "";
	let text = "";
	for (const child of children) {
		// 图片没有文字内容：`## ![logo](./a.png) 简介` 在 GitHub 上 slug 是 `-简介`
		if (child.type === "element" && child.tagName === "img") continue;
		text += headingText(child);
	}
	return text;
}

/**
 * rehype 插件形态：给 h1–h6 写 slug id。
 *
 * 必须排在 sanitize **之后**（见 markdownSanitize.ts 的插件序列）：这样写进去的
 * id 不会再过一遍白名单；同时顺序固定为模块级引用，streamdown 的解析缓存不失效。
 * 作者手写 `<h2 id="x">` 时保留原 id（不覆盖），只在缺失时补。
 */
export function rehypeHeadingAnchors() {
	return (tree: HastNode): undefined => {
		const occurrences = new Map<string, number>();
		const visit = (node: HastNode) => {
			const children = node.children;
			if (!children || children.length === 0) return;
			for (const child of children) {
				if (child.type === "element" && child.tagName && HEADING_TAGS.has(child.tagName)) {
					const base = githubHeadingSlug(headingText(child).trim());
					// 纯符号/纯 emoji 标题的 slug 为空串：不写 id，否则会生成 id=""
					if (base) {
						const seen = occurrences.get(base) ?? 0;
						occurrences.set(base, seen + 1);
						const id = seen === 0 ? base : `${base}-${seen}`;
						const properties = child.properties ?? (child.properties = {});
						if (!properties.id) properties.id = id;
					}
				}
				visit(child);
			}
		};
		visit(tree);
		return undefined;
	};
}

/**
 * 页内锚点链接的 id：`#架构` / `#%E6%9E%B6%E6%9E%84` → `架构`；
 * 非页内链接（外链、本地文件、空 `#`）→ null，交由原有外链/文件路径逻辑处理。
 */
export function anchorIdFromHref(href: string | null | undefined): string | null {
	if (!href) return null;
	const raw = href.trim();
	if (!raw.startsWith("#")) return null;
	const fragment = raw.slice(1);
	if (!fragment) return null;
	try {
		return decodeURIComponent(fragment);
	} catch {
		// 非法百分号编码：原样当 id 用（作者可能直接写了 `#100%覆盖`）
		return fragment;
	}
}
