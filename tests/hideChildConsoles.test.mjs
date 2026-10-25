import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as esmChildProcess from "node:child_process";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// ESM `import * as` 命名空间只读，无法在上面做补丁/还原断言；
// 走 CJS exports 对象（与 hideChildConsoles.ts 编译后 require 到的是同一实例）。
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");

const { hiddenConsoleOptions, installHiddenConsolePatch, installHostHiddenConsole, installRunnerNodeModeEnv, installRunnerPreloadEnv, getHiddenConsoleMode, configureDshRunnerNodeSidecar, getDshRunnerNodeSidecar } = loadTsCommonJs("src/main/dsh/hideChildConsoles.ts");

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

test("installHostHiddenConsole：非 win32 不治理、不触碰 ffi", () => {
	const { koffi, calls } = makeFfi();
	assert.equal(installHostHiddenConsole("linux", koffi), false);
	assert.equal(getHiddenConsoleMode(), "off");
	assert.equal(calls.load.length, 0);
	assert.equal(calls.allocConsole, 0);
});

test("installHostHiddenConsole：win32 不再 AllocConsole（CREATE_NO_WINDOW 策略）", () => {
	const { koffi, calls } = makeFfi({ getResults: [0, 0xabc], allocResult: 1 });
	assert.equal(installHostHiddenConsole("win32", koffi), false, "没有已分配的隐藏控制台");
	assert.equal(getHiddenConsoleMode(), "create-no-window");
	assert.equal(calls.load.length, 0, "现行路径不得加载 koffi");
	assert.equal(calls.allocConsole, 0, "AllocConsole 会异步弹出 conhost");
	assert.equal(calls.showWindow.length, 0);
});

test("installRunnerNodeModeEnv：win32 置 ELECTRON_RUN_AS_NODE=1（可还原），非 win32 不动", () => {
	// 沙箱第二级 runner（windows-acl）的 env 由 dsh-subprocess-local 从 host 进程环境派生，
	// spawn 补丁够不着；缺这个变量它会以 GUI electron.exe 跑、事件循环永不退出 → 每条
	// 沙箱命令挂满 120s 工具超时。
	const env = { PATH: "x" };
	const restore = installRunnerNodeModeEnv(env, "win32");
	assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
	assert.equal(env.PATH, "x", "其余 env 不动");
	restore();
	assert.equal("ELECTRON_RUN_AS_NODE" in env, false, "还原时删除原本不存在的键");
	const withExisting = { ELECTRON_RUN_AS_NODE: "0" };
	const restore2 = installRunnerNodeModeEnv(withExisting, "win32");
	assert.equal(withExisting.ELECTRON_RUN_AS_NODE, "1");
	restore2();
	assert.equal(withExisting.ELECTRON_RUN_AS_NODE, "0", "还原为原值");

	const linuxEnv = {};
	const restoreLinux = installRunnerNodeModeEnv(linuxEnv, "linux");
	assert.equal("ELECTRON_RUN_AS_NODE" in linuxEnv, false, "非 win32 不置位");
	restoreLinux();
});

test("installRunnerNodeModeEnv：host 环境标记能穿过 dsh-subprocess 的 scrubbedParentEnv 下发到沙箱 runner", async () => {
	// 这是本修复成立的**前提假设**，DSH 侧一旦改动 scrubbedParentEnv 的过滤规则
	// （例如开始抹除 ELECTRON_*），沙箱挂起就会复发——用真实实现把它钉住。
	// 契约来源：dsh-subprocess-local 的 targetEnvironment() = scrubbedParentEnv() + spec.env，
	// 只过滤 /KEY|PASSWORD|SECRET|TOKEN/i 与 DSH_* 前缀。
	let scrubbedParentEnv;
	try {
		({ scrubbedParentEnv } = await import("@deepseek-ai/dsh-subprocess"));
	} catch (error) {
		// DSH 运行时是可选依赖（可外置下载），缺失时跳过（不掩盖：上面的 install 断言仍在跑）
		console.log(`# skip: @deepseek-ai/dsh-subprocess 不可用 (${error?.code ?? error})`);
		return;
	}
	const previous = process.env.ELECTRON_RUN_AS_NODE;
	installRunnerNodeModeEnv(process.env, "win32");
	try {
		assert.equal(scrubbedParentEnv().ELECTRON_RUN_AS_NODE, "1", "host 环境标记必须原样穿过 scrub（否则沙箱 runner 退回 GUI 模式）");
	} finally {
		if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
		else process.env.ELECTRON_RUN_AS_NODE = previous;
	}
});

