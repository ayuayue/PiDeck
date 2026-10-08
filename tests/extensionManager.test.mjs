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
	assert.equal(await lightweightResult, fresh);
	assert.equal(await manager.list(false), fresh);
	assert.equal(await manager.list(true), fresh);
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
