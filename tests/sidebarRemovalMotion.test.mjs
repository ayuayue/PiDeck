import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

function load({ present = true, reduced = false } = {}) {
	const host = quickMessageHookHost();
	const api = createTsSandbox({
		stubs: {
			react: { ...host.react, createContext: () => ({ Provider: "provider" }), forwardRef: (render) => render, useContext: () => 7, useId: () => "sidebar", useLayoutEffect: host.react.useEffect },
			"react/jsx-runtime": { jsx: (type, props) => ({ type, props }) },
			"motion/react": { motion: { div: "motion-div" }, useIsPresent: () => present, useReducedMotion: () => reduced, AnimatePresence: "presence", LayoutGroup: "layout-group" },
			"../../lib/utils": { cn: (...args) => args.filter(Boolean).join(" ") },
		},
	})("src/renderer/src/components/removal/RemovalList.tsx");
	return { ...api, host };
}

function renderRow(options) {
	// 2026-10 第二批：原语迁至 components/removal/RemovalList（导出名 RemovalRow/RemovalList），
	// 侧栏旧名只作为薄包装 re-export 保留，行为断言全部指向共享模块。
	return load(options).RemovalRow({ itemId: "row-a", children: "content" }).props;
}

test("real deletion fades briefly and shifts sibling positions without squeezing row height", () => {
	const row = renderRow();
	const exit = row.variants.removed([]);
	assert.equal(exit.opacity, 0);
	assert.equal(exit.transition.duration, 0.1);
	assert.equal(exit.height, undefined);
	assert.equal(exit.marginTop, undefined);
	assert.equal(row.layout, "position");
	assert.equal(row.layoutDependency, 7);
	assert.equal(row.transition.layout.duration, 0.16);
	assert.equal(row.initial, false);
});

test("search filtering or source filtering is not treated as a deleted record", () => {
	assert.equal(renderRow().variants.removed(["row-a"]).transition.duration, 0);
});

test("reduced motion skips both fade and sibling movement", () => {
	const row = renderRow({ reduced: true });
	assert.equal(row.variants.removed([]).transition.duration, 0);
	assert.equal(row.transition.layout.duration, 0);
});

test("retained exiting rows are inert and hidden from assistive navigation", () => {
	const row = renderRow({ present: false });
	assert.equal(row.inert, true);
	assert.equal(row["aria-hidden"], true);
	assert.match(row.className, /pointer-events-none/);
});

test("layout measurements are keyed only by real record removals, not ordinary rerenders or additions", () => {
	const { host, RemovalList } = load();
	const generation = (ids) => host.render(() => RemovalList({ remainingIds: ids, children: "rows" })).props.value;
	assert.equal(generation(["a", "b"]), 0);
	assert.equal(generation(["a", "b"]), 0);
	assert.equal(generation(["b", "a"]), 0);
	assert.equal(generation(["b", "a", "c"]), 0);
	assert.equal(generation(["a", "c"]), 1);
	assert.equal(generation(["a", "c"]), 1);
	assert.equal(generation(["c"]), 2);
});

/**
 * 重排/新增位移（P0-1 侧栏列表）。
 *
 * orderSensitive 由调用方声明「这份列表的顺序本身是用户语义」：
 * - 项目列表：顺序只由拖拽决定 → 开启，重排与新增时其余行播 0.16s 位移；
 * - 会话列表：按 updatedAt 实时排序，顺序随消息变化不是用户动作 → 不开启，
 *   否则每次流式刷新都会整列重新测量。
 */
test("orderSensitive 列表在重排与新增时 bump 布局生成数", () => {
	const { host, RemovalList } = load();
	const gen = (ids) => host.render(() => RemovalList({ remainingIds: ids, children: "rows", orderSensitive: true })).props.value;

	assert.equal(gen(["a", "b"]), 0, "首帧不触发测量");
	assert.equal(gen(["a", "b"]), 0, "顺序未变的重渲不触发测量");
	assert.equal(gen(["b", "a"]), 1, "拖拽重排必须触发一次测量，否则行瞬跳");
	assert.equal(gen(["a", "b"]), 2, "换回原顺序同样是一次重排");
	assert.equal(gen(["a", "b", "c"]), 3, "新增条目让后续行位移，也算顺序变化");
	assert.equal(gen(["a", "b", "c"]), 3, "内容不变的重渲不再测量");
});

test("移除与重排同时发生时只 bump 一次（removed || reordered）", () => {
	const { host, RemovalList } = load();
	const gen = (ids) => host.render(() => RemovalList({ remainingIds: ids, children: "rows", orderSensitive: true })).props.value;

	assert.equal(gen(["a", "b", "c"]), 0);
	assert.equal(gen(["a", "c"]), 1, "移除同时也改变了顺序签名，但只算一次结构变动");
});

test("orderSensitive 是显式 opt-in：默认列表（会话）不因重排测量", () => {
	const { host, RemovalList } = load();
	const gen = (ids) => host.render(() => RemovalList({ remainingIds: ids, children: "rows" })).props.value;

	assert.equal(gen(["a", "b"]), 0);
	assert.equal(gen(["b", "a"]), 0, "会话按 updatedAt 排序，顺序变化不是用户动作，不测量");
	assert.equal(gen(["a", "c"]), 1, "真移除仍然测量");
});

test("接线：项目列表开启 orderSensitive，会话列表保持默认", () => {
	const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
	const sessionTree = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
	// 空白容忍：属性可能被格式化换行
	assert.match(projectTree, /<SidebarRemovalList\s+orderSensitive\s+remainingIds=/, "项目列表顺序由拖拽决定，必须开启");
	assert.doesNotMatch(sessionTree, /orderSensitive/, "会话列表按 updatedAt 实时排序，不得开启");
});