test("installRunnerPreloadEnv：win32 把 preload 写进 NODE_OPTIONS（append + 幂等 + 可还原），非 win32 不动", () => {
	// 黑窗口根治：第二级 ACL runner 的 env 来自 host 进程环境（经 scrubbedParentEnv
	// → IPC request.env），spawn 补丁的 preload 注入够不着它——必须由 host env 携带。
	const preloadPath = "C:\\app\\out\\main\\runnerConsolePreload.js";
	const env = { PATH: "x" };
	const restore = installRunnerPreloadEnv(env, "win32", preloadPath);
	assert.equal(env.NODE_OPTIONS, `--require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"`, "写入 preload（Windows NODE_OPTIONS 反斜杠必须翻倍）");
	assert.equal(env.PATH, "x", "其余 env 不动");
	// 幂等：已含同一 preload 时不重复 append（第一级 runner 的 options.env 由 host env
	// 派生，withRunnerPreload 也不能叠第二份，否则 Node 加载两遍）。
	const restore2 = installRunnerPreloadEnv(env, "win32", preloadPath);
	assert.equal(env.NODE_OPTIONS, `--require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"`, "重复安装不叠加");
	restore2();
	// append 语义：已有 NODE_OPTIONS 时拼接。
	const withExisting = { NODE_OPTIONS: "--no-warnings" };
	const restore3 = installRunnerPreloadEnv(withExisting, "win32", preloadPath);
	assert.equal(withExisting.NODE_OPTIONS, `--no-warnings --require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"`);
	restore3();
	assert.equal(withExisting.NODE_OPTIONS, "--no-warnings", "还原为原值");
	restore();
	assert.equal("NODE_OPTIONS" in env, false, "还原时删除原本不存在的键");

	const linuxEnv = {};
	const restoreLinux = installRunnerPreloadEnv(linuxEnv, "linux", preloadPath);
	assert.equal("NODE_OPTIONS" in linuxEnv, false, "非 win32 不置位");
	restoreLinux();
});

