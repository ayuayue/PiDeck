import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// #601：复制为图片的两条硬约束
// 1) html-to-image 会把 font-size 改成 floor(px) - 0.1（16px → 15.9px），整段拉丁文字宽等比收缩；
//    修法是把 "font-size" 从 includeStyleProperties 摘掉，并由我们自己把计算字号钉成 inline style。
// 2) 执行过程折叠栏会被一起截进图里，同一轮展开/收起导出两张不同的图；修法是克隆阶段整体摘掉。
const { EXPORT_EXCLUDED_SELECTORS, isExportExcludedNode, exportImageFilter, exportIncludeStyleProperties, pinExportTypography, prepareExportClone } = loadTsCommonJs("src/renderer/src/utils/exportImageCopy.ts");

/* ── 假 DOM：只实现被测函数真正用到的那几个成员（style / querySelectorAll / remove） ── */

function fakeNode({ classes = [], children = [], fontSize = "" } = {}) {
	const node = {
		style: {},
		removed: false,
		classList: { contains: (token) => classes.includes(token) },
		querySelectorAll(selector) {
			const matches = selector === "*" ? children : children.filter((child) => child.classList.contains(selector.slice(1)));
			// 子树也要递归：真实 querySelectorAll 是整棵子树，不是一层
			return children.flatMap((child) => (matches.includes(child) ? [child, ...child.querySelectorAll(selector)] : [])).filter((entry, index, all) => all.indexOf(entry) === index);
		},
		remove() {
			node.removed = true;
		},
	};
	// 计算字号按节点自带（模拟逐元素不同：正文 16px、行末元信息 11px）
	node.__fontSize = fontSize;
	return node;
}

const readFontSize = (node) => ({ fontSize: node.__fontSize ?? "16px" });

test("导出用的 includeStyleProperties 必须摘掉 font-size（否则被 html-to-image 改小）", () => {
	const source = ["color", "font-size", "line-height", "text-rendering", "font-family"];
	const list = exportIncludeStyleProperties(source);
	assert.deepEqual([...list], ["color", "line-height", "text-rendering", "font-family"]);
	// 只摘 font-size：其它属性照旧整体复制，否则导出图会丢样式
	assert.equal(list.length, source.length - 1);
	// 空列表/缺省都不抛（测试环境没有 document 时返回 []）
	assert.deepEqual([...exportIncludeStyleProperties([])], []);
});

test("导出 filter 排除执行过程折叠栏与行操作栏，普通节点与文本节点保留", () => {
	assert.deepEqual([...EXPORT_EXCLUDED_SELECTORS], [".execution-summary", ".turn-row-actions", ".user-turn-actions", ".copy-menu-popover"]);
	const fold = fakeNode({ classes: ["execution-summary"] });
	const actions = fakeNode({ classes: ["turn-row-actions"] });
	const body = fakeNode({ classes: ["assistant-text"] });
	assert.equal(isExportExcludedNode(fold), true);
	assert.equal(isExportExcludedNode(actions), true);
	assert.equal(isExportExcludedNode(body), false);
	assert.equal(exportImageFilter(fold), false);
	assert.equal(exportImageFilter(body), true);
	// 文本节点（无 classList）与 null 不能被当成排除项，否则整棵树都进不了图
	assert.equal(isExportExcludedNode({ nodeType: 3 }), false);
	assert.equal(isExportExcludedNode(null), false);
	assert.equal(exportImageFilter({ nodeType: 3 }), true);
});

test("字号按计算值逐个钉成 inline style，不再被 floor - 0.1 改小", () => {
	// 16.5px 是 chat 正文的 clamp 结果：html-to-image 会把它写成 floor(16.5) - 0.1 = 16.4px；
	// 16px 会写成 15.9px（用户实测的 15.9px 就是这一条）。
	const root = fakeNode({ fontSize: "16px" });
	const child = fakeNode({ fontSize: "16.5px" });
	const meta = fakeNode({ fontSize: "11.2px" });
	root.querySelectorAll = () => [child, meta];
	pinExportTypography(root, readFontSize);
	assert.equal(root.style.fontSize, "16px");
	assert.equal(child.style.fontSize, "16.5px");
	assert.equal(meta.style.fontSize, "11.2px");
	// 字形定位按几何精度走，而不是 hinting 网格（宽度差从 37px 降到 4px 内）。
	// 逐元素都得设：复制循环会把子节点的 text-rendering 写成 computed 值 auto，根上的继承会被打掉。
	assert.equal(root.style.textRendering, "geometricPrecision");
	assert.equal(child.style.textRendering, "geometricPrecision");
	assert.equal(meta.style.textRendering, "geometricPrecision");
});

test("prepareExportClone 先摘掉折叠栏与操作栏，再固化字号", () => {
	const finalAnswer = fakeNode({ fontSize: "16px" });
	const fold = fakeNode({ classes: ["execution-summary"] });
	const actions = fakeNode({ classes: ["turn-row-actions"] });
	const clone = fakeNode({ fontSize: "16px" });
	clone.querySelectorAll = (selector) => (selector === "*" ? [finalAnswer, fold, actions] : [finalAnswer, fold, actions].filter((node) => node.classList.contains(selector.slice(1))));
	prepareExportClone(clone, readFontSize);
	// 折叠态内容不进图：画布尺寸也不能被它拉长（所以是 remove 而不是 filter 掉）
	assert.equal(fold.removed, true);
	assert.equal(actions.removed, true);
	assert.equal(finalAnswer.removed, false);
	// 留下的节点仍然固化字号（折叠栏摘除不影响排版固化顺序）
	assert.equal(finalAnswer.style.fontSize, "16px");
	assert.equal(clone.style.textRendering, "geometricPrecision");
	assert.equal(finalAnswer.style.textRendering, "geometricPrecision");
});

test("html-to-image 只能从本模块调用：它的 includeStyleProperties 是模块级缓存，首次调用生效", async () => {
	// 我们对字号修复完全依赖「每次调用都传 includeStyleProperties（摘掉 font-size）」。
	// html-to-image 内部用 `cache || (cache = options.includeStyleProperties ?? 默认全集)`，
	// 所以任何不带这份列表的早期调用都会把字号修复跳过去，导出图静默退回 floor - 0.1。
	const { readFileSync, readdirSync, statSync } = await import("node:fs");
	const { join } = await import("node:path");
	const walk = (dir) =>
		readdirSync(dir).flatMap((name) => {
			const full = join(dir, name);
			return statSync(full).isDirectory() ? walk(full) : [full];
		});
	const offenders = walk("src/renderer/src")
		.filter((file) => /\.(ts|tsx)$/.test(file))
		.filter((file) => !file.replace(/\\/g, "/").endsWith("utils/exportImageCopy.ts"))
		.filter((file) => /from\s+"html-to-image"|import\(\s*"html-to-image"\s*\)/.test(readFileSync(file, "utf8")));
	assert.deepEqual(offenders, [], "其它文件直接调 html-to-image 会让导出字号修复失效（请走 utils/exportImageCopy）");
});
