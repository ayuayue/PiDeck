import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
	return module.exports;
}

const recovery = compile("src/main/window/rendererCrashRecovery.ts");

/** 可控时钟工厂：now 从 0 起步，advance(ms) 推进。 */
function clock() {
	let current = 0;
	return {
		now: () => current,
		advance: (ms) => {
			current += ms;
		},
	};
}

test("clean-exit never triggers auto reload", () => {
	const c = clock();
	const guard = recovery.createRendererCrashRecoveryGuard({ now: c.now });
	assert.equal(guard.shouldAutoReload("clean-exit"), false);
	assert.equal(guard.recoveriesInWindow(), 0);
});

test("crashed/oom reasons trigger auto reload and count toward the window", () => {
	const c = clock();
	const guard = recovery.createRendererCrashRecoveryGuard({ now: c.now });
	assert.equal(guard.shouldAutoReload("crashed"), true);
	assert.equal(guard.shouldAutoReload("oom"), true);
	assert.equal(guard.recoveriesInWindow(), 2);
});

test("crash storm beyond the limit stops auto reloading within the window", () => {
	const c = clock();
	const guard = recovery.createRendererCrashRecoveryGuard({ now: c.now });
	assert.equal(guard.shouldAutoReload("crashed"), true);
	assert.equal(guard.shouldAutoReload("crashed"), true);
	// 第 3 次仍在 60s 窗口内：拒绝恢复，避免无限重启循环
	assert.equal(guard.shouldAutoReload("crashed"), false);
	assert.equal(guard.recoveriesInWindow(), 2);
});

test("recoveries outside the window do not count toward the limit", () => {
	const c = clock();
	const guard = recovery.createRendererCrashRecoveryGuard({ now: c.now });
	guard.shouldAutoReload("crashed");
	guard.shouldAutoReload("crashed");
	assert.equal(guard.shouldAutoReload("crashed"), false);
	// 窗口期过后恢复计数清空，再次允许自动恢复
	c.advance(recovery.RENDERER_CRASH_RECOVERY_WINDOW_MS + 1);
	assert.equal(guard.recoveriesInWindow(), 0);
	assert.equal(guard.shouldAutoReload("crashed"), true);
});

test("index.ts wires the crash recovery guard into render-process-gone", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.match(source, /createRendererCrashRecoveryGuard/);
	assert.match(source, /rendererCrashGuard\.shouldAutoReload\(details\.reason\)/);
	assert.match(source, /mainWindow\.webContents\.reload\(\)/);
	assert.match(source, /isQuitting \|\| !rendererCrashGuard\.shouldAutoReload/);
});
