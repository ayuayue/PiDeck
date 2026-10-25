/**
 * sameCommands / toRuntimeCommandTarget（2027-02 性能治理配套）。
 *
 * 契约：
 * 1. sameCommands 内容等价返回 true，且同引用短路（命令表通常不变，写回 atom
 *    前保留原引用才能避免 chip 白名单 Set 全量重建）；
 * 2. toRuntimeCommandTarget 与 toSessionRuntimeTarget 在同样标量入参下行为一致
 *    （订阅方只依赖 agentId/generation，不依赖 runtime 对象身份）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { sameCommands, toRuntimeCommandTarget, toSessionRuntimeTarget } = loadTsCommonJs("src/renderer/src/utils/sessionCommands.ts");

test("sameCommands：同引用短路、内容等价为真、任一字段不同为假", () => {
	const list = [
		{ name: "compact", description: "压缩上下文", source: "builtin" },
		{ name: "reload", source: "extension" },
	];
	assert.equal(sameCommands(list, list), true, "同引用必须短路为真");
	assert.equal(
		sameCommands(
			list,
			list.map((item) => ({ ...item })),
		),
		true,
		"内容相同（新对象）也为真",
	);
	assert.equal(sameCommands(list, [...list, { name: "extra" }]), false, "长度不同为假");
	assert.equal(sameCommands(list, [list[0], { name: "reload", source: "other" }]), false, "source 不同为假");
	assert.equal(sameCommands(list, [{ ...list[0], description: "改" }, list[1]]), false, "description 不同为假");
	assert.equal(sameCommands([], []), true, "空表等价");
	assert.equal(sameCommands([], [{ name: "x" }]), false);
});

test("toRuntimeCommandTarget：标量齐备时与对象版结果一致，缺一返回 undefined", () => {
	const viaObject = toSessionRuntimeTarget("s1", { agentId: "a1", runtimeGeneration: 3 });
	const viaScalars = toRuntimeCommandTarget("s1", "a1", 3);
	assert.equal(JSON.stringify(viaScalars), JSON.stringify(viaObject));
	assert.equal(toRuntimeCommandTarget("s1", undefined, 3), undefined, "无 agentId 时无目标");
	assert.equal(toRuntimeCommandTarget("s1", "a1", undefined), undefined, "无 generation 时无目标");
});
