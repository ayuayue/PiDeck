/**
 * notifySummary：扩展通知（pi custom_message）的解析与展示白名单。
 *
 * 背景：后台子代理完成时插件发 `Background task completed: **agent**` 这类文案，
 * 时间线卡片要能一行说清「谁、什么状态」，同时保留原文供展开。
 * 这些文案由第三方插件产出（英文模板为主），所以解析必须宽容：
 * 认不出来就退化成「首行原文」，绝不隐藏信息。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseNotifySummary, isNotifiableCustomType, NOTIFY_CUSTOM_TYPES } = loadTsCommonJs("src/renderer/src/components/session/notifySummary.ts");

test("单个后台任务完成：解析出状态与子代理名，正文分段", () => {
	const summary = parseNotifySummary("Background task completed: **delegate** (task 3)\n\ndelegate: implemented\nfiles: 2");
	assert.equal(summary.status, "completed");
	assert.deepEqual([...summary.agents], ["delegate"]);
	assert.equal(summary.headline, "Background task completed: **delegate** (task 3)");
	assert.equal(summary.body, "delegate: implemented\nfiles: 2");
});

test("分组通知：多个子代理名全部解析出来", () => {
	const summary = parseNotifySummary("Background tasks completed (2): **a**, **b**");
	assert.equal(summary.status, "completed");
	assert.deepEqual([...summary.agents], ["a", "b"]);
	assert.equal(summary.body, "");
});

test("失败/暂停/停止状态各自可识别", () => {
	assert.equal(parseNotifySummary("Background task failed: **x**").status, "failed");
	assert.equal(parseNotifySummary("Detached foreground task paused: **x**").status, "paused");
	assert.equal(parseNotifySummary("Background task stopped: **x**").status, "stopped");
});

test("中文文案同样可识别（插件可能本地化）", () => {
	const summary = parseNotifySummary("后台任务已完成：**研究**");
	assert.equal(summary.status, "completed");
	assert.deepEqual([...summary.agents], ["研究"]);
});

test("状态只取首行冒号前的段，正文里的 completed/failed 不干扰", () => {
	const summary = parseNotifySummary("Background task completed: **x**\n\nx: this task failed earlier");
	assert.equal(summary.status, "completed");
});

test("无法识别的文案：状态 unknown，但首行与正文都保留", () => {
	const summary = parseNotifySummary("自定义通知\n第二行");
	assert.equal(summary.status, "unknown");
	assert.equal(summary.headline, "自定义通知");
	assert.equal(summary.body, "第二行");
	assert.deepEqual([...summary.agents], []);
});

test("空文本不抛错", () => {
	const summary = parseNotifySummary("");
	assert.equal(summary.status, "unknown");
	assert.equal(summary.headline, "");
	assert.equal(summary.body, "");
});

test("白名单：只放通知类 customType，内部上下文注入不展示", () => {
	assert.equal(isNotifiableCustomType("subagent-notify"), true);
	assert.equal(isNotifiableCustomType("subagent_control_notice"), true);
	// 计划模式上下文注入（display:false，实测单会话 22 条）不能变成时间线噪声
	assert.equal(isNotifiableCustomType("pi-deck-plan-mode-context"), false);
	assert.equal(isNotifiableCustomType(undefined), false);
	assert.equal(isNotifiableCustomType(123), false);
	assert.ok(NOTIFY_CUSTOM_TYPES.size >= 4);
});
