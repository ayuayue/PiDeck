import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadEditorDetector(fsStub, platform = "win32") {
	const source = readFileSync("src/main/editors/EditorDetector.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	});
	const sandbox = {
		exports: {},
		// 模块顶层用 process.env 拼 Windows 安装目录候选；测试固定 win32 平台 + 可控 PATH
		process: {
			platform,
			env: {
				LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
				ProgramFiles: "C:\\Program Files",
				"ProgramFiles(x86)": "C:\\Program Files (x86)",
				PATH: "",
			},
		},
		require: (name) => {
			if (name === "node:fs/promises") return fsStub;
			if (name === "node:path") return require("node:path");
			if (name === "node:child_process") {
				return {
					// 假 reg 进程：spawn 后立刻模拟进程结束（无输出），
					// 否则 runRegQuery 里 child.once("close") 永不触发，Promise 永不 settle，
					// 会让 detectExternalEditors 一直 await 导致测试挂死、拖垮全量套件。
					spawn: () => ({
						stdout: { setEncoding: () => {}, on: () => {}, once: () => {} },
						once: (event, cb) => {
							if (event === "close") queueMicrotask(() => cb && cb(0));
							if (event === "spawn") queueMicrotask(() => cb && cb());
						},
						unref: () => {},
					}),
				};
			}
			if (name === "electron") return { shell: { openPath: async () => "" } };
			if (name === "../../shared/types") {
				return {
					SUPPORTED_EXTERNAL_EDITORS: [
						{ id: "vscode", name: "Visual Studio Code" },
						{ id: "cursor", name: "Cursor" },
						{ id: "zed", name: "Zed" },
						{ id: "idea", name: "IntelliJ IDEA" },
						{ id: "webstorm", name: "WebStorm" },
						{ id: "phpstorm", name: "PhpStorm" },
						{ id: "pycharm", name: "PyCharm" },
					],
					createDefaultExternalEditorSettings: () => ({}),
				};
			}
			return require(name);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "EditorDetector.ts" });
	return sandbox.exports;
}

// ── matchProgramsDirName：目录名前缀匹配规则 ─────────────────────────

test("matchProgramsDirName matches versioned and unversioned JetBrains dirs", () => {
	const { matchProgramsDirName } = loadEditorDetector({});

	assert.equal(
		matchProgramsDirName(["IntelliJ IDEA 2026.1", "Zed"], ["IntelliJ IDEA"]),
		"IntelliJ IDEA 2026.1",
	);
	assert.equal(
		matchProgramsDirName(["IntelliJ IDEA", "Notepad++"], ["IntelliJ IDEA"]),
		"IntelliJ IDEA",
	);
	// Community Edition 前缀同源也应命中
	assert.equal(
		matchProgramsDirName(["IntelliJ IDEA Community Edition 2026.1"], ["IntelliJ IDEA"]),
		"IntelliJ IDEA Community Edition 2026.1",
	);
	// 大小写不敏感（磁盘目录名可能有大小写差异）
	assert.equal(
		matchProgramsDirName(["pycharm 2026.1"], ["PyCharm"]),
		"pycharm 2026.1",
	);
	assert.equal(
		matchProgramsDirName(["WebStorm 2025.3", "PhpStorm 2025.1"], ["WebStorm"]),
		"WebStorm 2025.3",
	);
	assert.equal(matchProgramsDirName(["Zed", "VS Code"], ["IntelliJ IDEA"]), null);
});

// ── detectExternalEditors：JetBrains 版本目录通配扫描 ─────────────────

test("detectExternalEditors finds IntelliJ IDEA installed in unversioned Programs dir", async () => {
	const existing = new Set([
		"C:\\Users\\test\\AppData\\Local\\Programs\\IntelliJ IDEA\\bin\\idea64.exe",
	]);
	const fsStub = {
		access: async (p) => {
			if (!existing.has(p)) throw new Error("ENOENT");
		},
		readdir: async (dir) => {
			if (dir === "C:\\Users\\test\\AppData\\Local\\Programs") {
				return ["IntelliJ IDEA", "Zed", "Common"];
			}
			throw new Error("ENOENT");
		},
	};
	// PATH 与常见路径全不命中：模拟用户未把 IDEA 加入 PATH、且版本不在固定候选里
	const { detectExternalEditors } = loadEditorDetector(fsStub);

	const editors = await detectExternalEditors();

	const idea = editors.find((editor) => editor.id === "idea");
	assert.ok(idea, "IntelliJ IDEA should be detected via Programs dir scan");
	assert.equal(
		idea.command,
		"C:\\Users\\test\\AppData\\Local\\Programs\\IntelliJ IDEA\\bin\\idea64.exe",
	);
	assert.equal(idea.detectedFrom, "common-path");
});

test("detectExternalEditors scans JetBrains subdir for versioned installs", async () => {
	const existing = new Set([
		"C:\\Program Files\\JetBrains\\WebStorm 2026.1\\bin\\webstorm64.exe",
	]);
	const fsStub = {
		access: async (p) => {
			if (!existing.has(p)) throw new Error("ENOENT");
		},
		readdir: async (dir) => {
			if (dir === "C:\\Program Files") return ["JetBrains", "Git"];
			if (dir === "C:\\Program Files\\JetBrains") return ["WebStorm 2026.1", "IntelliJ IDEA 2026.1"];
			throw new Error("ENOENT");
		},
	};
	const { detectExternalEditors } = loadEditorDetector(fsStub);

	const editors = await detectExternalEditors();

	const webstorm = editors.find((editor) => editor.id === "webstorm");
	assert.ok(webstorm, "WebStorm should be detected via JetBrains subdir scan");
	assert.equal(webstorm.command, "C:\\Program Files\\JetBrains\\WebStorm 2026.1\\bin\\webstorm64.exe");
});
