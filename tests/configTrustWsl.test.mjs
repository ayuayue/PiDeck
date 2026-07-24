import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadConfigManager() {
	let content;
	const writes = [];
	const source = readFileSync("src/main/config/ConfigManager.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		AbortController,
		clearTimeout,
		exports: {},
		process: { ...process, platform: "win32" },
		setTimeout,
		require: (id) => {
			if (id === "node:fs/promises") {
				return {
					mkdir: async () => {},
					readFile: async () => {
						if (content == null) throw new Error("ENOENT");
						return content;
					},
					writeFile: async (filePath, nextContent) => {
						content = nextContent;
						writes.push({ filePath, content: nextContent });
					},
				};
			}
			if (id === "node:path") return path.win32;
			if (id === "node:os") return { homedir: () => "C:\\Users\\tester" };
			if (id === "electron") return { net: {} };
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "ConfigManager.ts" });
	return { ...sandbox.exports, getContent: () => content, writes };
}

test("preserves POSIX WSL trust keys under Windows path semantics", async () => {
	const { ConfigManager, getContent, writes } = loadConfigManager();
	const manager = new ConfigManager("C:\\PiDeck\\config");

	await manager.ensureTrustedDirectory("/root/ba_cli/");
	assert.deepEqual(JSON.parse(getContent()), { "/root/ba_cli": true });
	assert.equal(await manager.getProjectTrustDecision("/root/ba_cli/subdir"), true);

	await manager.setProjectTrustDecision("/root/ba_cli/subdir/../private", false);
	assert.deepEqual(JSON.parse(getContent()), {
		"/root/ba_cli": true,
		"/root/ba_cli/private": false,
	});
	assert.equal(await manager.getProjectTrustDecision("/root/ba_cli/private/nested"), false);
	assert.equal(writes.every((write) => write.filePath === "C:\\PiDeck\\config\\trust.json"), true);
});

test("retains case-insensitive matching for native Windows trust keys", async () => {
	const { ConfigManager } = loadConfigManager();
	const manager = new ConfigManager("C:\\PiDeck\\config");

	await manager.setProjectTrustDecision("C:\\Repo", true);
	assert.equal(await manager.getProjectTrustDecision("c:\\repo\\child"), true);
});
