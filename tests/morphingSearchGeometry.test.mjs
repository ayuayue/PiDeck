import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { MORPHING_SEARCH_HEADER_HEIGHT, MORPHING_SEARCH_MIN_RESULTS_HEIGHT, isPlausibleAnchorRect, resolveMorphingSearchGeometry } = loadTsCommonJs("src/renderer/src/components/motion/morphingSearchGeometry.ts");

/**
 * 搜索面板落点回归测试。
 *
 * 背景（用户反馈「搜索弹框卡在屏幕外，多点几次又好了」）：面板是 fixed + portal，
 * 落点由锚点的 getBoundingClientRect 决定；侧栏入场动画 `.list-content-enter` 的
 * translateX(8px) 落在锚点祖先上时，fixed 锚点会被当成相对该祖先定位，读出的 left
 * 约为 -(列表宽度) + 8（1200 宽窗口 → -172），旧实现直接采用，面板整块被推出窗口左侧。
 * 契约：不可信测量被丢弃（保留上次有效值），且任何来源的落点都夹在窗口内。
 */

/** 改动前 render 时的落点公式，用于锁定「正常路径视觉不变」。 */
function legacyGeometry(anchor, viewport, maxWidth, maxHeight) {
	const width = Math.max(anchor.width, Math.min(maxWidth, viewport.width - anchor.left - 16));
	const resultsHeight = Math.max(96, Math.min(maxHeight, viewport.height - anchor.top - 80));
	return { top: anchor.top, left: anchor.left, width, resultsHeight };
}

function assertSameGeometry(actual, expected, label) {
	// 逐字段比较（strict）而不是 deepStrictEqual：模块经 VM 加载，对象来自另一个
	// realm，deepStrictEqual 会比 prototype 身份。
	for (const key of ["top", "left", "width", "resultsHeight"]) {
		assert.equal(actual[key], expected[key], `${label}: ${key} 与改动前不一致`);
	}
}

/** 面板整块矩形（顶栏 + 结果区）。 */
function panelBox(geometry) {
	return {
		top: geometry.top,
		left: geometry.left,
		right: geometry.left + geometry.width,
		bottom: geometry.top + MORPHING_SEARCH_HEADER_HEIGHT + geometry.resultsHeight,
	};
}

function assertInsideViewport(geometry, viewport, label) {
	const box = panelBox(geometry);
	assert.ok(box.left >= 0, `${label}: 面板左缘越出窗口 (${box.left})`);
	assert.ok(box.top >= 0, `${label}: 面板上缘越出窗口 (${box.top})`);
	assert.ok(box.right <= viewport.width, `${label}: 面板右缘越出窗口 (${box.right} > ${viewport.width})`);
	assert.ok(box.bottom <= viewport.height, `${label}: 面板下缘越出窗口 (${box.bottom} > ${viewport.height})`);
}

// 侧栏锚点是视口水平居中的 fixed 盒子（SidebarContent：left-1/2 + -translate-x-1/2，
// 宽 min(640px, 100vw - 2rem)），垂直落在 16vh；maxWidth 640 / maxHeight 360。
function sidebarAnchor(viewport) {
	const width = Math.min(640, viewport.width - 32);
	return { top: viewport.height * 0.16, left: (viewport.width - width) / 2, width };
}

const SIDEBAR_LIMITS = { maxWidth: 640, maxHeight: 360 };

test("正常锚点落点与改动前逐值一致（视觉不变）", () => {
	const viewports = [
		{ width: 880, height: 640 },
		{ width: 1200, height: 900 },
		{ width: 1600, height: 1000 },
		{ width: 1920, height: 1080 },
	];
	for (const viewport of viewports) {
		const anchor = sidebarAnchor(viewport);
		const geometry = resolveMorphingSearchGeometry({ anchor, viewport, ...SIDEBAR_LIMITS });
		assertSameGeometry(geometry, legacyGeometry(anchor, viewport, SIDEBAR_LIMITS.maxWidth, SIDEBAR_LIMITS.maxHeight), `viewport ${viewport.width}x${viewport.height}`);
	}
	// 会话内搜索框（非 iconOnly，宽 288）同样逐值一致
	const anchor = { top: 96, left: 420, width: 288 };
	const viewport = { width: 1400, height: 900 };
	assertSameGeometry(resolveMorphingSearchGeometry({ anchor, viewport, maxWidth: 448, maxHeight: 288 }), legacyGeometry(anchor, viewport, 448, 288), "会话内搜索框");
});

