import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 判据：锚点解析的**输入空间**必须与名字对齐，且找不到时退回尾窗。
 *
 * 第 9 件（组 2 实测）：旧签名收一个字符串叫 anchoredRunId，实际只喂
 * `runIndexOfMessage({ messageId })` —— 它扫 run.items 里的消息 id 与 meta.entryId，
 * **不看 run 自己的 id**。传 run id 时恒 undefined -> 每次跳转都退回尾窗，
 * 「接了线但恒不生效」，不报错、看起来像「跳转没生效」。
 *
 * 反例：把 byRunId 那条删掉（只留 entryId / messageId） -> 第一条判据红。
 */

const load = () => loadTsCommonJs("src/renderer/src/components/session/timeline/jumpTarget.ts");

/** 两轮：run 自带 id，items 里既有 messageId 也有 entryId。 */
const runs = () => [
	{ kind: "agent-run", id: "run-A", items: [{ id: "msg1", meta: {} }] },
	{ kind: "agent-run", id: "run-B", items: [{ id: "msg2", meta: { entryId: "E2" } }] },
];

/** 取 ok 的 startRun，非 ok 直接失败并打印 kind：断言失败信息要能指向哪种结局。 */
function startRunOf(result, label) {
	assert.equal(result.kind, "ok", label + " 期望 ok，实际 " + JSON.stringify(result));
	return result.startRun;
}

test("按 run 自己的 id 定位（第 9 件：旧实现恒 undefined）", () => {
	const { resolveAnchorStartRun } = load();
	assert.equal(startRunOf(resolveAnchorStartRun(runs(), { runId: "run-B" }), "run-B"), 1);
	assert.equal(startRunOf(resolveAnchorStartRun(runs(), { runId: "run-A" }), "run-A"), 0, "0 不能与 undefined 混");
	assert.equal(resolveAnchorStartRun(runs(), { runId: "run-gone" }).kind, "missing");
});

test("按 run 内 entryId 定位（重投影后仍稳定）", () => {
	const { resolveAnchorStartRun } = load();
	assert.equal(startRunOf(resolveAnchorStartRun(runs(), { entryId: "E2" }), "E2"), 1);
	assert.equal(resolveAnchorStartRun(runs(), { entryId: "gone" }).kind, "missing");
});

test("按 messageId 也能定位（投影 id，重投影会变）", () => {
	const { resolveAnchorStartRun } = load();
	assert.equal(startRunOf(resolveAnchorStartRun(runs(), { messageId: "msg2" }), "msg2"), 1);
	assert.equal(startRunOf(resolveAnchorStartRun(runs(), { messageId: "msg1" }), "msg1"), 0);
});

test("冲突与缺失必须可区分（第 10 件：undefined 二义会让我们的 bug 长得像数据问题）", () => {
	const { resolveAnchorStartRun } = load();
	const conflict = resolveAnchorStartRun(runs(), { runId: "run-A", entryId: "E2" });
	assert.equal(conflict.kind, "conflict", "两空间指向不同轮必须报 conflict，实际 " + JSON.stringify(conflict));
	// hits 至少两个有值，否则分不出「为什么冲突」
	const filled = [conflict.hits.run, conflict.hits.entry, conflict.hits.message].filter((value) => typeof value === "number");
	assert.ok(filled.length >= 2, "冲突要能看出两处各指向哪一轮：" + JSON.stringify(conflict.hits));
	assert.notEqual(conflict.kind, "missing", "冲突绝不能报成缺失");

	const missing = resolveAnchorStartRun(runs(), { runId: "nope" });
	assert.equal(missing.kind, "missing");
	assert.equal("hits" in missing, false, "missing 不带 hits（否则两种结局又混了）");
});

test("三空间全一致：ok，不是 conflict", () => {
	const { resolveAnchorStartRun } = load();
	const aligned = [{ kind: "agent-run", id: "run-X", items: [{ id: "msg-X", meta: { entryId: "E-X" } }] }];
	assert.equal(startRunOf(resolveAnchorStartRun(aligned, { runId: "run-X", entryId: "E-X", messageId: "msg-X" }), "aligned"), 0);
});

test("空输入 / 全找不到：missing，不抛", () => {
	const { resolveAnchorStartRun } = load();
	assert.equal(resolveAnchorStartRun(runs(), {}).kind, "missing");
	assert.equal(resolveAnchorStartRun(runs(), { runId: "" }).kind, "missing");
	assert.equal(resolveAnchorStartRun([], { runId: "x" }).kind, "missing");
});
