import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const M = load("src/main/pi/agentMessageProjector.ts");
const { AgentMessageProjector, toMessageEpochMs } = M;

/**
 * pi 的 JSONL 里 `message.timestamp` 是 **ISO 字符串**。
 *
 * 旧实现只认数值，字符串一律落进 `Date.now()` —— 整个历史窗口的时间戳都变成「加载那一刻」，
 * 彼此完全相同。后果不是显示问题，是**顺序判据失效**：
 *
 * 真机 2026-11-26 08:51（点刻度最后一条）：
 *   jump/settle {rectTop: -3113, scrollTop: 3262, scrollHeight: 6158}
 *   jump/entry  {foundIndex: 0, messages: 324}
 *
 * 目标被渲染到文档最顶部。因为合并按 timestamp 校正顺序，而窗口里每条都是同一个更晚的
 * `Date.now()` —— 「目标在前」构不成逆序，排序被跳过，补读进来那条就留在数组首位。
 */
const project = (timestamp) => {
	const projector = new AgentMessageProjector({ purpose: "timeline" });
	const out = projector.convert("_viewer", [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp }], ["e1"]);
	return out?.[0]?.timestamp;
};

test("ISO 字符串 timestamp 必须解析成毫秒，不能退化成 Date.now()", () => {
	const iso = "2026-11-25T10:00:00.000Z";
	const got = project(iso);
	assert.equal(got, Date.parse(iso), "实际 " + got + "，期望 " + Date.parse(iso));
});

test("数值 timestamp 原样保留", () => {
	const ms = 1_795_600_800_000;
	assert.equal(project(ms), ms);
});

test("缺失 timestamp 才回落到当前时间（不能影响有值的消息）", () => {
	const before = Date.now();
	const got = project(undefined);
	assert.ok(got >= before - 5 && got <= Date.now() + 5, "实际 " + got);
});

test("同一批消息的时间戳互不相同（全等于 Date.now() 就是这条判据要挡的事故）", () => {
	const projector = new AgentMessageProjector({ purpose: "timeline" });
	const out = projector.convert(
		"_viewer",
		[
			{ role: "user", content: [{ type: "text", text: "a" }], timestamp: "2026-11-25T10:00:00.000Z" },
			{ role: "assistant", content: [{ type: "text", text: "b" }], timestamp: "2026-11-25T10:05:00.000Z" },
		],
		["e1", "e2"],
	);
	const stamps = out.map((m) => m.timestamp);
	assert.notEqual(stamps[0], stamps[1], "两条消息拿到同一个时间戳，顺序判据就失效了");
	assert.equal(stamps[1] - stamps[0], 300_000);
});

test("toMessageEpochMs：垃圾值返回 undefined，由调用方兜底", () => {
	assert.equal(toMessageEpochMs("not-a-date"), undefined);
	assert.equal(toMessageEpochMs(""), undefined);
	assert.equal(toMessageEpochMs(null), undefined);
	assert.equal(toMessageEpochMs(-1), undefined);
	assert.equal(toMessageEpochMs(Number.NaN), undefined);
});
