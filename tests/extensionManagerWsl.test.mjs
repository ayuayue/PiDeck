import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		const manager = new ExtensionManager({}, () => ({}));
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

test("reads and writes extension enablement in the active WSL HOME", async () => {
	let settingsContent = JSON.stringify({ disabledExtensions: [] });
	const reads = [];
	const writes = [];
	const { ExtensionManager, wslPaths } = loadExtensionManager({
		readFile: async (filePath) => {
			reads.push(String(filePath));
			return settingsContent;
		},
		writeFile: async (filePath, content) => {
			writes.push(String(filePath));
			settingsContent = String(content);
		},
	});
	const manager = new ExtensionManager({}, () => ({}));
	manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));

	await manager.setEnabled("pi-deck-todo.ts", false);
	const disabled = await manager.getDisabledExtensions();

	const expectedPath = "//wsl.localhost/Ubuntu-24.04/root/.pi/agent/settings.json";
	assert.equal(reads.every((filePath) => filePath.replace(/\\/g, "/") === expectedPath), true);
	assert.equal(writes[0].replace(/\\/g, "/"), expectedPath);
	assert.equal(disabled.has("pi-deck-todo.ts"), true);
});
