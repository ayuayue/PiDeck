/**
 * 救回「加粗的裸 URL」被 GFM autolink literal 吞掉闭合星号的问题（issue #543）。
 *
 * 触发形态：`**http://127.0.0.1:18765**（…）`。GFM 的 extended url autolink 会一直吃到
 * 下一个空白，而 `*` 只在 URL **末尾**才被当作尾标点裁掉（spec §6.9）；闭合 `**` 后面
 * 紧跟非空白字符时，它就落在 URL 内部，于是：
 *   text("打开 **") + link(url/text = "http://…**（`8765`") + …
 * 两颗星号字面化、href 被污染、后面的行内代码也进了链接。
 *
 * 这是符合规范的解析结果（不是 remark-gfm 的 bug），只能在渲染侧修。判定收得很紧：
 * - 前一个节点是 text 且以未转义的 `**` 结尾；
 * - 下一个节点是 autolink literal 的产物（`url === 可见文本`，普通链接不满足）；
 * - URL 以 scheme 开头，且内部出现 `**`；
 * - `**` 后还有残余文本（若 URL 以 `**` 结尾，GFM 本来就会正确裁掉，不归这里管）。
 *
 * 修复后：`**` 之前的正文保留 → `strong(link(URL))` → 残余文本按同一处理器重新解析成
 * 行内节点（可能是全角括号、行内代码等），不会把 `` `code` `` 当字面量。
 *
 * 与 remarkRecoverInlineLinks 同属「解析器拆坏后的定向修复」，不碰代码/数学节点。
 */

/** remark/mdast 节点的最小形状：只访问本插件需要的字段（第三方边界，不引入 mdast 类型包）。 */
type MdNode = {
	type: string;
	value?: string;
	url?: string;
	children?: MdNode[];
	position?: { start?: { offset?: number }; end?: { offset?: number } };
	[key: string]: unknown;
};

/** 带 scheme 的 URL（autolink literal 只认这类）。 */
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 处理器的最小形状：只用到 parse（复用当前 unified 管线，含 GFM 扩展）。 */
type InlineParser = { parse: (value: string) => unknown };

/** 残余文本按当前管线重新解析成行内节点；解析不出段落时退回纯文本，绝不丢字。 */
function parseInline(parser: InlineParser, value: string): MdNode[] {
	try {
		const root = parser.parse(value) as MdNode | undefined;
		const paragraph = Array.isArray(root?.children) ? root.children[0] : undefined;
		if (paragraph?.type === "paragraph" && Array.isArray(paragraph.children)) return paragraph.children;
	} catch {
		// 解析器异常不能让整条消息渲染失败：退回纯文本，至少保留原文。
	}
	return [{ type: "text", value }];
}

/** 只处理 autolink literal 产物；返回替换后的节点序列，非目标形态返回 null。 */
function repairPair(before: MdNode | undefined, link: MdNode | undefined, parser: InlineParser, source: string): MdNode[] | null {
	if (before?.type !== "text" || typeof before.value !== "string" || !before.value.endsWith("**")) return null;
	// 作者显式转义的 `\*\*`：源文末两字符不是 `**`（而是 `\*`），保持原样。
	const end = before.position?.end?.offset;
	if (typeof end !== "number" || source.slice(end - 2, end) !== "**") return null;
	if (link?.type !== "link" || typeof link.url !== "string" || !Array.isArray(link.children) || link.children.length !== 1) return null;
	const [label] = link.children;
	if (label?.type !== "text" || typeof label.value !== "string") return null;
	// autolink literal 的 url 与可见文本完全相同；普通 `[text](url)` 不满足。
	if (link.url !== label.value) return null;
	const cut = label.value.indexOf("**");
	if (cut <= 0) return null;
	const url = label.value.slice(0, cut);
	if (!SCHEME_URL.test(url)) return null;
	const rest = label.value.slice(cut + 2);
	// 以 `**` 结尾的 URL 会被 GFM 正确裁掉并闭合加粗，不走本修复。
	if (rest.length === 0) return null;
	const head = before.value.slice(0, -2);
	return [...(head.length > 0 ? [{ ...before, value: head }] : []), { type: "strong", children: [{ type: "link", url, children: [{ type: "text", value: url }] }] }, ...parseInline(parser, rest)];
}

export function remarkRecoverBoldAutolinks(this: unknown) {
	// unified 以 processor 为 this 调用插件；这里只用 parse，且不依赖具体泛型参数。
	const parser = this as InlineParser;
	return (tree: unknown, file?: { value?: unknown }) => {
		const source = typeof file?.value === "string" ? file.value : "";
		if (source === "") return;

		const visit = (node: MdNode) => {
			const children = node.children;
			if (!Array.isArray(children)) return;
			const next: MdNode[] = [];
			for (let index = 0; index < children.length; index += 1) {
				const child = children[index];
				const repaired = repairPair(child, children[index + 1], parser, source);
				if (repaired) {
					next.push(...repaired);
					index += 1; // 同时消费掉后面的 link
					continue;
				}
				visit(child);
				next.push(child);
			}
			node.children = next;
		};

		visit(tree as MdNode);
	};
}