test("installRunnerPreloadEnv：host env 的 preload 能穿过 dsh-subprocess 的 scrubbedParentEnv 下发到沙箱 runner", async () => {
	// 与 ELECTRON_RUN_AS_NODE 同一前提假设：scrub 只过滤 KEY/PASSWORD/SECRET/TOKEN 与
	// DSH_*，NODE_OPTIONS 原样穿透。DSH 若开始抹除 NODE_OPTIONS，黑窗口会复发——钉住。
	let scrubbedParentEnv;
	try {
		({ scrubbedParentEnv } = await import("@deepseek-ai/dsh-subprocess"));
	} catch (error) {
		console.log(`# skip: @deepseek-ai/dsh-subprocess 不可用 (${error?.code ?? error})`);
		return;
	}
	const previous = process.env.NODE_OPTIONS;
	installRunnerPreloadEnv(process.env, "win32", "C:\\app\\out\\main\\runnerConsolePreload.js");
	try {
		const scrubbed = scrubbedParentEnv().NODE_OPTIONS ?? "";
		assert.ok(scrubbed.includes("--require=") && scrubbed.includes("runnerConsolePreload"), "preload 必须原样穿过 scrub（否则第二级 runner 无控制台、pwsh 弹黑窗口）");
	} finally {
		if (previous === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = previous;
	}
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

/** 在补丁安装前加载的 ESM 消费者也必须拿到 sidecar/preload，而非 Electron 原始 spawn。 */
test("win32 控制台补丁同步提前加载的 ESM 导出，并在还原时同步撤销", () => {
	const names = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"];
	const originals = Object.fromEntries(names.map((name) => [name, childProcess[name]]));
	const calls = [];
	const sidecar = "C:\\app\\node.exe";
	const preload = "C:\\app\\runnerConsolePreload.js";
	let restore;
	try {
		for (const name of names)
			childProcess[name] = (...args) => {
				calls.push({ name, args });
				return {};
			};
		syncBuiltinESMExports();
		const before = Object.fromEntries(names.map((name) => [name, esmChildProcess[name]]));
		configureDshRunnerNodeSidecar(sidecar);
		restore = installHiddenConsolePatch("win32", preload);
		for (const name of names) {
			assert.equal(esmChildProcess[name], childProcess[name], `${name} 的 ESM 绑定必须同步补丁`);
			assert.notEqual(esmChildProcess[name], before[name]);
		}
		esmChildProcess.spawn("C:\\app\\electron.exe", ["C:\\runtime\\runner.js", "--", "pwsh.exe"], { env: {}, stdio: ["ignore", "ignore", "ignore", "ipc", "pipe", "pipe", "pipe"] });
		assert.equal(calls[0].args[0], sidecar);
		assert.equal(calls[0].args[2].windowsHide, true);
		assert.equal(calls[0].args[2].env.NODE_OPTIONS, undefined, "sidecar 不注入 preload（asar 内路径在真 node.exe 上 MODULE_NOT_FOUND）");
		assert.equal(calls[0].args[2].stdio[3], "ipc", "Job runner 的 IPC 与 target carriers 不得改变");
		restore();
		restore = undefined;
		for (const name of names) assert.equal(esmChildProcess[name], before[name], `${name} 的 ESM 绑定必须同步还原`);
	} finally {
		restore?.();
		configureDshRunnerNodeSidecar(undefined);
		for (const name of names) childProcess[name] = originals[name];
		syncBuiltinESMExports();
	}
});

/** runner preload 的补丁同样要覆盖 ESM，保证嵌套 runner 不丢失无窗口策略。 */
test("runner preload 同步提前加载的 ESM spawn 和 spawnSync", () => {
	const originalSpawn = childProcess.spawn;
	const originalSpawnSync = childProcess.spawnSync;
	const calls = [];
	const sidecar = "C:\\app\\node.exe";
	try {
		childProcess.spawn = (...args) => {
			calls.push(args);
			return {};
		};
		childProcess.spawnSync = (...args) => {
			calls.push(args);
			return {};
		};
		syncBuiltinESMExports();
		loadTsCommonJs("src/main/dsh/runnerConsolePreload.ts", {
			globals: { process: { platform: "win32", execPath: sidecar, env: { PIDECK_DSH_RUNNER_NODE: sidecar } } },
		});
		assert.equal(esmChildProcess.spawn, childProcess.spawn, "preload 必须同步 ESM spawn");
		assert.equal(esmChildProcess.spawnSync, childProcess.spawnSync, "preload 必须同步 ESM spawnSync");
		for (const spawn of [esmChildProcess.spawn, esmChildProcess.spawnSync]) spawn("C:\\app\\electron.exe", ["C:\\runtime\\runner.js"], { windowsHide: false, env: { PATH: "test" } });
		assert.equal(calls.length, 2);
		for (const args of calls) {
			assert.equal(args[0], sidecar);
			assert.equal(args[2].windowsHide, true);
			assert.equal(args[2].env.PATH, "test");
		}
	} finally {
		childProcess.spawn = originalSpawn;
		childProcess.spawnSync = originalSpawnSync;
		syncBuiltinESMExports();
	}
});

test("win32 普通 spawn：恒注入 windowsHide（CREATE_NO_WINDOW 无窗口可继承控制台）", () => {
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
		childProcess.spawn("C:\\app\\electron.exe", ["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", "--workspace", "C:\\work"], { env: { PATH: "x" } });
		childProcess.spawn("C:\\app\\electron.exe", ["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js"], { env: { NODE_OPTIONS: "--no-warnings" } });
		childProcess.spawn("pwsh", ["-Command", "x"], { env: { PATH: "y" } });
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls[0][2].env.NODE_OPTIONS, `--require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"`, "runner spawn：注入 preload（Windows NODE_OPTIONS 反斜杠必须翻倍）");
	assert.equal(calls[0][2].env.PATH, "x", "其余 env 保留");
	assert.equal(calls[0][2].windowsHide, true, "runner spawn 也走 CREATE_NO_WINDOW");
	assert.equal(calls[1][2].env.NODE_OPTIONS, `--no-warnings --require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"`, "已有 NODE_OPTIONS 时 append");
	assert.equal("NODE_OPTIONS" in calls[2][2].env, false, "普通 spawn 不注入 preload");
});

test("runner spawn：host env 已带 preload 时不叠加第二份（installRunnerPreloadEnv × withRunnerPreload 幂等）", () => {
	// 端到端去重：installRunnerPreloadEnv 写进 host env 后，第一级 runner 的
	// options.env（由 host env 派生）已含 preload，withRunnerPreload 必须跳过 append。
	installHostHiddenConsole("win32", makeFfi({ getResults: [0, 0xabc] }).koffi);
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	const preloadPath = "C:\\app\\out\\main\\runnerConsolePreload.js";
	const hostEnv = { PATH: "x", NODE_OPTIONS: `--require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"` };
	const restoreEnv = installRunnerPreloadEnv(hostEnv, "win32", preloadPath);
	const restore = installHiddenConsolePatch("win32", preloadPath);
	try {
		childProcess.spawn("C:\\app\\electron.exe", ["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js"], { env: { ...hostEnv } });
	} finally {
		restore();
		restoreEnv();
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls[0][2].env.NODE_OPTIONS, `--require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"`, "preload 恰好一份：不能叠成 --require×2（Node 会加载两遍）");
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
		childProcess.spawn("C:\\app\\electron.exe", ["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js"], { env: { PATH: "x" } });
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
		childProcess.spawn("C:\\app\\electron.exe", ["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", "--workspace", "C:\\work"], { env: { PATH: "x" } });
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
	}
	assert.deepEqual(calls[0][1], ["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", "--workspace", "C:\\work"], "runner argv 原样透传");
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
		childProcess.spawn("C:\\app\\electron.exe", ["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", "--workspace", "C:\\work", "--", "pwsh.exe", "-Command", "$PID"], { env: { PATH: "x" } });
		// 普通 spawn 不受影响
		childProcess.spawn("git", ["status"], { env: { PATH: "g" } });
		// env 已有值时保持（幂等）
		childProcess.spawn("C:\\app\\electron.exe", ["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", "--workspace", "C:\\work"], { env: { PATH: "y", ELECTRON_RUN_AS_NODE: "1" } });
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls[0][2].env.ELECTRON_RUN_AS_NODE, "1", "runner spawn 注入 ELECTRON_RUN_AS_NODE=1");
	assert.equal(calls[0][2].env.NODE_OPTIONS, '--require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"', "preload 注入不受影响");
	assert.equal(calls[1][2].env.ELECTRON_RUN_AS_NODE, undefined, "非 runner 不注入");
	assert.equal(calls[2][2].env.ELECTRON_RUN_AS_NODE, "1", "env 已有值时保持 1（幂等）");
});

