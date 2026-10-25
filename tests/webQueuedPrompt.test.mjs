/**
 * Web 端待发送队列的投递判定 + composer 接线契约。
 *
 * 背景：pi 在回合进行中拒收新 prompt（turnActive），Web 端此前流式期间发送键直接消失，
 * 用户只能干等。队列语义对齐桌面 followUp：回合内暂存、回合结束按序投递。
 * 判定条件集中在 webQueueFlush 纯函数，这里逐条锁死——漏一条就会在流式中硬发，
 * 或在用户正回答 Ask 提问时叠一条消息。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { shouldFlushQueuedPrompt } = loadTsCommonJs("src/renderer/src/web/webQueueFlush.ts");

/** 基准：回合已结束、无挂起提问、有 1 条待发。 */
const idle = { streaming: false, externalStreaming: false, runtimeStatus: "idle", hasPendingUiRequest: false, paused: false, queuedCount: 1, flushing: false };

test("空闲且队列非空：立即投递", () => {
	assert.equal(shouldFlushQueuedPrompt(idle), true);
});

test("流式中（本端）不投递：等本轮流结束", () => {
	assert.equal(shouldFlushQueuedPrompt({ ...idle, streaming: true }), false);
});

test("外部流式（桌面端/其他设备回合）不投递", () => {
	assert.equal(shouldFlushQueuedPrompt({ ...idle, externalStreaming: true }), false);
});

test("runtime 仍在 running/starting 不投递（本端断流但 pi 未收口）", () => {
	assert.equal(shouldFlushQueuedPrompt({ ...idle, runtimeStatus: "running" }), false);
	assert.equal(shouldFlushQueuedPrompt({ ...idle, runtimeStatus: "starting" }), false);
});

test("挂起 Ask/权限提问时不叠消息", () => {
	assert.equal(shouldFlushQueuedPrompt({ ...idle, hasPendingUiRequest: true }), false);
});

test("停止后暂停：不自动投递（用户再次发送或点「继续发送」才恢复）", () => {
	assert.equal(shouldFlushQueuedPrompt({ ...idle, paused: true }), false);
});

test("队列为空或不重复消费在途项", () => {
	assert.equal(shouldFlushQueuedPrompt({ ...idle, queuedCount: 0 }), false);
	assert.equal(shouldFlushQueuedPrompt({ ...idle, flushing: true }), false);
});

test("接线契约：WebComposer 回合内提交走 onQueue 而不是直接丢弃", () => {
	const source = readFileSync("src/renderer/src/web/WebComposer.tsx", "utf8");
	// 曾经这里直接 return，流式期间输入框看着可用却发不出去
	assert.doesNotMatch(source, /props\.disabled\s*\|\|\s*props\.streaming\s*\|\|\s*busy\)\s*return/);
	assert.match(source, /if\s*\(props\.streaming\)\s*\{[\s\S]{0,200}props\.onQueue\(/);
	assert.match(source, /data-testid=\{compact \? "web-composer-queue-compact" : "web-composer-queue"\}/);
	assert.match(source, /data-testid="web-composer-queue-strip"/);
});

test("接线契约：WebChatApp 用纯函数判定并支持暂停/恢复/撤回", () => {
	const source = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
	assert.match(source, /shouldFlushQueuedPrompt\(\{/);
	assert.match(source, /const handleQueue = /);
	assert.match(source, /const handleRemoveQueued = /);
	// 停止 → 有队列时暂停自动投递
	assert.match(source, /const handleStop = \(\) => \{[\s\S]{0,500}setQueuePausedBoth\(true\)/);
});

test("接线契约：composer 的 pointerdown 焦点抑制不得拦到弹层输入框", () => {
	const source = readFileSync("src/renderer/src/web/WebComposer.tsx", "utf8");
	// 弹层经 portal 渲染，React 事件仍冒泡到 composer 工具行：不加 DOM 归属判断会
	// preventDefault 掉弹层搜索框的聚焦（移动端模型搜索完全无法输入的根因）
	assert.match(source, /composerRef\.current\?\.contains\(event\.target as Node\)\) return;/);
});
