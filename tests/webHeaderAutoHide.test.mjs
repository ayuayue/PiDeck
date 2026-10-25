import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveHeaderHidden, stepHeaderAutoHide, INITIAL_HEADER_AUTO_HIDE_STATE } = loadTsCommonJs("src/renderer/src/web/headerAutoHide.ts");
const { WEB_MOBILE_MAX_WIDTH, isMobileViewport, readViewportWidth } = loadTsCommonJs("src/renderer/src/web/webViewport.ts");

const mobile = { scrollTop: 400, delta: 0, viewportWidth: 375, forceVisible: false };

test("桌面宽度恒展开，忽略滚动位移", () => {
	assert.equal(resolveHeaderHidden(true, { ...mobile, viewportWidth: WEB_MOBILE_MAX_WIDTH + 1, delta: 500 }), false);
	assert.equal(resolveHeaderHidden(false, { ...mobile, viewportWidth: 1440, delta: 500 }), false);
});

test("forceVisible 压过收起判定", () => {
	assert.equal(resolveHeaderHidden(true, { ...mobile, delta: 500, forceVisible: true }), false);
	assert.equal(resolveHeaderHidden(true, { ...mobile, scrollTop: 0, forceVisible: true }), false);
});

test("回顶必然露出顶栏", () => {
	assert.equal(resolveHeaderHidden(true, { ...mobile, scrollTop: 0, delta: 500 }), false);
});

test("向上滚 8px 以上立即展开，8px 以内保持原状", () => {
	assert.equal(resolveHeaderHidden(true, { ...mobile, delta: -9 }), false);
	assert.equal(resolveHeaderHidden(true, { ...mobile, delta: -8 }), true);
	assert.equal(resolveHeaderHidden(true, { ...mobile, delta: -7 }), true);
});

test("向下滚 24px 以上收起，24px 以内保持原状", () => {
	assert.equal(resolveHeaderHidden(false, { ...mobile, delta: 25 }), true);
	assert.equal(resolveHeaderHidden(false, { ...mobile, delta: 24 }), false);
	assert.equal(resolveHeaderHidden(true, { ...mobile, delta: 24 }), true);
});

test("无位移时保持上一次状态", () => {
	assert.equal(resolveHeaderHidden(true, { ...mobile, delta: 0 }), true);
	assert.equal(resolveHeaderHidden(false, { ...mobile, delta: 0 }), false);
});

test("断点边界：760 算移动，761 算桌面", () => {
	assert.equal(isMobileViewport(WEB_MOBILE_MAX_WIDTH), true);
	assert.equal(isMobileViewport(WEB_MOBILE_MAX_WIDTH + 1), false);
	assert.equal(resolveHeaderHidden(true, { ...mobile, viewportWidth: WEB_MOBILE_MAX_WIDTH, delta: 500 }), true);
});

test("非浏览器环境按桌面处理", () => {
	assert.equal(readViewportWidth(), Number.POSITIVE_INFINITY);
});

test("CSS 断点与 JS 常量同源", () => {
	const css = readFileSync("src/renderer/src/web/web.css", "utf8");
	assert.match(css, new RegExp(`@media\\s*\\(max-width:\\s*${WEB_MOBILE_MAX_WIDTH}px\\)`), "web.css 的移动断点必须等于 WEB_MOBILE_MAX_WIDTH，否则 JS 判定与 CSS 布局会漂移");
	const source = readFileSync("src/renderer/src/web/webViewport.ts", "utf8");
	assert.doesNotMatch(source, /from\s+"react"/, "webViewport 是纯模块：引入 React 会让断点判定无法脱离浏览器单测");
});

test("接线契约：收起靠 grid-rows + inert，滚动回调来自时间线", () => {
	const header = readFileSync("src/renderer/src/web/WebHeader.tsx", "utf8");
	assert.match(header, /grid-rows-\[0fr\]/, "收起必须用 grid-rows 过渡，不能用拍脑袋的 max-height");
	assert.match(header, /inert=\{\s*Boolean\(\s*props\.headerHidden\s*\)\s*\}/, "收起态必须 inert：overflow-hidden 只裁剪，看不见的按钮仍可被 Tab 命中");
	assert.match(header, /aria-hidden=\{\s*props\.headerHidden\s*\|\|\s*undefined\s*\}/);

	const app = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
	assert.match(app, /onScrollTopChange=\{handleTimelineScroll\}/);
	assert.match(app, /data-header-hidden=\{\s*headerHidden\s*\?\s*"on"\s*:\s*undefined\s*\}/);

	const timeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
	assert.match(timeline, /props\.onScrollTopChange\?\.\(\s*el\.scrollTop\s*,\s*delta\s*\)/, "滚动回调必须在既有 onScroll 里上报，不新增监听器");
	assert.match(timeline, /!programmatic\s*&&\s*previousScrollTop\s*!==\s*null\s*&&\s*Math\.abs\(\s*delta\s*\)\s*<=\s*el\.clientHeight/, "程序化滚动与超一屏的跳转都不得触发收起");

	const css = readFileSync("src/renderer/src/web/web.css", "utf8");
	assert.match(timeline, /\[\[data-header-hidden=on\]_&\]:scroll-mt-0/, "顶栏收起后消息跳转不再为头部留白（用 Tailwind 任意变体，不写手写 CSS）");
	assert.doesNotMatch(readFileSync("src/renderer/src/web/web.css", "utf8"), /scroll-mt-24/, "web.css 不得再手写规则去压 utility");
});

