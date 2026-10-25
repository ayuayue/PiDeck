import assert from "node:assert/strict";
import test from "node:test";

import { resolveComposerSendButtonState } from "../src/renderer/src/utils/composerSendButton.ts";

/**
 * Composer 主发送圆钮显示决策：
 * - 空闲 → send；
 * - 忙碌且输入框为空 → stop（唯一停止入口）；
 * - 忙碌但有内容 → send（走 steer/followUp 投递，不吞掉用户输入）；
 * - 生图进行中 → spinner（不可停止，优先于其他状态）。
 */
test("空闲时显示发送按钮", () => {
	assert.equal(resolveComposerSendButtonState({ isAgentBusy: false, hasContent: false }), "send");
	assert.equal(resolveComposerSendButtonState({ isAgentBusy: false, hasContent: true }), "send");
});

test("忙碌且输入框为空时显示停止按钮", () => {
	assert.equal(resolveComposerSendButtonState({ isAgentBusy: true, hasContent: false }), "stop");
});

test("忙碌但输入框有内容时仍显示发送按钮", () => {
	assert.equal(resolveComposerSendButtonState({ isAgentBusy: true, hasContent: true }), "send");
});

test("生图进行中显示转圈，优先于忙碌与停止", () => {
	assert.equal(resolveComposerSendButtonState({ isAgentBusy: true, hasContent: false, isGeneratingImage: true }), "spinner");
	assert.equal(resolveComposerSendButtonState({ isAgentBusy: true, hasContent: true, isGeneratingImage: true }), "spinner");
});
