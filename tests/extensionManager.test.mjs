import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { createBunLayout } from "./helpers/bunLayout.mjs";

/** Resolve production imports from their source directory; stub only desktop side effects. */
const loadProductionTs = createTsSandbox({
	stubs: {
		"../fs/trash": { trashPath: (path) => rm(path, { recursive: true, force: true }) },
		"../logging/sharedLogger": { getAppLogger: () => null },
		"../pi/PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
		"./PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
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

/**
 * 更新失败提示（回归 issue 反馈：用户只看到「Pi 扩展命令执行失败，请重试。」+ 裸 npm ETARGET，
 * 误以为是 PiDeck 的 bug）。根因是 pi.dev 已宣布新版本、而用户配置的 npm 镜像尚未同步。
 * 用真实 updatePi 链路断言：命中特征时补提示，其余失败原样透传。
 */
function createUpdatePiManager(command, translate) {
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager({ check: async () => assert.fail("update failure must rethrow before the post-update version probe") }, () => ({}), undefined, undefined, translate);
	// 钉住检查结果，避免本用例触发网络；runPi 只承担「模拟失败退出」这一件事。
	manager.selfUpdate.check = async () => ({ hasUpdate: true, currentVersion: "1.1.0", latestVersion: "1.2.0", command });
	return manager;
}

test("updatePi explains missing-version failures as an unsynced package registry", async () => {
	const translateCalls = [];
	const manager = createUpdatePiManager("/usr/local/bin/pi", (key, params) => {
		translateCalls.push({ key, params });
		return `${key}|${JSON.stringify(params ?? {})}`;
	});
	manager.runPi = async () => {
		throw new Error(["Pi 扩展命令执行失败，请重试。", "npm error code ETARGET", "npm error notarget No matching version found for @earendil-works/pi-coding-agent@1.2.0."].join("\n"));
	};

	await assert.rejects(manager.updatePi(), (error) => {
		assert.match(error.message, /npm error code ETARGET/);
		assert.match(error.message, /mainExtension\.piUpdateRegistryLagHintManual/);
		assert.match(error.message, /https:\/\/registry\.npmjs\.org/);
		// pi-self 通道里可能是 pnpm/yarn/brew/managed/WSL：绝不能提示 npm 全局安装（那会在别的目录又装一个 pi）。
		assert.equal(error.message.includes("npm install -g"), false);
		return true;
	});
	assert.equal(translateCalls.length, 1);
	assert.equal(translateCalls[0].key, "mainExtension.piUpdateRegistryLagHintManual");
	// 逐字段断言：translateCalls 的元素来自 vm 沙箱 realm，deepStrictEqual 会因原型不同而失败。
	assert.equal(translateCalls[0].params.version, "1.2.0");
	assert.equal(translateCalls[0].params.registry, "https://registry.npmjs.org");
	assert.equal(translateCalls[0].params.command, undefined);
});

test("WSL 形态的命令不会被当成宿主 bun/npm 通道（否则会把 pi 装到 Windows 宿主机）", async () => {
	// 回归（2026-10 评审）：PiLocator.check 对 WSL 返回的是空格拼接的召唤命令
	// （`wsl -d <distro> -u <user> <linux pi 路径>`），不是 `wsl://` 标记；它若落进 bun 推导，
	// 推导出的 bun 在宿主上不存在 → 回退裸 `bun` → 在 Windows 上又装一份 pi，选中的 WSL 安装原地不动。
	const manager = createUpdatePiManager("wsl -d Ubuntu-24.04 -u dev /home/dev/.bun/bin/pi", (key) => key);
	const hostPackages = [];
	manager.selfUpdate.runBunGlobalUpdate = async () => {
		hostPackages.push("bun");
		throw new Error("宿主包管理器不得运行");
	};
	manager.selfUpdate.runNpmPrefixUpdate = async () => {
		hostPackages.push("npm");
		throw new Error("宿主包管理器不得运行");
	};
	const piCommands = [];
	manager.runPi = async (args) => {
		piCommands.push(args.join(" "));
		return "updated";
	};
	// 成功路径需更新后的版本探测：替掉 helper 里那个「失败必须早于校验」的断言桩。
	manager.selfUpdate.locator = { check: async () => ({ installed: true, version: "1.2.0" }) };

	const result = await manager.updatePi();
	assert.equal(result.updated, true);
	assert.equal(hostPackages.length, 0, "WSL 目标必须交回 pi 自更新");
	assert.equal(piCommands.join("|"), "update --self");
});

test("updatePi keeps unrelated failures verbatim (no registry hint)", async () => {
	const manager = createUpdatePiManager("/usr/local/bin/pi", (key) => key);
	manager.runPi = async () => {
		throw new Error(["Pi 扩展命令执行失败，请重试。", "npm error code EACCES", "npm error syscall mkdir"].join("\n"));
	};

	await assert.rejects(manager.updatePi(), (error) => {
		assert.match(error.message, /npm error code EACCES/);
		assert.equal(error.message.includes("piUpdateRegistryLagHint"), false);
		return true;
	});
});

test("updatePi registry hint keeps the --prefix of the portable install", async () => {
	const prefixDir = "/home/u/.config/PiDeck/pi-runtime/pi-global";
	const manager = createUpdatePiManager(`${prefixDir}/bin/pi`, (key, params) => `${key}|${params?.command ?? ""}`);
	// 前缀通道由 PiDeck 代跑 npm：替换真实子进程调用，只留「抛 ETARGET」这一步。
	manager.selfUpdate.runNpmPrefixUpdate = async () => {
		throw new Error("npm error code ETARGET\nnpm error notarget No matching version found for @earendil-works/pi-coding-agent@1.2.0.");
	};

	await assert.rejects(manager.updatePi(), (error) => {
		// 提示的命令必须与代跑同源（同样的 flags + --prefix，另加官方源），否则用户粘一条跑不通的命令。
		assert.ok(error.message.includes(`install -g --ignore-scripts --min-release-age=0 @earendil-works/pi-coding-agent@1.2.0 --prefix "${prefixDir}" --registry=https://registry.npmjs.org`), error.message);
		// 作用域源会压过 --registry：提示必须把 @earendil-works 的作用域源也指回官方源。
		assert.ok(error.message.includes("--@earendil-works:registry=https://registry.npmjs.org"), error.message);
		return true;
	});
});

test("updatePi registry hint also covers the bun install channel", async () => {
	const manager = createUpdatePiManager("/home/u/.bun/bin/pi", (key, params) => `${key}|${params?.command ?? ""}`);
	// bun 源缺版本的文案（全版本对齐 oven-sh/bun 源码：No version matching "x" found for specifier "y"）。
	manager.selfUpdate.runBunGlobalUpdate = async () => {
		throw new Error('error: No version matching "1.2.0" found for specifier "@earendil-works/pi-coding-agent"  (but package exists)');
	};

	await assert.rejects(manager.updatePi(), (error) => {
		assert.match(error.message, /No version matching/);
		assert.match(error.message, /mainExtension\.piUpdateRegistryLagHint/);
		assert.ok(error.message.includes("bun install -g --ignore-scripts @earendil-works/pi-coding-agent@1.2.0 --registry=https://registry.npmjs.org"), error.message);
		return true;
	});
});

test("updatePi 把发布年龄门失败转成放宽年龄门的提示（不误报镜像未同步）", async () => {
	const manager = createUpdatePiManager("/home/u/.bun/bin/pi", (key) => key);
	// 实测文案（bun 1.4.3）：No version matching "<pkg>" found for specifier "<ver>" (blocked by minimum-release-age: N seconds)
	manager.selfUpdate.runBunGlobalUpdate = async () => {
		throw new Error('error: No version matching "@earendil-works/pi-coding-agent" found for specifier "1.2.0" (blocked by minimum-release-age: 259200 seconds)');
	};

	await assert.rejects(manager.updatePi(), (error) => {
		assert.match(error.message, /blocked by minimum-release-age/);
		assert.match(error.message, /mainExtension\.piUpdateReleaseAgeHint/);
		assert.equal(error.message.includes("piUpdateRegistryLagHint"), false);
		return true;
	});
});

test("updatePi 也认 npm 的年龄门文案（with a date before），同样给放宽提示", async () => {
	const manager = createUpdatePiManager("/usr/local/bin/pi", (key) => key);
	manager.runPi = async () => {
		throw new Error("npm error code ETARGET\nnpm error notarget No matching version found for @earendil-works/pi-coding-agent@1.2.0 with a date before 2026-10-10T00:00:00.000Z.");
	};

	await assert.rejects(manager.updatePi(), (error) => {
		assert.match(error.message, /mainExtension\.piUpdateReleaseAgeHint/);
		assert.equal(error.message.includes("piUpdateRegistryLagHint"), false);
		return true;
	});
});

test("bun 代跑参数与 pi 自身 bun 分支对齐，年龄门开关按 bun 版本条件注入", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager({}, () => ({}));
	const versions = { "BUN_1_2/bun": "1.2.21", "BUN_1_3_0/bun": "1.3.0" };
	const installs = [];
	manager.selfUpdate.runPackageInstall = (command, args, _timeoutMs, env) => {
		if (args[0] === "--version") return Promise.resolve(`${versions[command] ?? "1.3.5"}\n`);
		installs.push({ command, args: args.join(" "), env });
		return Promise.resolve("installed");
	};

	assert.equal(await manager.selfUpdate.runBunGlobalUpdate("BUN_1_3/bun", "1.2.0", undefined, "/opt/oven"), "installed");
	assert.equal(await manager.selfUpdate.runBunGlobalUpdate("BUN_1_2/bun", "1.2.0", undefined), "installed");
	assert.equal(await manager.selfUpdate.runBunGlobalUpdate("BUN_1_3_0/bun", "1.2.0", undefined), "installed");
	// bun ≥ 1.3：带上年龄门开关（不带的话配了 bunfig 发布年龄门的机器上 bun 会自己拦下新版本），边界 1.3.0 也算支持。
	assert.equal(installs[0].args, "install -g --ignore-scripts --minimum-release-age=0 @earendil-works/pi-coding-agent@1.2.0");
	assert.equal(installs[2].args, "install -g --ignore-scripts --minimum-release-age=0 @earendil-works/pi-coding-agent@1.2.0");
	// bun < 1.3 没有这个开关：不能把它当已知参数发过去（未知参数会被拒绝，反而弄坏本来能成功的更新）。
	assert.equal(installs[1].args, "install -g --ignore-scripts @earendil-works/pi-coding-agent@1.2.0");
	// 自定义安装根要作为 BUN_INSTALL 传给子进程：GUI 启动读不到 shell rc，不传会把包装进默认 ~/.bun。
	assert.equal(installs[0].env.BUN_INSTALL, "/opt/oven");
	assert.equal(installs[1].env, undefined);
});

test("bun 版本探测失败时不注入年龄门开关（探测不得阻塞安装主流程）", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager({}, () => ({}));
	const installs = [];
	manager.selfUpdate.runPackageInstall = (command, args) => {
		if (args[0] === "--version") return Promise.reject(new Error("spawn bun ENOENT"));
		installs.push(args.join(" "));
		return Promise.resolve("installed");
	};

	assert.equal(await manager.selfUpdate.runBunGlobalUpdate("bun", "1.2.0", "@earendil-works/pi-coding-agent"), "installed");
	assert.equal(installs.length, 1);
	assert.equal(installs[0], "install -g --ignore-scripts @earendil-works/pi-coding-agent@1.2.0");
});

test("旧引导前缀代跑也带 pi 自身 npm 分支的脚本隔离与年龄门开关", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager({}, () => ({}));
	const installs = [];
	manager.selfUpdate.runPackageInstall = (command, args) => {
		installs.push({ command, args: args.join(" ") });
		return Promise.resolve("installed");
	};

	assert.equal(await manager.selfUpdate.runNpmPrefixUpdate("/home/u/.config/PiDeck/pi-runtime/pi-global", "1.2.0", undefined), "installed");
	assert.equal(installs.length, 1);
	assert.ok(installs[0].args.startsWith("install -g --ignore-scripts --min-release-age=0 @earendil-works/pi-coding-agent@1.2.0 --prefix "), installs[0].args);
	assert.ok(installs[0].args.endsWith("/home/u/.config/PiDeck/pi-runtime/pi-global"), installs[0].args);
});

