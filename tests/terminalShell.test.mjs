import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function loadTerminalSessionManagerModule() {
	const source = readFileSync(
		"src/main/terminal/TerminalSessionManager.ts",
		"utf8",
	);
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	});
	const sandbox = {
		exports: {},
		require: (name) => {
			if (name === "node-pty") return {};
			if (name === "node:crypto") return { randomUUID: () => "id" };
			if (name === "../../shared/ipc") return { ipcChannels: {} };
			return require(name);
		},
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "TerminalSessionManager.ts",
	});
	return sandbox.exports;
}

test("uses the macOS user shell as a login shell", () => {
	const { getTerminalShellCandidates } = loadTerminalSessionManagerModule();

	const candidates = getTerminalShellCandidates("darwin", {
		SHELL: "/bin/zsh",
		PATH: "/usr/bin:/bin",
	});

	assert.deepEqual(plain(candidates[0]), {
		shell: "zsh",
		command: "/bin/zsh",
		args: ["-l"],
	});
});

test("keeps Windows shell candidates unchanged", () => {
	const { getTerminalShellCandidates } = loadTerminalSessionManagerModule();

	const candidates = getTerminalShellCandidates("win32", {});

	assert.deepEqual(
		plain(candidates.map((candidate) => candidate.command)),
		["pwsh.exe", "powershell.exe", "cmd.exe"],
	);
	assert.deepEqual(
		plain(candidates.map((candidate) => candidate.args)),
		[[], [], []],
	);
});
