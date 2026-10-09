import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/** Exercise the real update/exec path without launching pi or accessing the network. */
function makeManager({ version = "0.80.0", installedVersion = "1.0.0", latestVersion = "1.0.0", executionError, stdout = "updated", stderr = "", checkError, hangUntilAbort = false, command } = {}) {
	const commands = [];
	const probes = [];
	const logs = [];
	const netFetchCalls = [];
	let invalidations = 0;
	let settings = { customPiPath: "/fixture/pi", wslEnabled: false };
	const originalSettings = settings;
	const load = createTsSandbox({
		stubs: {
			"node:child_process": {
				execFile: (command, args, options, callback) => {
					commands.push({ command, args: Array.from(args), options });
					queueMicrotask(() => callback(executionError ?? null, stdout, stderr));
				},
			},
			"../pi/PiProcess": { PiProcess: { invalidateVersionCache: () => invalidations++ } },
			"../fs/trash": { trashPath: async () => {} },
			"../logging/sharedLogger": { getAppLogger: () => ({ error: (...args) => logs.push(args) }) },
			// 旧前缀形态代跑 npm 时用它解析 npm 命令；固定回 npm，避免读到本机真实 settings。
			"../resourceWhitelist": { readConfiguredNpmCommand: () => ["npm"] },
			// 版本检查必须走 Electron net.fetch（Chromium 网络栈，系统/桌面代理生效）。
			// 这里**只**提供 net.fetch、刻意不在沙箱注册全局 fetch：实现若退回裸全局
			// fetch（undici，不读任何代理配置）会立即 ReferenceError，测试随之变红。
			electron: {
				net: {
					fetch: (...args) => {
						netFetchCalls.push(args);
						if (hangUntilAbort) {
							// 模拟真实 net.fetch 的 abort 语义：只在 signal 中止时才 reject。
							return new Promise((_resolve, reject) => {
								const signal = args[1]?.signal;
								signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
							});
						}
						if (checkError) return Promise.reject(checkError);
						return Promise.resolve({ ok: true, json: async () => ({ version: latestVersion }) });
					},
				},
			},
		},
	});
	const { ExtensionManager } = load("src/main/extensions/ExtensionManager.ts");
	const locator = {
		check: async (...args) => {
			probes.push(args);
			return { installed: true, version: commands.length ? installedVersion : version, ...(command ? { command } : {}) };
		},
		resolveCommand: (path) => path,
		createInvocation: (command, args) => ({ command: "node", args: [command, ...args], shell: false }),
		createProcessEnv: (snapshot) => ({ PI_OFFLINE: "1", CUSTOM_PI_PATH: snapshot.customPiPath }),
		warmWslCommand: async () => {},
	};
	const translate = (key, params = {}) => `${key} ${Object.values(params).join(" ")}`.trim();
	const manager = new ExtensionManager(locator, () => settings, undefined, undefined, translate);
	return { manager, commands, probes, logs, netFetchCalls, originalSettings, changeSettings: (next) => (settings = next), invalidations: () => invalidations };
}

for (const version of ["0.70.3", "0.80.0", "1.0.0"]) {
	test(`pi ${version} self-update uses --self and verifies the selected installation`, async () => {
		const fixture = makeManager({ version, installedVersion: "1.0.1", latestVersion: "1.0.1", stderr: "package-manager notice" });
		fixture.manager.piVersion = "0.60.0";
		const result = await fixture.manager.updatePi();
		assert.equal(result.updated, true);
		assert.ok(fixture.commands[0].args.includes("--self"));
		assert.ok(!fixture.commands[0].args.includes("pi"), "pi is not an extension source or legacy self-update target");
		assert.equal(fixture.commands[0].args.includes("--no-approve"), version !== "0.70.3", "use the fresh probe, not a stale version cache");
		assert.equal(fixture.commands[0].options.env.PI_OFFLINE, undefined, "online updates must override an inherited offline flag");
		assert.equal(fixture.commands[0].options.shell, false);
		assert.match(result.output, /package-manager notice/);
		assert.equal(fixture.probes.length, 2, "probe again after the command exits");
		assert.equal(fixture.invalidations(), 1);
	});
}

