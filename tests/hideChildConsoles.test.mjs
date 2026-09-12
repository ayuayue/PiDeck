import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// ESM `import * as` 命名空间只读，无法在上面做补丁/还原断言；
// 走 CJS exports 对象（与 hideChildConsoles.ts 编译后 require 到的是同一实例）。
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");

const { hiddenConsoleOptions, installHiddenConsolePatch, installHostHiddenConsole, getHiddenConsoleMode } = loadTsCommonJs(
	"src/main/dsh/hideChildConsoles.ts",
);

/** 构造假 koffi：getResults 依次返回 GetConsoleWindow 结果（单元素则恒定返回）。 */
function makeFfi({ getResults = [0], allocResult = 1, lastErrorResult } = {}) {
	const calls = { load: [], getConsoleWindow: [], allocConsole: 0, showWindow: [], lastError: 0 };
	const koffi = {
		load(name) {
			calls.load.push(name);
			return {
				func(signature) {
					if (signature.includes("GetConsoleWindow")) {
						return () => {
							const value = getResults.length === 1 ? getResults[0] : getResults.shift();
							calls.getConsoleWindow.push(value);
							return value;
						};
					}
					if (signature.includes("AllocConsole")) {
						return () => {
							calls.allocConsole += 1;
							return allocResult;
						};
					}
					if (signature.includes("GetLastError")) {
						return () => {
							calls.lastError += 1;
							return lastErrorResult ?? 0;
						};
					}
					if (signature.includes("ShowWindow")) {
						return (hWnd, nCmdShow) => {
							calls.showWindow.push([hWnd, nCmdShow]);
							return 1;
						};
					}
					throw new Error(`unexpected func signature: ${signature}`);
				},
			};
		},
	};
	return { koffi, calls };
}

test("hiddenConsoleOptions：未指定 windowsHide 时注入 true，已指定则尊重原值", () => {
	// loadTsCommonJs 在独立 vm realm 执行 TS：产物对象原型不同，deepStrictEqual 恒失败，
	// 逐字段断言（行为等价）。
	const injected = hiddenConsoleOptions({ stdio: "pipe" });
	assert.equal(injected.stdio, "pipe");
	assert.equal(injected.windowsHide, true);
	assert.equal(hiddenConsoleOptions({ windowsHide: false }).windowsHide, false);
	assert.equal(hiddenConsoleOptions({ windowsHide: true }).windowsHide, true);
	assert.equal(hiddenConsoleOptions(undefined), undefined);
});

test("installHostHiddenConsole：非 win32 不分配、不触碰 ffi", () => {
	const { koffi, calls } = makeFfi();
	assert.equal(installHostHiddenConsole("linux", koffi), false);
	assert.equal(getHiddenConsoleMode(), "off");
	assert.equal(calls.load.length, 0);
	assert.equal(calls.allocConsole, 0);
});

test("installHostHiddenConsole：win32 无控制台时 AllocConsole + ShowWindow(SW_HIDE)", () => {
	const { koffi, calls } = makeFfi({ getResults: [0, 0xabc], allocResult: 1 });
	assert.equal(installHostHiddenConsole("win32", koffi), true);
	assert.equal(getHiddenConsoleMode(), "allocated");
	assert.deepEqual(calls.load, ["kernel32.dll", "user32.dll"]);
	assert.equal(calls.allocConsole, 1);
	assert.deepEqual(calls.showWindow, [[0xabc, 0]], "SW_HIDE = 0");
});

test("installHostHiddenConsole：已有控制台时不再分配（视为成功）", () => {
	const { koffi, calls } = makeFfi({ getResults: [0xabc], allocResult: 1 });
	assert.equal(installHostHiddenConsole("win32", koffi), true);
	assert.equal(getHiddenConsoleMode(), "inherited-windowed");
	assert.equal(calls.allocConsole, 0);
	assert.equal(calls.showWindow.length, 0);
});

test("installHostHiddenConsole：AllocConsole 后句柄尚未就绪仍轮询隐藏", async () => {
	let hwnd = 0;
	const showWindow = [];
	const koffi = {
		load() {
			return {
				func(signature) {
					if (signature.includes("GetConsoleWindow")) return () => hwnd;
					if (signature.includes("AllocConsole")) return () => 1;
					if (signature.includes("ShowWindow")) {
						return (hWnd, nCmdShow) => {
							showWindow.push([hWnd, nCmdShow]);
							return 1;
						};
					}
					throw new Error(`unexpected func signature: ${signature}`);
				},
			};
		},
	};
	assert.equal(installHostHiddenConsole("win32", koffi), true);
	assert.equal(showWindow.length, 0, "首帧句柄为 0 时不能放弃隐藏");
	hwnd = 0xabc;
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.deepEqual(showWindow[0], [0xabc, 0]);
});

