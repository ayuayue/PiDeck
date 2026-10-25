import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
const notice = readFileSync("src/renderer/src/components/session/timelineFailureNotice.ts", "utf8");
const eventCards = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
const retryStep = readFileSync("src/renderer/src/components/session/turn/RetryStep.tsx", "utf8");
const processSummaryToggle = readFileSync("src/renderer/src/components/session/turn/ProcessSummaryToggle.tsx", "utf8");

const i18n = loadTsCommonJs("src/renderer/src/i18n.ts");
const { FLOATING_FAILURE_KEYS, RETRY_STATUS_KEYS, composeFailureNotice, failureRetrySignature, isExtensionErrorMessage, isFailureNoticeMessage, isFloatingFailureMessage, isRetryStatusMessage, isTransientRetryCard, reduceFailureNoticePass } = loadTsCommonJs(
	"src/renderer/src/components/session/timelineFailureNotice.ts",
	{
		// 与 composeFailureNotice 共用同一份 i18n 模块，否则 setI18nLocale 改不到 toast 文案。
		stubs: { "../../i18n": i18n },
	},
);
const { setI18nLocale } = i18n;

function message(i18nKey, extras = {}) {
	return {
		id: extras.id ?? "msg-1",
		agentId: extras.agentId ?? "agent-1",
		role: extras.role ?? "error",
		text: extras.text ?? "fallback",
		timestamp: 1,
		meta: {
			i18nKey,
			...(extras.debugDetails ? { debugDetails: extras.debugDetails } : {}),
			...(extras.i18nParams ? { i18nParams: extras.i18nParams } : {}),
		},
	};
}

test("floating failure keys: covers retry + failure diagnostics, excludes start/runtime/extension cards", () => {
	const keys = [
		"diagnostic.requestFailed",
		"diagnostic.requestFailedAfterRetries",
		"diagnostic.requestFailedUnknown",
		"diagnostic.requestFailedUnknownAfterRetries",
		"diagnostic.agentStopped",
		"diagnostic.promptRejected",
		"diagnostic.promptDeliveryUnknown",
		"diagnostic.commandFailed",
		"diagnostic.commandDeliveryUnknown",
		"diagnostic.commandCancelled",
		"diagnostic.processReconnectFailed",
		"diagnostic.historyLoadFailed",
		"diagnostic.retryScheduled",
		"diagnostic.retryScheduledAfterDelay",
		"diagnostic.retrySucceeded",
		"diagnostic.retryFailed",
	];
	for (const key of keys) {
		assert.equal(FLOATING_FAILURE_KEYS.has(key), true, `missing ${key} in FLOATING_FAILURE_KEYS`);
	}
	// 扩展错误要保留诊断卡（带 debugDetails），不能再进浮动 Set
	assert.equal(FLOATING_FAILURE_KEYS.has("diagnostic.extensionError"), false);
	assert.equal(isFloatingFailureMessage(message("diagnostic.extensionError")), false);
	assert.equal(isExtensionErrorMessage(message("diagnostic.extensionError")), true);
	assert.equal(isFailureNoticeMessage(message("diagnostic.extensionError")), true);
	assert.equal(isFailureNoticeMessage(message("diagnostic.requestFailed")), true);
	assert.equal(isFailureNoticeMessage(message("diagnostic.agentStartFailed")), false);
	assert.equal(isFailureNoticeMessage(message("diagnostic.compactReconnected")), false);
	assert.doesNotMatch(notice, /"diagnostic\.agentStartFailed"/);
	assert.doesNotMatch(notice, /"diagnostic\.runtimeError"/);
});

