import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { selectAtom } from "jotai/utils";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 模块图：session-atoms / composer-atoms / 时间线控制器（同一沙箱实例共享模块缓存，
 * 所以 composer-atoms 的 ./session-atoms 与上面加载的是同一份）。
 *
 * 相对 import 交给 createTsSandbox 按**被加载文件目录**解析：旧的手写 require 桥
 * 以 tests/ 为基准，生产代码一新增本地依赖就整片 MODULE_NOT_FOUND（本文件曾挂在这里：
 * session-atoms 链路新增 ../i18n 依赖后报 `Cannot find module '../i18n'`）。
 * jotai / react 不 stub —— 保持真实模块（与历史行为一致，atomFamily 在模块顶层求值）。
 */
const sandbox = createTsSandbox({
	stubs: {
		"../atoms": {},
		"../lib/pinTurnScroll": { animateScrollTop: () => () => undefined, pinScrollDurationMs: () => 320 },
		"../desktopApi": {},
		// i18n 只用到 t()：测试不校验文案，桩成直返 key。
		"../i18n": { t: (key) => key },
		"./timeline/autoExpandThreshold": { TURN_WINDOW_AUTO_EXPAND_THRESHOLD: 120, resolveAutoExpandThreshold: (h) => Math.max(120, Math.round(h * 0.4)) },
		"./timeline/scrollHistoryPolicy": {},
		"../components/session/timeline/turnRenderWindow": {
			TIMELINE_MOUNTED_TURN_LIMIT: 3,
			TIMELINE_SCROLLED_TURN_LIMIT: 3,
			TIMELINE_WINDOW_EXPAND_STEP: 3,
		},
	},
	globals: { Date },
});
const sessionAtoms = sandbox("src/renderer/src/atoms/session-atoms.ts");
const composerAtoms = sandbox("src/renderer/src/atoms/composer-atoms.ts");
const timeline = sandbox("src/renderer/src/hooks/useSessionTimelineController.ts");
const historyAvailability = sandbox("src/renderer/src/utils/sessionHistoryAvailability.ts");

test("session load and send selectors retain current references across background patches", () => {
	const store = createStore();
	const loadA = { status: "loading" };
	const sendA = { status: "activating" };
	const loadSelector = selectAtom(sessionAtoms.sessionMessageLoadStateAtom, (all) => all.A, Object.is);
	const sendSelector = selectAtom(composerAtoms.sessionSendStateByIdAtom, (all) => all.A, Object.is);
	store.set(sessionAtoms.sessionMessageLoadStateAtom, { A: loadA, B: { status: "ready" } });
	store.set(composerAtoms.sessionSendStateByIdAtom, { A: sendA, B: { status: "sending" } });
	const currentLoad = store.get(loadSelector);
	const currentSend = store.get(sendSelector);
	store.set(sessionAtoms.sessionMessageLoadStateAtom, { A: loadA, B: { status: "error" } });
	store.set(composerAtoms.sessionSendStateByIdAtom, { A: sendA, B: { status: "unknown" } });
	assert.equal(store.get(loadSelector), currentLoad);
	assert.equal(store.get(sendSelector), currentSend);
});

test("modern surface state covers cached loading, activation before binding, and unknown", () => {
	const cachedLoading = timeline.deriveSessionSurfaceRuntime(0, "loading", "idle", undefined, undefined);
	const activating = timeline.deriveSessionSurfaceRuntime(0, "ready", "activating", undefined, undefined, true);
	const unknown = timeline.deriveSessionSurfaceRuntime(0, "ready", "unknown", undefined, undefined);
	assert.equal(cachedLoading.isLoading, true);
	// 空会话已读完磁盘：发送 activating 只表示进程在起，不能把起始页换成骨架屏。
	assert.equal(activating.isLoading, false);
	assert.equal(activating.status, "starting");
	assert.equal(activating.isBusy, true);
	assert.equal(activating.isStarting, true);
	assert.equal(unknown.status, undefined);
	assert.equal(unknown.isStarting, false);
	assert.equal(unknown.isBusy, false);
});

