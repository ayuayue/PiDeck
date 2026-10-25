import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 并行问询上下文来源：按 originSessionId 从消息缓存取快照。
 *
 * 回归背景：输入框拆分菜单的「并行发送」只传了 originSessionId、没有显式传
 * context，导致侧边会话看不到主会话前因。现在所有入口都走
 * buildAskContextForSession，必须在发送瞬间读对会话、带上统一标题与角色标签。
 */
const LABELS = {
	"askPanel.contextTitle": "主会话上下文",
	"askPanel.contextUser": "用户",
	"askPanel.contextAssistant": "助手",
};

function loadHelper(messagesBySession) {
	const { buildAskContextForSession } = loadTsCommonJs("src/renderer/src/utils/askPanelContextSource.ts", {
		stubs: {
			"../i18n": { t: (key) => LABELS[key] ?? key },
			"../atoms/session-atoms": {
				sessionMessageCacheBySessionIdAtomFamily: (sessionId) => ({ sessionId }),
			},
		},
	});
	const requested = [];
	const store = {
		get(atom) {
			requested.push(atom.sessionId);
			return messagesBySession[atom.sessionId];
		},
	};
	return { buildAskContextForSession, store, requested };
}

test("按 originSessionId 读取对应会话的消息并生成上下文块", () => {
	const { buildAskContextForSession, store, requested } = loadHelper({
		s1: {
			messages: [
				{ role: "user", text: "主会话问题" },
				{ role: "assistant", text: "主会话回答" },
			],
		},
		s2: { messages: [{ role: "user", text: "另一条会话" }] },
	});
	assert.equal(buildAskContextForSession(store, "s1"), "主会话上下文\n用户：主会话问题\n助手：主会话回答");
	assert.deepEqual(requested, ["s1"]);
});

test("没有 originSessionId 时不读缓存，直接返回 null", () => {
	const { buildAskContextForSession, store, requested } = loadHelper({ s1: { messages: [{ role: "user", text: "x" }] } });
	assert.equal(buildAskContextForSession(store, undefined), null);
	assert.deepEqual(requested, []);
});

test("会话没有消息缓存或消息为空时返回 null（调用方跳过上下文注入）", () => {
	const { buildAskContextForSession, store } = loadHelper({ empty: { messages: [] } });
	assert.equal(buildAskContextForSession(store, "missing"), null);
	assert.equal(buildAskContextForSession(store, "empty"), null);
});

test("只带 user/assistant 正文，过滤 thinking 与空消息（复用 buildAskContextBlock 口径）", () => {
	const { buildAskContextForSession, store } = loadHelper({
		s1: {
			messages: [
				{ role: "user", text: "问题" },
				{ role: "assistant", text: "   " },
				{ role: "thinking", text: "隐藏思考" },
				{ role: "assistant", text: "回答" },
			],
		},
	});
	assert.equal(buildAskContextForSession(store, "s1"), "主会话上下文\n用户：问题\n助手：回答");
});
