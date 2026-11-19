import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/**
 * 过程组组体的**行为**契约（渲染真实组件，只替换绘制与跟底引擎）。
 *
 * 组体从「自然高度」改回「限高窗」后，这四条必须同时成立：
 * 1. 限高 `min(640px,60vh)` + 隐藏滚动条 + **不写** contain（旧版死区就是 contain 造成的）；
 * 2. 隐藏滚动条后靠左侧竖线给上下方向提示，且只有真有可滚内容时才进 Tab 顺序；
 * 3. 暂停跟底只发生在「会当场长高」的入口（组头展开、「显示更早」），普通点击不暂停；
 * 4. 展开定位按通道分流（自动落底跟随 / 手动从头读），组体打开时注册跳转露出入口。
 *
 * 预算（`boundMountedSteps`）与本组件一起跑真模块；跟底引擎、子行组件是替身
 * （引擎的真实行为由 `tests/process-fold-scroll` 与 e2e 覆盖）。
 */
const GROUP_STEP = "src/renderer/src/components/session/turn/ProcessGroupStep.tsx";

const LUCIDE_ICONS = ["ChevronDown", "ChevronRight", "ChevronUp", "FilePlus", "FileText", "Globe", "Image", "ListChecks", "MessageCircleQuestion", "Network", "Puzzle", "Search", "Sparkles", "SquareCode", "SquarePen", "Terminal", "Wrench"];

/** 一个工具成员（只填渲染与预算关心的字段）。 */
function toolMember(index) {
	const id = `tool-${index}`;
	return { kind: "tool-entry", id, group: { kind: "tool-group", id, messages: [{ id, agentId: "a1", role: "tool", text: "", timestamp: index, meta: { toolName: "bash", status: "success" } }] } };
}

function groupOf(count) {
	return { kind: "group", id: "group-1", members: Array.from({ length: count }, (_, index) => toolMember(index)), counts: [{ kind: "commands", count }], toolCount: count, hasThinking: false, extensionCount: 0 };
}

function descendants(node) {
	if (!node || typeof node !== "object") return [];
	return [node, ...[node.props?.children].flat(Infinity).flatMap(descendants)];
}

/** 视口可滚 / 不可滚两种几何，用来驱动方向提示与 Tab 顺序。 */
const SCROLLABLE = { scrollTop: 0, scrollHeight: 900, clientHeight: 400 };
const FITTED = { scrollTop: 0, scrollHeight: 400, clientHeight: 400 };

function stepHarness(options = {}) {
	const host = quickMessageHookHost();
	const jsx = (type, props) => ({ type, props });
	const calls = { sessionPaused: 0, scrollToBottom: [], restoreAt: [], noted: [], registered: 0, unregistered: 0, engineOptions: [] };
	const scroller = { ...(options.scroller ?? SCROLLABLE) };
	const engine = {
		scrollRef: { current: scroller },
		contentRef: { current: {} },
		scrollToBottom: (scrollOptions) => calls.scrollToBottom.push(scrollOptions?.animation),
		restoreAt: (scrollTop) => calls.restoreAt.push(scrollTop),
		noteWheel: (deltaY) => calls.noted.push(deltaY),
	};
	const load = createTsSandbox({
		stubs: {
			react: { ...host.react, memo: (component) => component },
			"react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
			"lucide-react": Object.fromEntries(LUCIDE_ICONS.map((name) => [name, name])),
			"../../../../../shared/fileChanges": { getToolName: () => "bash" },
			"../../../i18n": { t: (key) => key },
			"../ShimmerText": { ShimmerText: "shimmer" },
			"../RowText": { RowText: "row-text" },
			"../timeline/groupTurnProcess": { lastToolCategory: () => "commands" },
			"../timeline/toolCategory": { activityCategoryLabelKey: () => "label", topActivityKinds: () => [] },
			"../timeline/toolPhrase": { getToolPhraseFromArgs: () => ({ object: "" }) },
			"./ThinkingStep": { ThinkingStep: "thinking" },
			"./ToolStep": { ToolStep: "tool" },
			"./ExtensionEntryStep": { ExtensionEntryStep: "extension" },
			"../../../lib/stick-to-bottom": {
				useStickToBottom: (engineOptions) => {
					calls.engineOptions.push(engineOptions);
					return engine;
				},
			},
			"../../agents/message-scroller-context": {
				usePauseSessionFollow: () => () => {
					calls.sessionPaused += 1;
				},
			},
			"../timeline/nestedScrollerReveal": {
				registerNestedScrollerRestore: () => {
					calls.registered += 1;
					return () => {
						calls.unregistered += 1;
					};
				},
			},
			"./processGroupScrollContext": { ProcessGroupBodyScrollContext: { Provider: "group-body-context" }, ProcessGroupScrollControlsContext: { Provider: "group-geometry-context" } },
			// 组体几何：只要把 refs/restoreAt 透出去，方向提示与吸顶就都不需要真实 ResizeObserver。
			"./useProcessGroupScrollGeometry": {
				useProcessGroupScrollGeometry: (_open, scrollRef, _contentRef, restoreAt) => ({ scrollRef, restoreAt, subscribeGeometry: () => () => {} }),
			},
		},
	});
	const { ProcessGroupStep } = load(GROUP_STEP);
	// 同一个 props 对象复用：host 的 hook 槽位靠依赖数组判定，重建对象会让每次渲染都重挂 effect。
	let props = null;
	const render = () => host.render(() => ProcessGroupStep(props));
	const click = (match) => {
		const node = descendants(render()).find(match);
		assert.ok(node, "目标可点击节点必须存在");
		node.props.onClick();
	};
	return {
		calls,
		scroller,
		render: (next) => {
			props = next;
			return render();
		},
		rerender: render,
		click,
		unmount: host.unmount,
	};
}

