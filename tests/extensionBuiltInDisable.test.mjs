import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadWslPaths() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/wsl/WslPaths.ts"), sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

/**
 * 加载 ExtensionManager，并把 homeDir 重定向到 fixture（通过 mock os.homedir）。
 * 同时可 mock runPi 输出，便于测 list 冲突路径。
 */
function loadExtensionManager({ homeDir, runPiOutput = "", fsOverrides = {} } = {}) {
	const wslPaths = loadWslPaths();
	const realOs = require("node:os");
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "node:os") {
				return {
					...realOs,
					homedir: () => homeDir ?? realOs.homedir(),
				};
			}
			if (id === "node:fs/promises") {
				return { ...require(id), ...fsOverrides };
			}
			if (id === "node:child_process") {
				const real = require(id);
				return {
					...real,
					execFile: (cmd, args, opts, cb) => {
						// runPi 走 execFile；返回预设 stdout，模拟 pi list
						queueMicrotask(() => cb(null, runPiOutput, ""));
					},
				};
			}
			if (id === "../wsl/WslPaths") return wslPaths;
			if (id === "../pi/PiLocator") return {};
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/extensions/ExtensionManager.ts"), sandbox, {
		filename: "ExtensionManager.ts",
	});
	return sandbox.exports;
}

test("disableBuiltIn records removal and deletes user extension file", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-disable-builtin-"));
	const extensionsDir = join(fixtureHome, ".pi", "agent", "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	const target = join(extensionsDir, "pi-deck-todo.ts");
	writeFileSync(target, "// builtin todo\n", "utf8");

	let settings = { removedBuiltInExtensions: [] };
	const { ExtensionManager } = loadExtensionManager({ homeDir: fixtureHome });
	const manager = new ExtensionManager(
		{
			// locator 占位：disableBuiltIn 不调用 runPi
			check: async () => ({ installed: true, version: "0.80.0" }),
			createInvocation: (cmd, args) => ({ command: cmd, args, shell: false }),
			createProcessEnv: () => process.env,
			resolveCommand: () => "pi",
		},
		() => ({}),
		() => settings,
		async (patch) => {
			settings = { ...settings, ...patch };
			return settings;
		},
	);

	assert.equal(existsSync(target), true);
	await manager.disableBuiltIn("pi-deck-todo.ts");
	assert.equal(existsSync(target), false);
	// 注意：vm 沙箱内创建的数组与外层 realm 的 deepStrictEqual 可能因原型不同失败，逐项比较。
	assert.equal(settings.removedBuiltInExtensions?.length, 1);
	assert.equal(settings.removedBuiltInExtensions?.[0], "pi-deck-todo.ts");
	// 幂等：再删一次不应抛错，也不应重复写入
	await manager.disableBuiltIn("pi-deck-todo.ts");
	assert.equal(settings.removedBuiltInExtensions?.length, 1);
	assert.equal(settings.removedBuiltInExtensions?.[0], "pi-deck-todo.ts");

	rmSync(fixtureHome, { recursive: true, force: true });
});

test("list auto-disables built-in todo and deletes file when third-party rpiv-todo is present", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-conflict-todo-"));
	const extensionsDir = join(fixtureHome, ".pi", "agent", "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	const builtinPath = join(extensionsDir, "pi-deck-todo.ts");
	writeFileSync(builtinPath, "// builtin\n", "utf8");

	let settings = { removedBuiltInExtensions: [] };
	const piListOutput = [
		"User packages:",
		"npm:@juicesharp/rpiv-todo",
		join(fixtureHome, ".pi", "agent", "npm", "node_modules", "@juicesharp", "rpiv-todo"),
		"",
	].join("\n");

	const { ExtensionManager } = loadExtensionManager({
		homeDir: fixtureHome,
		runPiOutput: piListOutput,
	});

	// 绕过 noApproveSupported 的版本探测：直接 stub getPiVersion 路径
	// detectPiVersion 走 locator.check；给一个有效版本即可。
	const locator = {
		check: async () => ({ installed: true, version: "0.80.0" }),
		createInvocation: (cmd, args) => ({
			command: cmd,
			args,
			shell: false,
			pathPrefix: undefined,
			wsl: false,
			windowsVerbatimArguments: false,
		}),
		createProcessEnv: () => ({ ...process.env }),
		resolveCommand: () => "pi",
	};

	const manager = new ExtensionManager(
		locator,
		() => ({}),
		() => settings,
		async (patch) => {
			settings = { ...settings, ...patch };
			return settings;
		},
	);

	assert.equal(existsSync(builtinPath), true);
	const result = await manager.list(false);

	assert.equal(settings.removedBuiltInExtensions.includes("pi-deck-todo.ts"), true);
	assert.equal(existsSync(builtinPath), false, "conflicting built-in file must be deleted");
	assert.ok(result.conflicts?.some((c) => c.builtIn === "pi-deck-todo.ts"));
	const builtin = result.extensions.find((e) => e.source === "pi-deck-todo.ts");
	assert.equal(builtin?.enabled, false);

	rmSync(fixtureHome, { recursive: true, force: true });
});

test("list purges residual built-in file already marked removed", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-residual-todo-"));
	const extensionsDir = join(fixtureHome, ".pi", "agent", "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	const builtinPath = join(extensionsDir, "pi-deck-todo.ts");
	writeFileSync(builtinPath, "// leftover after disable-without-delete\n", "utf8");

	let settings = { removedBuiltInExtensions: ["pi-deck-todo.ts"] };
	const { ExtensionManager } = loadExtensionManager({
		homeDir: fixtureHome,
		runPiOutput: "User packages:\n",
	});
	const locator = {
		check: async () => ({ installed: true, version: "0.80.0" }),
		createInvocation: (cmd, args) => ({
			command: cmd,
			args,
			shell: false,
			pathPrefix: undefined,
			wsl: false,
			windowsVerbatimArguments: false,
		}),
		createProcessEnv: () => ({ ...process.env }),
		resolveCommand: () => "pi",
	};
	const manager = new ExtensionManager(
		locator,
		() => ({}),
		() => settings,
		async (patch) => {
			settings = { ...settings, ...patch };
			return settings;
		},
	);

	assert.equal(existsSync(builtinPath), true);
	await manager.list(false);
	assert.equal(existsSync(builtinPath), false, "residual removed built-in must be purged on list");

	rmSync(fixtureHome, { recursive: true, force: true });
});

// 避免 unused import 告警风格（homedir 仅文档用）
void homedir;
