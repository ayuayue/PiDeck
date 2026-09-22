/**
 * pi 认证助手启动参数解析的回归测试。
 *
 * 这里守的是「助手能不能找到 pi 的 SDK 入口」——它是整条登录链路的单点：
 * 解析错了，用户看到的就是「点了登录没反应/报通道不可用」。因此用临时目录
 * 造出真实的安装形态（包根 + dist/index.js、垫片目录与 node_modules 同级），
 * 逐条锁定识别规则与失败分类。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PI_PACKAGE_NAME, resolvePiAuthHostPath, resolvePiAuthHostLaunch, resolvePiSdkEntry } = loadTsCommonJs("src/main/pi/auth/piAuthHostLaunch.ts");

/** 造一个 pi 包目录；`withDist: false` 用来模拟「包在但入口缺失」的半损坏安装。 */
function writePiPackage(rootDir, { withDist = true, name = PI_PACKAGE_NAME } = {}) {
	mkdirSync(rootDir, { recursive: true });
	writeFileSync(join(rootDir, "package.json"), JSON.stringify({ name, version: "0.0.0-test" }));
	if (withDist) {
		mkdirSync(join(rootDir, "dist"), { recursive: true });
		writeFileSync(join(rootDir, "dist", "index.js"), "module.exports = {};\n");
		writeFileSync(join(rootDir, "dist", "cli.js"), "#!/usr/bin/env node\n");
	}
}

/** 造一个带 resources/pi-auth-host.mjs 的 app 目录，让助手文件存在性检查通过。 */
function writeAppDir(rootDir) {
	const appDir = join(rootDir, "app");
	mkdirSync(join(appDir, "resources"), { recursive: true });
	writeFileSync(join(appDir, "resources", "pi-auth-host.mjs"), "#!/usr/bin/env node\n");
	return appDir;
}

const BASE_SETTINGS = { customPiPath: undefined, wslEnabled: false, wslDistro: undefined, wslUser: undefined, piProxyEnabled: false, piProxyUrl: undefined, piProxyBypass: undefined };

/** 只实现本模块用到的三个方法；生产 PiLocator 有 electron 依赖，测试用替身更聚焦。 */
function fakeLocator({ command, windowsLaunch, env = { PATH: "stub", EMPTY: undefined } }) {
	return {
		resolveCommand: () => command,
		createInvocation: () => ({ command, args: [], shell: false, pathPrefix: undefined, wsl: undefined, windowsLaunch }),
		createProcessEnv: () => ({ ...env }),
	};
}