test("带 transform 的祖先里测出的锚点判定为不可信", () => {
	const viewport = { width: 1200, height: 900 };
	// 侧栏入场动画期间：锚点被当成相对 280 宽的侧栏定位 → left ≈ 140 - 320 + 8
	const poisoned = { top: 144, left: -172, width: 640 };
	assert.equal(isPlausibleAnchorRect(poisoned, viewport), false);
	// 反方向平移（动画 translateX 为正）与陈旧落点同样越界
	assert.equal(isPlausibleAnchorRect({ top: 144, left: 700, width: 640 }, viewport), false);
	assert.equal(isPlausibleAnchorRect({ top: -40, left: 280, width: 640 }, viewport), false);
	// 正常测量、零宽（侧栏折叠）与亚像素抖动
	assert.equal(isPlausibleAnchorRect(sidebarAnchor(viewport), viewport), true);
	assert.equal(isPlausibleAnchorRect({ top: 144, left: 280, width: 0 }, viewport), false);
	assert.equal(isPlausibleAnchorRect({ top: 144, left: -1.5, width: 640 }, viewport), true);
	assert.equal(isPlausibleAnchorRect({ top: 144, left: Number.NaN, width: 640 }, viewport), false);
});

test("坏落点漏进来时面板仍被夹回窗口内", () => {
	const viewport = { width: 1200, height: 900 };
	const geometry = resolveMorphingSearchGeometry({ anchor: { top: 144, left: -172, width: 640 }, viewport, ...SIDEBAR_LIMITS });
	assertInsideViewport(geometry, viewport, "transform 污染落点");
	assert.ok(geometry.width >= 640, "面板不应窄于锚点");

	// 窗口缩小后沿用旧落点（旧值在旧窗口里合法）
	const shrunk = { width: 900, height: 700 };
	const stale = resolveMorphingSearchGeometry({ anchor: { top: 144, left: 280, width: 640 }, viewport: shrunk, ...SIDEBAR_LIMITS });
	assertInsideViewport(stale, shrunk, "窗口缩小后的陈旧落点");
});

test("矮窗口纵向留在窗口内，且不小于最小结果区", () => {
	const viewport = { width: 604, height: 200 };
	const anchor = sidebarAnchor(viewport);
	const geometry = resolveMorphingSearchGeometry({ anchor, viewport, ...SIDEBAR_LIMITS });
	assertInsideViewport(geometry, viewport, "矮窗口");
	assert.equal(geometry.resultsHeight, MORPHING_SEARCH_MIN_RESULTS_HEIGHT);

	// 上限仍然生效
	const tall = resolveMorphingSearchGeometry({ anchor: sidebarAnchor({ width: 1600, height: 1000 }), viewport: { width: 1600, height: 1000 }, ...SIDEBAR_LIMITS });
	assert.equal(tall.resultsHeight, SIDEBAR_LIMITS.maxHeight);
	assert.equal(tall.width, SIDEBAR_LIMITS.maxWidth);
});

test("组件落点一律经几何函数，不再直接用锚点原始 left", () => {
	const source = readFileSync("src/renderer/src/components/motion/morphing-search.tsx", "utf8");
	assert.match(source, /isPlausibleAnchorRect\(rect,/);
	assert.match(source, /resolveMorphingSearchGeometry\(/);
	assert.doesNotMatch(source, /top:\s*anchorRect\.top/);
	assert.doesNotMatch(source, /left:\s*anchorRect\.left/);
	assert.doesNotMatch(source, /maxHeight:\s*resultsHeight/);
	// 打开瞬间补测：受控打开（侧栏条目 / Ctrl+F）不经过 openSearch()
	assert.match(source, /if \(open\) measureAnchor\(\);/);
});
