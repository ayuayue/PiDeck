import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { mergeDefaultTools, resolveDefaultTools, resolveDefaultToolsInLayer, isToolEnabled, isToolEnabledInLayer, setToolEnabled, encodeDefaultToolsSelection, defaultToolsDisablesAll, mergeCodemodeSetting, normalizeCodemodeMode, normalizeCodemodeInlineBudget, PI_DEFAULT_TOOL_NAMES } =
	loadTsCommonJs("src/shared/defaultTools.ts");

/** 跨 VM 数组需复制后再比较（见 tests/helpers/loadTsCommonJs.mjs）。 */
const plain = (value) => (value === undefined ? undefined : [...value]);

test("resolve: 未配置 = pi 默认集", () => {
	assert.deepEqual(plain(resolveDefaultTools(undefined)), [...PI_DEFAULT_TOOL_NAMES]);
});

test("resolve: 裸名字整体替换 + 增量按序生效", () => {
	// 裸名列表替换默认集后，-bash 找不到目标 → no-op（与 pi resolveDefaultTools 一致）
	assert.deepEqual(plain(resolveDefaultTools(["read", "-bash", "+grep"])), ["read", "grep"]);
	// 关掉默认集内的工具需在「增量-only」列表中才有目标
	assert.deepEqual(plain(resolveDefaultTools(["-bash", "+grep"])), ["read", "edit", "write", "grep"]);
	assert.deepEqual(plain(resolveDefaultTools(["+codemode"])), [...PI_DEFAULT_TOOL_NAMES, "codemode"]);
	// 增量引用默认集外的工具直接追加
	assert.deepEqual(plain(resolveDefaultTools(["+powershell"])), [...PI_DEFAULT_TOOL_NAMES, "powershell"]);
	// 关掉默认集未包含的工具是 no-op
	assert.deepEqual(plain(resolveDefaultTools(["-grep"])), [...PI_DEFAULT_TOOL_NAMES]);
});

test("resolve: 空数组 = 全部禁用（不回退默认集）", () => {
	assert.deepEqual(plain(resolveDefaultTools([])), []);
});

test("merge: 覆盖层只有增量时叠加继承层；含裸名时整体替换", () => {
	assert.deepEqual(plain(mergeDefaultTools(["read", "bash", "edit", "write"], ["+codemode"])), ["read", "bash", "edit", "write", "+codemode"]);
	assert.deepEqual(plain(mergeDefaultTools(["read"], ["grep", "+codemode"])), ["grep", "+codemode"]);
	assert.deepEqual(plain(mergeDefaultTools(undefined, ["+codemode"])), ["+codemode"]);
	assert.deepEqual(plain(mergeDefaultTools(["read"], undefined)), ["read"]);
	assert.equal(mergeDefaultTools(undefined, undefined), undefined);
});

test("resolveDefaultToolsInLayer: 复刻 0.99.2 实测的四条跨层语义", () => {
	// 未设置 + 未设置 → 默认
	assert.deepEqual(plain(resolveDefaultToolsInLayer(undefined, undefined)), [...PI_DEFAULT_TOOL_NAMES]);
	// 全局 [] + 项目未设置 → 空选择
	assert.deepEqual(plain(resolveDefaultToolsInLayer(undefined, [])), []);
	// 全局 ["read"] + 项目 [] → ["read"]（空 modifier 列表 = 不变）
	assert.deepEqual(plain(resolveDefaultToolsInLayer(["read"], [])), ["read"]);
	// 全局 [] + 项目 ["+codemode"] → 默认四工具 + codemode（并入默认集，不是并入空集）
	assert.deepEqual(plain(resolveDefaultToolsInLayer([], ["+codemode"])), ["read", "bash", "edit", "write", "codemode"]);
});

test("resolveDefaultToolsInLayer: 项目裸名整体替换全局；项目增量叠加全局", () => {
	assert.deepEqual(plain(resolveDefaultToolsInLayer(["read", "grep"], ["bash"])), ["bash"]);
	assert.deepEqual(plain(resolveDefaultToolsInLayer(["read"], ["+grep", "-read"])), ["grep"]);
});