function scrollerNode(tree) {
	const node = descendants(tree).find((candidate) => candidate?.props && "data-process-group-scroller" in candidate.props);
	assert.ok(node, "组体必须带 data-process-group-scroller 锚点");
	return node;
}

function headNode(tree) {
	const node = descendants(tree).find((candidate) => candidate?.props && "data-process-group-head" in candidate.props);
	assert.ok(node, "组头必须带 data-process-group-head 锚点");
	return node;
}

function overflowNodes(tree) {
	return descendants(tree)
		.filter((candidate) => candidate?.props && "data-process-group-overflow" in candidate.props)
		.map((candidate) => candidate.props["data-process-group-overflow"]);
}

const baseProps = { group: groupOf(3), running: false, open: true, autoOpen: false, onToggle: () => {}, showThinking: false, onOpenExternal: () => {} };

test("组体复用会话同一个跟底引擎（instant），且不向外层上报跟随意图", () => {
	const h = stepHarness();
	h.render(baseProps);
	// 跨 vm 的对象原型不同，deepEqual 会报「结构相同但引用不等」，逐字段断言。
	const options = h.calls.engineOptions[0] ?? {};
	assert.equal(options.initial, "instant");
	assert.equal(options.resize, "instant");
	assert.equal(options.reportUserIntent, undefined, "组内滚动不得改变外层时间线的跟随态");
	h.unmount();
});

test("组体限高、滚动条隐藏，且不写 contain（到边要把滚轮交还会话）", () => {
	const h = stepHarness();
	const scroller = scrollerNode(h.render(baseProps));
	const className = scroller.props.className ?? "";
	assert.match(className, /max-h-\[min\(640px,60vh\)\]/);
	assert.match(className, /overflow-y-auto/);
	assert.match(className, /\[scrollbar-width:none\]/);
	assert.doesNotMatch(className, /overscroll-(contain|none)/, "contain 会切断滚动链，到边后谁都不滚");
	// 滚轮必须路由给组体引擎才能产生上滚逃逸 / 回底重锁。
	scroller.props.onWheel({ deltaY: -120, target: null });
	assert.deepEqual(h.calls.noted, [-120]);
});

test("可滚时上下方向提示独立出现，并把组体放进 Tab 顺序", () => {
	const scroller = { scrollTop: 300, scrollHeight: 900, clientHeight: 400 };
	const h = stepHarness({ scroller });
	h.render(baseProps);
	const tree = h.rerender(); // 第二条渲染才读到 useEffect 量出的溢出状态
	assert.deepEqual(overflowNodes(tree), ["up", "down"]);
	assert.equal(scrollerNode(tree).props.tabIndex, 0);
	h.unmount();
});

test("滚到顶只提示下方；滚到底只提示上方", () => {
	const top = stepHarness({ scroller: { scrollTop: 0, scrollHeight: 900, clientHeight: 400 } });
	top.render(baseProps);
	assert.deepEqual(overflowNodes(top.rerender()), ["down"]);
	top.unmount();

	const bottom = stepHarness({ scroller: { scrollTop: 500, scrollHeight: 900, clientHeight: 400 } });
	bottom.render(baseProps);
	assert.deepEqual(overflowNodes(bottom.rerender()), ["up"]);
	bottom.unmount();
});

