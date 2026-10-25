import { createContext, useContext, type ReactNode } from "react";

/**
 * 「同一段落里有多少张图」的传递通道。
 *
 * 为什么不用 HTML 属性：图片逐节点渲染，组件看不到兄弟节点，最自然的做法是把数量写进
 * 属性（`data-md-image-count`）；但 streamdown 内部会跑 `rehype-sanitize` 的
 * `defaultSchema`，**只保留白名单属性**——实测 `{src, alt, data-*} ` 过一遍后只剩 `{alt}`
 * （2026-10-20 真机 smoke 复现）。所以改走组件树：由 `p` 组件数出子级图片数，用 context
 * 传给子树里的每个 `MarkdownImage`。
 *
 * 布局规则照 dsh：单图按内容尺寸（上限 640×360），同段 ≥2 张缩成 64px 瓷砖。
 */
const MarkdownImageGroupContext = createContext(1);

export function MarkdownImageGroupProvider(props: { count: number; children: ReactNode }) {
	return <MarkdownImageGroupContext.Provider value={props.count}>{props.children}</MarkdownImageGroupContext.Provider>;
}

/** 当前段落里的图片张数（无 Provider 时为 1，即单图规则）。 */
export function useMarkdownImageGroupCount(): number {
	return useContext(MarkdownImageGroupContext);
}

/**
 * hast 节点直接子级里的图片数量（纯函数，可单测）。
 * 只看直接子级：段落里的图片就是直接子级，嵌套图片（图套链接）由 `a` 包裹时不再计入。
 */
export function imageCountInChildren(node: unknown): number {
	if (typeof node !== "object" || node === null) return 0;
	const children = Reflect.get(node, "children");
	if (!Array.isArray(children)) return 0;
	let count = 0;
	for (const child of children) {
		if (typeof child === "object" && child !== null && Reflect.get(child, "tagName") === "img") count += 1;
	}
	return count;
}