test("timeline render: 重试状态与失败诊断都渲染卡片，重试卡带专属标题与旋转图标", () => {
	// 用户反馈：重试只弹 toast（且会自动消失），事后在会话里找不到重试痕迹 → 不再短路重试状态。
	assert.doesNotMatch(timeline, /isToastOnlyFailureMessage/);
	assert.doesNotMatch(notice, /TOAST_ONLY_FAILURE_KEYS/);
	assert.match(timeline, /composeFailureNotice\(message\)/);
	assert.match(timeline, /from "\.\/timelineFailureNotice"/);
	// error / system 两个分支都必须渲染诊断卡片（旧实现各有一条 return null 的重试短路）
	const cardReturns = timeline.match(/return <DiagnosticMessageCard key=\{message\.id\} message=\{message\} \/>;/g) ?? [];
	assert.equal(cardReturns.length, 2);
	// 重试卡在卡片组件里换标题 + running 态旋转图标，与普通「系统状态」区分开
	assert.match(eventCards, /isRetryStatusMessage\(props\.message\)/);
	assert.match(eventCards, /t\("diagnostic\.retryTitle"\)/);
	assert.match(eventCards, /className=\{retryRunning \? "animate-pideck-spin" : undefined\}/);
});

test("transient retry card: 重试卡不进时间线顶层，改由 run 内过程行留痕", () => {
	// 用户反馈（m00001）：重试卡与工具时间线割裂且顺序错乱 → 全部重试状态卡不再
	// 渲染顶层大卡片，收进所属 agent-run 的过程行（RetryStep，失败红/运行中旋转）。
	// toast 层判定保持不变：成功卡仍算重试状态卡，toast 照常弹。
	assert.equal(isRetryStatusMessage(message("diagnostic.retrySucceeded", { role: "system", text: "自动重试成功，共重试 2 次" })), true);
	assert.equal(isRetryStatusMessage(message("diagnostic.retryScheduled", { role: "system" })), true);
	assert.equal(isRetryStatusMessage(message("diagnostic.retryFailed", { role: "system" })), true);
	// 渲染层 system 分支短路全部重试状态卡（留痕职责移交 run 内过程行）
	assert.match(timeline, /if \(isRetryStatusMessage\(message\)\) return null;/);
	// RetryStep 过程行存在且复用工具行语言（tool-card class + 失败 tone-error）
	assert.match(retryStep, /tool-card w-full min-w-0 tone-/);
	assert.match(retryStep, /animate-pideck-spin/);
	// 过程摘要包含重试计数（折叠态一眼可看出本轮重试过）
	assert.match(processSummaryToggle, /executionRetryCount/);
});

test("retry success toast: 卡片不进时间线，toast 仍照常弹", () => {
	const toastedIds = new Set();
	const toastedRetrySignatures = new Set();
	const baseline = pass({ toastedIds, toastedRetrySignatures });
	const succeeded = message("diagnostic.retrySucceeded", {
		id: "retry-ok",
		role: "system",
		text: "自动重试成功，共重试 2 次",
		i18nParams: { count: "2/3" },
	});
	const live = pass({
		messages: [succeeded],
		state: baseline.state,
		toastedIds,
		toastedRetrySignatures,
	});
	assert.equal(toastIds(live), "retry-ok");
	assert.equal(failureRetrySignature(succeeded), "retry-ok:diagnostic.retrySucceeded:2/3");
});

test("retry status keys: 覆盖重试周期四态，不含普通失败诊断", () => {
	assert.equal(RETRY_STATUS_KEYS.has("diagnostic.retryScheduled"), true);
	assert.equal(RETRY_STATUS_KEYS.has("diagnostic.retryScheduledAfterDelay"), true);
	assert.equal(RETRY_STATUS_KEYS.has("diagnostic.retrySucceeded"), true);
	// retryFailed 是重试周期的收敛态，同样走重试卡语言
	assert.equal(RETRY_STATUS_KEYS.has("diagnostic.retryFailed"), true);
	// 普通失败诊断不是重试卡
	assert.equal(RETRY_STATUS_KEYS.has("diagnostic.requestFailed"), false);
	assert.equal(RETRY_STATUS_KEYS.has("diagnostic.agentStopped"), false);
	assert.equal(isRetryStatusMessage(message("diagnostic.retryScheduled")), true);
	assert.equal(isRetryStatusMessage(message("diagnostic.retryFailed")), true);
	assert.equal(isRetryStatusMessage(message("diagnostic.requestFailed")), false);
	// toast 层不受影响：重试周期每个 key 都仍然弹 toast（卡片与 toast 并存）
	assert.equal(isFloatingFailureMessage(message("diagnostic.retryFailed")), true);
	assert.equal(isFloatingFailureMessage(message("diagnostic.retrySucceeded")), true);
});

