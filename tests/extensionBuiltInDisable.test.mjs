import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const require = createRequire(import.meta.url);

/** Load the real dependency graph while redirecting user files and pi execution to fixtures. */
function loadExtensionManager({ homeDir, runPiOutput = "", fsOverrides = {} } = {}) {
	const realOs = require("node:os");
	const load = createTsSandbox({
		stubs: {
			"node:os": { ...realOs, homedir: () => homeDir ?? realOs.homedir() },
			"node:fs/promises": { ...require("node:fs/promises"), ...fsOverrides },
			"node:child_process": {
				...require("node:child_process"),
				execFile: (_command, _args, _options, callback) => queueMicrotask(() => callback(null, runPiOutput, "")),
			},
			"../pi/PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
			"../fs/trash": { trashPath: async () => {} },
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
	return load("src/main/extensions/ExtensionManager.ts");
}

test("disableBuiltIn records removal and deletes user extension file", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-disable-builtin-"));
	const extensionsDir = join(fixtureHome, ".pi", "agent", "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	const target = join(extensionsDir, "pi-deck-todo.ts");
	writeFileSync(target, "// builtin todo\n", "utf8");

	let settings = { removedBuiltInExtensions: [] };
	const { ExtensionManager } = loadExtensionManager({ homeDir: fixtureHome });
	const manager = new ExtensionManager(
		{
			// locator 占位：disableBuiltIn 不调用 runPi
			check: async () => ({ installed: true, version: "0.80.0" }),
			createInvocation: (cmd, args) => ({ command: cmd, args, shell: false }),
			createProcessEnv: () => process.env,
			resolveCommand: () => "pi",
		},
		() => ({}),
		() => settings,
		async (patch) => {
			settings = { ...settings, ...patch };
			return settings;
		},
	);

	assert.equal(existsSync(target), true);
	await manager.disableBuiltIn("pi-deck-todo.ts");
	assert.equal(existsSync(target), false);
	// 注意：vm 沙箱内创建的数组与外层 realm 的 deepStrictEqual 可能因原型不同失败，逐项比较。
	assert.equal(settings.removedBuiltInExtensions?.length, 1);
	assert.equal(settings.removedBuiltInExtensions?.[0], "pi-deck-todo.ts");
	// 幂等：再删一次不应抛错，也不应重复写入
	await manager.disableBuiltIn("pi-deck-todo.ts");
	assert.equal(settings.removedBuiltInExtensions?.length, 1);
	assert.equal(settings.removedBuiltInExtensions?.[0], "pi-deck-todo.ts");

	rmSync(fixtureHome, { recursive: true, force: true });
});

test("list auto-disables built-in todo and deletes file when third-party rpiv-todo is present", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-conflict-todo-"));
	const extensionsDir = join(fixtureHome, ".pi", "agent", "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	const builtinPath = join(extensionsDir, "pi-deck-todo.ts");
	writeFileSync(builtinPath, "// builtin\n", "utf8");

	let settings = { removedBuiltInExtensions: [] };
	const piListOutput = ["User packages:", "npm:@juicesharp/rpiv-todo", join(fixtureHome, ".pi", "agent", "npm", "node_modules", "@juicesharp", "rpiv-todo"), ""].join("\n");

	const { ExtensionManager } = loadExtensionManager({
		homeDir: fixtureHome,
		runPiOutput: piListOutput,
	});

	// 绕过 noApproveSupported 的版本探测：直接 stub getPiVersion 路径
	// detectPiVersion 走 locator.check；给一个有效版本即可。
	const locator = {
		check: async () => ({ installed: true, version: "0.80.0" }),
		createInvocation: (cmd, args) => ({
			command: cmd,
			args,
			shell: false,
			pathPrefix: undefined,
			wsl: false,
			windowsVerbatimArguments: false,
		}),
		createProcessEnv: () => ({ ...process.env }),
		resolveCommand: () => "pi",
	};

	const manager = new ExtensionManager(
		locator,
		() => ({}),
		() => settings,
		async (patch) => {
			settings = { ...settings, ...patch };
			return settings;
		},
	);

	assert.equal(existsSync(builtinPath), true);
	const result = await manager.list(false);

	assert.equal(settings.removedBuiltInExtensions.includes("pi-deck-todo.ts"), true);
	assert.equal(existsSync(builtinPath), false, "conflicting built-in file must be deleted");
	assert.ok(result.conflicts?.some((c) => c.builtIn === "pi-deck-todo.ts"));
	const builtin = result.extensions.find((e) => e.source === "pi-deck-todo.ts");
	assert.equal(builtin?.enabled, false);

	rmSync(fixtureHome, { recursive: true, force: true });
});

test("list purges residual built-in file already marked removed", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-residual-todo-"));
	const extensionsDir = join(fixtureHome, ".pi", "agent", "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	const builtinPath = join(extensionsDir, "pi-deck-todo.ts");
	writeFileSync(builtinPath, "// leftover after disable-without-delete\n", "utf8");

	let settings = { removedBuiltInExtensions: ["pi-deck-todo.ts"] };
	const { ExtensionManager } = loadExtensionManager({
		homeDir: fixtureHome,
		runPiOutput: "User packages:\n",
	});
	const locator = {
		check: async () => ({ installed: true, version: "0.80.0" }),
		createInvocation: (cmd, args) => ({
			command: cmd,
			args,
			shell: false,
			pathPrefix: undefined,
			wsl: false,
			windowsVerbatimArguments: false,
		}),
		createProcessEnv: () => ({ ...process.env }),
		resolveCommand: () => "pi",
	};
	const manager = new ExtensionManager(
		locator,
		() => ({}),
		() => settings,
		async (patch) => {
			settings = { ...settings, ...patch };
			return settings;
		},
	);

	assert.equal(existsSync(builtinPath), true);
	await manager.list(false);
	assert.equal(existsSync(builtinPath), false, "residual removed built-in must be purged on list");

	rmSync(fixtureHome, { recursive: true, force: true });
});

test("toggleBuiltIn opt-in writes enabledBuiltInExtensions and never touches removed", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-optin-toggle-"));
	let settings = { removedBuiltInExtensions: [], enabledBuiltInExtensions: [] };
	const { ExtensionManager } = loadExtensionManager({ homeDir: fixtureHome });
	const locator = {
		check: async () => ({ installed: true, version: "0.80.0" }),
		createInvocation: (cmd, args) => ({ command: cmd, args, shell: false }),
		createProcessEnv: () => process.env,
		resolveCommand: () => "pi",
	};
	const manager = new ExtensionManager(
		locator,
		() => ({}),
		() => settings,
		async (patch) => {
			settings = { ...settings, ...patch };
			return settings;
		},
	);

	// 开启：写 opt-in 列表，不动 removed（两套机制互斥）
	await manager.toggleBuiltIn("pi-deck-gui-bridge.ts", true);
	assert.equal(settings.enabledBuiltInExtensions?.length, 1);
	assert.equal(settings.enabledBuiltInExtensions?.[0], "pi-deck-gui-bridge.ts");
	assert.equal(settings.removedBuiltInExtensions?.length, 0);
	// 幂等：重复开启不重复写入
	await manager.toggleBuiltIn("pi-deck-gui-bridge.ts", true);
	assert.equal(settings.enabledBuiltInExtensions?.length, 1);
	// 关闭：移出 opt-in 列表
	await manager.toggleBuiltIn("pi-deck-gui-bridge.ts", false);
	assert.equal(settings.enabledBuiltInExtensions?.length, 0);
	// 非默认关的内置扩展必须走 removed 机制，拒绝用这个开关
	await assert.rejects(() => manager.toggleBuiltIn("pi-deck-todo.ts", true), /默认关闭/);
	// 自愈：曾被「移除」的 opt-in 扩展重新打开开关时，同步清除 removed 标记
	settings = { removedBuiltInExtensions: ["pi-deck-gui-bridge.ts"], enabledBuiltInExtensions: [] };
	await manager.toggleBuiltIn("pi-deck-gui-bridge.ts", true);
	assert.equal(settings.removedBuiltInExtensions?.length, 0);
	assert.equal(settings.enabledBuiltInExtensions?.[0], "pi-deck-gui-bridge.ts");

	rmSync(fixtureHome, { recursive: true, force: true });
});

test("toggleFromUi 内置扩展走 PiDeck 设置路由，绝不写原生过滤规则", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-toggle-from-ui-builtin-"));
	let settings = { removedBuiltInExtensions: ["pi-deck-todo.ts"], enabledBuiltInExtensions: [] };
	const { ExtensionManager } = loadExtensionManager({ homeDir: fixtureHome });
	const manager = new ExtensionManager(
		{
			check: async () => ({ installed: true, version: "0.80.0" }),
			createInvocation: (cmd, args) => ({ command: cmd, args, shell: false }),
			createProcessEnv: () => process.env,
			resolveCommand: () => "pi",
		},
		() => ({}),
		() => settings,
		async (patch) => {
			settings = { ...settings, ...patch };
			return settings;
		},
	);
	const nativeCalls = [];
	manager.configureNativeToggle(async (input) => {
		nativeCalls.push(input);
		return { ok: true };
	});

	// 普通内置扩展：开关走 removedBuiltInExtensions（RPC -e 注入），不能落到原生过滤规则
	await manager.toggleFromUi("pi-deck-todo.ts", true);
	assert.equal(settings.removedBuiltInExtensions?.length, 0);
	assert.equal(nativeCalls.length, 0, "内置扩展不得写原生过滤规则");

	// 默认关闭的内置扩展（opt-in）：开关走 enabledBuiltInExtensions，同样不碰原生规则
	await manager.toggleFromUi("pi-deck-gui-bridge.ts", true);
	assert.equal(settings.enabledBuiltInExtensions?.length, 1);
	assert.equal(nativeCalls.length, 0);

	rmSync(fixtureHome, { recursive: true, force: true });
});

test("toggleFromUi 非内置扩展走原生规则：透传路径，缺路径按 source 反查列表", async () => {
	const fixtureHome = mkdtempSync(join(tmpdir(), "pideck-toggle-from-ui-native-"));
	const { ExtensionManager } = loadExtensionManager({ homeDir: fixtureHome });
	const manager = new ExtensionManager(
		{ check: async () => ({ installed: true, version: "0.80.0" }), createInvocation: (cmd, args) => ({ command: cmd, args, shell: false }), createProcessEnv: () => process.env, resolveCommand: () => "pi" },
		() => ({}),
		() => ({}),
		async () => ({}),
	);
	const nativeCalls = [];
	manager.configureNativeToggle(async (input) => {
		nativeCalls.push(input);
		return { ok: true };
	});
	// Web 端扩展列表剥离了宿主机路径：本地文件扩展必须按 source 反查出真实路径（pi 按绝对路径精确匹配）
	manager.list = async () => ({ extensions: [{ name: "my-ext", source: "my-ext", path: "/home/u/.pi/agent/extensions/my-ext.ts", scope: "user", enabled: false }] });

	await manager.toggleFromUi("my-ext", false, "user", "/home/u/.pi/agent/extensions/my-ext.ts");
	// 沙箱内创建的对象与外层 realm 的 deepStrictEqual 会因原型不同失败：逐项比较
	const forwarded = nativeCalls.at(-1);
	assert.equal(forwarded.source, "my-ext");
	assert.equal(forwarded.path, "/home/u/.pi/agent/extensions/my-ext.ts");
	assert.equal(forwarded.scope, "user");
	assert.equal(forwarded.projectId, undefined);
	assert.equal(forwarded.enabled, false);

	await manager.toggleFromUi("my-ext", true, "user");
	assert.equal(nativeCalls.at(-1).path, "/home/u/.pi/agent/extensions/my-ext.ts", "缺 path 时必须用列表里的真实路径");

	// 插件开发 demo：pi-deck- 前缀但不在白名单 → 仍走原生规则（issue #321）
	manager.list = async () => ({ extensions: [] });
	await manager.toggleFromUi("pi-deck-demo-plugin.ts", true, "user");
	assert.equal(nativeCalls.at(-1).source, "pi-deck-demo-plugin.ts");
	assert.equal(nativeCalls.at(-1).path, undefined);

	// 项目作用域：projectId 原样透传（主进程据此定位项目层配置）
	await manager.toggleFromUi("my-ext", false, "project", "/home/u/proj/.pi/extensions/my-ext.ts", "p1");
	assert.equal(nativeCalls.at(-1).projectId, "p1");

	rmSync(fixtureHome, { recursive: true, force: true });
});

// 避免 unused import 告警风格（homedir 仅文档用）
void homedir;
