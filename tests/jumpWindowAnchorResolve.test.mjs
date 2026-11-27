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

test("按 run 自己的 id 定位（旧实现恒 undefined）", () => {
	const { resolveAnchorStartRun } = load();
	assert.equal(resolveAnchorStartRun(runs(), { runId: "run-B" }), 1, "run-B 是第 1 轮");
	assert.equal(resolveAnchorStartRun(runs(), { runId: "run-A" }), 0, "run-A 是第 0 轮（0 不能与 undefined 混）");
	assert.equal(resolveAnchorStartRun(runs(), { runId: "run-gone" }), undefined);
});

test("按 run 内那条消息的 entryId 定位（重投影后仍稳定）", () => {
	const { resolveAnchorStartRun } = load();
	assert.equal(resolveAnchorStartRun(runs(), { entryId: "E2" }), 1);
	assert.equal(resolveAnchorStartRun(runs(), { entryId: "gone" }), undefined);
});

test("按 messageId 也能定位，但它是投影 id（重投影会变）", () => {
	const { resolveAnchorStartRun } = load();
	assert.equal(resolveAnchorStartRun(runs(), { messageId: "msg2" }), 1);
	assert.equal(resolveAnchorStartRun(runs(), { messageId: "msg1" }), 0);
});

test("多个空间指向不同轮：不猜，返回 undefined（宁可退回尾窗）", () => {
	const { resolveAnchorStartRun } = load();
	const got = resolveAnchorStartRun(runs(), { runId: "run-A", messageId: "msg2" });
	assert.equal(got, undefined, "run-A 是第 0 轮、msg2 在第 1 轮 —— 必须不猜，实际返回 " + got);
});

test("空输入 / 全找不到：undefined（尾窗语义），不抛", () => {
	const { resolveAnchorStartRun } = load();
	assert.equal(resolveAnchorStartRun(runs(), {}), undefined);
	assert.equal(resolveAnchorStartRun(runs(), { runId: "" }), undefined);
	assert.equal(resolveAnchorStartRun([], { runId: "x" }), undefined);
});