test("installHostHiddenConsole：AllocConsole 失败返回 false（触发 windowsHide 兜底）", () => {
	const { koffi, calls } = makeFfi({ getResults: [0], allocResult: 0, lastErrorResult: 6 });
	assert.equal(installHostHiddenConsole("win32", koffi), false);
	assert.equal(getHiddenConsoleMode(), "failed");
	assert.equal(calls.allocConsole, 1);
});

test("installHostHiddenConsole：AllocConsole 失败但 GetLastError=5（ConPTY/已附带控制台）→ 视为成功", () => {
	// 2026-09 实测：Windows Terminal/VS Code 等 ConPTY 终端起到的进程，GetConsoleWindow
	// 为 NULL 但已附带控制台（GetConsoleCP 非 0），AllocConsole 以 ERROR_ACCESS_DENIED(5)
	// 失败。误判成「分配失败」会退回 windowsHide 注入，孙进程反而弹出可见黑窗口。
	const { koffi, calls } = makeFfi({ getResults: [0], allocResult: 0, lastErrorResult: 5 });
	assert.equal(installHostHiddenConsole("win32", koffi), true);
	assert.equal(getHiddenConsoleMode(), "inherited-windowless");
	assert.equal(calls.allocConsole, 1);
	assert.equal(calls.showWindow.length, 0, "无窗口可隐藏，继承即可");
	assert.equal(calls.lastError, 1, "GetLastError 必须在紧跟的语句取到");
});

test("installHostHiddenConsole：GetLastError 不可用（老 ffi 替身）时维持旧兜底", () => {
	// 假 koffi 未提供 GetLastError：func() 抛异常 → lastError=undefined → 按旧行为返回 false。
	const koffiWithNoLastError = {
		load() {
			return {
				func(signature) {
					if (signature.includes("GetConsoleWindow")) return () => 0;
					if (signature.includes("AllocConsole")) return () => 0;
					if (signature.includes("ShowWindow")) return () => 1;
					throw new Error(`unexpected func signature: ${signature}`);
				},
			};
		},
	};
	assert.equal(installHostHiddenConsole("win32", koffiWithNoLastError), false);
	assert.equal(getHiddenConsoleMode(), "failed");
});

test("installHostHiddenConsole：ffi 加载异常静默返回 false", () => {
	const throwing = {
		load() {
			throw new Error("koffi unavailable");
		},
	};
	assert.equal(installHostHiddenConsole("win32", throwing), false);
});

test("installHiddenConsolePatch：非 win32 不安装，win32 安装且可还原", () => {
	const originalSpawn = childProcess.spawn;

	const restoreLinux = installHiddenConsolePatch("linux");
	assert.equal(childProcess.spawn, originalSpawn, "linux 不应安装补丁");
	restoreLinux();

	const restoreWin = installHiddenConsolePatch("win32");
	try {
		assert.notEqual(childProcess.spawn, originalSpawn, "win32 应安装补丁");
	} finally {
		restoreWin();
	}
	assert.equal(childProcess.spawn, originalSpawn, "还原后 spawn 应恢复原引用");
});

test("host 隐藏控制台生效时：普通 spawn 不注入 windowsHide（子进程继承隐藏控制台）", () => {
	installHostHiddenConsole("win32", makeFfi({ getResults: [0, 0xabc] }).koffi);
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {}; // 不真正 spawn
	};
	const restore = installHiddenConsolePatch("win32");
	try {
		childProcess.spawn("pwsh", ["-Command", "Get-Location"]);
		childProcess.spawn("pwsh", ["-Command", "x"], { cwd: "C:\\work" });
		childProcess.spawn("pwsh", { cwd: "C:\\work" });
		childProcess.spawn("pwsh");
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls.length, 4);
	assert.equal(calls[0][2], undefined, "生效模式：无 options 时保持 undefined");
	assert.equal(calls[1][2].cwd, "C:\\work");
	assert.equal("windowsHide" in calls[1][2], false, "生效模式：不注入 windowsHide");
	assert.equal(calls[2][1].cwd, "C:\\work");
	assert.equal("windowsHide" in calls[2][1], false);
	assert.equal(calls[3][1], undefined);
});