/** runner 负责超时和进程回收；追加 exit 会丢失 Get-Location 等命令的延迟格式化输出。 */
test("runner spawn/spawnSync：保留 pwsh 原始命令与管道，不追加 exit 截断输出", () => {
	installHostHiddenConsole("win32", makeFfi({ getResults: [0, 0xabc] }).koffi);
	const originalSpawn = childProcess.spawn;
	const originalSpawnSync = childProcess.spawnSync;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	childProcess.spawnSync = (...args) => {
		calls.push(args);
		return {};
	};
	const restore = installHiddenConsolePatch("win32", "C:\\app\\out\\main\\runnerConsolePreload.js");
	const argv = ["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", "--workspace", "C:\\work", "--", "pwsh.exe", "-NoLogo", "-NonInteractive", "-Command", "Get-Location"];
	const stdio = ["pipe", "pipe", "pipe", "ipc", "pipe", "pipe", "pipe"];
	try {
		for (const spawn of [childProcess.spawn, childProcess.spawnSync]) spawn("C:\\app\\electron.exe", argv, { env: { PATH: "x" }, stdio });
		childProcess.spawn("C:\\app\\electron.exe", ["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", "--workspace", "C:\\work", "--", "git.exe", "status"], { env: { PATH: "x" } });
	} finally {
		restore();
		childProcess.spawn = originalSpawn;
		childProcess.spawnSync = originalSpawnSync;
		syncBuiltinESMExports();
	}
	for (const call of calls.slice(0, 2)) {
		assert.deepEqual(call[1], argv, "不改写 PowerShell 命令，保留原始退出码与格式化输出");
		assert.deepEqual(call[2].stdio, stdio, "不改动 runner 的 stdin、IPC 与 target carriers");
		assert.equal(call[2].env.ELECTRON_RUN_AS_NODE, "1");
		assert.equal(call[2].env.NODE_OPTIONS, '--require="C:\\\\app\\\\out\\\\main\\\\runnerConsolePreload.js"');
	}
	assert.deepEqual(calls[2][1], ["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", "--workspace", "C:\\work", "--", "git.exe", "status"], "非 pwsh 命令也原样透传");
});