test("pickBunCommand：只有本地绝对路径才允许退回裸 bun（包装命令串宁可响亮失败）", () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager({}, () => ({}));
	// WSL 召唤串之类的包装命令退回裸 `bun` = 拿宿主 bun 去装 pi、装错机器；必须原样返回让它 ENOENT。
	const wrapped = "wsl -d Ubuntu-24.04 -u dev /home/dev/.bun/bin/bun";
	assert.equal(manager.selfUpdate.pickBunCommand(wrapped), wrapped);
	// 裸命令名原样交给 PATH。
	assert.equal(manager.selfUpdate.pickBunCommand("bun"), "bun");
});

test("bun 候选探测看盘：命中候选就用绝对路径，全都不存在才回退裸 bun（fs 桩隔离环境）", () => {
	// 候选列表包含 /usr/local/bin、~/.bun/bin 等真实位置：用可切换的 fs 桩隔离开发机环境，
	// 先只让一个 home 下候选「存在」（探测循环必须是活的，删掉循环断言就会红），再全部抽空。
	let existing = new Set();
	const load = createTsSandbox({
		stubs: {
			"node:fs": { existsSync: (path) => existing.has(String(path)) },
			"../fs/trash": { trashPath: async () => {} },
			"../logging/sharedLogger": { getAppLogger: () => null },
			"../pi/PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
			"./PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
		},
	});
	const { ExtensionManager } = load("src/main/extensions/ExtensionManager.ts");
	const manager = new ExtensionManager({}, () => ({}));
	const bunName = process.platform === "win32" ? "bun.exe" : "bun";
	const candidate = join(homedir(), ".linuxbrew", "bin", bunName);
	existing = new Set([candidate]);
	assert.equal(manager.selfUpdate.pickBunCommand(join("/tmp/nowhere/.bun/bin", bunName)), candidate);
	existing = new Set();
	assert.equal(manager.selfUpdate.pickBunCommand(join("/tmp/nowhere/.bun/bin", bunName)), "bun");
});

