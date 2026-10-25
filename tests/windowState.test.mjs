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

// ===== 位置与最大化记忆（#?）——此前只存宽高，每次启动都居中 =====

test("windowState: position and maximized flag round-trip through save/read", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		saveLastWindowBounds(dir, { x: 2100.4, y: -80.6, width: 1360, height: 800, maximized: true });
		assert.deepEqual(readLastWindowBounds(dir), { x: 2100, y: -81, width: 1360, height: 800, maximized: true });
		// maximized=false 不落盘（与旧文件格式保持一致，读出时字段缺省即 false）
		saveLastWindowBounds(dir, { x: 10, y: 20, width: 1360, height: 800, maximized: false });
		assert.deepEqual(readLastWindowBounds(dir), { x: 10, y: 20, width: 1360, height: 800 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: legacy size-only record still reads (no position, not maximized)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		writeFileSync(join(dir, "last-window-bounds.json"), '{"width":1251,"height":965}', "utf8");
		assert.deepEqual(readLastWindowBounds(dir), { width: 1251, height: 965 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: half or non-finite position is dropped as a whole", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		writeFileSync(join(dir, "last-window-bounds.json"), '{"width":1251,"height":965,"x":100}', "utf8");
		assert.deepEqual(readLastWindowBounds(dir), { width: 1251, height: 965 });
		writeFileSync(join(dir, "last-window-bounds.json"), '{"width":1251,"height":965,"x":100,"y":1e999,"maximized":"yes"}', "utf8");
		assert.deepEqual(readLastWindowBounds(dir), { width: 1251, height: 965 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: recorded position inside the work area is restored as-is (no centering)", () => {
	const bounds = constrainWindowBoundsToWorkArea({ x: 300, y: 120, width: 1251, height: 965 }, { x: 0, y: 0, width: 2560, height: 1400 });
	assert.deepEqual(bounds, { x: 300, y: 120, width: 1251, height: 965 });
});

test("windowState: recorded position is clamped into the work area with the safety inset", () => {
	const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
	// 右下越界 → 贴右下内边距
	assert.deepEqual(constrainWindowBoundsToWorkArea({ x: 1500, y: 900, width: 1200, height: 800 }, workArea), { x: 1920 - 16 - 1200, y: 1040 - 16 - 800, width: 1200, height: 800 });
	// 左上越界（显示器拔掉后残留的负坐标）→ 贴左上内边距
	assert.deepEqual(constrainWindowBoundsToWorkArea({ x: -3000, y: -500, width: 1200, height: 800 }, workArea), { x: 16, y: 16, width: 1200, height: 800 });
	// 次显示器的负坐标 workArea 内位置原样保留
	assert.deepEqual(constrainWindowBoundsToWorkArea({ x: -1500, y: 40, width: 1200, height: 800 }, { x: -1920, y: 0, width: 1920, height: 1040 }), { x: -1500, y: 40, width: 1200, height: 800 });
});

test("windowState: recorded position on a work area smaller than the minimum window snaps to the area origin", () => {
	const bounds = constrainWindowBoundsToWorkArea({ x: 500, y: 300, width: 1200, height: 900 }, { x: 100, y: 50, width: 800, height: 600 });
	assert.deepEqual(bounds, { x: 100, y: 50, width: 880, height: 640 });
});

test("windowState: recorded edge-aligned geometry is not inset or resized", () => {
	const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
	for (const recorded of [{ x: 0, y: 0, width: 960, height: 1040 }, { x: 960, y: 0, width: 960, height: 1040 }, { ...workArea }]) {
		assert.deepEqual(constrainWindowBoundsToWorkArea(recorded, workArea), recorded);
	}
});

test("windowState: unchanged work area preserves native frame bounds outside its edges", () => {
	for (const workArea of [
		{ x: 0, y: 0, width: 1920, height: 1040 },
		{ x: -1920, y: -120, width: 1920, height: 1040 },
	]) {
		const recorded = { x: workArea.x - 7, y: workArea.y, width: 974, height: 1047 };
		assert.deepEqual(constrainWindowBoundsToWorkArea({ ...recorded, workArea }, workArea), recorded);
	}
});

test("windowState: changed work area constrains previously recorded native frame bounds", () => {
	const recorded = { x: -7, y: 0, width: 974, height: 1047, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
	assert.deepEqual(constrainWindowBoundsToWorkArea(recorded, { x: 0, y: 0, width: 1280, height: 900 }), { x: 16, y: 16, width: 974, height: 868 });
});

test("windowState: work area metadata does not preserve a completely off-screen window", () => {
	const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
	assert.deepEqual(constrainWindowBoundsToWorkArea({ x: -3000, y: -2000, width: 1200, height: 800, workArea }, workArea), { x: 16, y: 16, width: 1200, height: 800 });
});

test("windowState: saved work area round-trips alongside edge-aligned geometry", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		const recorded = { x: -7, y: 0, width: 974, height: 1047, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
		saveLastWindowBounds(dir, recorded);
		assert.deepEqual(readLastWindowBounds(dir), recorded);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: invalid work area metadata is discarded without losing window geometry", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		const geometry = { x: 0, y: 0, width: 960, height: 1040 };
		for (const workArea of [null, {}, { x: 0, y: 0, width: -1, height: 1040 }, { x: "0", y: 0, width: 1920, height: 1040 }, { x: 0, y: 0, width: 0.1, height: 1040 }]) {
			writeFileSync(join(dir, "last-window-bounds.json"), JSON.stringify({ ...geometry, workArea }), "utf8");
			assert.deepEqual(readLastWindowBounds(dir), geometry);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