test("接线契约：自动贴底与回到底部算程序化滚动，不参与顶栏收起判定", () => {
	const timeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
	assert.match(timeline, /programmaticScrollRef\.current\s*=\s*true[\s\S]{0,120}el\.scrollTo\(\s*\{\s*top:\s*el\.scrollHeight\s*\}\s*\)/, "流式自动贴底必须先标记程序化，再 scrollTo");
	assert.match(timeline, /suppressUntilNearBottomRef\.current\s*=\s*true/, "回到底部的平滑滚动要持续抑制到贴底为止");
	assert.match(timeline, /const\s+programmatic\s*=\s*programmaticScrollRef\.current\s*\|\|\s*suppressUntilNearBottomRef\.current/, "上报前必须同时看两个抑制标记");
	assert.match(timeline, /if\s*\(!programmatic\s*&&\s*previousScrollTop\s*!==\s*null/, "程序化滚动不得上报位移");
});

test("step：单帧小位移累计后收起（真实滚动每帧只有几像素）", () => {
	let state = INITIAL_HEADER_AUTO_HIDE_STATE;
	for (const delta of [5, 5, 5, 5, 5]) state = stepHeaderAutoHide(state, { scrollTop: 400, delta, viewportWidth: 375, forceVisible: false });
	assert.equal(state.hidden, true, "累计 25px 应收起");
	assert.equal(state.direction, 1);
});

test("step：方向翻转清零累计，反向一小段就恢复", () => {
	let state = { hidden: true, direction: 1, distance: 30 };
	state = stepHeaderAutoHide(state, { scrollTop: 400, delta: -4, viewportWidth: 375, forceVisible: false });
	assert.equal(state.hidden, true, "刚反向 4px 未达 -8 阈值，保持收起");
	state = stepHeaderAutoHide(state, { scrollTop: 396, delta: -5, viewportWidth: 375, forceVisible: false });
	assert.equal(state.hidden, false, "反向累计 9px 恢复（阈值是严格 < -8）");
	assert.equal(state.distance, 0, "状态翻转后累计清零");
});

test("step：forceVisible 优先，且不破坏后续判定", () => {
	const state = stepHeaderAutoHide({ hidden: true, direction: 1, distance: 30 }, { scrollTop: 400, delta: 100, viewportWidth: 375, forceVisible: true });
	assert.equal(state.hidden, false);
});

test("step：零位移不改状态", () => {
	const before = { hidden: true, direction: -1, distance: 12 };
	assert.deepEqual(stepHeaderAutoHide(before, { scrollTop: 400, delta: 0, viewportWidth: 375, forceVisible: false }), before);
});

test("接线契约：状态机抽到 hook，WebChatApp 不再自己维护累计", () => {
	const app = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
	assert.match(app, /useWebHeaderAutoHide\(\(\)\s*=>\s*overlayOpenRef\.current\)/);
	assert.doesNotMatch(app, /headerScrollRef/, "累计/方向翻转必须在 hook 内，不能再散在 1100 行的组件里");
	const hook = readFileSync("src/renderer/src/web/useWebHeaderAutoHide.ts", "utf8");
	assert.match(hook, /stepHeaderAutoHide\(/, "hook 只做持有状态与上报，判定走纯 step 函数");
});

test("接线契约：窄屏下键盘/焦点能唤回收起的顶栏（inert 之后没有别的恢复路径）", () => {
	const app = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
	assert.match(app, /addEventListener\("keydown",\s*onKeyDown,\s*true\)/);
	assert.match(app, /addEventListener\("focusin",\s*onFocusIn,\s*true\)/);
	assert.match(app, /removeEventListener\("keydown",\s*onKeyDown,\s*true\)/, "监听必须有配对清理");
	assert.match(app, /removeEventListener\("focusin",\s*onFocusIn,\s*true\)/);
});
