import remarkGfm, { type Options as RemarkGfmOptions } from "remark-gfm";
import type { Plugin, Pluggable } from "unified";

/**
 * 会话/静态 markdown 渲染统一使用的 GFM 插件。
 *
 * 关闭单波浪线删除线（remark-gfm 默认 singleTilde: true；GitHub/CommonMark 只用 `~~`）：
 * AI 输出与文件内容里常见的 `~` 路径会被 `~text~` 单波形误判成删除线，
 * 例如 Windows 8.3 短路径 `C:\Users\ADMINI~1\...` 会被从 `~` 处劈开，
 * 后续 remarkLinkifyPaths 只能拿到 `\AppData\...` 这类残缺路径 → 点击打开空文件。
 * `~~...~~` 双波形删除线语义不受影响（与 GitHub 行为对齐）。
 */
const gfmPlugin = remarkGfm as unknown as Plugin<[RemarkGfmOptions?]>;

/** [plugin, options] 元组形态（与 streamdown defaultRemarkPlugins.gfm 同形），可放进 remarkPlugins 列表 */
export const remarkGfmNoSingleTilde: Pluggable = [gfmPlugin, { singleTilde: false }];

/** 本地图片文件后缀：只救这些，其余（.md/.ts 等）留给文件链接处理。 */
const RECOGNIZED_IMAGE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;

/**
 * 单段只含一个「图片语法」文本时的匹配：目标必须是绝对路径、`./`/`../` 或盘符开头。
 * 限定这几类前缀是刻意的——相对裸文件名（`![](a.png)`）与正文里的普通词组无法区分。
 */
const RECOVERABLE_IMAGE_PARAGRAPH = /^!\[([^\]\n]*)\]\(((?:\/(?!\/)|\.{1,2}\/|[a-zA-Z]:[\\/])[^\n<>()[\]"']+\.[A-Za-z0-9]+)\)$/u;

/** remark/mdast 节点的最小形状：只访问本插件需要的字段（第三方边界，不引入 mdast 类型包）。 */
type MdNode = {
	type: string;
	value?: string;
	alt?: string;
	url?: string;
	children?: MdNode[];
	position?: { start?: { offset?: number }; end?: { offset?: number } };
	[key: string]: unknown;
};

/**
 * 救回被 Markdown 解析器拆坏的本地图片写法。
 *
 * 触发场景：`![架构图](/tmp/a b.png)` 这种目标里带空格的写法，CommonMark 的链接目标
 * 语法不允许裸空格，解析器会把整段降级成纯文本，用户看到的是一行原始语法而不是图。
 * 模型写出来的路径带空格很常见（Desktop/My Documents、中文目录名后跟空格等）。
 *
 * 判定收得很紧，宁可少救也不能把正文改坏：
 * - 段落只有一个 text 子节点；
 * - 该节点的原文与节点值逐字相同（即作者没写转义，转义示例 `\!\[` 不动）；
 * - 目标以 `/`、`./`、`../`、盘符开头，且扩展名属于图片；
 * - 目标必须含空格（不含空格的畸形写法解析器本来就能处理，不需要这里插手）。
 */
export const remarkRecoverLocalImages = () => {
	return (tree: MdNode, file?: { value?: unknown }) => {
		const source = typeof file?.value === "string" ? file.value : "";
		if (source === "") return;

		const visit = (node: MdNode) => {
			const children = node.children;
			if (node.type === "paragraph" && Array.isArray(children) && children.length === 1) {
				const [child] = children;
				const start = child?.position?.start?.offset;
				const end = child?.position?.end?.offset;
				if (child && child.type === "text" && typeof child.value === "string" && typeof start === "number" && typeof end === "number" && source.slice(start, end) === child.value) {
					const match = RECOVERABLE_IMAGE_PARAGRAPH.exec(child.value);
					const target = match?.[2];
					if (match && target !== undefined && target.includes(" ") && RECOGNIZED_IMAGE_EXTENSION.test(target)) {
						node.children = [{ type: "image", alt: match[1], url: target, position: child.position }];
					}
				}
				return;
			}
			if (!Array.isArray(children)) return;
			for (const child of children) visit(child);
		};

		visit(tree);
	};
};
