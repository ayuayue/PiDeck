import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 分批扩窗的防爆契约（2026-11）。
 *
 * 真机现场：点大纲最上面的刻度 → 界面弹「界面渲染异常」（React #185）。
 * 崩溃栈落在 `setScrolledWindowTurns((prev) => prev + batch)`：补页每补一页都会
 * `expandWindowBatched(growth)` 排一批，补到很早的历史时待扩量累计上百轮，
 * rAF 链上连发上百次 setState，超过 React 的嵌套更新上限。
 *
 * 这两条是那次修复的骨架，删掉任何一条都会静默退回崩溃形态：
 *   1. 待扩量超过单链上限时一次性推开（把上百次 setState 压成一次）
 *   2. 窗口轮数有上限（不超过已加载消息数），不再无限膨胀
 */
const source = readFileSync(new URL("../src/renderer/src/hooks/useSessionTimelineController.ts", import.meta.url), "utf8");

test("待扩量超过单链上限时一次性推开", () => {
	assert.match(source, /TURN_WINDOW_EXPAND_MAX_CHAIN_TURNS\s*=\s*\d+/);
	assert.match(source, /const batch = backlog > TURN_WINDOW_EXPAND_MAX_CHAIN_TURNS \? backlog : Math\.min\(TURN_WINDOW_EXPAND_BATCH_TURNS, backlog\);/);
});

test("窗口轮数不超过已加载消息数", () => {
	assert.match(source, /loadedMessageCountRef\.current = combinedMessages\.length;/);
	assert.match(source, /setScrolledWindowTurns\(\(prev\) => Math\.min\(prev \+ batch, Math\.max\(prev, windowCap\)\)\);/);
});

test("补页遇到「补不出新内容」立即结算，不再空转", () => {
	const stage = readFileSync(new URL("../src/renderer/src/components/session/SessionSurfaceStage.tsx", import.meta.url), "utf8");
	assert.match(stage, /const noProgress =/);
	assert.match(stage, /if \(step === "load" && !noProgress\)/);
	// 发下一页必须让出一轮：同步发会让 effect → setState → effect 连成嵌套更新链
	assert.match(stage, /const timer = setTimeout\(\(\) => \{/);
});
