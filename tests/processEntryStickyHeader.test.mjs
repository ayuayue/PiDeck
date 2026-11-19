import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const TURN_PATH = "src/renderer/src/components/session/turn/";
const policy = () => loadTsCommonJs(`${TURN_PATH}processEntryStickyPolicy.ts`);
const normalize = (value) => JSON.parse(JSON.stringify(value));

/** 每例只覆盖一个几何边界，默认视口 200px、展开项 800px。 */
function metrics(overrides = {}) {
	return { expanded: true, viewportTop: 100, viewportHeight: 200, entryTop: 40, entryBottom: 840, entryHeight: 800, headerHeight: 28, ...overrides };
}

for (const [name, changes, expected] of [
	["长展开项跨过组体顶部时吸顶", {}, { sticky: true, pinned: true }],
	["短项不启用吸顶", { entryHeight: 180 }, { sticky: false, pinned: false }],
	["恰好与视口等高不启用吸顶", { entryHeight: 200 }, { sticky: false, pinned: false }],
	["未展开项不启用吸顶", { expanded: false }, { sticky: false, pinned: false }],
	["标题还在原位时不显示回到开头图标", { entryTop: 100 }, { sticky: true, pinned: false }],
	["尚未进入视口的项不显示吸顶操作", { entryTop: 450 }, { sticky: true, pinned: false }],
	["离开当前项后旧标题退场", { entryBottom: 128 }, { sticky: true, pinned: false }],
	["滚动的亚像素偏差不触发图标闪烁", { entryTop: 99.5 }, { sticky: true, pinned: false }],
	["隐藏的组体不启用吸顶", { viewportHeight: 0 }, { sticky: false, pinned: false }],
	["非有限几何值不启用吸顶", { entryTop: Number.NaN }, { sticky: false, pinned: false }],
]) {
	test(name, () => assert.deepEqual(normalize(policy().resolveProcessEntryStickyState(metrics(changes))), expected));
}

test("回到本项开头的位置取原始 section，不取已经吸顶的 header", () => {
	assert.equal(policy().processEntryStartOffset({ entryTop: 40, viewportTop: 100, scrollTop: 400 }), 340);
});

test("开头位置不落到负值，非法输入不写入滚动容器", () => {
	assert.equal(policy().processEntryStartOffset({ entryTop: 80, viewportTop: 100, scrollTop: 0 }), 0);
	assert.equal(policy().processEntryStartOffset({ entryTop: Number.NaN, viewportTop: 100, scrollTop: 0 }), null);
});

/** 在现有 React 槽位宿主上补本域所需 hooks，不另造 TS/vm 加载器。 */
function reactHost() {
	const host = quickMessageHookHost();
	return { ...host, react: { ...host.react, useLayoutEffect: host.react.useEffect, useMemo: (factory, deps) => host.react.useCallback(factory(), deps) } };
}

/** 几何与滚动引擎均为替身；重点断言 hook 订阅、恢复与卸载的公开效果。 */
function entryHarness(options = {}) {
	const host = reactHost();
	const focusCalls = [];
	let belongsToGroup = true;
	const scroll = { clientTop: 0, clientHeight: 200, scrollTop: 400, getBoundingClientRect: () => ({ top: 100 }), contains: () => belongsToGroup };
	const makeControl = (sink) => ({
		scrollRef: { current: scroll },
		restoreAt: (offset) => sink.restored.push(offset),
		subscribeGeometry: (listener) => {
			sink.subscribers.add(listener);
			return () => sink.subscribers.delete(listener);
		},
	});
	const groupSink = { subscribers: new Set(), restored: [] };
	const sessionSink = { subscribers: new Set(), restored: [] };
	const groupControl = makeControl(groupSink);
	const sessionControl = makeControl(sessionSink);
	// hasGroupControls=false 模拟「组外 / 组体不提供几何」：此时才退回会话几何。
	const state = { insideGroup: true, hasGroupControls: options.hasGroupControls ?? true };
	const load = createTsSandbox({
		stubs: {
			react: { ...host.react, useContext: () => sessionControl },
			// 生产实现读会话几何后 restoreAt(当前位移) 解锁锁底；这里用同一个替身上报。
			"../../agents/message-scroller-context": { MessageScrollerGeometryContext: {}, usePauseSessionFollow: () => () => sessionControl.restoreAt(scroll.scrollTop) },
			"./processGroupScrollContext": { useInsideProcessGroupBody: () => state.insideGroup, useProcessGroupScrollControls: () => (state.hasGroupControls ? groupControl : null) },
		},
	});
	const { useProcessEntryStickyHeader } = load(`${TURN_PATH}useProcessEntryStickyHeader.ts`);
	const render = (expanded = true) => host.render(() => useProcessEntryStickyHeader(expanded));
	const initial = render();
	initial.entryRef.current = { offsetHeight: 800, getBoundingClientRect: () => ({ top: 40, bottom: 840 }) };
	initial.headerRef.current = { offsetHeight: 28, querySelector: () => ({ focus: (options) => focusCalls.push(options) }) };
	const notify = () => {
		for (const listener of [...groupSink.subscribers, ...sessionSink.subscribers]) listener();
	};
	notify();
	return {
		render,
		notify,
		focusCalls,
		unmount: host.unmount,
		groupSubscribers: groupSink.subscribers,
		sessionSubscribers: sessionSink.subscribers,
		groupRestored: groupSink.restored,
		sessionRestored: sessionSink.restored,
		leaveGroup: () => {
			state.insideGroup = false;
			state.hasGroupControls = false;
		},
		detachEntry: () => {
			belongsToGroup = false;
		},
	};
}