test("win32 补丁：execFile（带 callback）与 exec 恒注入 windowsHide", () => {
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

	installHostHiddenConsole("win32");
	const restore = installHiddenConsolePatch("win32");
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
	assert.equal(calls.length, 3);
	assert.equal(calls[0][1][2].windowsHide, true, "callback 形态：options 插入 callback 前");
	assert.equal(typeof calls[0][1][3], "function");
	assert.equal(calls[1][1][2].encoding, "utf8");
	assert.equal(calls[1][1][2].windowsHide, true);
	assert.equal(calls[2][1][1].encoding, "utf8");
	assert.equal(calls[2][1][1].windowsHide, true);
});

test("CUI sidecar：版本管理器垫片一律忽略，退回 electron.exe + preload", () => {
	// PATH 上的 mise/scoop 垫片能跑 node -v，但会转丢 runner 的 IPC 管道，
	// 宿主判 “Windows Job runner exited with exit code 0 before proving its
	// managed range empty”，PTC run_code 直接失败。宁可不改写。
	configureDshRunnerNodeSidecar("C:\\Users\\t\\AppData\\Local\\mise\\shims\\node", "win32");
	assert.equal(getDshRunnerNodeSidecar(), undefined);
	configureDshRunnerNodeSidecar("C:\\Users\\t\\AppData\\Local\\mise\\shims\\node.exe", "win32");
	assert.equal(getDshRunnerNodeSidecar(), undefined);
	configureDshRunnerNodeSidecar("C:\\Users\\t\\scoop\\shims\\node.exe", "win32");
	assert.equal(getDshRunnerNodeSidecar(), undefined);
	configureDshRunnerNodeSidecar("C:\\Users\\t\\AppData\\Local\\mise\\installs\\node\\24.13.0\\node.exe", "win32");
	assert.equal(getDshRunnerNodeSidecar(), "C:\\Users\\t\\AppData\\Local\\mise\\installs\\node\\24.13.0\\node.exe");
	configureDshRunnerNodeSidecar(undefined);
	assert.equal(getDshRunnerNodeSidecar(), undefined);
});

