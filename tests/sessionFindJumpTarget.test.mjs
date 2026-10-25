import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveJumpMessageIndex, resolveJumpScrollTarget } = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpTarget.ts");

/**
 * 2027-02 用户反馈：会话内查找（Ctrl/Cmd+Shift+F）能搜到结果，但点击命中「没有任何
 * 反应」。根因是 id 口径不一致——Go 索引返回的是**会话文件条目 id**（JSONL 行 id，
 * 在消息上落在 meta.entryId），而时间线消息/DOM 的 id 是投影 id
 * （`${agentId}-history-${entryId}`，见 AgentMessageProjector）。直接拿条目 id 去查
 * `[data-message-id]` 永远查不到，于是既没滚动也没高亮。
 */
function projectedMessage(entryId, role = "assistant") {
	// 与 AgentMessageProjector 的投影口径一致
	return { id: `agent-1-history-${entryId}`, role, text: `text of ${entryId}`, meta: { entryId } };
}

test("会话内查找命中（条目 id）归一到投影消息 id：这是跳转能落位的前提", () => {
	const messages = [projectedMessage("e1", "user"), projectedMessage("e2"), projectedMessage("e3")];
	assert.equal(resolveJumpMessageIndex(messages, "e2"), 1);
	assert.equal(resolveJumpMessageIndex(messages, "e3"), 2);
});

test("刻度/大纲传投影 id 时仍走精确匹配（既有跳转语义不变）", () => {
	const messages = [projectedMessage("e1"), projectedMessage("e2")];
	assert.equal(resolveJumpMessageIndex(messages, "agent-1-history-e2"), 1);
	// 消息 id 精确命中优先于 meta.entryId：同一条消息两种 id 都指它
	assert.equal(resolveJumpMessageIndex(messages, "agent-1-history-e1"), 0);
});

test("目标还没加载进窗口时返回 -1：由挂起跳转按策略补页后重新归一", () => {
	const messages = [projectedMessage("e5"), projectedMessage("e6")];
	assert.equal(resolveJumpMessageIndex(messages, "e1"), -1);
});

test("异常输入不抛：空 id / 没有 meta 的消息", () => {
	assert.equal(resolveJumpMessageIndex([], "e1"), -1);
	assert.equal(resolveJumpMessageIndex([projectedMessage("e1")], ""), -1);
	assert.equal(resolveJumpMessageIndex([{ id: "synthetic-1" }, projectedMessage("e1")], "e1"), 1);
});

/**
 * 轮内中间回答（阶段正文）随「执行过程」折叠区一起 display:none：节点在 DOM 里，
 * 但几何矩形全为 0。对它算 scrollTop 等于跳到时间线顶部（用户看到的是「跳错位置」）。
 */
function fakeElement({ visible, turnRow = null }) {
	return {
		getClientRects: () => ({ length: visible ? 1 : 0 }),
		closest: (selector) => {
			assert.equal(selector, ".turn-row, .user-turn");
			return turnRow;
		},
	};
}

test("可见节点直接落位", () => {
	const element = fakeElement({ visible: true });
	assert.equal(resolveJumpScrollTarget(element), element);
});

test("折叠隐藏的节点（display:none）退到所属轮次行", () => {
	const turnRow = { marker: "turn-row" };
	const hidden = fakeElement({ visible: false, turnRow });
	assert.equal(resolveJumpScrollTarget(hidden), turnRow);
});

test("隐藏又没有轮次行祖先时退回元素本身（不抛、不死循环）", () => {
	const hidden = fakeElement({ visible: false, turnRow: null });
	assert.equal(resolveJumpScrollTarget(hidden), hidden);
});
