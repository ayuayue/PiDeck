/**
 * 远端 compare 语义透传（W4 远端测试债）：公共 compareRefs 的 mode/ahead/behind 必须原样进入面板状态，
 * 能力说明条按答案的真实语义判断——merge-base 有 ahead/behind，不能再提示 trees-only。
 *
 * 只测行为：从 controller 的公开结果与纯判据断言用户会看到什么，不扫描源码形状。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const { shouldShowRemoteGitCapabilityNote } = loadTsCommonJs("src/renderer/src/utils/remoteGitCapabilityNotes.ts");

const BASE = "refs/heads/main";
const HEAD = "refs/heads/topic";
const oid = (letter) => letter.repeat(40);

function harness(api) {
	const states = [];
	const controller = createRemoteGitViewController("project-1", "key-1", api, (state) => states.push(state), "");
	return { controller, last: () => states.at(-1) };
}

test("merge-base 答案的 mode/ahead/behind 原样进入状态，trees-only 说明隐藏", async () => {
	const h = harness({
		compareRefs: async () => ({
			ok: true,
			value: {
				mode: "merge-base",
				base: { ref: BASE, oid: oid("a") },
				head: { ref: HEAD, oid: oid("b") },
				files: [{ status: "M", path: "src/a.ts" }],
				ahead: 3,
				behind: 2,
			},
		}),
	});
	await h.controller.runCompare(BASE, HEAD);
	const compare = h.last().compare;
	assert.equal(compare.mode, "merge-base");
	assert.equal(compare.ahead, 3);
	assert.equal(compare.behind, 2);
	assert.equal(shouldShowRemoteGitCapabilityNote("compare", { compareOpen: true, compareMode: compare.mode }), false, "merge-base 已有 ahead/behind，不该再提示缺 merge-base / ahead-behind");
});

test("trees 答案只带 mode，trees-only 说明显示", async () => {
	const h = harness({
		compareRefs: async () => ({
			ok: true,
			value: {
				mode: "trees",
				base: { ref: BASE, oid: oid("a") },
				head: { ref: HEAD, oid: oid("b") },
				files: [],
			},
		}),
	});
	await h.controller.runCompare(BASE, HEAD);
	const compare = h.last().compare;
	assert.equal(compare.mode, "trees");
	assert.equal(compare.ahead, undefined, "两树比较没有 ahead/behind，不能填 0 冒充支持");
	assert.equal(compare.behind, undefined);
	assert.equal(shouldShowRemoteGitCapabilityNote("compare", { compareOpen: true, compareMode: compare.mode }), true);
});

test("答案没有 mode 时不编造语义：仍按 trees 提示", async () => {
	const h = harness({
		compareRefs: async () => ({ ok: true, value: { base: { ref: BASE, oid: oid("a") }, head: { ref: HEAD, oid: oid("b") }, files: [] } }),
	});
	await h.controller.runCompare(BASE, HEAD);
	const compare = h.last().compare;
	assert.equal(compare.mode, undefined);
	assert.equal(shouldShowRemoteGitCapabilityNote("compare", { compareOpen: true, compareMode: compare.mode }), true);
});