test("host 隐藏控制台失效时：退回 windowsHide 注入（兜底）", () => {
	installHostHiddenConsole("win32", makeFfi({ getResults: [0], allocResult: 0 }).koffi);
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	const restore = installHiddenConsolePatch("win32");
	try {
		childProcess.spawn("pwsh", ["-Command", "Get-Location"]);
		childProcess.spawn("pwsh", ["-Command", "x"], { cwd: "C:\\work" });
		childProcess.spawn("pwsh", { cwd: "C:\\work" });
		childProcess.spawn("pwsh", ["-Command", "x"], { windowsHide: false });
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls.length, 4);
	assert.equal(calls[0][2].windowsHide, true, "无 options 时补 { windowsHide: true }");
	assert.equal(calls[1][2].cwd, "C:\\work");
	assert.equal(calls[1][2].windowsHide, true);
	assert.equal(calls[2][1].cwd, "C:\\work");
	assert.equal(calls[2][1].windowsHide, true);
	assert.equal(calls[3][2].windowsHide, false, "显式 windowsHide:false 尊重原值");
});

test("沙箱 runner spawn：注入 NODE_OPTIONS preload（append 语义），普通 spawn 不注入", () => {
	installHostHiddenConsole("win32", makeFfi({ getResults: [0, 0xabc] }).koffi);
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	const preloadPath = "C:\\app\\out\\main\\runnerConsolePreload.js";
	const restore = installHiddenConsolePatch("win32", preloadPath);
	try {
		childProcess.spawn(
			"C:\\app\\electron.exe",
			["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", "--workspace", "C:\\work"],
			{ env: { PATH: "x" } },
		);
		childProcess.spawn(
			"C:\\app\\electron.exe",
			["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js"],
			{ env: { NODE_OPTIONS: "--no-warnings" } },
		);
		childProcess.spawn("pwsh", ["-Command", "x"], { env: { PATH: "y" } });
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
	}
	assert.equal(
		calls[0][2].env.NODE_OPTIONS,
		`--require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"`,
		"runner spawn：注入 preload（Windows NODE_OPTIONS 反斜杠必须翻倍）",
	);
	assert.equal(calls[0][2].env.PATH, "x", "其余 env 保留");
	assert.equal("windowsHide" in calls[0][2], false, "生效模式：runner spawn 也不注入 windowsHide");
	assert.equal(
		calls[1][2].env.NODE_OPTIONS,
		`--no-warnings --require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"`,
		"已有 NODE_OPTIONS 时 append",
	);
	assert.equal("NODE_OPTIONS" in calls[2][2].env, false, "普通 spawn 不注入 preload");
});

test("兜底模式下 runner spawn：windowsHide 注入与 preload 同时生效", () => {
	installHostHiddenConsole("win32", makeFfi({ getResults: [0], allocResult: 0 }).koffi);
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	const restore = installHiddenConsolePatch("win32", "C:\\app\\out\\main\\runnerConsolePreload.js");
	try {
		childProcess.spawn(
			"C:\\app\\electron.exe",
			["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js"],
			{ env: { PATH: "x" } },
		);
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls[0][2].windowsHide, true, "兜底模式：注入 windowsHide");
	assert.equal(calls[0][2].env.NODE_OPTIONS, '--require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"');
});

test("pwsh spawn：注入启动优化环境变量（冷启动提速），非 pwsh 不注入", () => {
	installHostHiddenConsole("win32", makeFfi({ getResults: [0, 0xabc] }).koffi);
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	const restore = installHiddenConsolePatch("win32");
	try {
		// 本地 pwsh spawn：env 注入 POWERSHELL_*/DOTNET_* 启动优化
		childProcess.spawn("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-Command", "x"], { env: { PATH: "p" } });
		// PATH 裸名 pwsh
		childProcess.spawn("pwsh", ["-c", "x"], { env: { PATH: "p" } });
		// 非 pwsh（node/git/cmd）：不注入
		childProcess.spawn("git", ["status"], { env: { PATH: "g" } });
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls[0][2].env.POWERSHELL_TELEMETRY_OPTOUT, "1");
	assert.equal(calls[0][2].env.POWERSHELL_UPDATECHECK, "Off");
	assert.equal(calls[0][2].env.DOTNET_NOLOGO, "1");
	assert.equal(calls[0][2].env.PATH, "p", "其余 env 保留");
	assert.equal(calls[1][2].env.POWERSHELL_TELEMETRY_OPTOUT, "1", "PATH 裸名 pwsh 同样注入");
	assert.equal("POWERSHELL_TELEMETRY_OPTOUT" in calls[2][2].env, false, "非 pwsh 不注入");
});

