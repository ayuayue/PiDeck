import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 2026-10-06 事故回归：输入触发的预热（activateRuntime）在引导页虚拟会话上必然
// 报「会话不存在」。本文件是纯源码契约测试，不依赖 vm loader——
// composerPrewarmFocus.test.mjs 的 loader 因上游新增 ./timeline/sendScroll import
// 缺 stub 而红（基线复跑确认），与本修复无关。
const composerArea = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");

test("input prewarm skips the guide bootstrap virtual session", () => {
	// 跳过判定必须在 activateRuntime 调用之前；引导页的 standby 预热由首次
	// 发送时的 createDraft IPC 触发（sessionIpc createDraft → ensureStandbyAgent）。
	const prewarmEffect = composerArea.slice(composerArea.indexOf("prewarmStartedForSessionRef = useRef"), composerArea.indexOf("desktopApi.sessions.activateRuntime"));
	assert.match(prewarmEffect, /if\s*\(\s*props\.sessionId\s*===\s*GUIDE_BOOTSTRAP_SESSION_ID\s*\)\s*return;/);
});
