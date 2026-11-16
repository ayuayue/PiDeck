import assert from "node:assert/strict";
import test from "node:test";
import { sessionTimelineControllerSource as source } from "./helpers/sessionTimelineControllerSources.mjs";

test("timeline 控制器不再整表订阅加载状态 atom", () => {
	assert.doesNotMatch(source, /useAtomValue\(sessionMessageLoadStateAtom\)/);
});

test("加载状态改为本会话 status 切片订阅（selectAtom）", () => {
	assert.match(source, /selectAtom\(\s*sessionMessageLoadStateAtom,/);
	assert.match(source, /loadStateStatus/);
});