test("pwsh spawn：追加 exit 兜底 + stdin 改 ignore（挂起止血）", () => {
	installHostHiddenConsole("win32", makeFfi({ getResults: [0, 0xabc] }).koffi);
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	const restore = installHiddenConsolePatch("win32");
	try {
		// 本地 pwsh spawn：-Command 命令追加换行 + exit；stdin pipe → ignore
		childProcess.spawn("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output hi"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "p" } });
		// 非 pwsh 不受影响
		childProcess.spawn("git", ["status"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "g" } });
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls[0][1][4], "Write-Output hi\nexit $LASTEXITCODE", "命令末尾追加 exit 兜底");
	assert.equal(calls[0][2].stdio[0], "ignore", "stdin 改 ignore（不等管道 EOF）");
	assert.equal(calls[0][2].stdio[1], "pipe", "stdout 保持 pipe");
	assert.equal(calls[0][2].env.POWERSHELL_TELEMETRY_OPTOUT, "1", "启动环境注入不受影响");
	assert.deepEqual(calls[1][1], ["status"], "非 pwsh 不追加 exit");
	assert.equal(calls[1][2].stdio[0], "pipe", "非 pwsh 的 stdin 不动");
});

test("runner spawn：不受 pwsh 挂起兜底影响（argv 不含 -Command）", () => {
	installHostHiddenConsole("win32", makeFfi({ getResults: [0, 0xabc] }).koffi);
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	const restore = installHiddenConsolePatch("win32", "C:\\app\\out\\main\\runnerConsolePreload.js");
	try {
		childProcess.spawn(
			"C:\\app\\electron.exe",
			["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", "--workspace", "C:\\work"],
			{ env: { PATH: "x" } },
		);
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
	}
	assert.deepEqual(calls[0][1], [
		"C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js",
		"--workspace",
		"C:\\work",
	], "runner argv 原样透传");
	assert.equal(calls[0][2].env.NODE_OPTIONS, '--require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"');
});

test("runner spawn：强制注入 ELECTRON_RUN_AS_NODE=1（挂起根治：缺它 runner 以 GUI 模式跑、永不退出）", () => {
	installHostHiddenConsole("win32", makeFfi({ getResults: [0, 0xabc] }).koffi);
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	const restore = installHiddenConsolePatch("win32", "C:\\app\\out\\main\\runnerConsolePreload.js");
	try {
		childProcess.spawn(
			"C:\\app\\electron.exe",
			["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", "--workspace", "C:\\work", "--", "pwsh.exe", "-Command", "$PID"],
			{ env: { PATH: "x" } },
		);
		// 普通 spawn 不受影响
		childProcess.spawn("git", ["status"], { env: { PATH: "g" } });
		// env 已有值时保持（幂等）
		childProcess.spawn(
			"C:\\app\\electron.exe",
			["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", "--workspace", "C:\\work"],
			{ env: { PATH: "y", ELECTRON_RUN_AS_NODE: "1" } },
		);
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls[0][2].env.ELECTRON_RUN_AS_NODE, "1", "runner spawn 注入 ELECTRON_RUN_AS_NODE=1");
	assert.equal(calls[0][2].env.NODE_OPTIONS, '--require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"', "preload 注入不受影响");
	assert.equal(calls[1][2].env.ELECTRON_RUN_AS_NODE, undefined, "非 runner 不注入");
	assert.equal(calls[2][2].env.ELECTRON_RUN_AS_NODE, "1", "env 已有值时保持 1（幂等）");
});