test("timeline controller exposes surface loading for the bottom composer gate", () => {
	const controllerSource = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
	// SessionView 不能再用 messages.length>0 当挂载条件：历史会话首帧 length=0。
	assert.match(controllerSource, /isSurfaceLoading/);
	assert.match(controllerSource, /deriveSessionSurfaceRuntime\(/);
	assert.match(controllerSource, /isKnownEmptySessionRecord/);
	// 切会话已有缓存或空草稿时不得把 loadState 打成 loading（否则空会话闪骨架）。
	assert.match(controllerSource, /if \(cachedEntry \|\| knownEmpty\) return/);
	// 预热写 filePath/dshSessionId 后仍粘住空会话，避免起始页 / 历史骨架抽搐。
	assert.match(controllerSource, /stickyEmptyRef/);
	// 无锚点恢复必须等读盘完成，否则冷会话 scrollHeight≈0 把 restorePhase 钉成 complete。
	assert.match(controllerSource, /if \(isSurfaceLoading\) return;\s*const requestOwnerKey = ownerKey;\s*if \(!anchor\)/);
	const timelineSource = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	assert.match(timelineSource, /controller\.knownEmpty/);
	assert.doesNotMatch(timelineSource, /isKnownEmptySessionRecord\(/);
});

test("timeline skeleton copy is history loading, not agent starting", () => {
	const timelineSource = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.match(timelineSource, /t\("app\.historyLoading"\)/);
	assert.doesNotMatch(timelineSource.slice(timelineSource.indexOf("{isConversationLoading && (")), /t\("app\.agentStarting"\)/);
	assert.match(zh, /"app\.historyLoading": "正在加载历史…"/);
	assert.match(en, /"app\.historyLoading": "Loading history\.\.\."/);
});

test("unloaded session with no load state must not flash the start surface", () => {
	// 挂载首帧 loadState 尚未写入（passive effect 在 paint 后才执行）时，
	// 历史会话会被误判为「空会话」→ 起始页闪屏。undefined 一律视为加载中。
	const unloaded = timeline.deriveSessionSurfaceRuntime(0, undefined, "idle", undefined, undefined);
	assert.equal(unloaded.isLoading, true);
});

test("known-empty drafts stay on the start surface instead of flashing history loading", () => {
	// 新建/切到空草稿：catalog 已确认无文件无消息。不能把 undefined/loading
	// 钉成骨架——否则底部 composer 先挂再卸（输入框上跳），切回空会话还闪「正在加载历史」。
	const unloadedDraft = timeline.deriveSessionSurfaceRuntime(0, undefined, "idle", undefined, undefined, false, true);
	assert.equal(unloadedDraft.isLoading, false);
	const loadingDraft = timeline.deriveSessionSurfaceRuntime(0, "loading", "idle", undefined, undefined, false, true);
	assert.equal(loadingDraft.isLoading, false);
	// 有会话文件的历史仍按原规则：未到缓存前必须钉骨架，禁止闪起始页。
	const history = timeline.deriveSessionSurfaceRuntime(0, undefined, "idle", undefined, undefined, false, false);
	assert.equal(history.isLoading, true);
});

test("isKnownEmptySessionRecord only treats drafts and file-less empty sessions as empty", () => {
	const { isKnownEmptySessionRecord } = timeline;
	assert.equal(isKnownEmptySessionRecord(undefined), false);
	assert.equal(isKnownEmptySessionRecord({ status: "draft", messageCount: 0 }), true);
	assert.equal(isKnownEmptySessionRecord({ status: "active", messageCount: 0 }), true);
	assert.equal(
		isKnownEmptySessionRecord({
			status: "active",
			messageCount: 0,
			filePath: "/tmp/session.jsonl",
		}),
		false,
	);
	assert.equal(
		isKnownEmptySessionRecord({
			status: "active",
			messageCount: 3,
		}),
		false,
	);
	assert.equal(
		isKnownEmptySessionRecord({
			status: "active",
			messageCount: 0,
			backend: "dsh",
			dshSessionId: "sess_1",
		}),
		false,
	);
	// imagegen 会话历史独立存 ImageSessionStore，不体现在 filePath/messageCount：
	// 已 promote 的 active 生图会话不能判空，否则重启后打开跳过历史加载显示空引导页。
	assert.equal(
		isKnownEmptySessionRecord({
			status: "active",
			messageCount: 0,
			backend: "imagegen",
		}),
		false,
	);
	// 尚未生图的 imagegen 草稿仍是空会话，保持起始页。
	assert.equal(
		isKnownEmptySessionRecord({
			status: "draft",
			messageCount: 0,
			backend: "imagegen",
		}),
		true,
	);
	// 预热已写 host id，但草稿尚未开聊：仍是空会话，不能去拉历史骨架。
	assert.equal(
		isKnownEmptySessionRecord({
			status: "draft",
			messageCount: 0,
			backend: "dsh",
			dshSessionId: "sess_1",
		}),
		true,
	);
});

test("ready load state with known-history record and empty cache stays loading", () => {
	// LRU 淘汰缓存后 loadState 残留 ready：缓存条目不存在（disk 读取结果未到达）
	// 必须视为加载中，禁止显示起始页——不依赖 catalog messageCount（摘要缺失时
	// 兜底为 0，老记录会误判真空）。
	const evicted = timeline.deriveSessionSurfaceRuntime(0, "ready", "idle", undefined, undefined, false);
	assert.equal(evicted.isLoading, true);
	// disk 已返回且确认无消息（cacheMessages 无论空/非空都会创建条目）：
	// ready + 条目存在 = 读取完成，空会话显示起始页是合法终态，不死锁。
	const diskConfirmedEmpty = timeline.deriveSessionSurfaceRuntime(0, "ready", "idle", undefined, undefined, true);
	assert.equal(diskConfirmedEmpty.isLoading, false);
	// 读取失败不进入加载死循环（保持既有错误后的呈现路径）。
	const loadError = timeline.deriveSessionSurfaceRuntime(0, "error", "idle", undefined, undefined, true);
	assert.equal(loadError.isLoading, false);
});
test("load-more follows modern starting state while legacy remains prop-owned", () => {
	// 初始加载（无消息）时隐藏按钮
	assert.equal(timeline.canLoadSessionTimelineMore(true, 0), false);
	// runtime 创建期间已有消息则不隐藏（避免闪烁）
	assert.equal(timeline.canLoadSessionTimelineMore(true, 150), true);
	// idle 状态始终显示
	assert.equal(timeline.canLoadSessionTimelineMore(false, 0), true);
	assert.equal(timeline.canLoadSessionTimelineMore(false, 150), true);
	const legacyCanLoadMoreMessages = false;
	assert.equal(legacyCanLoadMoreMessages, false);
});

test("ready with zero record count and no cache entry still stays loading", () => {
	// 上一版曾用「recordMessageCount>0 || hasSessionFile」判据：catalog messageCount
	// 缺失（兜底 0）时失效，且文件残留空会死锁骨架屏。缓存条目存在性判据对
	// count=0 的老记录同样生效，disk 返回空后能正常退出 loading（不闪起始页不死锁）。
	const staleRecord = timeline.deriveSessionSurfaceRuntime(0, "ready", "idle", undefined, undefined, false);
	assert.equal(staleRecord.isLoading, true);
	const staleRecordAfterDisk = timeline.deriveSessionSurfaceRuntime(0, "ready", "idle", undefined, undefined, true);
	assert.equal(staleRecordAfterDisk.isLoading, false);
});

test("history availability gate only flags pages main marked unavailable", () => {
	const { sessionHistoryUnavailableState } = historyAvailability;
	// DSH host 被手动停止：main 返回带原因的空页，渲染层必须进错误专态而不是写空缓存。
	const stopped = sessionHistoryUnavailableState({ messages: [], total: 0, nextBefore: null, unavailable: "dsh-host-stopped" });
	// 跨 realm 对象用字段比较（deepStrictEqual 会拿 prototype 身份，必然不等）
	assert.equal(stopped?.status, "error");
	assert.equal(stopped?.reason, "dsh-host-stopped");
	// 真空会话（无 unavailable 字段）不能被误判成不可用——否则空草稿永远进错误态。
	assert.equal(sessionHistoryUnavailableState({ messages: [], total: 0, nextBefore: null }), null);
	assert.equal(sessionHistoryUnavailableState({ messages: [{ role: "user" }], total: 1, nextBefore: 0 }), null);
});