test("toast effect: reducer owns session-aware baseline; retry signatures survive tab switches", () => {
	assert.match(timeline, /reduceFailureNoticePass/);
	assert.match(timeline, /const toastedRetrySignatures = new Set<string>\(\);/);
	assert.match(timeline, /const toastedFailureIds = new Set<string>\(\);/);
	assert.doesNotMatch(timeline, /const lastRetryToastRef/);
	assert.doesNotMatch(timeline, /const failureBaselineRef/);
	assert.match(notice, /session-retry:\$\{message\.agentId\}/);
});

function emptyNoticeState() {
	return { sessionId: undefined, baselineIds: null };
}

function pass(overrides) {
	return reduceFailureNoticePass({
		sessionId: "session-a",
		isLoading: false,
		messages: [],
		state: emptyNoticeState(),
		toastedIds: new Set(),
		toastedRetrySignatures: new Set(),
		...overrides,
	});
}

/** loadTsCommonJs 在独立 VM 里跑，返回的数组不能和本环境字面量 deepEqual。 */
function toastIds(result) {
	return Array.from(result.toasts, (item) => String(item.id)).join(",");
}

test("reduceFailureNoticePass: live reconnect failure toasts once, switch-back does not replay", () => {
	const toastedIds = new Set();
	const toastedRetrySignatures = new Set();
	const reconnect = message("diagnostic.processReconnectFailed", { id: "fail-1", text: "自动重连失败" });

	const loading = pass({
		isLoading: true,
		toastedIds,
		toastedRetrySignatures,
	});
	assert.equal(toastIds(loading), "");

	const baseline = pass({
		state: loading.state,
		toastedIds,
		toastedRetrySignatures,
	});
	assert.equal(toastIds(baseline), "");

	const live = pass({
		messages: [reconnect],
		state: baseline.state,
		toastedIds,
		toastedRetrySignatures,
	});
	assert.equal(toastIds(live), "fail-1");

	// 切到另一会话再切回：组件会丢掉 ref，但模块级 Set 必须继续挡住同一条失败。
	const other = pass({
		sessionId: "session-b",
		isLoading: true,
		state: live.state,
		toastedIds,
		toastedRetrySignatures,
	});
	const backLoading = pass({
		isLoading: true,
		state: other.state,
		toastedIds,
		toastedRetrySignatures,
	});
	const back = pass({
		messages: [reconnect],
		state: backLoading.state,
		toastedIds,
		toastedRetrySignatures,
	});
	assert.equal(toastIds(back), "");
});

test("reduceFailureNoticePass: retry toast does not replay after switching sessions", () => {
	const toastedIds = new Set();
	const toastedRetrySignatures = new Set();
	const retry = message("diagnostic.retryScheduled", {
		id: "retry-1",
		text: "正在自动重试 1",
		i18nParams: { count: 1 },
	});

	const baseline = pass({ toastedIds, toastedRetrySignatures });
	const live = pass({
		messages: [retry],
		state: baseline.state,
		toastedIds,
		toastedRetrySignatures,
	});
	assert.equal(toastIds(live), "retry-1");
	assert.equal(failureRetrySignature(retry), "retry-1:diagnostic.retryScheduled:1");

	const other = pass({
		sessionId: "session-b",
		isLoading: true,
		state: live.state,
		toastedIds,
		toastedRetrySignatures,
	});
	const back = pass({
		messages: [retry],
		state: { sessionId: other.state.sessionId, baselineIds: null },
		toastedIds,
		toastedRetrySignatures,
	});
	assert.equal(toastIds(back), "");

	const nextAttempt = message("diagnostic.retryScheduled", {
		id: "retry-1",
		text: "正在自动重试 2",
		i18nParams: { count: 2 },
	});
	const next = pass({
		messages: [nextAttempt],
		state: back.state,
		toastedIds,
		toastedRetrySignatures,
	});
	assert.equal(toastIds(next), "retry-1");
});

