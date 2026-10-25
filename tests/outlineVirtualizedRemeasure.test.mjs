import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const HOOK_SOURCE = "src/renderer/src/components/session/timeline/useTimelineOutlineActiveId.ts";

// 只 stub 模块求值需要的 React 入口：本文件的守卫是「观察配置 + 接线」，不执行 hook 生命周期
// （Node 测试环境没有 DOM/MutationObserver，跑不了真实 observer 回调）。
const reactStub = {
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => undefined],
	useRef: (initial) => ({ current: initial }),
	useEffect: () => undefined,
	useLayoutEffect: () => undefined,
	useCallback: (callback) => callback,
	useMemo: (factory) => factory(),
};

const outline = loadTsCommonJs(HOOK_SOURCE, { stubs: { react: reactStub } });
// 行根选择器的唯一真值在 visible-rows 模块，探针与生产共用同一份字面量。
const visibleRows = loadTsCommonJs("src/renderer/src/hooks/timeline/useVisibleTimelineRows.ts", { stubs: { react: reactStub } });

test("outline observer covers rows mounted inside the virtual container", () => {
	assert.deepEqual({ ...outline.TIMELINE_MESSAGE_LIST_OBSERVER_OPTIONS }, { childList: true, subtree: true });
});

test("virtual row recycling re-measures positions through the throttled entry", () => {
	const source = readFileSync(HOOK_SOURCE, "utf8");
	// 只观察直接子节点收不到虚拟容器内部（VirtualRunList）的挂载/回收 —— #401 复审回归点。
	assert.match(source, /observe\(\s*messageList\s*,\s*TIMELINE_MESSAGE_LIST_OBSERVER_OPTIONS\s*\)/);
	// 回调必须落到 120ms 节流入口（scheduleContentMeasurement → scheduleSync(true) → measurePositions）。
	assert.match(source, /new MutationObserver\(\s*scheduleContentMeasurement\s*\)/);
	assert.match(source, /CONTENT_MEASURE_INTERVAL_MS\s*=\s*120/);
});

test("measureOutlineItemPositions 只扫行根（改前/改后扫描量与 rect 探针）", () => {
	// 同一场景：200 个 [data-message-id]，其中 10 个是行根、190 个是行内子卡。
	// 改前：querySelectorAll 返回 200 个元素、逐个读 dataset（虚拟化滚动时每 120ms 一次）；
	// 改后：querySelectorAll(ROOT_ROW_SELECTOR) 只返回 10 个行根。rect 次数两边都只对命中项。
	let afterRectCalls = 0;
	let afterScanned = 0;
	const makeRoot = (id) => ({
		dataset: { messageId: id },
		getBoundingClientRect: () => {
			afterRectCalls += 1;
			return { top: 42 };
		},
	});
	const roots = Array.from({ length: 10 }, (_, index) => makeRoot(`m${index}`));
	const cards = Array.from({ length: 190 }, (_, index) => ({ dataset: { messageId: `card-${index}` }, getBoundingClientRect: () => ({ top: 42 }) }));
	const ids = new Set(roots.map((element) => element.dataset.messageId));
	const timeline = {
		scrollTop: 0,
		getBoundingClientRect: () => {
			afterRectCalls += 1;
			return { top: 0 };
		},
		querySelectorAll: (selector) => {
			if (selector !== visibleRows.ROOT_ROW_SELECTOR) return [];
			afterScanned += roots.length;
			return roots;
		},
		querySelector: () => null,
	};
	const positions = outline.measureOutlineItemPositions(timeline, ids);
	assert.equal(positions.length, 10, "每个大纲项都要测到");
	assert.equal(afterRectCalls, 11, "改后：10 个行根 + 1 次容器 rect");
	assert.equal(afterScanned, 10, "改后只扫 10 个行根");

	let legacyRectCalls = 0;
	let legacyScanned = 0;
	const legacyTimeline = {
		scrollTop: 0,
		getBoundingClientRect: () => ({ top: 0 }),
		querySelectorAll: () => {
			const all = [...roots, ...cards];
			legacyScanned += all.length;
			return all.map((element) => ({
				dataset: element.dataset,
				getBoundingClientRect: () => {
					legacyRectCalls += 1;
					return { top: 42 };
				},
			}));
		},
	};
	const legacyPositions = [];
	for (const element of legacyTimeline.querySelectorAll()) {
		const id = element.dataset.messageId;
		if (ids.has(id)) legacyPositions.push({ id, top: element.getBoundingClientRect().top });
	}
	assert.equal(legacyPositions.length, 10);
	assert.equal(legacyScanned, 200, "改前扫描 200 个 data-message-id");
	assert.equal(legacyRectCalls, 10, "旧实现也只对命中 id 取 rect");
	assert.ok(afterScanned * 20 <= legacyScanned, "同一场景扫描元素数下降一个量级以上");
});