test("runner spawn：-- 尾部 pwsh -Command 追加 exit（沙箱内 pwsh 不退出止血），stdio 不动", () => {
	// 2026-09-12 automation 实测：沙箱内 pwsh（runner 用 CreateProcessAsUserW 拉起，
	// 补丁够不着子进程）输出完成后不退出，4/4 挂满 120s 工具超时——在 runner spawn
	// 边界改写 -- 尾部的 -Command 参数追加 exit。stdio 不能动：runner 可能用 stdin
	// pipe 向受限命令传数据。
	installHostHiddenConsole("win32", makeFfi({ getResults: [0, 0xabc] }).koffi);
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	const restore = installHiddenConsolePatch("win32", "C:\\app\\out\\main\\runnerConsolePreload.js");
	try {
		childProcess.spawn(
			"C:\\app\\electron.exe",
			[
				"C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js",
				"--workspace", "C:\\work",
				"--", "pwsh.exe", "-NoLogo", "-NonInteractive", "-Command", "Write-Output hi",
			],
			{ env: { PATH: "x" }, stdio: ["ignore", "pipe", "pipe"] },
		);
		// 尾部非 pwsh -Command（git）：argv 原样透传
		childProcess.spawn(
			"C:\\app\\electron.exe",
			[
				"C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js",
				"--workspace", "C:\\work",
				"--", "git.exe", "status",
			],
			{ env: { PATH: "x" } },
		);
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls[0][1][8], "Write-Output hi\nexit $LASTEXITCODE", "沙箱 pwsh 命令末尾追加 exit");
	assert.equal(calls[0][2].stdio[0], "ignore", "runner spawn 的 stdio 不被 pwsh 守卫改动");
	assert.equal(calls[0][2].stdio[1], "pipe");
	assert.equal(calls[0][2].env.ELECTRON_RUN_AS_NODE, "1", "ELECTRON_RUN_AS_NODE 注入不受影响");
	assert.equal(calls[0][2].env.NODE_OPTIONS, '--require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"');
	assert.deepEqual(
		calls[1][1],
		[
			"C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js",
			"--workspace", "C:\\work",
			"--", "git.exe", "status",
		],
		"尾部非 pwsh -Command 时 argv 原样透传",
	);
});

test("win32 补丁：execFile（带 callback）与 exec 在兜底模式注入、生效模式不动", () => {
	const originalSpawn = childProcess.spawn;
	const originalExecFile = childProcess.execFile;
	const originalExec = childProcess.exec;
	const calls = [];
	childProcess.spawn = () => ({});
	childProcess.execFile = (...args) => {
		calls.push(["execFile", args]);
		return {};
	};
	childProcess.exec = (...args) => {
		calls.push(["exec", args]);
		return {};
	};

	// 兜底模式：注入 windowsHide
	installHostHiddenConsole("win32", makeFfi({ getResults: [0], allocResult: 0 }).koffi);
	let restore = installHiddenConsolePatch("win32");
	try {
		childProcess.execFile("taskkill", ["/PID", "123"], () => undefined);
		childProcess.execFile("pwsh.exe", ["-c", "x"], { encoding: "utf8" });
		childProcess.exec("where pwsh", { encoding: "utf8" });
	} finally {
		restore();
	}
	const fallbackCalls = calls.splice(0);
	assert.equal(fallbackCalls.length, 3);
	assert.equal(fallbackCalls[0][1][2].windowsHide, true, "callback 形态：options 插入 callback 前");
	assert.equal(typeof fallbackCalls[0][1][3], "function");
	assert.equal(fallbackCalls[1][1][2].encoding, "utf8");
	assert.equal(fallbackCalls[1][1][2].windowsHide, true);
	assert.equal(fallbackCalls[2][1][1].encoding, "utf8");
	assert.equal(fallbackCalls[2][1][1].windowsHide, true);

	// 生效模式：不注入
	installHostHiddenConsole("win32", makeFfi({ getResults: [0, 0xabc] }).koffi);
	restore = installHiddenConsolePatch("win32");
	try {
		childProcess.execFile("taskkill", ["/PID", "123"], () => undefined);
		childProcess.execFile("pwsh.exe", ["-c", "x"], { encoding: "utf8" });
		childProcess.exec("where pwsh", { encoding: "utf8" });
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
		childProcess.execFile = originalExecFile;
		childProcess.exec = originalExec;
	}
	const activeCalls = calls.splice(0);
	assert.equal(activeCalls.length, 3);
	assert.equal(activeCalls[0][1][2], undefined, "生效模式：callback 形态无 options 时保持 undefined");
	assert.equal("windowsHide" in activeCalls[1][1][2], false);
	assert.equal("windowsHide" in activeCalls[2][1][1], false);
	assert.equal(activeCalls[1][1][2].encoding, "utf8", "原 options 原样透传");
});
