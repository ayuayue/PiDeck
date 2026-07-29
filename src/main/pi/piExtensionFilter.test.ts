import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DESKTOP_PARK_SUFFIX,
	isDesktopBlockedExtension,
	parkBlockedExtensionsInDir,
	restoreAllParkedExtensions,
	scanExtensionDir,
	unparkBlockedExtensions,
} from "./piExtensionFilter";

test("isDesktopBlockedExtension matches codeisland variants only", () => {
	assert.equal(isDesktopBlockedExtension("codeisland.ts"), true);
	assert.equal(isDesktopBlockedExtension("codeisland.js"), true);
	assert.equal(isDesktopBlockedExtension("CodeIsland"), true);
	assert.equal(isDesktopBlockedExtension("my-codeisland-bridge.ts"), true);
	assert.equal(isDesktopBlockedExtension("pi-deck-todo.ts"), false);
	assert.equal(isDesktopBlockedExtension("orca-agent-status.ts"), false);
	assert.equal(isDesktopBlockedExtension(`codeisland.ts${DESKTOP_PARK_SUFFIX}`), false);
});

test("park then unpark restores original filename", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-park-"));
	try {
		writeFileSync(join(dir, "codeisland.ts"), "export default () => {}");
		writeFileSync(join(dir, "pi-deck-todo.ts"), "export default () => {}");
		mkdirSync(join(dir, "good-pkg"));
		writeFileSync(join(dir, "good-pkg", "index.ts"), "export default () => {}");

		const parked = parkBlockedExtensionsInDir(dir);
		assert.ok(parked.some((p) => p.name === "codeisland.ts"));
		assert.equal(existsSync(join(dir, "codeisland.ts")), false);
		assert.equal(existsSync(join(dir, `codeisland.ts${DESKTOP_PARK_SUFFIX}`)), true);
		// 其它扩展未动
		assert.equal(existsSync(join(dir, "pi-deck-todo.ts")), true);
		assert.equal(existsSync(join(dir, "good-pkg", "index.ts")), true);

		unparkBlockedExtensions(parked);
		assert.equal(existsSync(join(dir, "codeisland.ts")), true);
		assert.equal(existsSync(join(dir, `codeisland.ts${DESKTOP_PARK_SUFFIX}`)), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("park refcount keeps file parked until last unpark", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-park-ref-"));
	try {
		writeFileSync(join(dir, "codeisland.ts"), "x");
		const a = parkBlockedExtensionsInDir(dir);
		const b = parkBlockedExtensionsInDir(dir);
		assert.equal(existsSync(join(dir, "codeisland.ts")), false);

		unparkBlockedExtensions(a);
		// 仍有一个引用
		assert.equal(existsSync(join(dir, "codeisland.ts")), false);
		unparkBlockedExtensions(b);
		assert.equal(existsSync(join(dir, "codeisland.ts")), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("restoreAllParkedExtensions recovers orphaned park files", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-park-orphan-"));
	try {
		writeFileSync(join(dir, "codeisland.ts"), "x");
		renameSync(join(dir, "codeisland.ts"), join(dir, `codeisland.ts${DESKTOP_PARK_SUFFIX}`));
		const restored = restoreAllParkedExtensions([dir]);
		assert.ok(restored.includes("codeisland.ts"));
		assert.equal(existsSync(join(dir, "codeisland.ts")), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("scanExtensionDir reports blocked without mutating", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-scan-"));
	try {
		writeFileSync(join(dir, "codeisland.ts"), "x");
		writeFileSync(join(dir, "other.ts"), "x");
		const result = scanExtensionDir(dir);
		assert.ok(result.blocked.includes("codeisland.ts"));
		assert.ok(result.safePaths.some((p) => p.endsWith("other.ts")));
		assert.equal(existsSync(join(dir, "codeisland.ts")), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
