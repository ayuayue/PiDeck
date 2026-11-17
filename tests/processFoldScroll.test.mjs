import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** 渲染真实折叠区，检查内容顺序、挂载预算与滚动归属；子行只替换绘制。 */
function foldHarness(count = 6) {
	const host = quickMessageHookHost();
	const jsx = (type, props, key) => ({ type, props, key });
	let scrollEngines = 0;
	const load = createTsSandbox({
		stubs: {
			react: { ...host.react, memo: (component) => component },
			"react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
			"lucide-react": { ChevronUp: "icon" },
			"../../../i18n": { t: (key) => key },
			"../../../lib/hooks/use-render-reuse": { useStableKeyedHandlers: (factory) => factory },
			"../../../lib/stick-to-bottom": {
				useStickToBottom: () => {
					scrollEngines++;
					return { scrollRef: { current: null }, contentRef: { current: null }, noteWheel() {} };
				},
			},
			"../../ui-shadcn/virtual-stack": { VirtualStack: "stack" },
			"./ErrorStep": { ErrorStep: "error" },
			"./InterimAnswer": { InterimAnswer: "interim" },
			"./ProcessGroupStep": { ProcessGroupStep: "group" },
			"./RetryStep": { RetryStep: "retry" },
			"./useProcessGroupState": { isGroupOpen: () => false },
		},
	});
	const { ProcessFold } = load("src/renderer/src/components/session/turn/ProcessFold.tsx");
	const { PROCESS_FOLD_NODE_LIMIT: limit } = load("src/renderer/src/components/session/timeline/turnMountBudget.ts");
	let nodes = Array.from({ length: count }, (_, index) => ({ kind: "interim", id: `row-${index}`, message: { text: `detail-${index}` } }));
	const render = (overrides = {}) => host.render(() => ProcessFold({ nodes, stepsVisible: true, groupState: {}, onToggleGroup() {}, onOpenExternal() {}, onCollapse() {}, ...overrides }));
	return {
		render,
		limit,
		engines: () => scrollEngines,
		append: () => {
			nodes = [...nodes, { kind: "interim", id: `row-${nodes.length}`, message: { text: "appended" } }];
		},
		unmount: host.unmount,
	};
}

function descendants(tree) {
	if (!tree || typeof tree !== "object") return [];
	return [tree, ...[tree.props?.children].flat(Infinity).flatMap(descendants)];
}

test("展开的执行过程自然参与会话布局，不建立独立滚动或追底引擎", () => {
	const h = foldHarness();
	const tree = descendants(h.render({ agentRunning: true }));
	assert.equal(h.engines(), 0, "流式跟随应只由会话滚动区管理");
	for (const element of tree) {
		assert.doesNotMatch(element.props?.className ?? "", /overflow-(?:y-)?(?:auto|scroll)|max-h-/);
		assert.equal(element.props?.onWheel, undefined, "过程区不得认领滚轮");
	}
	assert.deepEqual(
		tree.filter((node) => node.type === "interim").map((node) => node.props.messageId),
		["row-0", "row-1", "row-2", "row-3", "row-4", "row-5"],
	);
	h.unmount();
});

test("过程区按时序显示已落盘正文，跳过外层已挂载的 live 正文", () => {
	const h = foldHarness();
	const rows = descendants(h.render({ liveInterimId: "row-3" })).filter((node) => node.type === "interim");
	assert.deepEqual(
		rows.map((node) => node.props.messageId),
		["row-0", "row-1", "row-2", "row-4", "row-5"],
	);
	h.unmount();
});

test("无内部虚拟视口后仍限制初始 DOM，按批展开的旧内容不会被追加内容挤走", () => {
	const h = foldHarness(200);
	assert.ok(h.limit <= 32, "自然高度的过程区必须保持较小的默认挂载量");
	let tree = descendants(h.render());
	assert.equal(tree.filter((node) => node.type === "interim").length, h.limit);
	const earlier = tree.find((node) => node.type === "button" && node.props.title === "timeline.showEarlierSteps");
	assert.ok(earlier, "更早的内容必须有可达入口");
	earlier.props.onClick();
	tree = descendants(h.render());
	const expanded = tree.filter((node) => node.type === "interim");
	assert.equal(expanded.length, h.limit * 2);
	h.append();
	const appended = descendants(h.render()).filter((node) => node.type === "interim");
	assert.equal(appended[0].props.messageId, expanded[0].props.messageId);
	assert.equal(appended.at(-1).props.text, "appended");
	h.unmount();
});
