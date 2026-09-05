import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadWslPaths() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/wsl/WslPaths.ts"), sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

function loadExtensionManager(fsOverrides = {}) {
	const wslPaths = loadWslPaths();
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "node:fs/promises") {
				return { ...require(id), ...fsOverrides };
			}
			if (id === "../wsl/WslPaths") return wslPaths;
			// 25fd516 起 ExtensionManager 依赖内置扩展清单模块；按真实模块透传（纯数据 + 纯函数）
			if (id === "./builtInExtensions") {
				return require("../src/main/extensions/builtInExtensions.ts");
			}
			// 删除走系统回收站统一入口；本测试不触达删除路径，提供 noop stub 即可。
			if (id === "../fs/trash") return { trashPath: async () => {} };
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			if (id === "./extensionVersionGate") {
				return require("../src/main/extensions/extensionVersionGate.ts");
			}
			// ExtensionManager 依赖 ../utils/versionCompare 的 compareVersions；.ts 经 node 类型剥离可 require。
			if (id === "../utils/versionCompare") {
				return require("../src/main/utils/versionCompare.ts");
			}
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/extensions/ExtensionManager.ts"), sandbox, {
		filename: "ExtensionManager.ts",
	});
	return { ...sandbox.exports, wslPaths };
}

test("reads an installed WSL npm extension version through its canonical host path", async () => {
	const fixtureDir = mkdtempSync(join(tmpdir(), "pideck-extension-version-"));
	const fixturePath = join(fixtureDir, "package.json");
	writeFileSync(fixturePath, JSON.stringify({ name: "fixture-extension", version: "1.2.3" }), "utf8");
	const requestedPaths = [];

	try {
		const { ExtensionManager, wslPaths } = loadExtensionManager({
			readFile: async (path, encoding) => {
				requestedPaths.push(String(path));
				return readFile(fixturePath, encoding);
			},
		});
		const manager = new ExtensionManager({}, () => ({}));
		manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));

		const version = await manager.readInstalledVersion(
			"/root/.pi/agent/extensions/npm/fixture-extension",
		);

		assert.equal(version, "1.2.3");
		assert.equal(requestedPaths.length, 1);
		assert.equal(
			requestedPaths[0].replace(/\\/g, "/"),
			"//wsl.localhost/Ubuntu-24.04/root/.pi/agent/extensions/npm/fixture-extension/package.json",
		);
	} finally {
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("setEnabled 写入 PiDeck settings 的 scoped 禁用列表（不再写 pi settings.json）", async () => {
	// 旧实现读写 ~/.pi/agent/settings.json 的 disabledExtensions；pi 0.82.x 不识别该键，
	// 新实现改为写 PiDeck 自身设置（scope+source），启动 RPC 时由白名单模式生效。
	let pideckSettings = {};
	const { ExtensionManager } = loadExtensionManager();
	const manager = new ExtensionManager(
		{},
		() => ({}),
		() => pideckSettings,
		async (patch) => {
			pideckSettings = { ...pideckSettings, ...patch };
			return pideckSettings;
		},
	);

	// 默认 scope=user
	await manager.setEnabled("npm:pi-web-access", false);
	assert.equal(
		JSON.stringify(manager.getDisabledExtensions()),
		JSON.stringify([{ scope: "user", source: "npm:pi-web-access" }]),
	);

	// 指定 project scope → 并列独立条目
	await manager.setEnabled("npm:pi-mcp-adapter", false, "project");
	assert.equal(
		JSON.stringify(manager.getDisabledExtensions()),
		JSON.stringify([
			{ scope: "user", source: "npm:pi-web-access" },
			{ scope: "project", source: "npm:pi-mcp-adapter" },
		]),
	);

	// 启用 user 级 → 只清对应 scope 条目，project 条目保留
	await manager.setEnabled("npm:pi-web-access", true);
	assert.equal(
		JSON.stringify(manager.getDisabledExtensions()),
		JSON.stringify([{ scope: "project", source: "npm:pi-mcp-adapter" }]),
	);

	// 幂等：重复禁用不产生重复条目
	await manager.setEnabled("npm:pi-mcp-adapter", false, "project");
	assert.equal(
		JSON.stringify(manager.getDisabledExtensions()),
		JSON.stringify([{ scope: "project", source: "npm:pi-mcp-adapter" }]),
	);
});

test("setEnabled 禁用动作对低于白名单门槛的 pi 版本抛错（≥0.60 才支持 -e 目录/包源）", async () => {
	let pideckSettings = {};
	const { ExtensionManager } = loadExtensionManager();
	const manager = new ExtensionManager(
		{},
		() => ({}),
		() => pideckSettings,
		async (patch) => {
			pideckSettings = { ...pideckSettings, ...patch };
			return pideckSettings;
		},
		// 注入翻译 stub：断言抛错文案来自 mainExtension.piVersionTooOldForDisable（含版本号插值）
		(key, params) => `${key}:${params?.version ?? ""}`,
	);
	// 直接替换私有 getPiVersion 探测（运行时是普通方法），模拟老版本 pi。
	manager.getPiVersion = async () => "0.55.1";

	await assert.rejects(
		() => manager.setEnabled("npm:some-ext", false, "user"),
		/mainExtension\.piVersionTooOldForDisable:0\.55\.1/,
	);
	// 拒绝后不得写入任何禁用条目（JSON.stringify 规避 vm 沙箱数组引用不等）
	assert.equal(JSON.stringify(manager.getDisabledExtensions()), "[]");
	// 启用动作（移除条目）不受版本门槛约束
	await manager.setEnabled("npm:some-ext", true);
	assert.equal(JSON.stringify(manager.getDisabledExtensions()), "[]");
});

test("setEnabled 允许达标版本的 pi 禁用扩展（白名单机制可用的分界 0.60）", async () => {
	let pideckSettings = {};
	const { ExtensionManager } = loadExtensionManager();
	const manager = new ExtensionManager(
		{},
		() => ({}),
		() => pideckSettings,
		async (patch) => {
			pideckSettings = { ...pideckSettings, ...patch };
			return pideckSettings;
		},
		(key, params) => `${key}:${params?.version ?? ""}`,
	);
	manager.getPiVersion = async () => "0.60.0";
	await manager.setEnabled("npm:some-ext", false, "user");
	assert.equal(
		JSON.stringify(manager.getDisabledExtensions()),
		JSON.stringify([{ scope: "user", source: "npm:some-ext" }]),
	);

	// 版本探测失败（未知）时放行，不拦截写入
	manager.getPiVersion = async () => null;
	await manager.setEnabled("npm:pi-web-access", false, "project");
	assert.equal(
		JSON.stringify(manager.getDisabledExtensions()),
		JSON.stringify([
			{ scope: "user", source: "npm:some-ext" },
			{ scope: "project", source: "npm:pi-web-access" },
		]),
	);
});

test("白名单总开关（禁用 -e 参数）默认关闭，可切换并持久化", async () => {
	let pideckSettings = {};
	const { ExtensionManager } = loadExtensionManager();
	const manager = new ExtensionManager(
		{},
		() => ({}),
		() => pideckSettings,
		async (patch) => {
			pideckSettings = { ...pideckSettings, ...patch };
			return pideckSettings;
		},
	);

	// 未设置时默认 false：白名单模式正常工作
	assert.equal(manager.isWhitelistDisabled(), false);

	// 开启总开关：写入 disableExtensionWhitelist=true
	await manager.setWhitelistDisabled(true);
	assert.equal(manager.isWhitelistDisabled(), true);
	assert.equal(pideckSettings.disableExtensionWhitelist, true);

	// 关闭恢复默认
	await manager.setWhitelistDisabled(false);
	assert.equal(manager.isWhitelistDisabled(), false);
	assert.equal(pideckSettings.disableExtensionWhitelist, false);
});
