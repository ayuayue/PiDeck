import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { shouldActivateAcpHistory, shouldApplyHistorySnapshot } = loadTsCommonJs("src/renderer/src/web/webHistoryLoad.ts");

test("ACP 冷会话需要后台激活以恢复 agent 侧历史", () => {
	assert.equal(shouldActivateAcpHistory({ backend: "acp", hasRuntime: false, attempted: false }), true);
	assert.equal(shouldActivateAcpHistory({ backend: "acp", hasRuntime: true, attempted: false }), false, "已有 runtime 时由 session/load 自己重放");
	assert.equal(shouldActivateAcpHistory({ backend: "acp", hasRuntime: false, attempted: true }), false, "同一页面生命周期只尝试一次，轮询不得反复拉起 CLI");
	assert.equal(shouldActivateAcpHistory({ backend: "pi", hasRuntime: false, attempted: false }), false, "pi 历史在本地文件，不需要激活");
	assert.equal(shouldActivateAcpHistory({ backend: "dsh", hasRuntime: false, attempted: false }), false);
});

test("非 ACP 会话的空结果就是权威空历史", () => {
	assert.equal(shouldApplyHistorySnapshot({ backend: "pi", nextCount: 0, previousCount: 3, acpRuntimePending: false }), true);
	assert.equal(shouldApplyHistorySnapshot({ backend: "dsh", nextCount: 0, previousCount: 3, acpRuntimePending: false }), true);
	assert.equal(shouldApplyHistorySnapshot({ backend: undefined, nextCount: 0, previousCount: 0, acpRuntimePending: false }), true);
});

test("ACP runtime 未就绪时的空结果不得覆盖缓存或结束加载态", () => {
	// 冷会话首次打开：没有缓存也要继续 loading，等激活完成后重拉。
	assert.equal(shouldApplyHistorySnapshot({ backend: "acp", nextCount: 0, previousCount: 0, acpRuntimePending: true }), false);
	// 已有缓存：更不能用空结果抹掉。
	assert.equal(shouldApplyHistorySnapshot({ backend: "acp", nextCount: 0, previousCount: 5, acpRuntimePending: true }), false);
});

test("ACP 已有内容时瞬时空结果保留缓存（切会话/重开页面空白页的根因）", () => {
	assert.equal(shouldApplyHistorySnapshot({ backend: "acp", nextCount: 0, previousCount: 5, acpRuntimePending: false }), false);
	assert.equal(shouldApplyHistorySnapshot({ backend: "acp", nextCount: 0, previousCount: 0, acpRuntimePending: false }), true, "真正没有历史的 ACP 会话仍要落到空态");
	assert.equal(shouldApplyHistorySnapshot({ backend: "acp", nextCount: 2, previousCount: 5, acpRuntimePending: false }), true, "非空结果正常应用");
});