test("CUI sidecar：把 electron.exe runner 改写成 node.exe，且 windowsHide=true", () => {
	installHostHiddenConsole("win32");
	configureDshRunnerNodeSidecar("C:\\app\\resources\\dsh-runner-node\\node.exe");
	assert.equal(getDshRunnerNodeSidecar(), "C:\\app\\resources\\dsh-runner-node\\node.exe");
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	const restore = installHiddenConsolePatch("win32", "C:\\app\\out\\main\\runnerConsolePreload.js");
	try {
		childProcess.spawn("C:\\app\\electron.exe", ["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", "--workspace", "C:\\work", "--", "pwsh.exe", "-Command", "$PID"], { env: { PATH: "x" }, windowsHide: false });
		childProcess.spawn("git", ["status"], { env: { PATH: "g" } });
	} finally {
		restore();
		configureDshRunnerNodeSidecar(undefined);
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls[0][0], "C:\\app\\resources\\dsh-runner-node\\node.exe", "runner 可执行文件换成 CUI sidecar");
	assert.equal(calls[0][2].windowsHide, true, "sidecar 自建无窗口控制台，不依赖 host AllocConsole");
	assert.equal(calls[0][2].env.NODE_OPTIONS, undefined, "sidecar 是真 node.exe，不注入 preload：asar 内的 --require 会让 runner exit 1");
	assert.equal("ELECTRON_RUN_AS_NODE" in calls[0][2].env, false, "node.exe 不需要 RUN_AS_NODE");
	assert.equal(calls[1][0], "git", "非 runner spawn 不改写");
});

test("CUI sidecar 不注入 preload：真 node.exe 读不了 app.asar，注入会让第一级 runner 立刻退出（PTC 全失败回归）", () => {
	installHostHiddenConsole("win32");
	configureDshRunnerNodeSidecar("C:\\app\\resources\\dsh-runner-node\\node.exe");
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	// 生产打包后 preload 位于 app.asar 内；sidecar 是真 node.exe，没有 Electron 的 asar 读取能力。
	const asarPreload = "C:\\app\\resources\\app.asar\\out\\main\\runnerConsolePreload.js";
	const restore = installHiddenConsolePatch("win32", asarPreload);
	try {
		childProcess.spawn("C:\\app\\electron.exe", ["C:\\app\\node_modules\\@deepseek-ai\\dsh-subprocess-local\\lib\\runner.js", "--", "node", "-e", "1"], { env: { PATH: "x", ELECTRON_RUN_AS_NODE: "1" } });
	} finally {
		restore();
		configureDshRunnerNodeSidecar(undefined);
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls[0][0], "C:\\app\\resources\\dsh-runner-node\\node.exe");
	assert.equal(calls[0][2].env.NODE_OPTIONS, undefined, "NODE_OPTIONS 不得带 asar 内 preload");
	assert.equal(calls[0][2].env.ELECTRON_RUN_AS_NODE, "1", "原有环境变量不被额外改写");
});

test("CUI sidecar：host 无 AllocConsole 时仍改写（靠 CREATE_NO_WINDOW，不再怕 GUI 父进程弹窗）", () => {
	installHostHiddenConsole("win32");
	configureDshRunnerNodeSidecar("C:\\app\\resources\\dsh-runner-node\\node.exe");
	const originalSpawn = childProcess.spawn;
	const calls = [];
	childProcess.spawn = (...args) => {
		calls.push(args);
		return {};
	};
	const restore = installHiddenConsolePatch("win32", "C:\\app\\out\\main\\runnerConsolePreload.js");
	try {
		childProcess.spawn("C:\\app\\electron.exe", ["C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js"], { env: { PATH: "x" } });
	} finally {
		restore();
		configureDshRunnerNodeSidecar(undefined);
		childProcess.spawn = originalSpawn;
	}
	assert.equal(calls[0][0], "C:\\app\\resources\\dsh-runner-node\\node.exe");
	assert.equal(calls[0][2].windowsHide, true);
	assert.equal("ELECTRON_RUN_AS_NODE" in calls[0][2].env, false);
});