for (const version of ["0.70.2", "0.70.3-beta.1", undefined]) {
	test(`unsupported pi version ${version ?? "unknown"} offers manual upgrade instead of guessing a package-manager command`, async () => {
		const fixture = makeManager({ version: version ?? "" });
		await assert.rejects(fixture.manager.updatePi(), /mainExtension\.piSelfUpdateUnsupported.*0\.70\.3/);
		assert.equal(fixture.commands.length, 0);
	});
}

test("a failed release check is an error, not a successful no-update result", async () => {
	const fixture = makeManager({ checkError: new Error("connection unavailable") });
	await assert.rejects(fixture.manager.updatePi(), /mainExtension\.updateCheckFailed/);
	assert.equal(fixture.commands.length, 0);
});

test("pi version check uses Electron net.fetch so the desktop/system proxy applies", async () => {
	// 回归（v0.7.9）：版本检查曾用裸全局 fetch（undici），不读任何代理配置，
	// 代理网络下直连 pi.dev 十秒必超时（AbortError "This operation was aborted"）。
	// 沙箱未注册全局 fetch，实现只有走 electron.net.fetch 才能拿到版本号。
	const fixture = makeManager({ latestVersion: "9.9.9" });
	const result = await fixture.manager.checkPiUpdate();
	assert.equal(result.error, undefined);
	assert.equal(result.latestVersion, "9.9.9");
	assert.equal(fixture.netFetchCalls.length, 1);
	assert.equal(fixture.netFetchCalls[0][0], "https://pi.dev/api/latest-version");
});

test("a timed-out version check reports an explicit timeout instead of a bare abort", async () => {
	// hangUntilAbort 的 net.fetch 桩永不 resolve，只有 signal 中止才 reject；
	// 实现必须把无 reason 的 abort（"This operation was aborted"）转成明确超时文案。
	const fixture = makeManager({ hangUntilAbort: true });
	await assert.rejects(fixture.manager.fetchPiLatestVersion("1.0.0", 5), /timed out/i);
});

test("bun 全局安装的 pi：PiDeck 代跑 bun install -g，不再调 pi update --self", async () => {
	// 回归（2026-10 用户报障）：pi 在 Windows 上不支持 bun 自更新，`pi update --self`
	// 直接报错退出；分派器必须按可执行路径形状识别 bun 布局并代跑 bun。
	const { dirname, join } = await import("node:path");
	const bunPi = process.platform === "win32" ? String.raw`C:\Users\tester\.bun\bin\pi.exe` : "/home/tester/.bun/bin/pi";
	const expectedBun = join(dirname(bunPi), process.platform === "win32" ? "bun.exe" : "bun");
	const fixture = makeManager({ version: "1.0.0", latestVersion: "1.1.0", installedVersion: "1.1.0", command: bunPi });
	const result = await fixture.manager.updatePi();
	assert.equal(result.updated, true);
	assert.equal(fixture.commands.length, 1, "只代跑 bun，不调 pi update --self");
	assert.equal(fixture.commands[0].args[0], expectedBun);
	assert.deepEqual(fixture.commands[0].args.slice(1), ["install", "-g", "@earendil-works/pi-coding-agent@1.1.0"]);
	assert.match(result.command, /bun install -g @earendil-works\/pi-coding-agent@1\.1\.0/);
});

