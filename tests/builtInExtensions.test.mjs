import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadBuiltInExtensionsModule() {
	const source = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {}, require, console };
	vm.runInNewContext(outputText, sandbox, { filename: "builtInExtensions.ts" });
	return sandbox.exports;
}

function sameArgs(actual, expected) {
	// vm 沙箱数组与主 realm deepStrictEqual 可能因原型不同失败
	assert.equal(JSON.stringify([...actual]), JSON.stringify(expected));
}

test("appendBuiltInExtensionArgs adds repeated --extension flags", () => {
	const { appendBuiltInExtensionArgs } = loadBuiltInExtensionsModule();
	const next = appendBuiltInExtensionArgs(["--mode", "rpc"], [
		"C:\\app\\resources\\extensions\\pi-deck-todo.ts",
		"C:\\app\\resources\\extensions\\pi-deck-plan-mode.ts",
	]);
	sameArgs(next, [
		"--mode",
		"rpc",
		"--extension",
		"C:\\app\\resources\\extensions\\pi-deck-todo.ts",
		"--extension",
		"C:\\app\\resources\\extensions\\pi-deck-plan-mode.ts",
	]);
});

test("appendBuiltInExtensionArgs skips when noExtensions is true", () => {
	const { appendBuiltInExtensionArgs } = loadBuiltInExtensionsModule();
	const next = appendBuiltInExtensionArgs(["--mode", "rpc", "--no-extensions"], [
		"/tmp/pi-deck-todo.ts",
	], { noExtensions: true });
	sameArgs(next, ["--mode", "rpc", "--no-extensions"]);
});

test("listActiveBuiltInExtensionPaths respects removedBuiltIn and missing files", () => {
	const { listActiveBuiltInExtensionPaths, BUILT_IN_EXTENSIONS } = loadBuiltInExtensionsModule();
	const root = mkdtempSync(join(tmpdir(), "pideck-builtin-ext-"));
	const extDir = join(root, "resources", "extensions");
	mkdirSync(extDir, { recursive: true });
	// 只写入 ask + todo，故意不写 plan/nul，验证缺失跳过
	writeFileSync(join(extDir, "pi-deck-ask-question.ts"), "// ask\n", "utf8");
	writeFileSync(join(extDir, "pi-deck-todo.ts"), "// todo\n", "utf8");

	try {
		const paths = listActiveBuiltInExtensionPaths(
			{ appPath: root, resourcesPath: root, isDev: true },
			["pi-deck-todo.ts"],
		);
		assert.equal(paths.length, 1);
		assert.ok(String(paths[0]).endsWith("pi-deck-ask-question.ts"));
		// 内置扩展清单随版本增长：ask/goal/nul-redirect/plan-mode/retry-no-body/security-gate/session-title/subagents/todo/vision
		// 内置扩展清单随版本增长：ask/goal/nul-redirect/plan-mode/request-size-recovery/retry-no-body/security-gate/session-title/subagents/todo/vision
		assert.equal(BUILT_IN_EXTENSIONS.length, 11);
		assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-goal-mode.ts"));
		assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-session-title.ts"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("built-in extension removal has a registered IPC handler", () => {
	const storeIpc = readFileSync("src/main/ipc/storeIpc.ts", "utf8");
	const extensionsTab = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
	assert.match(storeIpc, /ipcChannels\.extensionsRemoveBuiltIn[\s\S]*extensionManager\.removeBuiltIn\(source\)/);
	assert.match(storeIpc, /ipcChannels\.extensionsRestoreBuiltIn[\s\S]*extensionManager\.restoreBuiltIn\(source\)/);
	assert.doesNotMatch(extensionsTab, /extension\.enabled === false \? "disabled"/);
	assert.doesNotMatch(extensionsTab, /t\("common\.enabled"\)|t\("common\.disabled"\)/);
});

test("AgentManager no longer deploys built-ins via ensurePiDeckExtension", () => {
	const index = readFileSync("src/main/index.ts", "utf8");
	const storeIpc = readFileSync("src/main/ipc/storeIpc.ts", "utf8");
	const processSource = readFileSync("src/main/pi/PiProcess.ts", "utf8");
	assert.doesNotMatch(index, /async function ensurePiDeckExtension/);
	assert.doesNotMatch(storeIpc, /ensurePiDeckExtension/);
	assert.match(index, /migrateLegacyBuiltInExtensions/);
	assert.match(processSource, /appendBuiltInExtensionArgs/);
	assert.match(processSource, /--extension/);
});
