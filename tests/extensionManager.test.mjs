import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/** Resolve production imports from their source directory; stub only desktop side effects. */
const loadProductionTs = createTsSandbox({
	stubs: {
		"../fs/trash": { trashPath: (path) => rm(path, { recursive: true, force: true }) },
		"../logging/sharedLogger": { getAppLogger: () => null },
		"../pi/PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
		// fetchPiLatestVersion 走 Electron net.fetch（桌面代理生效）；测试用例替换
		// globalThis.fetch 注入版本接口应答，这里只做转发。
		electron: { net: { fetch: (...args) => globalThis.fetch(...args) } },
	},
	globals: { fetch: (...args) => globalThis.fetch(...args) },
});

function loadExtensionManagerModule() {
	return loadProductionTs("src/main/extensions/ExtensionManager.ts");
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

test("checkPiUpdate uses the pi.dev release version for the self-update check", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager(
		{
			check: async () => ({ installed: true, version: "1.0.0" }),
			createInvocation: () => ({ command: "npm", args: [], shell: false }),
			createProcessEnv: () => ({}),
			warmWslCommand: async () => undefined,
		},
		() => ({}),
		undefined,
		undefined,
		() => "test error",
	);
	const originalFetch = globalThis.fetch;
	const originalResponse = globalThis.Response;
	globalThis.Response = class TestResponse {
		constructor(body, init) {
			this.body = body;
			this.status = init.status;
			this.ok = this.status >= 200 && this.status < 300;
		}
		async json() {
			return JSON.parse(this.body);
		}
	};
	globalThis.fetch = async (url) => {
		assert.equal(url, "https://pi.dev/api/latest-version");
		return new globalThis.Response(JSON.stringify({ version: "1.0.1" }), { status: 200 });
	};
	try {
		const result = await manager.checkPiUpdate();
		assert.equal(result.currentVersion, "1.0.0");
		assert.equal(result.latestVersion, "1.0.1");
		assert.equal(result.hasUpdate, true);
		assert.equal(result.error, undefined);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.Response = originalResponse;
	}
});

test("a stale lightweight extension scan cannot overwrite a newer force refresh", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager({}, () => ({}));
	const lightweight = deferred();
	const forced = deferred();

	// Isolate cache ordering from pi/npm IO. The production method is private in TypeScript,
	// but remains a normal method at runtime and is intentionally replaced only for this test.
	manager.loadList = (includeVersionInfo) => (includeVersionInfo ? forced.promise : lightweight.promise);

	const lightweightResult = manager.list(false);
	const forceResult = manager.list(true);
	const fresh = { extensions: [{ id: "fresh", source: "npm:fresh" }], raw: "fresh" };
	const stale = { extensions: [{ id: "stale", source: "npm:stale" }], raw: "stale" };

	forced.resolve(fresh);
	assert.equal(await forceResult, fresh);

	lightweight.resolve(stale);
	// 缓存命中会返回「重算过 enabled 的克隆」，所以不再做引用相等断言；行为契约是内容仍是那份新结果。
	const afterStale = await lightweightResult;
	assert.equal(afterStale.raw, "fresh");
	assert.deepEqual(
		afterStale.extensions.map((extension) => extension.id),
		["fresh"],
	);
	assert.equal((await manager.list(false)).raw, "fresh");
	assert.equal((await manager.list(true)).raw, "fresh");
});

/**
 * 以下三例在实例级钉住 loadList 的并行语义（审查建议）：上面的竞态用例整体打桩了
 * loadList，守护不到包装层内部的并发结构。这里只打桩两个源（runPi / scanLocalExtensions），
 * 让真实 loadList 跑完；两源用 deferred 完全由测试控制结算时刻，不依赖真实计时与执行顺序。
 */
const PI_LIST_OUTPUT = ["User packages:", "  npm:aaa", "    C:\\ext\\aaa"].join("\n");
const LOCAL_SCAN_ROWS = [{ id: "local:zzz.ts", source: "zzz.ts", path: "P:\\ext\\zzz.ts", scope: "user" }];

