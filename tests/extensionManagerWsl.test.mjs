import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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

function loadExtensionManager(fsOverrides = {}) {
	const wslPaths = loadWslPaths();
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "node:fs/promises") {
				return { ...require(id), ...fsOverrides };
			}
			if (id === "../wsl/WslPaths") return wslPaths;
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/extensions/ExtensionManager.ts"), sandbox, {
		filename: "ExtensionManager.ts",
	});
	return { ...sandbox.exports, wslPaths };
}

test("reads an installed WSL npm extension version through its canonical host path", async () => {
	const fixtureDir = mkdtempSync(join(tmpdir(), "pideck-extension-version-"));
	const fixturePath = join(fixtureDir, "package.json");
	writeFileSync(fixturePath, JSON.stringify({ name: "fixture-extension", version: "1.2.3" }), "utf8");
	const requestedPaths = [];

	try {
		const { ExtensionManager, wslPaths } = loadExtensionManager({
			readFile: async (path, encoding) => {
				requestedPaths.push(String(path));
				return readFile(fixturePath, encoding);
			},
		});
		const manager = new ExtensionManager(
			{},
			() => ({}),
			() => ({ removedBuiltInExtensions: [] }),
			async () => ({ removedBuiltInExtensions: [] }),
		);
		manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));

		const version = await manager.readInstalledVersion(
			"/root/.pi/agent/extensions/npm/fixture-extension",
		);

		assert.equal(version, "1.2.3");
		assert.equal(requestedPaths.length, 1);
		assert.equal(
			requestedPaths[0].replace(/\\/g, "/"),
			"//wsl.localhost/Ubuntu-24.04/root/.pi/agent/extensions/npm/fixture-extension/package.json",
		);
	} finally {
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("removeBuiltIn deletes the extension file under the active WSL HOME", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-builtin-remove-"));
	// 模拟 //wsl.localhost/Ubuntu-24.04/root 映射到临时目录的语义：直接用本地 fixture 作为 windowsHome
	const extensionsDir = join(fixtureHome, ".pi", "agent", "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	const targetFile = join(extensionsDir, "pi-deck-todo.ts");
	writeFileSync(targetFile, "export default function () {}", "utf8");

	let savedSettings = { removedBuiltInExtensions: [] };
	const removedPaths = [];

	try {
		const { ExtensionManager } = loadExtensionManager({
			rm: async (filePath, options) => {
				removedPaths.push({ path: String(filePath), options });
				// 真正删掉 fixture 文件，验证路径正确
				rmSync(String(filePath), { force: true, ...(options ?? {}) });
			},
		});

		const manager = new ExtensionManager(
			{},
			() => ({}),
			() => savedSettings,
			async (patch) => {
				savedSettings = { ...savedSettings, ...patch };
				return savedSettings;
			},
		);
		// 不走真实 WSL 路径映射：把 homeDir 指到 fixture
		manager.configureWsl({
			distro: "Ubuntu-24.04",
			user: "root",
			linuxHome: "/root",
			windowsHome: fixtureHome,
		});

		assert.equal(existsSync(targetFile), true);
		await manager.removeBuiltIn("pi-deck-todo.ts");

		assert.equal(existsSync(targetFile), false);
		assert.equal(savedSettings.removedBuiltInExtensions.includes("pi-deck-todo.ts"), true);
		assert.equal(removedPaths.length, 1);
		assert.equal(
			removedPaths[0].path.replace(/\\/g, "/"),
			targetFile.replace(/\\/g, "/"),
		);
		assert.equal(removedPaths[0].options?.force, true);
	} finally {
		rmSync(fixtureHome, { recursive: true, force: true });
	}
});

test("removeBuiltInFile rejects path traversal and non-builtin names", async () => {
	const { ExtensionManager } = loadExtensionManager();
	const manager = new ExtensionManager(
		{},
		() => ({}),
		() => ({ removedBuiltInExtensions: [] }),
		async (s) => s,
	);

	await assert.rejects(() => manager.removeBuiltInFile("../evil.ts"), /非法内置扩展路径/);
	await assert.rejects(() => manager.removeBuiltInFile("not-builtin.ts"), /非法内置扩展路径/);
	await assert.rejects(() => manager.removeBuiltIn("npm:something"), /只能操作内置扩展/);
});
