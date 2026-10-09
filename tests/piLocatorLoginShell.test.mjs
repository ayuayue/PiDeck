import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

function loadLocator({ execFile, platform = "linux", env = {}, fsOverride = {} } = {}) {
	return (async () => {
		const fs = await import("node:fs");
		const load = createTsSandbox({
			stubs: {
				electron: { app: { getPath: () => "/tmp/pideck-home" } },
				"node:child_process": {
					execFile,
					// 回归护栏：readLoginShellPath 的 execFileSync 必须被删（M1 根因）。
					execFileSync: () => {
						throw new Error("execFileSync must never be called: it blocks the Electron main loop");
					},
				},
				// 允许按用例覆盖 existsSync/realpathSync 等，模拟 POSIX 软链语义
				"node:fs": { ...fs, ...fsOverride },
			},
			globals: { process: { ...process, platform, env: { ...process.env, ...env } } },
		});
		return load("src/main/pi/PiLocator.ts");
	})();
}

test("warmLoginShellPath：异步执行一次并进程级缓存（成功值）", async () => {
	let execCalls = 0;
	const mod = await loadLocator({
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
	const mod = await loadLocator({
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
	const mod = await loadLocator({
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
	const mod = await loadLocator({
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

test("probeLoginShellPi 把版本管理器的会话级软链解析成真实路径（#318）", async () => {
	const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const fs = await import("node:fs");
	const root = mkdtempSync(join(tmpdir(), "pideck-probe-realpath-"));
	const realBin = join(root, "fnm", "node-versions", "v24.14.1", "installation", "bin");
	mkdirSync(realBin, { recursive: true });
	const realPi = join(realBin, "pi");
	writeFileSync(realPi, "#!/usr/bin/env node\n");
	// fnm multishell 是会话级软链（shell 退出即被清理）。生产代码按 POSIX 语义
	// 过滤（startsWith("/")+existsSync），宿主可能是 Windows，所以用 fs 桩把
	// 假 POSIX 软链路径映射到宿主真实文件，验证 realpath 解析这一步本身。
	const multishellBinPosix = "/home/u/.local/state/fnm_multishells/64463_1791384711281/bin";
	const mod = await loadLocator({
		env: { SHELL: "/bin/sh" },
		execFile: (_command, _args, _options, callback) => {
			queueMicrotask(() => callback(null, `${multishellBinPosix}/pi\n`, ""));
		},
		fsOverride: {
			// loginShellCandidates 会用 existsSync 过滤 shell 候选（宿主可能是 Windows），
			// 放行 SHELL 候选让探测链路真的执行到 multishell 路径解析这一步。
			existsSync: (p) => (p === "/bin/sh" ? true : p === `${multishellBinPosix}/pi` ? true : fs.existsSync(p)),
			realpathSync: (p) => (p === `${multishellBinPosix}/pi` ? realPi : fs.realpathSync(p)),
		},
	});
	try {
		const locator = new mod.PiLocator();
		const found = await locator.probeLoginShellPi({ force: true, allowProbe: true });
		assert.equal(found, realPi, "应返回 realpath 解析后的稳定路径，而不是随会话销毁的软链");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
