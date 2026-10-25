import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * terminalIpc 边界回归测试。
 *
 * 背景 1：terminal:shells 通道曾在 shared/ipc.ts 定义、preload 暴露，但主进程漏注册
 * ipcMain.handle，渲染层 shell 下拉永远 reject 且被 .catch 静默吞掉，
 * 表现为候选 shell 列表恒为空。此测试从 IPC 边界锁定 handler 行为。
 * 背景 2：terminal:input / resize / close 直达原生 pty（write/resize），非字符串/
 * 非有限数字入参会在边界 throw 或以 NaN 落到 ConPTY；按「无效载荷静默忽略」
 * 与 manager 侧迟到输入同哲学，在此锁定边界校验不被误删。
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
			if (id.endsWith("/fonts/SystemFonts")) {
				return { listSystemFontFamilies: () => ["JetBrains Mono", "Cascadia Code"] };
			}
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

test("terminal:fonts channel is handled and delegates to listSystemFontFamilies", async () => {
	const handlers = new Map();
	const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };

	const { registerTerminalIpc } = loadTerminalIpc({
		ipcMain,
		ipcChannels: { terminalShells: "terminal:shells", terminalFonts: "terminal:fonts" },
	});
	registerTerminalIpc({
		appLogger: { info: () => {} },
		sessionRuntimeCoordinator: {},
		terminalManager: {},
		toSessionCommandIpcError: (error) => new Error(error?.message ?? "error"),
	});

	const handler = handlers.get("terminal:fonts");
	assert.ok(handler, "terminal:fonts handler must be registered in main process");
	const fonts = await handler({}, undefined);
	// 与 stub listSystemFontFamilies 同引用：handler 只透传不包装
	assert.deepEqual(fonts, ["JetBrains Mono", "Cascadia Code"]);
});

test("源码契约：terminalFonts 通道在三处同步注册", () => {
	// 三处同步纪律：shared/ipc.ts 通道常量、main handler、preload 白名单，
	// 漏一处渲染层拿到 undefined。此守卫防 fonts 通道重蹈 shells 漏注册的覆辙。
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	assert.match(ipc, /terminalFonts:\s*"terminal:fonts"/);
	const preload = readFileSync("src/preload/index.ts", "utf8");
	assert.match(preload, /terminalFonts/);
});

test("terminal:input 边界校验：tabId/data 非字符串静默忽略，不触达 pty.write", async () => {
	const { handlers, terminalManager, calls } = registerWithSpy({
		terminalInput: "terminal:input",
	});
	const input = handlers.get("terminal:input");
	assert.ok(input, "terminal:input handler must be registered");
	input({}, 123, "ls"); // tabId 非字符串
	input({}, null, "ls"); // tabId null
	input({}, "tab-1", { raw: true }); // data 非字符串（会同步 throw 进 pty.write）
	input({}, "tab-1", undefined);
	assert.deepEqual(calls.input, [], "非法入参一律不触达 manager/pty");
	input({}, "tab-1", "dir\r");
	assert.deepEqual(calls.input, [["tab-1", "dir\r"]], "合法入参透传");
});

test("terminal:resize 边界校验：非有限数字静默忽略（NaN 落 ConPTY 行为未定义）", async () => {
	const { handlers, calls } = registerWithSpy({
		terminalResize: "terminal:resize",
	});
	const resize = handlers.get("terminal:resize");
	assert.ok(resize, "terminal:resize handler must be registered");
	resize({}, "tab-1", "120", 30); // cols 字符串
	resize({}, "tab-1", Number.NaN, 30); // NaN
	resize({}, "tab-1", 120, Number.POSITIVE_INFINITY); // Infinity
	resize({}, "tab-1", 120); // rows 缺位
	assert.deepEqual(calls.resize, [], "非法入参一律不触达 manager/pty");
	resize({}, "tab-1", 120, 30);
	assert.deepEqual(calls.resize, [["tab-1", 120, 30]], "合法入参透传");
});

test("terminal:close 边界校验：tabId 非字符串静默忽略且不写关闭日志", async () => {
	const { handlers, calls, logCalls } = registerWithSpy({
		terminalClose: "terminal:close",
	});
	const close = handlers.get("terminal:close");
	assert.ok(close, "terminal:close handler must be registered");
	close({}, null);
	close({}, 42);
	assert.deepEqual(calls.close, [], "非法入参不触达 manager");
	assert.equal(logCalls.length, 0, "非法入参不写关闭日志");
	close({}, "tab-1");
	assert.deepEqual(calls.close, ["tab-1"], "合法入参透传");
	assert.equal(logCalls.length, 1, "合法关闭写一条日志");
});

/**
 * 公共注入：注册全部 terminal 通道，terminalManager 记录 input/resize/close 调用。
 * channelsKey 里出现的键才注入对应通道常量（保持与真实 ipcChannels 的键名一致）。
 */
function registerWithSpy(channelsKey) {
	const handlers = new Map();
	const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
	const calls = { input: [], resize: [], close: [] };
	const logCalls = [];
	const terminalManager = {
		input: (tabId, data) => calls.input.push([tabId, data]),
		resize: (tabId, cols, rows) => calls.resize.push([tabId, cols, rows]),
		close: (tabId) => calls.close.push(tabId),
		listShells: () => [],
	};
	const { registerTerminalIpc } = loadTerminalIpc({ ipcMain, ipcChannels: channelsKey });
	registerTerminalIpc({
		appLogger: { info: (...args) => logCalls.push(args) },
		sessionRuntimeCoordinator: {},
		terminalManager,
		toSessionCommandIpcError: (error) => new Error(error?.message ?? "error"),
	});
	return { handlers, terminalManager, calls, logCalls };
}
