import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { constrainWindowBoundsToWorkArea, readLastWindowBounds, saveLastWindowBounds } from "../src/main/windowState.ts";

/**
 * 窗口大小记忆（startupWindowMode="last"）存储层测试：
 * 保存/读取/损坏容错/最小尺寸校验。
 */
test("windowState: save then read returns the same bounds", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		saveLastWindowBounds(dir, { width: 1360, height: 800 });
		assert.deepEqual(readLastWindowBounds(dir), { width: 1360, height: 800 });
		// 写入文件为 JSON 格式（后续人工排查/清理可读）
		assert.match(readFileSync(join(dir, "last-window-bounds.json"), "utf8"), /"width":1360/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: missing file returns null (fallback to default mode)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		assert.equal(readLastWindowBounds(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: corrupted JSON returns null", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		saveLastWindowBounds(dir, { width: 1200, height: 700 });
		const file = join(dir, "last-window-bounds.json");
		writeFileSync(file, "{not-json", "utf8");
		assert.equal(readLastWindowBounds(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: bounds below minimum window size are rejected", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		saveLastWindowBounds(dir, { width: 600, height: 400 });
		assert.equal(readLastWindowBounds(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: fractional bounds are rounded on save", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		saveLastWindowBounds(dir, { width: 1360.7, height: 800.2 });
		assert.deepEqual(readLastWindowBounds(dir), { width: 1361, height: 800 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: non-finite persisted bounds are rejected", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		writeFileSync(join(dir, "last-window-bounds.json"), '{"width":1e999,"height":800}', "utf8");
		assert.equal(readLastWindowBounds(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: full-work-area restore is inset and centered", () => {
	const workArea = { x: 0, y: 0, width: 2560, height: 1439 };
	const bounds = constrainWindowBoundsToWorkArea({ width: 2560, height: 1439 }, workArea);

	assert.deepEqual(bounds, { x: 16, y: 16, width: 2528, height: 1407 });
	assert.notDeepEqual(bounds, { x: 0, y: 0, width: 2560, height: 1439 });
	assert.ok(bounds.x >= workArea.x);
	assert.ok(bounds.y >= workArea.y);
	assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
	assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height);
});

test("windowState: negative-coordinate work areas keep the restored window inside the target display", () => {
	const bounds = constrainWindowBoundsToWorkArea({ width: 1400, height: 800 }, { x: -1920, y: -100, width: 1920, height: 1080 });

	assert.deepEqual(bounds, { x: -1660, y: 40, width: 1400, height: 800 });
	assert.ok(bounds.x >= -1920);
	assert.ok(bounds.y >= -100);
	assert.ok(bounds.x + bounds.width <= 0);
	assert.ok(bounds.y + bounds.height <= 980);
});

test("windowState: work areas smaller than the minimum preserve the minimum and center as far as possible", () => {
	const bounds = constrainWindowBoundsToWorkArea({ width: 1200, height: 900 }, { x: 100, y: 50, width: 800, height: 600 });

	assert.deepEqual(bounds, { x: 60, y: 30, width: 880, height: 640 });
});

test("windowState: invalid values fall back to finite minimum-size bounds", () => {
	const bounds = constrainWindowBoundsToWorkArea({ width: Number.NaN, height: Number.POSITIVE_INFINITY }, { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: Number.NaN, height: -1 });

	assert.deepEqual(bounds, { x: 0, y: 0, width: 880, height: 640 });
});