test("loadList starts the pi process list and the local directory scan concurrently", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager({}, () => ({}));
	const piDeferred = deferred();
	const scanDeferred = deferred();
	const startOrder = [];
	manager.runPi = () => {
		startOrder.push("pi");
		return piDeferred.promise;
	};
	manager.scanLocalExtensions = () => {
		startOrder.push("scan");
		return scanDeferred.promise;
	};

	const pending = manager.list(false);
	// list() 同步驱动 loadList 到 Promise.all 才让出：两个源在第一次 await 之前都已启动。
	// 若退回「先 await runPi、再 await scanLocalExtensions」的串行写法，此刻只有 ["pi"]。
	assert.deepEqual(startOrder, ["pi", "scan"]);

	scanDeferred.resolve(LOCAL_SCAN_ROWS);
	piDeferred.resolve(PI_LIST_OUTPUT);
	const result = await pending;
	const sources = result.extensions.map((extension) => extension.source);
	assert.ok(sources.includes("npm:aaa"));
	assert.ok(sources.includes("zzz.ts"));
});

test("loadList returns identical rows no matter which source settles first", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();

	const collectRows = async (firstSettled) => {
		const manager = new ExtensionManager({}, () => ({}));
		const piDeferred = deferred();
		const scanDeferred = deferred();
		manager.runPi = () => piDeferred.promise;
		manager.scanLocalExtensions = () => scanDeferred.promise;
		const pending = manager.list(false);
		// deferred 显式控制结算顺序：先让一个源完全落地，再结算另一个；不靠真实计时。
		if (firstSettled === "pi") {
			piDeferred.resolve(PI_LIST_OUTPUT);
			await piDeferred.promise;
			scanDeferred.resolve(LOCAL_SCAN_ROWS);
		} else {
			scanDeferred.resolve(LOCAL_SCAN_ROWS);
			await scanDeferred.promise;
			piDeferred.resolve(PI_LIST_OUTPUT);
		}
		const result = await pending;
		// 展开拷回主 realm：vm 沙箱产出的数组带沙箱原型，deepStrictEqual 跨原型必败。
		return [...result.extensions.map((extension) => [extension.id, extension.source, extension.path ?? null, extension.scope])];
	};

	const piFirst = await collectRows("pi");
	const scanFirst = await collectRows("scan");
	// 合并规则（pi 条目在前、本地条目在后、内置兜底补齐）与两源结算顺序解耦：逐元素一致。
	assert.deepEqual(scanFirst, piFirst);
	assert.deepEqual(piFirst.slice(0, 2), [
		["user:npm:aaa", "npm:aaa", "C:\\ext\\aaa", "user"],
		["local:zzz.ts", "zzz.ts", "P:\\ext\\zzz.ts", "user"],
	]);
});

test("list propagates the first rejected source and never leaks the late rejection as unhandledRejection", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		// 两个拒绝方向都验证：先拒绝的源决定 list() 的拒绝原因；另一源迟到的拒绝必须被
		// Promise.all 挂上的处理函数吸收，不得逃逸成 unhandledRejection。
		for (const firstRejection of ["scan", "pi"]) {
			const manager = new ExtensionManager({}, () => ({}));
			const piDeferred = deferred();
			const scanDeferred = deferred();
			manager.runPi = () => piDeferred.promise;
			manager.scanLocalExtensions = () => scanDeferred.promise;
			const pending = manager.list(false);
			if (firstRejection === "scan") {
				scanDeferred.reject(new Error("scan-boom"));
				await assert.rejects(pending, /scan-boom/);
				piDeferred.reject(new Error("pi-late-boom"));
			} else {
				piDeferred.reject(new Error("pi-boom"));
				await assert.rejects(pending, /pi-boom/);
				scanDeferred.reject(new Error("scan-late-boom"));
			}
			// 让事件循环跑到未处理拒绝检测点：真有逃逸时 process 事件已在此之前触发。
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.deepEqual(unhandled, [], `late rejection leaked as unhandledRejection: ${unhandled.map((reason) => String(reason)).join("; ")}`);
		}
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("cached list re-runs the enabled projection so a toggle shows up without a rescan", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const settings = { disabledExtensions: [] };
	const manager = new ExtensionManager({}, () => settings);
	let scanCount = 0;
	manager.runPi = async () => {
		scanCount += 1;
		return "User packages:\n  npm:demo\n    C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\demo\n";
	};

	const first = await manager.list(false);
	assert.equal(first.extensions.find((extension) => extension.source === "npm:demo")?.enabled, true);

	// 开关写盘后主进程会刷新投影快照，但缓存里的 enabled 是上次扫描时算好的：
	// 缓存命中必须重算，否则刷新链条会把刚点开的开关抬回旧值。
	settings.disabledExtensions = [{ scope: "user", source: "npm:demo" }];
	const second = await manager.list(false);
	assert.equal(second.extensions.find((extension) => extension.source === "npm:demo")?.enabled, false);
	assert.equal(scanCount, 1, "缓存命中不应再跑一次 pi list");
	assert.equal(first.extensions.find((extension) => extension.source === "npm:demo")?.enabled, true, "返回的是克隆，不污染已发出的快照");
});