test("组内行订阅组体视口的几何变化（不是会话视口），滚动不直接驱动整个过程组重渲染", () => {
	const h = entryHarness();
	assert.equal(h.groupSubscribers.size, 1);
	assert.equal(h.sessionSubscribers.size, 0, "组体有几何时不得再订会话视口");
	assert.equal(h.render().pinned, true);
	assert.equal(h.render().sticky, true);
	h.unmount();
	assert.equal(h.groupSubscribers.size, 0);
});

test("组体不提供几何时退回会话视口", () => {
	const h = entryHarness({ hasGroupControls: false });
	assert.equal(h.sessionSubscribers.size, 1);
	assert.equal(h.groupSubscribers.size, 0);
	assert.equal(h.render().pinned, true);
	h.unmount();
});

test("回到开头经 restoreAt 解锁跟底，并把键盘焦点留在原标题", () => {
	const h = entryHarness();
	h.render().returnToStart();
	assert.deepEqual(h.groupRestored, [340]);
	assert.deepEqual(h.sessionRestored, [], "组内定位只能改组体滚动，不得动会话视口");
	assert.deepEqual(normalize(h.focusCalls), [{ preventScroll: true }]);
});

test("在标题已滚走时收起，先恢复本项锚点", () => {
	const h = entryHarness();
	h.render().prepareCollapse();
	assert.deepEqual(h.groupRestored, [340]);
});

test("未展开时没有几何订阅，也不改变滚动位置", () => {
	const h = entryHarness();
	const row = h.render(false);
	row.prepareCollapse();
	assert.equal(h.groupSubscribers.size, 0);
	assert.deepEqual(h.groupRestored, []);
	assert.equal(h.render(false).sticky, false);
});

test("开合成员：只在变大时停跟底，且组体与会话两层都停", () => {
	const h = entryHarness();
	const api = h.render();
	// 本用例只看「暂停跟底」这一层：把标题挪到视口下方，免得 prepareCollapse 顺手回到本项开头。
	api.entryRef.current = { offsetHeight: 800, getBoundingClientRect: () => ({ top: 120, bottom: 920 }) };
	api.prepareToggle(true);
	assert.deepEqual(h.groupRestored, [400]);
	assert.deepEqual(h.sessionRestored, [400], "组体还没到限高时，成员展开会把会话也一起撑高");
	api.prepareToggle(false);
	assert.deepEqual(h.groupRestored, [400], "收起不会把读者拽走，不得再停一次");
	assert.deepEqual(h.sessionRestored, [400]);
	h.unmount();
});

test("组外开合成员不动任何滚动位置（扁平路径保持既有行为）", () => {
	const h = entryHarness({ hasGroupControls: false });
	h.leaveGroup();
	h.render().prepareToggle(true);
	assert.deepEqual(h.groupRestored, []);
	assert.deepEqual(h.sessionRestored, []);
	h.unmount();
});

test("移出过程组后不残留吸顶状态和订阅", () => {
	const h = entryHarness();
	h.leaveGroup();
	h.render();
	assert.equal(h.groupSubscribers.size, 0);
	assert.equal(h.sessionSubscribers.size, 0);
	assert.equal(h.render().sticky, false);
	h.render().returnToStart();
	assert.deepEqual(h.groupRestored, []);
	assert.deepEqual(h.sessionRestored, []);
});

test("已经脱离当前组体的迟到几何通知不得显示吸顶或恢复位置", () => {
	const h = entryHarness();
	h.detachEntry();
	h.notify();
	assert.equal(h.render().pinned, false);
	h.render().returnToStart();
	assert.deepEqual(h.groupRestored, []);
});

