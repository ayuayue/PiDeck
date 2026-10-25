import type { StreamdownProps } from "streamdown";
// rehype-raw / rehype-sanitize 由 streamdown 依赖树提供（仓库既有 unified / hast 也是裸导入同口径），
// 版本随 streamdown 走；streamdown 根导出只有 import 条件，Node 侧 require 拿不到，故直接引这两个包。
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

/**
 * 不可信 Markdown 的 HTML 净化管线（会话正文 / 文件预览 / 公告等共用）。
 *
 * 为什么必须有这一层：MarkdownStream 早期只挂了 `defaultRehypePlugins.raw`，等于把模型（与任何被渲染的
 * 文件/公告）输出的 HTML **原样**塞进应用 DOM。AI 回复里最常见的「帮我画个 SVG / 写段 HTML」会带
 * `<style>svg{width:100%}</style>` 这类全局选择器——style 元素一旦进 DOM 就作用于整个页面，
 * 于是标题栏/时间线里所有 lucide 图标一起被放大，**切到别的会话（该消息卸载）才恢复正常**
 * （2026-10 issue #397 反馈）。同一条路径上还放行了 `<iframe>`、`onerror=` 与 `javascript:` 链接。
 *
 * 取舍：
 * - 用 rehype-sanitize 的 GitHub 默认 schema（白名单）做真正的允许清单，不自己写过滤规则；
 * - `harden` 故意不启用：它会把被拦的链接/图片替换成英文「[blocked]」文案并重写树，
 *   本应用自己的 `pideck-file:` 本地图与 `file://` 本地链接会被一起打死，
 *   URL 安全由 `markdownUrlTransform` / `resolveMarkdownImageSrc` 统一负责；
 * - `src` 不进协议白名单：图片地址要先经过本地路径解析（`C:\\x.png`、`./out/a.png`、pideck-file），
 *   在 sanitize 环节按 http(s) 过滤会把本地图全清空；
 * - 内联 SVG 保留几何/描边属性（AI 画图常用），但不放行 `<style>`/`<image>`/`<foreignObject>`/事件属性。
 */

/** 整棵子树都丢掉的标签：`<style>` 留下文本会把 CSS 源码当正文显示，`<iframe>`/`<object>` 会发起外部请求。 */
const DANGEROUS_TAGS = new Set(["style", "script", "iframe", "frame", "frameset", "object", "embed", "foreignobject", "link", "meta", "base", "template", "noscript", "form", "textarea", "select", "option", "button", "marquee", "canvas"]);

/** 允许的内联 SVG 标签：只有几何与文字，不含 `<style>`/`<image>`（外链）/`<use>`/`<foreignObject>`。 */
const SVG_TAGS = ["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "tspan", "defs", "lineargradient", "radialgradient", "stop", "clippath", "symbol"];

/** SVG 属性白名单：只放行绘制相关属性（hast 里的属性名是 camelCase）。 */
const SVG_ATTRIBUTES = [
	"viewBox",
	"xmlns",
	"fill",
	"stroke",
	"strokeWidth",
	"strokeLinecap",
	"strokeLinejoin",
	"strokeDasharray",
	"strokeOpacity",
	"fillOpacity",
	"fillRule",
	"clipRule",
	"clipPath",
	"opacity",
	"transform",
	"d",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"x",
	"y",
	"x1",
	"x2",
	"y1",
	"y2",
	"points",
	"dx",
	"dy",
	"offset",
	"stopColor",
	"stopOpacity",
	"gradientUnits",
	"gradientTransform",
	"textAnchor",
	"dominantBaseline",
	"fontSize",
	"fontFamily",
	"fontWeight",
	"preserveAspectRatio",
];

/**
 * sanitize schema = GitHub 默认白名单 + 本应用的 URL 口径 + 内联 SVG 子集。
 * 导出成常量便于测试直接断言（schema 漂移会立刻被 `tests/markdownHtmlSanitize.test.mjs` 抓到）。
 */
export const MARKDOWN_SANITIZE_SCHEMA = (() => {
	const baseAttributes = defaultSchema.attributes ?? {};
	const baseProtocols = defaultSchema.protocols ?? {};
	// src 从协议白名单里摘掉：本地图片地址（盘符/相对路径/pideck-file:）由渲染层统一解析
	const { src: _unusedSrcProtocols, ...protocolsWithoutSrc } = baseProtocols;
	const attributes: Record<string, unknown[]> = { ...baseAttributes };
	for (const tag of SVG_TAGS) attributes[tag] = [...SVG_ATTRIBUTES];
	return {
		...defaultSchema,
		tagNames: [...(defaultSchema.tagNames ?? []), ...SVG_TAGS],
		protocols: {
			...protocolsWithoutSrc,
			// tel 与 streamdown 一致；file / pideck-file 是本应用的本地文件与只读图片协议
			href: [...(baseProtocols.href ?? []), "tel", "file", "pideck-file"],
		},
		attributes: {
			...attributes,
			// 代码块 meta（```ts title="x.ts"）由 remark codeMeta 写进 hProperties，是标题/文件名来源
			code: [...(baseAttributes.code ?? []), "metastring"],
		},
	};
})();

/** hast 节点的最小结构：只用到遍历必需字段（类型从 hast 的 Root 里取会退化成字面量 "root"）。 */
type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

/** 递归摘除危险元素子树；返回被摘掉的个数（纯函数，测试可直接断言）。 */
export function pruneDangerousHtml(parent: HastNode): number {
	const children = parent.children;
	if (!children || children.length === 0) return 0;
	let removed = 0;
	const kept: HastNode[] = [];
	for (const child of children) {
		// 连内容一起丢：`<style>` 的 CSS 源码、`<iframe>` 的地址都不该出现在正文里
		if (child.type === "element" && child.tagName && DANGEROUS_TAGS.has(child.tagName.toLowerCase())) {
			removed += 1;
			continue;
		}
		removed += pruneDangerousHtml(child);
		kept.push(child);
	}
	parent.children = kept;
	return removed;
}

/** rehype 插件形态：在 sanitize 之前先整棵摘掉 `<style>`/`<script>`/`<iframe>` 等。 */
export function rehypeDropDangerousHtml() {
	return (tree: HastNode): undefined => {
		pruneDangerousHtml(tree);
		return undefined;
	};
}

type RehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>;

/**
 * 不可信 Markdown 的标准 rehype 插件序列：raw（渲染 HTML）→ 摘除危险子树 → sanitize（白名单）。
 * 顺序固定在模块级（引用稳定）：streamdown 以插件列表为 key 缓存解析产物，每次渲染新建数组会让缓存失效。
 */
export const UNTRUSTED_MARKDOWN_REHYPE_PLUGINS: RehypePlugins = [rehypeRaw, rehypeDropDangerousHtml, [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA]];
