import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");

test("timeline 控制器不再整表订阅加载状态 atom", () => {
	assert.doesNotMatch(source, /useAtomValue\(sessionMessageLoadStateAtom\)/);
});

test("加载状态改为本会话 status 切片订阅（selectAtom）", () => {
	assert.match(source, /selectAtom\(\s*sessionMessageLoadStateAtom,/);
	assert.match(source, /loadStateStatus/);
});