test("parseListOutput strips the pi list (filtered) suffix so uninstall/update use a clean source", () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager({}, () => ({}));

	const raw = ["User packages:", "  npm:pi-web-access", "    C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\pi-web-access", "  npm:@adrianapan/pikit (filtered)", "    C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\@adrianapan\\pikit"].join("\n");

	const parsed = manager.parseListOutput(raw);
	const pikit = parsed.find((ext) => ext.source.includes("pikit"));

	// source 必须是干净的 npm source：卸载（pi remove）与更新（pi update / npm view）都依赖它
	assert.equal(pikit.source, "npm:@adrianapan/pikit");
	assert.equal(pikit.filtered, true);
	assert.equal(pikit.id, "user:npm:@adrianapan/pikit");
	// 路径行照常解析，不受后缀影响
	assert.equal(pikit.path, "C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\@adrianapan\\pikit");
});

test("parseListOutput leaves plain package sources untouched", () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager({}, () => ({}));

	const raw = ["User packages:", "  npm:pi-web-access", "    C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\pi-web-access"].join("\n");

	const parsed = manager.parseListOutput(raw);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].source, "npm:pi-web-access");
	assert.equal(parsed[0].filtered, undefined);
});

test("list discovers local js, index.js, and package-manifest extensions once per root", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const home = await mkdtemp(join(tmpdir(), "pideck-extension-discovery-"));
	try {
		const extensionsDir = join(home, ".pi", "agent", "extensions");
		await mkdir(join(extensionsDir, "index-package"), { recursive: true });
		await mkdir(join(extensionsDir, "manifest-package", "dist"), { recursive: true });
		await mkdir(join(extensionsDir, "fallback-package"), { recursive: true });
		await mkdir(join(extensionsDir, "ignored-directory"), { recursive: true });
		await writeFile(join(extensionsDir, "plain.js"), "module.exports = {};", "utf8");
		await writeFile(join(extensionsDir, "index-package", "index.js"), "module.exports = {};", "utf8");
		await writeFile(join(extensionsDir, "manifest-package", "package.json"), JSON.stringify({ pi: { extensions: ["dist/first.js", "dist/second.ts"] } }), "utf8");
		await writeFile(join(extensionsDir, "manifest-package", "dist", "first.js"), "module.exports = {};", "utf8");
		await writeFile(join(extensionsDir, "manifest-package", "dist", "second.ts"), "export default {};", "utf8");
		await writeFile(join(extensionsDir, "fallback-package", "package.json"), JSON.stringify({ pi: { extensions: ["missing.js"] } }), "utf8");
		await writeFile(join(extensionsDir, "fallback-package", "index.js"), "module.exports = {};", "utf8");
		await writeFile(join(extensionsDir, "ignored-directory", "README.md"), "not an extension", "utf8");

		const manager = new ExtensionManager({}, () => ({}));
		manager.configureWsl({ windowsHome: home });
		manager.runPi = async () => "User packages:\n";
		const result = await manager.list(false);
		const local = result.extensions.filter((extension) => extension.id.startsWith("local:"));
		const bySource = new Map(local.map((extension) => [extension.source, extension]));

		assert.equal(bySource.get("plain.js")?.path, join(extensionsDir, "plain.js"));
		assert.equal(bySource.get("index-package")?.path, join(extensionsDir, "index-package"));
		assert.equal(bySource.get("manifest-package")?.path, join(extensionsDir, "manifest-package"));
		assert.equal(bySource.get("fallback-package")?.path, join(extensionsDir, "fallback-package"));
		assert.equal(local.filter((extension) => extension.source === "manifest-package").length, 1);
		assert.equal(bySource.has("ignored-directory"), false);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("uninstall removes a local extension and clears its stale disable entry", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const home = await mkdtemp(join(tmpdir(), "pideck-extension-manager-"));
	try {
		const extensionsDir = join(home, ".pi", "agent", "extensions");
		const settingsPath = join(home, ".pi", "agent", "settings.json");
		await mkdir(extensionsDir, { recursive: true });
		await writeFile(join(extensionsDir, "local-tool.ts"), "export default {};", "utf8");
		await writeFile(settingsPath, JSON.stringify({ disabledExtensions: ["local-tool.ts", "other.ts"] }), "utf8");

		// 拆分后构造签名：(locator, getSettings, getPiDeckSettings, patchPiDeckSettings, translate)
		const manager = new ExtensionManager(
			{},
			() => ({}),
			() => ({}),
			async () => ({}),
			(key) => (key === "mainExtension.invalidPath" ? "Invalid extension path." : key),
		);
		manager.wslEnvironment = { windowsHome: home };
		await manager.uninstall("local-tool.ts");

		await assert.rejects(readFile(join(extensionsDir, "local-tool.ts"), "utf8"), { code: "ENOENT" });
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.deepEqual(settings.disabledExtensions, ["other.ts"]);
		await assert.rejects(manager.uninstall("../outside.ts"), /Invalid extension path/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("uninstall allows pi-deck-* local files outside the built-in whitelist (plugin-dev demo)", async () => {
	// demo（pi-deck-demo-plugin.ts）不在内置白名单：普通本地扩展，卸载必须走
	// 删文件路径；旧代码按 pi-deck- 前缀一律拦成「内置扩展不可卸载」，demo 行
	// 的卸载按钮直接报错。白名单成员（真内置）仍拒绝——内置行的卸载语义由
	// removeBuiltIn（标记 removed + 删文件）承担，不能混用普通卸载路径。
	const { ExtensionManager } = loadExtensionManagerModule();
	const home = await mkdtemp(join(tmpdir(), "pideck-extension-manager-demo-uninstall-"));
	try {
		const extensionsDir = join(home, ".pi", "agent", "extensions");
		await mkdir(extensionsDir, { recursive: true });
		await writeFile(join(extensionsDir, "pi-deck-demo-plugin.ts"), "export default {};", "utf8");
		const manager = new ExtensionManager(
			{},
			() => ({}),
			() => ({}),
			async () => ({}),
			(key) => key,
		);
		manager.wslEnvironment = { windowsHome: home };
		await manager.uninstall("pi-deck-demo-plugin.ts");
		await assert.rejects(readFile(join(extensionsDir, "pi-deck-demo-plugin.ts"), "utf8"), { code: "ENOENT" });
		await assert.rejects(manager.uninstall("pi-deck-todo.ts"), /builtInCannotUninstall/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("npmViewVersion 复用 pi settings.json 的 npmCommand（#318/#263）", async () => {
	const home = await mkdtemp(join(tmpdir(), "pideck-extmgr-npmcmd-"));
	try {
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ npmCommand: ["pnpm", "exec", "npm"] }));
		let captured;
		// 独立 sandbox：node:os/node:child_process 仅在本用例内 stub，不污染共享 loader
		const load = createTsSandbox({
			stubs: {
				"node:os": { homedir: () => home },
				"node:child_process": {
					execFile: (command, args, _options, callback) => {
						captured = { command: String(command), args: [...args] };
						queueMicrotask(() => callback(null, "9.9.9\n", ""));
					},
				},
				"../logging/sharedLogger": { getAppLogger: () => null },
				"../pi/PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
			},
		});
		const { ExtensionManager } = load("src/main/extensions/ExtensionManager.ts");
		const manager = new ExtensionManager(
			{
				check: async () => ({ installed: true, version: "1.0.0" }),
				createInvocation: (command, args) => ({ command, args, shell: false }),
				createProcessEnv: () => ({}),
				warmWslCommand: async () => undefined,
			},
			() => ({}),
		);
		const version = await manager.npmViewVersion("context-mode");
		assert.equal(version, "9.9.9");
		assert.equal(captured.command, "pnpm", "应使用配置的包装命令而非裸 npm");
		// VM 跨 realm 数组：用 JSON 文本比较
		assert.equal(JSON.stringify(captured.args), JSON.stringify(["exec", "npm", "view", "context-mode", "version"]));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("npmViewVersion 未配置 npmCommand 时回落裸 npm（行为不变）", async () => {
	const home = await mkdtemp(join(tmpdir(), "pideck-extmgr-npmcmd-default-"));
	try {
		let captured;
		const load = createTsSandbox({
			stubs: {
				"node:os": { homedir: () => home },
				"node:child_process": {
					execFile: (command, args, _options, callback) => {
						captured = { command: String(command), args: [...args] };
						queueMicrotask(() => callback(null, "1.0.0\n", ""));
					},
				},
				"../logging/sharedLogger": { getAppLogger: () => null },
				"../pi/PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
			},
		});
		const { ExtensionManager } = load("src/main/extensions/ExtensionManager.ts");
		const manager = new ExtensionManager(
			{
				createInvocation: (command, args) => ({ command, args, shell: false }),
				createProcessEnv: () => ({}),
			},
			() => ({}),
		);
		await manager.npmViewVersion("context-mode");
		assert.equal(captured.command, "npm");
		assert.equal(JSON.stringify(captured.args), JSON.stringify(["view", "context-mode", "version"]));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("扩展开关保留列表缓存：开关后的刷新零重扫描，开关值仍立刻可见", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const settings = { disabledExtensions: [] };
	const manager = new ExtensionManager({}, () => settings);
	let scanCount = 0;
	manager.runPi = async () => {
		scanCount += 1;
		return "User packages:\n  npm:demo\n    C:\Users\demo\.pi\agent\npm\node_modules\demo\n";
	};
	// 模拟 pi settings.json 的包级过滤规则作为原生真值
	let nativeEnabled = true;
	manager.configureNativeEnabledReader((extension) => (extension.source === "npm:demo" ? { enabled: nativeEnabled } : undefined));
	manager.configureNativeToggle(async ({ enabled }) => {
		nativeEnabled = enabled;
		return { ok: true };
	});

	assert.equal((await manager.list(false)).extensions.find((extension) => extension.source === "npm:demo")?.enabled, true);
	await manager.setEnabled("npm:demo", false);

	// 开关只改 enabled：缓存命中路径会重算投影，因此不能清缓存——
	// 清缓存会让跟随开关的刷新白等一次 `pi list` 全量扫描（开关行长时间 pending）。
	const after = await manager.list(false);
	assert.equal(scanCount, 1, "开关不应让列表缓存失效");
	assert.equal(after.extensions.find((extension) => extension.source === "npm:demo")?.enabled, false, "缓存命中仍要重算 enabled");
});

test("开关后的轻量投影同时刷新过滤式安装标记（缓存不得残留旧 filtered）", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const settings = { disabledExtensions: [] };
	const manager = new ExtensionManager({}, () => settings);
	let scanCount = 0;
	manager.runPi = async () => {
		scanCount += 1;
		// 首次扫描时条目是对象形态（整包停用也是对象），pi list 会打上 (filtered)
		return "User packages:\n  npm:demo (filtered)\n    C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\demo\n";
	};
	let nativeFiltered = true;
	manager.configureNativeEnabledReader((extension) => (extension.source === "npm:demo" ? { enabled: true, filtered: nativeFiltered } : undefined));
	manager.configureNativeToggle(async () => ({ ok: true }));

	const first = await manager.list(false);
	assert.equal(first.extensions.find((extension) => extension.source === "npm:demo")?.filtered, true);

	// 启用后条目已折回纯字符串；pi list 不再标 filtered，但列表缓存还是旧快照
	nativeFiltered = false;
	await manager.setEnabled("npm:demo", true);
	const after = await manager.list(false);
	assert.equal(scanCount, 1, "轻量刷新不应重扫描");
	assert.equal(after.extensions.find((extension) => extension.source === "npm:demo")?.filtered, false, "缓存命中路径必须按原生条目重算 filtered，否则「过滤式安装」徽标会残留");
});

/**
 * 接线回归（任务 3 审查建议）：跑真实 loadList(true) 全链路——runPi 喂 `pi list` 假输出、
 * scanLocalExtensions 喂本地行，registry 基址由 execFile 替身应答 `npm config get registry`，
 * packument 经 globalThis.fetch 替身供给（npmRegistryVersion 默认 fetchImpl 即 globalThis.fetch）。
 * 其余用例要么整体打桩 loadList，要么只打桩两源且走 includeVersionInfo=false，守护不到
 * ExtensionManager 里 resolver 创建与 enrichExtensionVersion 调用点的接线；本用例把
 * 「latestVersion 来自 registry 快路 + 请求带 corgi Accept 头」固化成永久回归。
 */
test("list(true) 的 latestVersion 来自 registry 快路解析值，请求带 corgi Accept 头", async () => {
	const home = await mkdtemp(join(tmpdir(), "pideck-extmgr-registry-wiring-"));
	const originalFetch = globalThis.fetch;
	const fetchCalls = [];
	const npmCalls = [];
	try {
		// 真实 installed package.json：readInstalledVersion 真读盘，currentVersion 不靠打桩。
		const installedDir = join(home, "npm", "node_modules", "context-mode");
		await mkdir(installedDir, { recursive: true });
		await writeFile(join(installedDir, "package.json"), JSON.stringify({ name: "context-mode", version: "1.0.0" }), "utf8");
		const raw = ["User packages:", "  npm:context-mode", `    ${installedDir}`].join("\n");

		// 独立 sandbox：node:os / node:child_process 只在本用例内替身，不污染共享 loader。
		const load = createTsSandbox({
			stubs: {
				"node:os": { homedir: () => home },
				"node:child_process": {
					execFile: (command, args, _options, callback) => {
						npmCalls.push({ command: String(command), args: [...args] });
						// config get registry 供基址解析；view 只在快路失败回退时才应出现。
						const stdout = args.includes("registry") ? "https://registry.npmjs.org/\n" : "9.9.9\n";
						queueMicrotask(() => callback(null, stdout, ""));
					},
				},
				"../fs/trash": { trashPath: (path) => rm(path, { recursive: true, force: true }) },
				"../logging/sharedLogger": { getAppLogger: () => null },
				"../pi/PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
			},
			// 沙箱内 globalThis.fetch 转发到宿主全局：用例替换宿主 globalThis.fetch 即完成注入，
			// 不必给生产代码增加仅供测试的注入点。
			globals: { fetch: (...args) => globalThis.fetch(...args) },
		});
		const { ExtensionManager } = load("src/main/extensions/ExtensionManager.ts");
		const manager = new ExtensionManager({ createInvocation: (command, args) => ({ command, args, shell: false }), createProcessEnv: () => ({}) }, () => ({}));
		manager.runPi = async () => raw;
		manager.scanLocalExtensions = async () => LOCAL_SCAN_ROWS;

		globalThis.fetch = async (url, init) => {
			fetchCalls.push({ url, init });
			const buffer = Buffer.from(JSON.stringify({ "dist-tags": { latest: "2.5.0" } }), "utf8");
			return {
				ok: true,
				status: 200,
				body: {
					getReader() {
						let sent = false;
						return {
							async read() {
								if (sent) return { done: true, value: undefined };
								sent = true;
								return { done: false, value: buffer };
							},
							async cancel() {},
						};
					},
				},
			};
		};

		const result = await manager.list(true);
		const row = result.extensions.find((extension) => extension.source === "npm:context-mode");
		assert.ok(row, "npm:context-mode 行必须出现在列表里");
		// 快路解析值落到列表行：回退值 9.9.9 或缺失（undefined）都必须让本断言失败。
		assert.equal(row.latestVersion, "2.5.0");
		assert.equal(row.currentVersion, "1.0.0");
		assert.equal(row.hasUpdate, true);
		// 本地扫描行仍参与合并，证明接线没有挤掉并行扫描的结果。
		assert.ok(result.extensions.some((extension) => extension.source === "zzz.ts"));

		assert.equal(fetchCalls.length, 1);
		assert.equal(fetchCalls[0].url, "https://registry.npmjs.org/context-mode");
		assert.equal(fetchCalls[0].init.headers.Accept, "application/vnd.npm.install-v1+json");
		assert.ok(fetchCalls[0].init.signal, "快路请求必须挂 AbortSignal，超时才能中断挂起的请求");
		assert.deepEqual(
			npmCalls.map((call) => call.args.join(" ")),
			["config get registry"],
			"快路命中后不得再 spawn npm view",
		);
	} finally {
		globalThis.fetch = originalFetch;
		await rm(home, { recursive: true, force: true });
	}
});