test("自定义 BUN_INSTALL 的 shim（<root>/bin/pi + <root>/install/global）按 bun 通道代跑", async () => {
	// 回归（2026-10 评审）：这类路径靠形状无法与普通全局安装区分；不细化的话 Windows 上只能落到
	// pi 自身的 gate（“Update pi manually”）。
	const root = await mkdtemp(join(tmpdir(), "pideck-bun-custom-"));
	try {
		await mkdir(join(root, "bin"), { recursive: true });
		await mkdir(join(root, "install", "global", "node_modules"), { recursive: true });
		const piPath = join(root, "bin", process.platform === "win32" ? "pi.exe" : "pi");
		await writeFile(piPath, "", "utf8");
		const manager = createUpdatePiManager(piPath, (key) => key);
		const calls = [];
		manager.selfUpdate.runBunGlobalUpdate = async (command, _version, _packageName, installRoot) => {
			calls.push({ command, installRoot });
			throw new Error("stop after capture");
		};

		await assert.rejects(manager.updatePi(), /stop after capture/);
		assert.equal(calls.length, 1, "必须走 bun 通道代跑");
		// 安装根要作为 BUN_INSTALL 传给 bun：自定义根自动推断，不靠用户 shell rc。
		assert.equal(calls[0].installRoot, root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("bun 本体不在 $BUN_INSTALL/bin 时按已知位置探测（linuxbrew/nix 不再 ENOENT）", async () => {
	// 回归：Homebrew/nix 装的 bun 本体不在 `~/.bun/bin`（那里只有 shim），Linux 的 linuxbrew/nix
	// 不在 PiLocator 硬编码目录里，只有裸 `bun` 回退时会 ENOENT。真实目录 fixture：只造 nix profile 里的 bun。
	const home = await mkdtemp(join(tmpdir(), "pideck-bun-home-"));
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager({}, () => ({}));
	try {
		const binDir = join(home, ".nix-profile", "bin");
		await mkdir(binDir, { recursive: true });
		const bunName = process.platform === "win32" ? "bun.exe" : "bun";
		const bunPath = join(binDir, bunName);
		await writeFile(bunPath, "", "utf8");
		// configureWsl 只是把 home（windowsHome）指到 fixture：home 下候选排在系统目录之前，
		// 探测结果与开发机装了什么无关。
		manager.configureWsl({ windowsHome: home });
		assert.equal(manager.selfUpdate.pickBunCommand(join(home, ".bun", "bin", bunName)), bunPath);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("推导出的 bun 存在时用绝对路径（不依赖 GUI 进程的 PATH）", async () => {
	const layout = await createBunLayout({ withBun: true });
	try {
		const manager = createUpdatePiManager(layout.piPath, (key) => key);
		const calls = [];
		manager.selfUpdate.runBunGlobalUpdate = async (command) => {
			calls.push(command);
			throw new Error("stop after capture");
		};

		await assert.rejects(manager.updatePi(), /stop after capture/);
		assert.deepEqual(calls, [layout.bunPath]);
	} finally {
		await layout.cleanup();
	}
});

test("推导出的 bun 与已知候选都不存在时才回退裸 bun（Homebrew/scoop 装的 bun 本体在别处）", async () => {
	// 候选探测会真查盘（~/.bun、/usr/local/bin、nix …）：用 fs 桩固定成「什么都不存在」，
	// 断言才与开发机是否装过 bun 无关（否则本机装了 bun 的开发/CI 会假红）。
	const load = createTsSandbox({
		stubs: {
			"node:fs": { existsSync: () => false },
			"../fs/trash": { trashPath: async () => {} },
			"../logging/sharedLogger": { getAppLogger: () => null },
			"../pi/PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
			"./PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
		},
	});
	const { ExtensionManager } = load("src/main/extensions/ExtensionManager.ts");
	const manager = new ExtensionManager(
		{},
		() => ({}),
		undefined,
		undefined,
		(key) => key,
	);
	manager.selfUpdate.check = async () => ({ hasUpdate: true, currentVersion: "1.1.0", latestVersion: "1.2.0", command: "/tmp/nowhere/.bun/bin/pi" });
	const calls = [];
	manager.selfUpdate.runBunGlobalUpdate = async (command) => {
		calls.push(command);
		throw new Error("stop after capture");
	};

	await assert.rejects(manager.updatePi(), /stop after capture/);
	assert.deepEqual(calls, ["bun"]);
});

test("a stale lightweight extension scan cannot overwrite a newer force refresh", async () => {
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager({}, () => ({}));
	const lightweight = deferred();
	const forced = deferred();

	// Isolate cache ordering from pi/npm IO. The production method is private in TypeScript,
	// but remains a normal method at runtime and is intentionally replaced only for this test.
	manager.catalog.loadList = (includeVersionInfo) => (includeVersionInfo ? forced.promise : lightweight.promise);

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

test("缓存失效（install/uninstall 路径）会丢弃在飞的旧列表并重新扫描", async () => {
	// 回归（2026-10 评审）：W3 把缓存代数机搬进 PiExtensionCatalog 后，这条「generation 变了就丢弃旧结果、
	// 重入 list()」的分支一度只剩源码可读、没有测试；这里是它的直测。
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager({}, () => ({}));
	const first = deferred();
	const second = deferred();
	let calls = 0;
	manager.catalog.loadList = () => {
		calls += 1;
		return calls === 1 ? first.promise : second.promise;
	};

	const pending = manager.list(false);
	// 模拟安装/卸载：generation 递增，在飞的旧请求结果必须被丢弃。
	manager.invalidateListCache();
	first.resolve({ extensions: [], raw: "stale" });
	// 让重入的 list() 跑到第二次 loadList。
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls, 2, "代际变化后必须重新扫描");
	second.resolve({ extensions: [{ id: "fresh", source: "npm:fresh" }], raw: "fresh" });

	const result = await pending;
	assert.equal(result.raw, "fresh");
	assert.equal((await manager.list(false)).raw, "fresh", "新结果要写回缓存");
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
	manager.catalog.scanLocalExtensions = () => {
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
		manager.catalog.scanLocalExtensions = () => scanDeferred.promise;
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
			manager.catalog.scanLocalExtensions = () => scanDeferred.promise;
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

	const parsed = manager.catalog.parseListOutput(raw);
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

	const parsed = manager.catalog.parseListOutput(raw);
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

		// 路径型 source（../outside.ts、F:\pkg 等）是 pi packages 条目，不是 extensions 目录里的
		// 本地文件：卸载必须交给 pi remove，绝不进删文件分支（旧实现会拼成
		// ~/.pi/agent/extensions/../outside.ts 去删，必然失败且报告误导）。
		const piCommands = [];
		manager.runPi = async (args) => {
			piCommands.push([...args]);
			return "";
		};
		await manager.uninstall("../outside.ts");
		assert.deepEqual(piCommands, [["remove", "../outside.ts"]]);
		// 删文件分支的穿越防护不放宽：非裸文件名仍被拒绝拼进 extensions 目录。
		await assert.rejects(manager.removeLocalExtension("../outside.ts"), /Invalid extension path/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("uninstall allows pi-deck-* local files outside the built-in whitelist", async () => {
	// 带 pi-deck- 前缀但不在内置白名单里的用户扩展：卸载必须走删文件路径；
	// 旧代码按前缀一律拦成「内置扩展不可卸载」，这类行的卸载
	// 的卸载按钮直接报错。白名单成员（真内置）仍拒绝——内置行的卸载语义由
	// removeBuiltIn（标记 removed + 删文件）承担，不能混用普通卸载路径。
	const { ExtensionManager } = loadExtensionManagerModule();
	const home = await mkdtemp(join(tmpdir(), "pideck-extension-manager-prefix-uninstall-"));
	try {
		const extensionsDir = join(home, ".pi", "agent", "extensions");
		await mkdir(extensionsDir, { recursive: true });
		await writeFile(join(extensionsDir, "pi-deck-user-extension.ts"), "export default {};", "utf8");
		const manager = new ExtensionManager(
			{},
			() => ({}),
			() => ({}),
			async () => ({}),
			(key) => key,
		);
		manager.wslEnvironment = { windowsHome: home };
		await manager.uninstall("pi-deck-user-extension.ts");
		await assert.rejects(readFile(join(extensionsDir, "pi-deck-user-extension.ts"), "utf8"), { code: "ENOENT" });
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
				"./PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
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
		const version = await manager.catalog.npmViewVersion("context-mode");
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
				"./PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
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
		await manager.catalog.npmViewVersion("context-mode");
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
				"./PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
			},
			// 沙箱内 globalThis.fetch 转发到宿主全局：用例替换宿主 globalThis.fetch 即完成注入，
			// 不必给生产代码增加仅供测试的注入点。
			globals: { fetch: (...args) => globalThis.fetch(...args) },
		});
		const { ExtensionManager } = load("src/main/extensions/ExtensionManager.ts");
		const manager = new ExtensionManager({ createInvocation: (command, args) => ({ command, args, shell: false }), createProcessEnv: () => ({}) }, () => ({}));
		manager.runPi = async () => raw;
		manager.catalog.scanLocalExtensions = async () => LOCAL_SCAN_ROWS;

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

/**
 * 回归（2026-10 用户反馈）：npm registry 不可达、npm view 回退又被超时杀掉时，
 * 扩展行必须仍然显示本地已装版本。旧实现把「读 package.json」与「查 registry」
 * 串在同一个 Promise.all 里，任一失败整行只剩「当前：- · 最新：-」，用户看到的就是
 * 「检查扩展版本失败」+ 两个空值。
 */
test("registry 快路与 npm view 回退都失败时仍显示本地已装版本", async () => {
	const home = await mkdtemp(join(tmpdir(), "pideck-extmgr-version-degrade-"));
	try {
		// 真实 installed package.json：degrade 用例靠它证明「当前」列不依赖网络。
		const installedDir = join(home, "npm", "node_modules", "context-mode");
		await mkdir(installedDir, { recursive: true });
		await writeFile(join(installedDir, "package.json"), JSON.stringify({ name: "context-mode", version: "1.0.0" }), "utf8");
		const raw = ["User packages:", "  npm:context-mode", `    ${installedDir}`].join("\n");

		const npmCalls = [];
		const load = createTsSandbox({
			stubs: {
				"node:os": { homedir: () => home },
				"node:child_process": {
					execFile: (command, args, _options, callback) => {
						npmCalls.push({ command: String(command), args: [...args] });
						// 基址解析成功（快路真的发一次 HTTP）；npm view 以「超时被杀」形态失败：
						// stderr 为空、只有 error.message，正是真实 registry 挂掉时的子进程结果。
						if (args.includes("registry")) {
							queueMicrotask(() => callback(null, "https://registry.npmjs.org/\n", ""));
							return;
						}
						const error = new Error("Command failed: npm view context-mode version");
						error.killed = true;
						queueMicrotask(() => callback(error, "", ""));
					},
				},
				"../fs/trash": { trashPath: (path) => rm(path, { recursive: true, force: true }) },
				"../logging/sharedLogger": { getAppLogger: () => null },
				"../pi/PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
				"./PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
			},
			globals: {
				fetch: () => {
					throw new Error("fetch failed: ECONNRESET");
				},
			},
		});
		const { ExtensionManager } = load("src/main/extensions/ExtensionManager.ts");
		const manager = new ExtensionManager({ createInvocation: (command, args) => ({ command, args, shell: false }), createProcessEnv: () => ({}) }, () => ({}));
		manager.runPi = async () => raw;
		manager.catalog.scanLocalExtensions = async () => LOCAL_SCAN_ROWS;

		const result = await manager.list(true);
		const row = result.extensions.find((extension) => extension.source === "npm:context-mode");
		assert.ok(row, "npm:context-mode 行必须出现在列表里");
		assert.equal(row.currentVersion, "1.0.0", "网络失败不得把本地已装版本一起吞掉");
		assert.equal(row.latestVersion, undefined);
		assert.equal(row.hasUpdate, false, "最新版本未知时不得凭猜测报有更新");
		assert.ok(row.updateError, "最新版本查不到必须留下可见提示");
		assert.deepEqual(
			npmCalls.filter((call) => !call.args.includes("registry")).map((call) => call.args.join(" ")),
			["view context-mode version"],
			"快路失败后仍必须回退一次 npm view",
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