test("reduceFailureNoticePass: cached session switch without a loading flicker still does not replay", () => {
	// 旧 bug：同一 Timeline 实例切会话时 lastRetryToastRef 被清空，但 baseline 仍是上一会话的 id，
	// 且 retry 绕过 toastedFailureIds，切回就会把同一条重连 toast 再弹一遍。
	const toastedIds = new Set();
	const toastedRetrySignatures = new Set();
	const retry = message("diagnostic.retryScheduled", {
		id: "retry-cached",
		text: "正在自动重试 1",
		i18nParams: { count: 1 },
	});
	const reconnect = message("diagnostic.processReconnectFailed", {
		id: "fail-cached",
		text: "自动重连失败",
	});

	const readyA = pass({ toastedIds, toastedRetrySignatures });
	const liveA = pass({
		messages: [retry, reconnect],
		state: readyA.state,
		toastedIds,
		toastedRetrySignatures,
	});
	assert.equal(toastIds(liveA), "retry-cached,fail-cached");

	const readyB = pass({
		sessionId: "session-b",
		messages: [],
		state: liveA.state,
		toastedIds,
		toastedRetrySignatures,
	});
	assert.equal(toastIds(readyB), "");

	const backA = pass({
		messages: [retry, reconnect],
		state: readyB.state,
		toastedIds,
		toastedRetrySignatures,
	});
	assert.equal(toastIds(backA), "");
});

test("composeFailureNotice: retry stays info, request failure stays session-error title", () => {
	setI18nLocale("zh-CN");
	const retry = composeFailureNotice(
		message("diagnostic.retryScheduled", {
			text: "正在自动重试 2",
			i18nParams: { count: 2 },
		}),
	);
	assert.equal(retry.kind, "info");
	assert.equal(retry.duration, 2200);
	assert.equal(retry.id, "session-retry:agent-1");
	assert.equal(retry.title, "自动重试");

	const failed = composeFailureNotice(
		message("diagnostic.requestFailed", {
			text: "请求失败。",
			debugDetails: "HTTP 429",
		}),
	);
	assert.equal(failed.kind, "error");
	assert.equal(failed.title, "会话失败");
	assert.match(failed.body, /请求失败/);
	assert.match(failed.body, /HTTP 429/);
});

test("composeFailureNotice: extension error uses its own title and shows debugDetails", () => {
	setI18nLocale("zh-CN");
	const noticeContent = composeFailureNotice(
		message("diagnostic.extensionError", {
			text: "扩展执行错误。",
			debugDetails: "pi-deck-todo: Cannot read properties of undefined",
		}),
	);
	assert.equal(noticeContent.title, "扩展执行错误");
	assert.equal(noticeContent.kind, "error");
	assert.equal(noticeContent.body, "pi-deck-todo: Cannot read properties of undefined");
	assert.notEqual(noticeContent.title, "会话失败");
	assert.equal(noticeContent.id, undefined);

	const clipped = composeFailureNotice(
		message("diagnostic.extensionError", {
			text: "扩展执行错误。",
			debugDetails: "x".repeat(400),
		}),
	);
	assert.equal(clipped.body.endsWith("…"), true);
	assert.ok(clipped.body.length < 400);
});

test("failure toast i18n keys exist in zh-CN and en-US", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.match(zh, /"diagnostic\.failureToastTitle": "会话失败"/);
	assert.match(zh, /"diagnostic\.extensionErrorToastTitle": "扩展执行错误"/);
	assert.match(zh, /"diagnostic\.retryTitle": "自动重试"/);
	assert.match(en, /"diagnostic\.failureToastTitle": "Session error"/);
	assert.match(en, /"diagnostic\.extensionErrorToastTitle": "Extension error"/);
	assert.match(en, /"diagnostic\.retryTitle": "Auto retry"/);
});
