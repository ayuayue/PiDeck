/**
 * Agent 桌面通知的统一出口：门控顺序、文案、点击跳转与「Ask 是否真的弹出」。
 * 用假 Notification 记录构造参数，不依赖真实系统通知。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadToast({ supported = true, focused = false } = {}) {
	const shown = [];
	class FakeNotification {
		static isSupported() {
			return supported;
		}
		constructor(options) {
			this.options = options;
			this.handlers = {};
			shown.push(this);
		}
		on(event, handler) {
			this.handlers[event] = handler;
			return this;
		}
		show() {
			this.shown = true;
		}
	}
	const mod = loadTsCommonJs("src/main/notifications/agentToast.ts", {
		stubs: {
			electron: { Notification: FakeNotification },
			"./alertFocusGate": { isMainWindowFocused: () => focused, shouldAlertNow: (alertOnly, isFocused) => !alertOnly || !isFocused },
			"./notificationToast": {
				buildToastXml: (input) => `xml:${input.launch}:${input.body}`,
				notificationLaunchUrl: (sessionId) => `pideck://session/${sessionId ?? ""}`,
			},
		},
	});
	return { mod, shown };
}

function makeDeps(settings, activated = []) {
	return {
		settings: () => settings,
		getWindow: () => null,
		logoUri: () => null,
		translate: (key, params = {}) => `${key}:${params.title ?? ""}:${params.question ?? ""}`,
		activate: (sessionId) => activated.push(sessionId),
		logger: { warn: () => undefined },
	};
}

test("会话完成通知：带会话深链，点击跳回该会话", () => {
	const { mod, shown } = loadToast();
	const activated = [];
	const settings = { enableNotifications: true, askNotificationEnabled: false, alertOnlyWhenUnfocused: false };
	mod.notifySessionFinished(makeDeps(settings, activated), { agentId: "a1", title: "标题", sessionId: "s1" });
	assert.equal(shown.length, 1);
	assert.match(shown[0].options.toastXml, /pideck:\/\/session\/s1/);
	assert.equal(shown[0].shown, true);
	shown[0].handlers.click();
	assert.deepEqual(activated, ["s1"]);
});

test("会话完成通知受 enableNotifications 与「仅失焦提醒」门控", () => {
	const off = loadToast();
	off.mod.notifySessionFinished(makeDeps({ enableNotifications: false, askNotificationEnabled: true, alertOnlyWhenUnfocused: false }), { agentId: "a1", title: "T" });
	assert.equal(off.shown.length, 0);

	const focused = loadToast({ focused: true });
	focused.mod.notifySessionFinished(makeDeps({ enableNotifications: true, askNotificationEnabled: true, alertOnlyWhenUnfocused: true }), { agentId: "a1", title: "T" });
	assert.equal(focused.shown.length, 0, "窗口在前台时不打扰");

	const unsupported = loadToast({ supported: false });
	unsupported.mod.notifySessionFinished(makeDeps({ enableNotifications: true, askNotificationEnabled: true, alertOnlyWhenUnfocused: false }), { agentId: "a1", title: "T" });
	assert.equal(unsupported.shown.length, 0);
});

test("超长会话标题在进入通知文案前被截断（16K 标题不再撑大 toast）", () => {
	const { mod, shown } = loadToast();
	const settings = { enableNotifications: true, askNotificationEnabled: true, alertOnlyWhenUnfocused: false };
	mod.notifySessionFinished(makeDeps(settings), { agentId: "a1", title: "x".repeat(16000) });
	assert.equal(shown.length, 1);
	assert.ok(shown[0].options.body.length < 200, `body length ${shown[0].options.body.length}`);
	assert.match(shown[0].options.body, /…/);

	mod.notifyAskPending(makeDeps(settings), { agentId: "a1", sessionId: "s1", sessionTitle: "s".repeat(16000), question: "" });
	assert.ok(shown[1].options.body.length < 200, `ask body length ${shown[1].options.body.length}`);
});

test("完成通知在 1s 内合并，避免连续 toast 阻塞；Ask 不受限", () => {
	const { mod, shown } = loadToast();
	let now = 1000;
	const settings = { enableNotifications: true, askNotificationEnabled: true, alertOnlyWhenUnfocused: false };
	const deps = { ...makeDeps(settings), now: () => now };

	mod.notifySessionFinished(deps, { agentId: "a1", title: "T1" });
	assert.equal(shown.length, 1);
	now += 300;
	mod.notifySessionFinished(deps, { agentId: "a2", title: "T2" });
	assert.equal(shown.length, 1, "1s 内第二个完成通知被节流");
	now += 800;
	mod.notifySessionFinished(deps, { agentId: "a3", title: "T3" });
	assert.equal(shown.length, 2, "超过间隔后恢复");

	mod.notifyAskPending(deps, { agentId: "a4", sessionId: "s1", sessionTitle: "Q", question: "q" });
	assert.equal(shown.length, 3, "Ask 通知需要用户操作，不参与节流");
});

test("Ask 通知走独立开关，返回是否真的弹出（供每轮去重），问题文本截断 60 字符", () => {
	const { mod, shown } = loadToast();
	const settings = { enableNotifications: true, askNotificationEnabled: false, alertOnlyWhenUnfocused: false };
	assert.equal(mod.notifyAskPending(makeDeps(settings), { agentId: "a1", sessionId: "s1", sessionTitle: "T", question: "q" }), false, "开关关着不弹出");
	assert.equal(shown.length, 0);

	settings.askNotificationEnabled = true;
	const question = "x".repeat(80);
	assert.equal(mod.notifyAskPending(makeDeps(settings), { agentId: "a1", sessionId: "s1", sessionTitle: "T", question }), true);
	assert.equal(shown.length, 1);
	assert.match(shown[0].options.body, /x{60}…/);
	assert.doesNotMatch(shown[0].options.body, /x{61}/);

	// 没有提问内容时退回通用文案
	mod.notifyAskPending(makeDeps(settings), { agentId: "a1", sessionId: "s1", sessionTitle: "T", question: "" });
	assert.match(shown[1].options.body, /mainNotification\.askPending/);
});
