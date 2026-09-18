import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

function loadLocator({ execFile, platform = "linux" } = {}) {
	const load = createTsSandbox({
		stubs: {
			electron: { app: { getPath: () => "/tmp/pideck-home" } },
			"node:child_process": {
				execFile,
				// 回归护栏：readLoginShellPath 的 execFileSync 必须被删（M1 根因）。
				execFileSync: () => {
					throw new Error(
						"execFileSync must never be called: it blocks the Electron main loop",
					);
				},
			},
		},
		globals: { process: { ...process, platform } },
	});
	return load("src/main/pi/PiLocator.ts");
}

test("warmLoginShellPath：异步执行一次并进程级缓存（成功值）", async () => {
	let execCalls = 0;
	const mod = loadLocator({
		execFile: (command, args, _options, callback) => {
			execCalls += 1;
			assert.equal(command, "/bin/sh");
			// VM 跨 realm：args 是沙箱内 Array，与宿主 Array 原型不同，用 JSON 文本比较。
			assert.equal(JSON.stringify(args), JSON.stringify(["-lc", 'printf %s "$PATH"']));
			callback(null, "/usr/local/bin:/opt/homebrew/bin\n", "");
		},
	});
	const locator = new mod.PiLocator();
	const first = await locator.warmLoginShellPath();
	assert.equal(first, "/usr/local/bin:/opt/homebrew/bin");
	const second = await locator.warmLoginShellPath();
	assert.equal(second, "/usr/local/bin:/opt/homebrew/bin");
	assert.equal(execCalls, 1, "缓存命中，不重复执行登录 shell");
});

test("warmLoginShellPath：失败负缓存为空串（与旧行为一致，仅退化 env PATH）", async () => {
	let execCalls = 0;
	const mod = loadLocator({
		execFile: (_command, _args, _options, callback) => {
			execCalls += 1;
			callback(new Error("timeout"), "", "");
		},
	});
	const locator = new mod.PiLocator();
	assert.equal(await locator.warmLoginShellPath(), "");
	assert.equal(await locator.warmLoginShellPath(), "");
	assert.equal(execCalls, 1, "负缓存同样只执行一次");
});

test("getSearchDirs 不再同步阻塞：未预热时用 env PATH 返回并后台补热", async () => {
	const mod = loadLocator({
		execFile: (_command, _args, _options, callback) => {
			queueMicrotask(() => callback(null, "/from/login/shell", ""));
		},
	});
	const locator = new mod.PiLocator();
	// 未预热直接同步读：不得抛 execFileSync、不得缺 env 目录
	const dirs = locator.getSearchDirs();
	assert.ok(Array.isArray(dirs));
	assert.ok(dirs.length > 0, "env PATH 目录仍在");
	// 后台补热完成后，缓存就绪
	await locator.warmLoginShellPath();
	assert.ok(locator.getSearchDirs().includes("/from/login/shell"));
});

test("check() 先预热登录 shell 再探测（win32 恒空不执行）", async () => {
	let warmCalls = 0;
	const mod = loadLocator({
		execFile: (command, _args, _options, callback) => {
			// 只数登录 shell 预热调用；runCheck 的 `pi --version` 探测是同文件里
			// 另一处合法 execFile，不计入（计划原断言把两者混计，会误伤）。
			if (command === "/bin/sh") warmCalls += 1;
			callback(null, "/login-shell-bin", "");
		},
	});
	const locator = new mod.PiLocator();
	await locator.check(undefined, false, undefined, undefined);
	assert.equal(warmCalls, 1, "check 异步入口负责确定性预热");
});