test("旧引导前缀副本：PiDeck 带 --prefix 代跑 npm，不再让 pi 自更新落空", async () => {
	// 回归（2026-10 用户报障）：pi 的 npm 自更新在 Windows 不推断前缀，`npm install -g`
	// 落到用户真实全局目录，前缀里的旧副本原地不动（更新成功但版本不变）；
	// 分派器必须按 pi-runtime/pi-global 路径形状识别并带 --prefix 代跑。
	const prefixPi = process.platform === "win32" ? String.raw`C:\Users\tester\AppData\Roaming\pi-desktop-dev\pi-runtime\pi-global\pi.cmd` : "/home/tester/.config/pi-desktop/pi-runtime/pi-global/bin/pi";
	const expectedPrefix = process.platform === "win32" ? String.raw`C:\Users\tester\AppData\Roaming\pi-desktop-dev\pi-runtime\pi-global` : "/home/tester/.config/pi-desktop/pi-runtime/pi-global";
	const fixture = makeManager({ version: "1.0.0", latestVersion: "1.1.0", installedVersion: "1.1.0", command: prefixPi });
	const result = await fixture.manager.updatePi();
	assert.equal(result.updated, true);
	assert.equal(fixture.commands.length, 1, "只代跑 npm，不调 pi update --self");
	assert.equal(fixture.commands[0].args[0], "npm");
	assert.deepEqual(fixture.commands[0].args.slice(1), ["install", "-g", "@earendil-works/pi-coding-agent@1.1.0", "--prefix", expectedPrefix]);
	assert.match(result.command, /npm install -g @earendil-works\/pi-coding-agent@1\.1\.0 --prefix <pi-runtime>/);
});

test("zero exit status does not count as a self-update when the selected pi remains outdated", async () => {
	const fixture = makeManager({ installedVersion: "0.80.0" });
	await assert.rejects(fixture.manager.updatePi(), /mainExtension\.piUpdateNotApplied.*0\.80\.0.*1\.0\.0/);
	assert.equal(fixture.invalidations(), 1, "invalidate stale caches even when verification fails");
});

test("self-update uses one settings snapshot for checking, execution and verification", async () => {
	const fixture = makeManager();
	const fetchVersion = fixture.manager.fetchPiLatestVersion.bind(fixture.manager);
	fixture.manager.fetchPiLatestVersion = async (...args) => {
		fixture.changeSettings({ customPiPath: "/other/pi", wslEnabled: false });
		return fetchVersion(...args);
	};
	await fixture.manager.updatePi();
	assert.equal(fixture.commands[0].args[0], "/fixture/pi");
	assert.equal(fixture.commands[0].options.env.CUSTOM_PI_PATH, "/fixture/pi");
	assert.ok(fixture.probes.every((args) => args[0] === "/fixture/pi"));
});

for (const [version, expected] of [
	["0.70.2", ["update"]],
	["0.70.3", ["update", "--extensions"]],
	["1.0.0", ["update", "--extensions", "--no-approve"]],
]) {
	test(`pi ${version} updates extensions without unsupported flags or updating pi itself`, async () => {
		const fixture = makeManager({ version });
		await fixture.manager.updateExtensions();
		assert.deepEqual(fixture.commands[0].args.slice(1), expected);
	});
}

test("extension update failures preserve bounded, credential-free diagnostics in the UI and app log", async () => {
	const fixture = makeManager({
		executionError: Object.assign(new Error("process terminated"), { killed: true, signal: "SIGTERM" }),
		stdout: "Update with the package manager that owns this installation.",
		stderr: "\u001b[31mEACCES /home/fixture-user/npm token=fixture-sensitive-token https://fixture:fixture-password@example.invalid/pkg\u001b[0m",
	});
	await assert.rejects(fixture.manager.updateExtension("npm:fixture-extension"), (error) => {
		assert.match(error.message, /mainExtension\.commandTimedOut/);
		assert.match(error.message, /EACCES/);
		assert.match(error.message, /package manager/);
		assert.ok(error.message.length < 4500);
		for (const secret of ["fixture-sensitive-token", "fixture-password", "fixture-user", "\u001b["]) assert.ok(!error.message.includes(secret));
		return true;
	});
	assert.equal(fixture.logs.length, 1);
	const logged = JSON.stringify(fixture.logs);
	assert.match(logged, /EACCES/);
	assert.ok(!logged.includes("fixture-sensitive-token"));
	assert.ok(!logged.includes("fixture-password"));
});
