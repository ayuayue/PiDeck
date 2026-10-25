import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
	return module.exports;
}

const railActive = compile("src/renderer/src/components/session/timeline/outlineRailActive.ts");

const positions = (...entries) => entries.map(([id, top]) => ({ id, top }));

function createIndex(items) {
	return railActive.createOutlineItemIndex(items);
}

test("outline active item follows the last checkpoint above the viewport anchor", () => {
	const active = railActive.resolveActiveOutlineItemId(positions(["one", -180], ["two", -12], ["three", 96]), 28);
	assert.equal(active, "two");
});

test("outline active item falls back to the first checkpoint below the viewport", () => {
	const active = railActive.resolveActiveOutlineItemId(positions(["one", 64], ["two", 240]), 28);
	assert.equal(active, "one");
});

test("large outlines resolve the active checkpoint without scanning every position", () => {
	const source = Array.from({ length: 16_384 }, (_, index) => ({
		id: `item-${index}`,
		top: index * 16,
	}));
	let indexedReads = 0;
	const measured = new Proxy(source, {
		get(target, property, receiver) {
			if (typeof property === "string" && /^\d+$/.test(property)) indexedReads += 1;
			return Reflect.get(target, property, receiver);
		},
	});

	assert.equal(railActive.resolveActiveOutlineItemId(measured, 12_345 * 16 + 8), "item-12345");
	assert.ok(indexedReads <= 20, `expected binary lookup, got ${indexedReads} position reads`);
});

test("sampled rail highlights the closest rendered checkpoint", () => {
	const source = ["first", "near", "target", "far", "last"].map((id) => ({ id }));
	const rail = [source[0], source[3], source[4]];
	const active = railActive.resolveVisibleRailActiveId("target", createIndex(source), rail);
	assert.equal(active, "far");
});

test("rendered active checkpoint remains exact when it is present on the rail", () => {
	const source = ["one", "two", "three"].map((id) => ({ id }));
	const active = railActive.resolveVisibleRailActiveId("two", createIndex(source), source);
	assert.equal(active, "two");
});

test("unknown active checkpoints do not highlight an unrelated rail tick", () => {
	const source = ["one", "two"].map((id) => ({ id }));
	assert.equal(railActive.resolveVisibleRailActiveId("missing", createIndex(source), source), undefined);
});

const activeHookSource = readFileSync("src/renderer/src/components/session/timeline/useTimelineOutlineActiveId.ts", "utf8");
const stickSource = readFileSync("src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts", "utf8");
const scrollerSource = readFileSync("src/renderer/src/components/agents/message-scroller.tsx", "utf8");
const controllerSource = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");

test("equivalent outline values do not force a rail recomputation", () => {
	const previous = [{ id: "one", role: "user", title: "First", time: "10:00" }];
	const equivalent = [{ id: "one", role: "user", title: "First", time: "10:00" }];
	const changed = [{ id: "one", role: "user", title: "Renamed", time: "10:00" }];

	assert.equal(railActive.areOutlineRailItemsEqual(previous, equivalent), true);
	assert.equal(railActive.areOutlineRailItemsEqual(previous, changed), false);
});
test("outline hook caches content positions and rate-limits remeasurement", () => {
	assert.match(activeHookSource, /const positionsRef = useRef/);
	assert.match(activeHookSource, /CONTENT_MEASURE_INTERVAL_MS = 120/);
	assert.match(activeHookSource, /resolveActiveOutlineItemId\(\s*positionsRef\.current/);
	assert.match(activeHookSource, /contentResizeObserver\?\.observe\(content\)/);
});

test("rail wheel input uses the stick-to-bottom wheel bridge", () => {
	assert.match(stickSource, /const scrollByWheel = useCallback<ScrollByWheel>/);
	// rail 输入没有嵌套滚动 target，直接走 applyWheelOnScroll（escape 解析在
	// applyWheelEscape 内，仅处理带 target 的事件路径）
	assert.match(stickSource, /const scrollByWheel = useCallback<ScrollByWheel>\(\s*\(deltaY\) => \{[\s\S]*?applyWheelOnScroll\(scroll, deltaY\);[\s\S]*?scroll\.scrollBy\(\{\s*top: deltaY\s*\?*[\s\S]{0,20}?\}\)/);
	assert.match(scrollerSource, /scrollByWheel: engineScrollByWheel/);
	assert.match(controllerSource, /api\.scrollByWheel\(deltaY\)/);
});
