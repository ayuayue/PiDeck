/**
 * 页内锚点滚动定位的行为测试（README 目录 `[架构](#架构)` 点击后滚到该标题）。
 *
 * 为什么不用真 DOM：要验证的三件事全是纯 DOM 计算——找哪个滚动容器、滚动量算对没、
 * 目标没挂载时是否按帧重试。用最小假 DOM（含 document 顺序、overflow 计算值）就能
 * 精确断言 scrollTop，比 Electron e2e 快两个数量级且不依赖构建产物。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 只实现 markdownAnchorScroll 用到的 DOM 面：classList / parentElement / querySelector / rect / scroll。 */
function createElement(options = {}) {
	const element = {
		id: options.id ?? "",
		classNames: options.classNames ?? [],
		overflowY: options.overflowY ?? "visible",
		top: options.top ?? 0,
		scrollHeight: options.scrollHeight ?? 0,
		clientHeight: options.clientHeight ?? 0,
		scrollTop: 0,
		scrollCalls: [],
		scrollIntoViewCalls: [],
		parentElement: null,
		children: [],
	};
	element.classList = { contains: (name) => element.classNames.includes(name) };
	element.getBoundingClientRect = () => ({ top: element.top, bottom: element.top });
	element.scrollTo = (scrollOptions) => {
		element.scrollCalls.push(scrollOptions);
		element.scrollTop = scrollOptions.top;
	};
	element.scrollIntoView = (scrollOptions) => element.scrollIntoViewCalls.push(scrollOptions);
	element.append = (child) => {
		child.parentElement = element;
		element.children.push(child);
		return child;
	};
	element.querySelector = (selector) => findFirst(element, selector);
	return element;
}

/** 选择器只支持本模块用到的 `#a, #b` 形态。 */
function findFirst(root, selector) {
	const ids = selector.split(",").map((part) => part.trim().replace(/^#/, ""));
	const walk = (node) => {
		for (const child of node.children) {
			if (child.id && ids.includes(child.id)) return child;
			const found = walk(child);
			if (found) return found;
		}
		return null;
	};
	return walk(root);
}

/** 每个用例一份干净沙箱：全局里的 window/document/rAF 都在 JS 侧受控。 */
function loadModule() {
	const document = createElement({ id: "#document" });
	const frames = [];
	const { scrollToMarkdownAnchor } = loadTsCommonJs("src/renderer/src/utils/markdownAnchorScroll.ts", {
		globals: {
			window: {
				getComputedStyle: (element) => ({ overflowY: element.overflowY }),
				matchMedia: () => ({ matches: false }),
			},
			document,
			// 假 DOM 的节点不是真 HTMLElement：模块里的 instanceof 检查只用来排除非元素返回值
			HTMLElement: Object,
			CSS: { escape: (value) => value },
			requestAnimationFrame: (callback) => {
				frames.push(callback);
				return frames.length;
			},
		},
	});
	return { document, frames, scrollToMarkdownAnchor };
}

/** 跑完一帧（回调里可能再排一帧）。 */
function runFrame(frames) {
	const pending = frames.shift();
	pending?.();
}

test("滚动量按最近滚动容器计算，只动那一个容器，并留出顶部空隙", () => {
	const { document, frames, scrollToMarkdownAnchor } = loadModule();
	const pane = document.append(createElement({ classNames: ["markdown-preview"], overflowY: "auto", scrollHeight: 2000, clientHeight: 500, top: 100 }));
	const body = pane.append(createElement({ classNames: ["markdown-body"], top: 100 }));
	const link = body.append(createElement({ id: "", top: 120 }));
	const heading = body.append(createElement({ id: "架构", top: 900 }));

	scrollToMarkdownAnchor(link, "架构");
	runFrame(frames);

	assert.equal(pane.scrollCalls.length, 1);
	assert.equal(pane.scrollTop, 900 - 100 + 0 - 12);
	// 不用 scrollIntoView（那会连带滚动外层/整页）
	assert.equal(heading.scrollIntoViewCalls.length, 0);
	assert.equal(pane.scrollCalls[0].behavior, "smooth");
});

test("同一窗口多份正文时，命中点击位置自己那份（id 重复不串台）", () => {
	const { document, frames, scrollToMarkdownAnchor } = loadModule();
	const pane = document.append(createElement({ overflowY: "auto", scrollHeight: 4000, clientHeight: 500 }));
	const first = pane.append(createElement({ classNames: ["markdown-body"] }));
	first.append(createElement({ id: "配置", top: 300 }));
	const second = pane.append(createElement({ classNames: ["markdown-body"] }));
	const linkInSecond = second.append(createElement({ top: 2000 }));
	second.append(createElement({ id: "配置", top: 2100 }));

	scrollToMarkdownAnchor(linkInSecond, "配置");
	runFrame(frames);

	assert.equal(pane.scrollTop, 2100 - 12);
});

test("原始 HTML 标题被 sanitize 加了 user-content- 前缀时仍能命中", () => {
	const { document, frames, scrollToMarkdownAnchor } = loadModule();
	const pane = document.append(createElement({ overflowY: "auto", scrollHeight: 2000, clientHeight: 500 }));
	const body = pane.append(createElement({ classNames: ["markdown-body"] }));
	const link = body.append(createElement({}));
	body.append(createElement({ id: "user-content-keep-me", top: 640 }));

	scrollToMarkdownAnchor(link, "keep-me");
	runFrame(frames);

	assert.equal(pane.scrollTop, 640 - 12);
});

test("目标尚未挂载（大文档分块挂载中）时按帧重试，挂上来就滚；始终没有则安静放弃", () => {
	const { document, frames, scrollToMarkdownAnchor } = loadModule();
	const pane = document.append(createElement({ overflowY: "auto", scrollHeight: 2000, clientHeight: 500 }));
	const body = pane.append(createElement({ classNames: ["markdown-body"] }));
	const link = body.append(createElement({}));

	scrollToMarkdownAnchor(link, "后文");
	// 前三帧都还没有目标
	runFrame(frames);
	runFrame(frames);
	runFrame(frames);
	assert.equal(pane.scrollCalls.length, 0);
	body.append(createElement({ id: "后文", top: 480 }));
	runFrame(frames);
	assert.equal(pane.scrollTop, 480 - 12);
	assert.equal(frames.length, 0, "命中后不再排队");

	// 永不出现：重试窗口用尽后不再排帧，也不抛错
	const another = document.append(createElement({ overflowY: "auto", scrollHeight: 2000, clientHeight: 500 }));
	const link2 = another.append(createElement({}));
	scrollToMarkdownAnchor(link2, "不存在的锚点");
	for (let index = 0; index < 40; index += 1) runFrame(frames);
	assert.equal(frames.length, 0);
});