/** 一个会话只有一组监听和 ResizeObserver；多个组的行共享一帧通知。 */
function geometryHarness() {
	const host = reactHost();
	const frames = new Map();
	const listeners = new Map();
	const observers = [];
	let nextFrame = 0;
	const scrollRef = {
		current: {
			addEventListener: (event, listener) => listeners.set(event, listener),
			removeEventListener: (event, listener) => {
				if (listeners.get(event) === listener) listeners.delete(event);
			},
		},
	};
	const contentRef = { current: {} };
	const load = createTsSandbox({
		stubs: { react: host.react },
		globals: {
			requestAnimationFrame: (callback) => {
				const id = ++nextFrame;
				frames.set(id, callback);
				return id;
			},
			cancelAnimationFrame: (id) => frames.delete(id),
			ResizeObserver: class {
				constructor(callback) {
					this.callback = callback;
					this.targets = [];
					this.disconnected = false;
					observers.push(this);
				}
				observe(target) {
					this.targets.push(target);
				}
				disconnect() {
					this.disconnected = true;
				}
			},
		},
	});
	const { useMessageScrollerGeometry } = load("src/renderer/src/components/agents/message-scroller-context.ts");
	const restoreAt = () => {};
	const render = () => host.render(() => useMessageScrollerGeometry(scrollRef, contentRef, restoreAt));
	const controls = render();
	return {
		render,
		controls,
		frames,
		listeners,
		observers,
		unmount: host.unmount,
		flush: () => {
			const callbacks = [...frames.values()];
			frames.clear();
			for (const callback of callbacks) callback();
		},
	};
}

test("多个项和密集滚动/尺寸变化共用一帧通知", () => {
	const h = geometryHarness();
	let first = 0;
	let second = 0;
	h.controls.subscribeGeometry(() => first++);
	h.controls.subscribeGeometry(() => second++);
	h.listeners.get("scroll")();
	h.listeners.get("scroll")();
	h.observers[0].callback();
	assert.equal(h.frames.size, 1);
	h.flush();
	assert.deepEqual([first, second], [1, 1]);
	assert.equal(h.listeners.size, 1);
	assert.equal(h.observers[0].targets.length, 2);
});

test("会话视口卸载时取消监听、尺寸观察和未结算帧", () => {
	const h = geometryHarness();
	h.controls.subscribeGeometry(() => {});
	assert.equal(h.frames.size, 1);
	h.unmount();
	assert.equal(h.frames.size, 0);
	assert.equal(h.listeners.size, 0);
	assert.equal(h.observers[0].disconnected, true);
});

test("订阅解除后不再通知已卸载行，会话卸载释放资源", () => {
	const h = geometryHarness();
	let notifications = 0;
	const unsubscribe = h.controls.subscribeGeometry(() => notifications++);
	unsubscribe();
	h.flush();
	assert.equal(notifications, 0);
	h.unmount();
	assert.equal(h.listeners.size, 0);
	assert.equal(h.frames.size, 0);
	assert.equal(h.observers[0].disconnected, true);
});

test("工具与思考复用只含图标和 Tooltip 的回到开头入口，不新增图钉或收起动作", () => {
	for (const file of ["ToolCallComponents.tsx", "TimelineEventCards.tsx"]) {
		const source = readFileSync(`src/renderer/src/components/session/${file}`, "utf8");
		assert.match(source, /useProcessEntryStickyHeader\(expanded\)/);
		assert.match(source, /data-process-entry-header/);
		assert.match(source, /<ProcessEntryReturnToStart\s+onClick=\{sticky\.returnToStart\}/);
	}
	const source = readFileSync(`${TURN_PATH}ProcessEntryReturnToStart.tsx`, "utf8");
	assert.match(source, /<TooltipTrigger\s+asChild>/);
	assert.match(source, /aria-label=\{label\}/);
	assert.match(source, /<TooltipContent[\s\S]*?\{label\}/);
	assert.match(source, /<ArrowUpToLine\b/);
	assert.doesNotMatch(source, /\bPin\b|ChevronUp|collapse|<span/);
});

test("父级先关闭后，子项退订不得重新排入未清理的动画帧", () => {
	const h = geometryHarness();
	const first = h.controls.subscribeGeometry(() => {});
	const second = h.controls.subscribeGeometry(() => {});
	h.unmount();
	first();
	second();
	assert.equal(h.frames.size, 0);
	assert.equal(h.listeners.size, 0);
});

test("吸顶面的悬停底色必须保持不透明，不能透出下面的输出", () => {
	const source = readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");
	const pinnedClasses = source.match(/sticky\.pinned\s*&&\s*"([^"]+)"/)?.[1] ?? "";
	assert.match(pinnedClasses, /bg-bg-app/);
	assert.match(pinnedClasses, /hover:bg-\[color:color-mix\(in_srgb,var\(--color-bg-hover\)_50%,var\(--color-bg-app\)\)\]/);
	assert.doesNotMatch(pinnedClasses, /transparent/);
});

test("Tooltip 的字号覆盖不得被 class 合并器误判为颜色并删掉正文色", () => {
	const source = readFileSync(`${TURN_PATH}ProcessEntryReturnToStart.tsx`, "utf8");
	const fontClass = source.match(/<TooltipContent\b[^>]*?className="([^"]+)"/)?.[1];
	assert.ok(fontClass);
	const { cn } = loadTsCommonJs("src/renderer/src/lib/utils.ts");
	const merged = cn("bg-foreground text-background text-xs", fontClass);
	assert.ok(merged.split(/\s+/).includes("text-background"), "字号覆盖必须保留 Tooltip 面上的对比文字色");
});
