import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 会话 Tab 固定/拖拽排序纯逻辑（sessionTabs）。
 * 不变量：tabs 始终为 [pinned...] + [normal...]（固定在前）。
 */

function loadSessionTabs() {
	const source = readFileSync("src/renderer/src/utils/sessionTabs.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: "sessionTabs.ts",
	}).outputText;
	const sandbox = { exports: {}, require: () => ({}) };
	vm.runInNewContext(output, sandbox, { filename: "sessionTabs.ts" });
	return sandbox.exports;
}

const json = (value) => JSON.stringify(value);

test("togglePinSessionTab: 固定后进入固定区末尾并保持前置不变量", () => {
	const { togglePinSessionTab } = loadSessionTabs();
	const tabs = ["a", "b", "c"]; // 全部普通
	const next = togglePinSessionTab(tabs, [], "b");
	assert.equal(json(next.pinned), json(["b"]));
	// b 移到普通区之前（固定区）
	assert.equal(json(next.tabs), json(["b", "a", "c"]));
});

test("togglePinSessionTab: 取消固定后回到普通区开头", () => {
	const { togglePinSessionTab } = loadSessionTabs();
	const tabs = ["b", "a", "c"]; // b 固定在前
	const next = togglePinSessionTab(tabs, ["b"], "b");
	assert.equal(json(next.pinned), json([]));
	// 普通区开头 = 紧跟（空的）固定区之后
	assert.equal(json(next.tabs), json(["a", "c", "b"]));
});

test("togglePinSessionTab: 已固定列表新增固定项不破坏顺序", () => {
	const { togglePinSessionTab } = loadSessionTabs();
	const tabs = ["p1", "p2", "n1", "n2"];
	const next = togglePinSessionTab(tabs, ["p1", "p2"], "n1");
	assert.equal(json(next.pinned), json(["p1", "p2", "n1"]));
	assert.equal(json(next.tabs), json(["p1", "p2", "n1", "n2"]));
});

test("reorderSessionTabs: 普通区内拖动排序", () => {
	const { reorderSessionTabs } = loadSessionTabs();
	const tabs = ["p1", "n1", "n2", "n3"];
	const next = reorderSessionTabs(tabs, ["p1"], "n3", "n1", "before");
	assert.equal(json(next.pinned), json(["p1"]));
	assert.equal(json(next.tabs), json(["p1", "n3", "n1", "n2"]));
	// after 插入
	const after = reorderSessionTabs(tabs, ["p1"], "n1", "n3", "after");
	assert.equal(json(after.tabs), json(["p1", "n2", "n3", "n1"]));
});

test("reorderSessionTabs: 固定区内拖动排序", () => {
	const { reorderSessionTabs } = loadSessionTabs();
	const tabs = ["p1", "p2", "p3", "n1"];
	const next = reorderSessionTabs(tabs, ["p1", "p2", "p3"], "p3", "p1", "before");
	assert.equal(json(next.tabs), json(["p3", "p1", "p2", "n1"]));
	assert.equal(json(next.pinned), json(["p1", "p2", "p3"]));
});

test("reorderSessionTabs: 普通拖入固定区自动转为固定", () => {
	const { reorderSessionTabs } = loadSessionTabs();
	const tabs = ["p1", "n1", "n2"];
	const next = reorderSessionTabs(tabs, ["p1"], "n1", "p1", "after");
	assert.equal(json(next.pinned), json(["p1", "n1"])); // n1 变为固定
	assert.equal(json(next.tabs), json(["p1", "n1", "n2"]));
});

test("reorderSessionTabs: 固定拖入普通区自动取消固定", () => {
	const { reorderSessionTabs } = loadSessionTabs();
	const tabs = ["p1", "p2", "n1"];
	const next = reorderSessionTabs(tabs, ["p1", "p2"], "p1", "n1", "after");
	assert.equal(json(next.pinned), json(["p2"])); // p1 取消固定
	assert.equal(json(next.tabs), json(["p2", "n1", "p1"]));
});

test("reorderSessionTabs: 拖到自身不做任何变化", () => {
	const { reorderSessionTabs } = loadSessionTabs();
	const tabs = ["p1", "n1"];
	const next = reorderSessionTabs(tabs, ["p1"], "n1", "n1", "before");
	assert.equal(json(next.tabs), json(["p1", "n1"]));
	assert.equal(json(next.pinned), json(["p1"]));
});

test("openPreviewSessionTab: 单击替换预览，不降级常驻 Tab", () => {
	const { openPreviewSessionTab } = loadSessionTabs();
	const first = openPreviewSessionTab(["a"], [], null, "b");
	assert.equal(json(first.tabs), json(["a", "b"]));
	assert.equal(first.previewId, "b");

	const replaced = openPreviewSessionTab(first.tabs, [], first.previewId, "c");
	assert.equal(json(replaced.tabs), json(["a", "c"]));
	assert.equal(replaced.previewId, "c");

	const resident = openPreviewSessionTab(["a", "c"], [], "c", "a");
	assert.equal(json(resident.tabs), json(["a", "c"]));
	assert.equal(resident.previewId, "c");
});

test("openPermanentSessionTab: 双击升格预览为常驻", () => {
	const { openPermanentSessionTab } = loadSessionTabs();
	const next = openPermanentSessionTab(["a", "b"], [], "b", "b");
	assert.equal(json(next.tabs), json(["a", "b"]));
	assert.equal(next.previewId, null);
});

test("openPermanentSessionTab: already-open resident tab keeps the same array", () => {
	const { openPermanentSessionTab } = loadSessionTabs();
	const tabs = ["a", "b"];
	const next = openPermanentSessionTab(tabs, [], null, "a");
	// 侧栏重复打开已常驻会话不得每次 new 一份 tabs，否则 jotai set 会每帧重渲染。
	assert.equal(next.tabs, tabs);
	assert.equal(next.previewId, null);
});

test("cycleSessionTab: 按顺序循环切换，到头回绕", () => {
	const { cycleSessionTab } = loadSessionTabs();
	const tabs = ["a", "b", "c"];
	assert.equal(cycleSessionTab(tabs, "a", 1), "b");
	assert.equal(cycleSessionTab(tabs, "c", 1), "a"); // 末尾回绕到首个
	assert.equal(cycleSessionTab(tabs, "b", -1), "a");
	assert.equal(cycleSessionTab(tabs, "a", -1), "c"); // 首个回绕到末尾
});

test("cycleSessionTab: 当前会话不在 Tab 列表时从端点切入；不足 2 个不切", () => {
	const { cycleSessionTab } = loadSessionTabs();
	const tabs = ["a", "b", "c"];
	// 分屏聚焦外会话/无 Tab 场景：正向切到首个、反向切到末个
	assert.equal(cycleSessionTab(tabs, undefined, 1), "a");
	assert.equal(cycleSessionTab(tabs, "not-in-tabs", -1), "c");
	assert.equal(cycleSessionTab(tabs, undefined, -1), "c");
	// 0/1 个 Tab 无处可切，交回空让订阅静默忽略
	assert.equal(cycleSessionTab([], undefined, 1), null);
	assert.equal(cycleSessionTab(["only"], "only", 1), null);
});
