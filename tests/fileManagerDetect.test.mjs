import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function loadFileManager(existsStub = () => false) {
	const source = readFileSync("src/main/files/FileManager.ts", "utf8");
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
			if (name === "node:fs") return { existsSync: existsStub };
			if (name === "node:child_process") {
				return { spawn: () => ({ once: () => {}, unref: () => {} }) };
			}
			if (name === "../../shared/types/project") return {};
			return require(name);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "FileManager.ts" });
	return sandbox.exports;
}

// ── detectFileManagerForPlatform：平台 + PATH 探针（纯函数） ──────────

test("Windows always returns the built-in File Explorer", () => {
	const { detectFileManagerForPlatform } = loadFileManager();
	const info = detectFileManagerForPlatform("win32", "C:\\Windows", () => false);
	assert.deepEqual(plain(info), {
		id: "windows-explorer",
		name: "explorer",
		command: "explorer.exe",
	});
});

test("macOS returns Finder via open command", () => {
	const { detectFileManagerForPlatform } = loadFileManager();
	const info = detectFileManagerForPlatform("darwin", "/usr/bin", () => false);
	assert.deepEqual(plain(info), { id: "finder", name: "Finder", command: "open" });
});

test("Linux picks the first file manager found on PATH in priority order", () => {
	const { detectFileManagerForPlatform } = loadFileManager();
	// 只装 Dolphin：命中，name 用其专名
	const dolphin = detectFileManagerForPlatform("linux", "/usr/bin", (cmd) => cmd === "dolphin");
	assert.deepEqual(plain(dolphin), { id: "dolphin", name: "Dolphin", command: "dolphin" });

	// GNOME Files（nautilus）优先于 Dolphin：优先级决定选择
	const nautilus = detectFileManagerForPlatform("linux", "/usr/bin", (cmd) => cmd === "nautilus" || cmd === "dolphin");
	assert.deepEqual(plain(nautilus), { id: "nautilus", name: "Files", command: "nautilus" });

	// 全部未装：返回 null（调用方回退系统默认）
	const none = detectFileManagerForPlatform("linux", "/usr/bin", () => false);
	assert.equal(none, null);
});

test("findOnPath checks PATH entries with platform extension rules", () => {
	// 路径感知 stub：只有具体文件存在
	const existingPaths = new Set(["/usr/bin/dolphin", "C:\\Windows\\System32\\explorer.exe", "C:\\tools\\code.cmd"]);
	const { findOnPath } = loadFileManager((p) => existingPaths.has(p));
	// Linux：无扩展名匹配
	assert.equal(findOnPath("dolphin", "/usr/bin:/opt/bin", "linux"), true);
	assert.equal(findOnPath("thunar", "/usr/bin:/opt/bin", "linux"), false);
	// Windows：补 .exe/.cmd/.bat 探测
	assert.equal(findOnPath("explorer", "C:\\Windows\\System32", "win32"), true);
	// 已带扩展名的 Windows 命令只匹配原样；无扩展名会补 .exe/.cmd/.bat 探测
	assert.equal(findOnPath("code.cmd", "C:\\tools", "win32"), true);
	assert.equal(findOnPath("nano", "C:\\tools", "win32"), false);
	// 分隔符差异：Windows 用分号，Linux 用冒号
	assert.equal(findOnPath("dolphin", "/usr/bin;/opt/bin", "linux"), false);
});
