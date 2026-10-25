import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 纯函数模块（无第三方依赖），转译后直接取导出。
const { buildCronExpression, parseCronVisualState, switchCronKind } = loadTsCommonJs("src/renderer/src/components/automation/cronScheduleModel.ts");

// loadTsCommonJs 在独立 VM realm 执行，对象原型不同会导致 deepStrictEqual 失败；
// 先 JSON 往返拉回主 realm 再比较（仅用于纯数据对象）。
const plain = (value) => JSON.parse(JSON.stringify(value));
const assertPlainEqual = (actual, expected, message) => {
	assert.deepEqual(plain(actual), expected, message);
};

test("buildCronExpression encodes every visual frequency into a 5-field cron", () => {
	assert.equal(buildCronExpression({ kind: "every-minutes", interval: 30 }), "*/30 * * * *");
	assert.equal(buildCronExpression({ kind: "every-minutes", interval: 1 }), "* * * * *");
	assert.equal(buildCronExpression({ kind: "hourly", minute: 15 }), "15 * * * *");
	assert.equal(buildCronExpression({ kind: "daily", hour: 9, minute: 30 }), "30 9 * * *");
	assert.equal(buildCronExpression({ kind: "weekdays", hour: 9, minute: 0 }), "0 9 * * 1-5");
	assert.equal(buildCronExpression({ kind: "weekly", days: [1, 3, 5], hour: 8, minute: 0 }), "0 8 * * 1,3,5");
	assert.equal(buildCronExpression({ kind: "monthly", day: 1, hour: 0, minute: 0 }), "0 0 1 * *");
	assert.equal(buildCronExpression({ kind: "custom", expression: " 5 4 * * 2 " }), "5 4 * * 2");
});

test("parseCronVisualState round-trips common crons and falls back to custom safely", () => {
	assertPlainEqual(parseCronVisualState("*/10 * * * *"), { kind: "every-minutes", interval: 10 });
	assertPlainEqual(parseCronVisualState("15 * * * *"), { kind: "hourly", minute: 15 });
	assertPlainEqual(parseCronVisualState("30 9 * * *"), { kind: "daily", hour: 9, minute: 30 });
	assertPlainEqual(parseCronVisualState("0 9 * * 1-5"), { kind: "weekdays", hour: 9, minute: 0 });
	assertPlainEqual(parseCronVisualState("0 8 * * 1,3,5"), { kind: "weekly", days: [1, 3, 5], hour: 8, minute: 0 });
	assertPlainEqual(parseCronVisualState("0 0 1 * *"), { kind: "monthly", day: 1, hour: 0, minute: 0 });
	// 复杂表达式（列表/月份限定）不允许「猜错」成另一种频率，一律落 custom。
	assert.equal(parseCronVisualState("5,15,25 * * * *").kind, "custom");
	assert.equal(parseCronVisualState("0 9 * feb *").kind, "custom");
	// 周字段 7 映射回周日 0（weekly）。
	assertPlainEqual(parseCronVisualState("0 0 * * 7"), { kind: "weekly", days: [0], hour: 0, minute: 0 });
});

test("switchCronKind keeps previously chosen time and weekdays when switching", () => {
	const fromDaily = switchCronKind({ kind: "daily", hour: 9, minute: 30 }, "weekly");
	assertPlainEqual(fromDaily, { kind: "weekly", days: [1, 2, 3, 4, 5], hour: 9, minute: 30 });
	// 切自定义时保留原文（由当前可视化状态生成），往返不失真。
	const custom = switchCronKind({ kind: "daily", hour: 9, minute: 30 }, "custom");
	assertPlainEqual(custom, { kind: "custom", expression: "30 9 * * *" });
});