test("setToolEnabled: 未配置时开启 codemode → 结果含默认四工具 + codemode", () => {
	const next = setToolEnabled({ entries: undefined, name: "codemode", on: true });
	assert.deepEqual(plain(resolveDefaultTools(next)), ["read", "bash", "edit", "write", "codemode"]);
});

test("setToolEnabled 回归: 显式空列表（[]）后只开 codemode，不会带回默认四工具", () => {
	// 旧实现写 ["+codemode"]，在注释/回退上会得到 read/bash/edit/write；
	// 新实现必须让解析结果只含 codemode。
	const entries = [];
	const next = setToolEnabled({ entries, name: "codemode", on: true });
	assert.deepEqual(plain(resolveDefaultTools(next)), ["codemode"]);
	assert.ok(!plain(next).includes("+codemode") || plain(next).every((entry) => entry === "codemode" || entry.startsWith("-")));
});

test("setToolEnabled 回归: 裸名列表只关一个工具后不恢复默认集", () => {
	const next = setToolEnabled({ entries: ["read", "bash"], name: "bash", on: false });
	assert.deepEqual(plain(resolveDefaultTools(next)), ["read"]);
});

test("setToolEnabled 回归: 关闭最后一个已选工具得到空选择", () => {
	const next = setToolEnabled({ entries: ["codemode"], name: "codemode", on: false });
	assert.deepEqual(plain(resolveDefaultTools(next)), []);
	assert.equal(defaultToolsDisablesAll(plain(next)), true);
});

test("setToolEnabled: 重复开关幂等", () => {
	const on = setToolEnabled({ entries: undefined, name: "codemode", on: true });
	const off = setToolEnabled({ entries: on, name: "codemode", on: false });
	assert.deepEqual(plain(resolveDefaultTools(off)), [...PI_DEFAULT_TOOL_NAMES]);
	assert.deepEqual(plain(setToolEnabled({ entries: off, name: "codemode", on: false })), plain(off));
	assert.deepEqual(plain(setToolEnabled({ entries: on, name: "codemode", on: true })), plain(on));
});

test("setToolEnabled: 关闭默认集内工具不动用户裸名条目与未知工具名", () => {
	const next = setToolEnabled({ entries: ["read", "my_custom_tool"], name: "read", on: false });
	assert.deepEqual(plain(resolveDefaultTools(next)), ["my_custom_tool"]);
	assert.ok(plain(next).includes("my_custom_tool"), "未知/第三方工具名必须原样保留");
});

test("setToolEnabled: 未知工具可开启并保留", () => {
	const next = setToolEnabled({ entries: undefined, name: "my_custom_tool", on: true });
	assert.deepEqual(plain(resolveDefaultTools(next)), [...PI_DEFAULT_TOOL_NAMES, "my_custom_tool"]);
});

test("setToolEnabled: 项目层以全局为 base 回验（清空继承选择）", () => {
	// 全局显式四工具，项目要清空 → 项目层不能依赖同名的空数组语义，
	// 必须实际解析为 []。
	const next = setToolEnabled({ baseEntries: ["read", "bash", "edit", "write"], entries: undefined, name: "read", on: false });
	assert.deepEqual(plain(resolveDefaultToolsInLayer(["read", "bash", "edit", "write"], next)), ["bash", "edit", "write"]);
});

test("setToolEnabled: 项目层只开 codemode（全局默认）不误带裸名机制", () => {
	const next = setToolEnabled({ baseEntries: undefined, entries: undefined, name: "codemode", on: true });
	assert.deepEqual(plain(resolveDefaultToolsInLayer(undefined, next)), ["read", "bash", "edit", "write", "codemode"]);
});

test("encodeDefaultToolsSelection: 精确表达所选集合（含未知工具）", () => {
	for (const selection of [[], ["codemode"], ["read", "bash", "edit", "write"], ["ls", "my_custom_tool"]]) {
		const encoded = encodeDefaultToolsSelection({ selection });
		assert.deepEqual(plain(resolveDefaultTools(encoded)), selection);
	}
});