test("内容装得下时不画提示，也不占 Tab 位", () => {
	const h = stepHarness({ scroller: FITTED });
	h.render(baseProps);
	const tree = h.rerender();
	assert.deepEqual(overflowNodes(tree), []);
	assert.equal(scrollerNode(tree).props.tabIndex, undefined);
	h.unmount();
});

test("组头展开时先停跟底再切换；收起方向不停（收起不会把读者拽走）", () => {
	const opened = stepHarness();
	const toggles = [];
	opened.render({ ...baseProps, open: false, onToggle: (next) => toggles.push(next) });
	headNode(opened.rerender()).props.onClick();
	assert.deepEqual(toggles, [true]);
	assert.equal(opened.calls.sessionPaused, 1, "展开组体会当场长高，必须停会话跟底");
	assert.ok(opened.calls.restoreAt.length >= 1, "组体自己的跟底也要停");
	opened.unmount();

	const closed = stepHarness();
	const closedToggles = [];
	closed.render({ ...baseProps, open: true, onToggle: (next) => closedToggles.push(next) });
	headNode(closed.rerender()).props.onClick();
	assert.deepEqual(closedToggles, [false]);
	assert.equal(closed.calls.sessionPaused, 0);
	closed.unmount();
});

test("「显示更早」属于长高动作：先停跟底，再按批把早期成员挂回来", () => {
	const h = stepHarness();
	h.render({ ...baseProps, group: groupOf(40) });
	const tree = h.rerender();
	const toolCount = (candidate) => descendants(candidate).filter((node) => node?.type === "tool").length;
	assert.equal(toolCount(tree), 32, "默认只挂最近 PROCESS_GROUP_MEMBER_LIMIT 个成员");
	const earlier = descendants(tree).find((node) => node?.type === "button" && node.props?.title === "timeline.showEarlierSteps");
	assert.ok(earlier, "超出预算必须有「显示更早」入口");
	earlier.props.onClick();
	assert.equal(h.calls.sessionPaused, 1);
	assert.ok(h.calls.restoreAt.length >= 1);
	assert.equal(toolCount(h.rerender()), 40, "点一次应把剩下的成员全部挂回来（40 ≤ 32×2）");
	h.unmount();
});

test("组体打开时注册跳转露出入口，关闭 / 卸载时注销", () => {
	const opened = stepHarness();
	opened.render(baseProps);
	assert.equal(opened.calls.registered, 1);
	opened.render({ ...baseProps, open: false });
	assert.equal(opened.calls.unregistered, 1);
	opened.unmount();

	const closed = stepHarness();
	closed.render({ ...baseProps, open: false });
	assert.equal(closed.calls.registered, 0);
	closed.unmount();
});

test("展开定位按通道分流：自动通道落底跟随，手动通道从头读", () => {
	const auto = stepHarness();
	auto.render({ ...baseProps, open: false });
	auto.render({ ...baseProps, open: true, autoOpen: true });
	assert.deepEqual(auto.calls.scrollToBottom, ["instant"]);
	assert.deepEqual(auto.calls.restoreAt, []);
	auto.unmount();

	const manual = stepHarness();
	manual.render({ ...baseProps, open: false });
	manual.render({ ...baseProps, open: true, autoOpen: false });
	assert.deepEqual(manual.calls.scrollToBottom, []);
	assert.deepEqual(manual.calls.restoreAt, [0]);
	manual.unmount();
});

test("组体把让位标记与自身几何交给组内行（吸顶 / 回到开头相对组体视口）", () => {
	const h = stepHarness();
	const tree = h.render(baseProps);
	const nodes = descendants(tree);
	const bodyContext = nodes.find((node) => node?.type === "group-body-context");
	const geometryContext = nodes.find((node) => node?.type === "group-geometry-context");
	const content = nodes.find((node) => node?.props && "data-process-group-content" in node.props);
	assert.ok(bodyContext?.props?.value === true, "组体必须告诉组内工具卡「内层让位」");
	assert.ok(geometryContext, "组体必须提供自身几何");
	assert.ok(content, "组内内容盒必须存在（跳转露出与跟底都观察它）");
	// 几何 provider 必须把内容盒包在里面，否则组内行拿不到视口几何。
	assert.ok(descendants(geometryContext).includes(content));
	h.unmount();
});