function withTempDir(run) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-auth-launch-"));
	try {
		return run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("resolvePiSdkEntry 从包内任意 JS 文件向上找到 dist/index.js", () => {
	withTempDir((dir) => {
		const packageRoot = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
		writePiPackage(packageRoot);
		assert.equal(resolvePiSdkEntry(join(packageRoot, "dist", "cli.js")), join(packageRoot, "dist", "index.js"));
	});
});

test("resolvePiSdkEntry 识别与 node_modules 同级的垫片目录（npm 全局前缀形态）", () => {
	withTempDir((dir) => {
		const prefix = join(dir, "npm-prefix");
		writePiPackage(join(prefix, "node_modules", "@earendil-works", "pi-coding-agent"));
		writeFileSync(join(prefix, "pi.cmd"), "@echo off\n");
		assert.equal(resolvePiSdkEntry(join(prefix, "pi.cmd")), join(prefix, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
	});
});

test("resolvePiSdkEntry 不把同名目录误判为 pi 包，且缺 dist 入口时返回 undefined", () => {
	withTempDir((dir) => {
		const other = join(dir, "node_modules", "not-pi");
		writePiPackage(other, { name: "not-pi" });
		assert.equal(resolvePiSdkEntry(join(other, "dist", "cli.js")), undefined);

		const broken = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
		writePiPackage(broken, { withDist: false });
		assert.equal(resolvePiSdkEntry(join(broken, "package.json")), undefined);
	});
});

test("resolvePiSdkEntry 穿透 node_modules/.bin 符号链接（POSIX）", { skip: process.platform === "win32" }, () => {
	withTempDir((dir) => {
		const packageRoot = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
		writePiPackage(packageRoot);
		const binDir = join(dir, "node_modules", ".bin");
		mkdirSync(binDir, { recursive: true });
		symlinkSync(join(packageRoot, "dist", "cli.js"), join(binDir, "pi"));
		assert.equal(resolvePiSdkEntry(join(binDir, "pi")), join(packageRoot, "dist", "index.js"));
	});
});

test("resolvePiAuthHostLaunch: node-direct 通道直接用垫片还原出的入口与同一 node", () => {
	withTempDir((dir) => {
		const appPath = writeAppDir(dir);
		const packageRoot = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
		writePiPackage(packageRoot);
		const nodeExe = join(dir, "node.exe");
		const launch = resolvePiAuthHostLaunch({
			settings: BASE_SETTINGS,
			locator: fakeLocator({ command: nodeExe, windowsLaunch: { channel: "node-direct", entry: join(packageRoot, "dist", "cli.js") } }),
			userDataPath: join(dir, "userData"),
			appPath,
			resourcesPath: join(dir, "unused"),
			isPackaged: false,
		});
		assert.equal(launch.ok, true);
		assert.equal(launch.sdkEntry, join(packageRoot, "dist", "index.js"));
		assert.equal(launch.nodeExe, nodeExe);
		assert.equal(launch.helperPath, join(appPath, "resources", "pi-auth-host.mjs"));
		// 值为 undefined 的键必须被剔除，避免不同 Node 版本对 env 处理不一致。
		assert.equal(Object.hasOwn(launch.env, "EMPTY"), false);
		assert.equal(launch.env.PIDECK_PI_SDK_ENTRY, launch.sdkEntry);
	});
});

test("resolvePiAuthHostLaunch: 裸命令名走 PATH 解析并保留代理环境变量", () => {
	withTempDir((dir) => {
		const appPath = writeAppDir(dir);
		const prefix = join(dir, "npm-prefix");
		writePiPackage(join(prefix, "node_modules", "@earendil-works", "pi-coding-agent"));
		writeFileSync(join(prefix, "pi.cmd"), "@echo off\n");
		const originalPath = process.env.PATH;
		process.env.PATH = prefix;
		try {
			const launch = resolvePiAuthHostLaunch({
				settings: { ...BASE_SETTINGS, piProxyEnabled: true, piProxyUrl: "http://127.0.0.1:7890" },
				locator: fakeLocator({ command: "pi", env: { PATH: prefix, HTTPS_PROXY: "http://127.0.0.1:7890" } }),
				userDataPath: join(dir, "userData"),
				appPath,
				resourcesPath: join(dir, "unused"),
				isPackaged: false,
			});
			assert.equal(launch.ok, true);
			assert.equal(launch.sdkEntry, join(prefix, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
			assert.equal(launch.env.HTTPS_PROXY, "http://127.0.0.1:7890");
		} finally {
			process.env.PATH = originalPath;
		}
	});
});

test("resolvePiAuthHostLaunch: 打包态从 resourcesPath 取助手文件", () => {
	withTempDir((dir) => {
		const resourcesPath = join(dir, "resources");
		mkdirSync(resourcesPath, { recursive: true });
		writeFileSync(join(resourcesPath, "pi-auth-host.mjs"), "#!/usr/bin/env node\n");
		assert.equal(resolvePiAuthHostPath({ appPath: join(dir, "asar"), resourcesPath, isPackaged: true }), join(resourcesPath, "pi-auth-host.mjs"));
	});
});

test("resolvePiAuthHostLaunch: WSL / 找不到入口 / 缺助手各自给出分类原因", () => {
	withTempDir((dir) => {
		const appPath = writeAppDir(dir);
		const wsl = resolvePiAuthHostLaunch({
			settings: BASE_SETTINGS,
			locator: fakeLocator({ command: "wsl://Ubuntu/user/usr/bin/pi" }),
			userDataPath: join(dir, "userData"),
			appPath,
			resourcesPath: join(dir, "unused"),
			isPackaged: false,
		});
		assert.equal(wsl.ok, false);
		assert.equal(wsl.reason, "wsl");

		// 编译版单文件 pi：命令在，但没有可分包的 JS 入口。
		const compiled = join(dir, "pi.bin");
		writeFileSync(compiled, "");
		const noEntry = resolvePiAuthHostLaunch({
			settings: BASE_SETTINGS,
			locator: fakeLocator({ command: compiled, windowsLaunch: { channel: "cmd-shim", reason: "unrecognized" } }),
			userDataPath: join(dir, "userData"),
			appPath,
			resourcesPath: join(dir, "unused"),
			isPackaged: false,
		});
		assert.equal(noEntry.ok, false);
		assert.equal(noEntry.reason, "no-pi-entry");
		assert.equal(noEntry.detail, "unrecognized");

		const packageRoot = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
		writePiPackage(packageRoot);
		const emptyAppDir = join(dir, "app-without-helper");
		mkdirSync(emptyAppDir, { recursive: true });
		const noHelper = resolvePiAuthHostLaunch({
			settings: BASE_SETTINGS,
			locator: fakeLocator({ command: join(packageRoot, "dist", "cli.js") }),
			userDataPath: join(dir, "userData"),
			appPath: emptyAppDir,
			resourcesPath: join(dir, "unused"),
			isPackaged: false,
		});
		assert.equal(noHelper.ok, false);
		assert.equal(noHelper.reason, "helper-missing");
	});
});
