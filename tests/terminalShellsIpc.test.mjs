import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * terminal:shells IPC 回归测试。
 *
 * 背景：该通道曾在 shared/ipc.ts 定义、preload 暴露，但主进程漏注册
 * ipcMain.handle，渲染层 shell 下拉永远 reject 且被 .catch 静默吞掉，
 * 表现为候选 shell 列表恒为空。此测试从 IPC 边界锁定 handler 行为。
 */
function loadTerminalIpc({ ipcMain, ipcChannels }) {
	const output = ts.transpileModule(readFileSync("src/main/ipc/terminalIpc.ts", "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: (id) => {
			if (id === "electron") return { ipcMain };
			if (id.endsWith("/shared/ipc")) return { ipcChannels };
			return {};
		},
	});
	return module.exports;
}

test("terminal:shells channel is handled and delegates to listShells", async () => {
	const handlers = new Map();
	const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
	const shells = [{ shell: "pwsh", label: "PowerShell", available: true }];
	let listShellsCalls = 0;
	const terminalManager = {
		listShells: () => {
			listShellsCalls += 1;
			return shells;
		},
	};

	const { registerTerminalIpc } = loadTerminalIpc({
		ipcMain,
		ipcChannels: { terminalShells: "terminal:shells" },
	});
	registerTerminalIpc({
		appLogger: { info: () => {} },
		projectStore: { get: () => undefined },
		sessionRuntimeCoordinator: {},
		terminalManager,
		toSessionCommandIpcError: (error) => new Error(error?.message ?? "error"),
	});

	const handler = handlers.get("terminal:shells");
	assert.ok(handler, "terminal:shells handler must be registered in main process");
	// handler 直接透传 listShells() 结果（同引用），不做额外包装
	assert.strictEqual(await handler({}, undefined), shells);
	assert.equal(listShellsCalls, 1);
});