test("encodeDefaultToolsSelection: 已精确表达目标时保持原值（含用户排序/未知条目）", () => {
	const entries = ["bash", "read", "my_custom_tool"];
	const encoded = encodeDefaultToolsSelection({ entries, selection: ["bash", "read", "my_custom_tool"] });
	assert.deepEqual(plain(encoded), entries);
});

test("encodeDefaultToolsSelection: 项目层候选必须按跨层合并语义回验", () => {
	// 全局 [] + 项目希望得到 ["codemode"]：不能写 ["+codemode"]（那会得到默认四工具 + codemode）
	const encoded = encodeDefaultToolsSelection({ baseEntries: [], selection: ["codemode"] });
	assert.deepEqual(plain(resolveDefaultToolsInLayer([], encoded)), ["codemode"]);
});

test("isToolEnabledInLayer 与 resolve 一致", () => {
	assert.equal(isToolEnabled(undefined, "bash"), true);
	assert.equal(isToolEnabled(undefined, "codemode"), false);
	assert.equal(isToolEnabled(["+codemode"], "codemode"), true);
	assert.equal(isToolEnabled(["-bash"], "bash"), false);
	assert.equal(isToolEnabled([], "read"), false);
	assert.equal(isToolEnabledInLayer([], ["+codemode"], "read"), true);
	assert.equal(isToolEnabledInLayer([], [], "read"), false);
});

test("defaultToolsDisablesAll 仅对空数组为真", () => {
	assert.equal(defaultToolsDisablesAll([]), true);
	assert.equal(defaultToolsDisablesAll(undefined), false);
	assert.equal(defaultToolsDisablesAll(["+codemode"]), false);
});

test("mergeCodemodeSetting: 只 patch 指定键并保留未知嵌套字段", () => {
	const existing = { mode: "only", inlineBudget: 1500, futureField: { nested: true } };
	// 改 mode：inlineBudget 与未知字段都保留
	assert.deepEqual(JSON.parse(JSON.stringify(mergeCodemodeSetting(existing, { mode: "on" }))), { mode: "on", inlineBudget: 1500, futureField: { nested: true } });
	// 删 mode：其他键保留
	assert.deepEqual(JSON.parse(JSON.stringify(mergeCodemodeSetting(existing, { mode: undefined }))), { inlineBudget: 1500, futureField: { nested: true } });
	// 删最后一个键且无未知字段 → 整个对象消失（不落盘 codemode:{}）
	assert.equal(mergeCodemodeSetting({ mode: "on" }, { mode: undefined }), undefined);
	// 未知字段存在时即使删掉已知键也保留对象
	assert.deepEqual(JSON.parse(JSON.stringify(mergeCodemodeSetting({ mode: "on", futureField: 1 }, { mode: undefined }))), { futureField: 1 });
	// 非对象 existing 视为空对象
	assert.deepEqual(JSON.parse(JSON.stringify(mergeCodemodeSetting("garbage", { mode: "only" }))), { mode: "only" });
	// 空 patch 且无 existing → undefined
	assert.equal(mergeCodemodeSetting(undefined, {}), undefined);
});

test("normalizeCodemodeMode / normalizeCodemodeInlineBudget: 合法保留，非法丢弃", () => {
	assert.equal(normalizeCodemodeMode("on"), "on");
	assert.equal(normalizeCodemodeMode("only"), "only");
	assert.equal(normalizeCodemodeMode("sometimes"), undefined);
	assert.equal(normalizeCodemodeMode(undefined), undefined);
	assert.equal(normalizeCodemodeInlineBudget(0), 0);
	assert.equal(normalizeCodemodeInlineBudget(1500.7), 1500);
	assert.equal(normalizeCodemodeInlineBudget(-5), undefined);
	assert.equal(normalizeCodemodeInlineBudget(Number.NaN), undefined);
	assert.equal(normalizeCodemodeInlineBudget("3000"), undefined);
});
