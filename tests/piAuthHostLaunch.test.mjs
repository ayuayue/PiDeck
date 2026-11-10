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
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PI_PACKAGE_NAME, resolvePiAuthHostPath, resolvePiAuthHostLaunch, resolvePiSdkEntry, resolveMiseShimSdkEntry, resolveBunShimSdkEntry } = loadTsCommonJs("src/main/pi/auth/piAuthHostLaunch.ts");
const { buildPiProxyEnvPatch } = loadTsCommonJs("src/main/sessions/sessionProxyPolicy.ts");

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

const BASE_SETTINGS = { customPiPath: undefined, wslEnabled: false, wslDistro: undefined, wslUser: undefined, piProxyEnabled: false, piProxyUrl: undefined, piProxyBypass: "", piProxyProviders: [], piProxyModels: [] };

/** 只实现本模块用到的三个方法；生产 PiLocator 有 electron 依赖，测试用替身更聚焦。 */
function fakeLocator({ command, windowsLaunch, env = { PATH: "stub", EMPTY: undefined } }) {
	return {
		resolveCommand: () => command,
		createInvocation: () => ({ command, args: [], shell: false, pathPrefix: undefined, wsl: undefined, windowsLaunch }),
		// 生产实现在 env 上叠代理 patch；替身复用生产规则，代理相关断言才有意义。
		createProcessEnv: (settings) => ({ ...env, ...(buildPiProxyEnvPatch(settings) ?? {}) }),
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

/** 造一个官方安装器（managed install）的 agent 目录：bin 垫片 + install 标记 + releases/<ver>。 */
function writeManagedInstall(agentDir, { versions, currentVersion }) {
	mkdirSync(join(agentDir, "bin"), { recursive: true });
	// 官方安装器生成的垫片只是转发到 pi-launcher.js，不含 npm 垫片的 node_modules 相对路径形态。
	writeFileSync(join(agentDir, "bin", "pi.cmd"), '@echo off\nnode "%~dp0pi-launcher.js" %*\n');
	writeFileSync(join(agentDir, "bin", "pi"), '#!/bin/sh\nexec node pi-launcher.js "$@"\n');
	const installRoot = join(agentDir, "install");
	mkdirSync(installRoot, { recursive: true });
	writeFileSync(join(installRoot, "managed-install.json"), JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }));
	for (const version of versions) writePiPackage(join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent"));
	if (currentVersion !== undefined) writeFileSync(join(installRoot, "current-version"), `${currentVersion}\n`);
	return installRoot;
}

test("resolvePiAuthHostLaunch: 官方 managed 安装按 install/current-version 取 releases 内的 SDK 入口", () => {
	withTempDir((dir) => {
		const appPath = writeAppDir(dir);
		const agentDir = join(dir, ".pi", "agent");
		writeManagedInstall(agentDir, { versions: ["1.2.3", "1.3.0"], currentVersion: "1.2.3" });
		const launch = resolvePiAuthHostLaunch({
			settings: { ...BASE_SETTINGS, customPiPath: join(agentDir, "bin", "pi.cmd") },
			locator: fakeLocator({ command: join(agentDir, "bin", "pi.cmd"), windowsLaunch: { channel: "cmd-shim", reason: "unrecognized" } }),
			userDataPath: join(dir, "userData"),
			appPath,
			resourcesPath: join(dir, "unused"),
			isPackaged: false,
		});
		// 垫片还原失败 + 向上找不到 node_modules 时，必须退到 managed 布局而不是报 no-pi-entry。
		assert.equal(launch.ok, true);
		assert.equal(launch.sdkEntry, join(agentDir, "install", "releases", "1.2.3", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
		assert.equal(launch.env.PIDECK_PI_SDK_ENTRY, launch.sdkEntry);
	});
});

test("resolvePiAuthHostLaunch: managed-install.json 带 BOM 时仍走官方 managed 布局", () => {
	withTempDir((dir) => {
		const appPath = writeAppDir(dir);
		const agentDir = join(dir, ".pi", "agent");
		const installRoot = writeManagedInstall(agentDir, { versions: ["1.2.3"], currentVersion: "1.2.3" });
		// PowerShell 5.1 重写标记文件会带 BOM；误判为非 managed 会让侧车找不到 SDK 入口。
		writeFileSync(join(installRoot, "managed-install.json"), `\uFEFF${JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" })}`);
		const launch = resolvePiAuthHostLaunch({
			settings: { ...BASE_SETTINGS, customPiPath: join(agentDir, "bin", "pi.cmd") },
			locator: fakeLocator({ command: join(agentDir, "bin", "pi.cmd"), windowsLaunch: { channel: "cmd-shim", reason: "unrecognized" } }),
			userDataPath: join(dir, "userData"),
			appPath,
			resourcesPath: join(dir, "unused"),
			isPackaged: false,
		});
		assert.equal(launch.ok, true, `带 BOM 的标记文件应仍能解析 SDK 入口：${launch.error}`);
		assert.equal(launch.sdkEntry, join(installRoot, "releases", "1.2.3", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
	});
});

test("resolvePiAuthHostLaunch: current-version 缺失时退到 releases 下版本号最大的完整 release", () => {
	withTempDir((dir) => {
		const appPath = writeAppDir(dir);
		const agentDir = join(dir, ".pi", "agent");
		writeManagedInstall(agentDir, { versions: ["1.2.3", "1.10.0", "not-a-version"] });
		const launch = resolvePiAuthHostLaunch({
			settings: BASE_SETTINGS,
			locator: fakeLocator({ command: join(agentDir, "bin", "pi") }),
			userDataPath: join(dir, "userData"),
			appPath,
			resourcesPath: join(dir, "unused"),
			isPackaged: false,
		});
		assert.equal(launch.ok, true);
		// 1.10.0 > 1.2.3（数值比较，不是字符串序）；not-a-version 目录被忽略。
		assert.equal(launch.sdkEntry, join(agentDir, "install", "releases", "1.10.0", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
	});
});

test("resolvePiAuthHostLaunch: 目录形态像 managed 但没有合法标记/包时仍报 no-pi-entry", () => {
	withTempDir((dir) => {
		const appPath = writeAppDir(dir);
		const agentDir = join(dir, ".pi", "agent");
		mkdirSync(join(agentDir, "bin"), { recursive: true });
		writeFileSync(join(agentDir, "bin", "pi.cmd"), '@echo off\nnode "%~dp0pi-launcher.js" %*\n');
		const launch = resolvePiAuthHostLaunch({
			settings: BASE_SETTINGS,
			locator: fakeLocator({ command: join(agentDir, "bin", "pi.cmd"), windowsLaunch: { channel: "cmd-shim", reason: "unrecognized" } }),
			userDataPath: join(dir, "userData"),
			appPath,
			resourcesPath: join(dir, "unused"),
			isPackaged: false,
		});
		assert.equal(launch.ok, false);
		assert.equal(launch.reason, "no-pi-entry");
	});
});

/** 造一个 mise 布局：`<data>/shims/pi[.exe]` + `<data>/installs/node/<ver>/node_modules/...`。 */
function writeMiseLayout(dataDir, versions) {
	mkdirSync(join(dataDir, "shims"), { recursive: true });
	const shim = join(dataDir, "shims", process.platform === "win32" ? "pi.exe" : "pi");
	// 真实垫片是编译产物：这里只需要「文件存在且不是 JS」这一个形态特征。
	writeFileSync(shim, "");
	for (const version of versions) writePiPackage(join(dataDir, "installs", "node", version, "node_modules", "@earendil-works", "pi-coding-agent"));
	return shim;
}

/** MISE_INSTALL_PATH 会覆盖 installs 根：用例期间清掉并在结束后还原，避免开发机环境串味。 */
function withoutMiseInstallPath(run) {
	const saved = process.env.MISE_INSTALL_PATH;
	delete process.env.MISE_INSTALL_PATH;
	try {
		return run();
	} finally {
		if (saved !== undefined) process.env.MISE_INSTALL_PATH = saved;
	}
}

test("resolveMiseShimSdkEntry 识别 mise 垫片，去 installs/node/<ver> 取包（多版本取最高）", () => {
	withTempDir((dir) =>
		withoutMiseInstallPath(() => {
			const dataDir = join(dir, "mise");
			const shim = writeMiseLayout(dataDir, ["22.0.0", "24.13.0", "lts"]);
			const expected = join(dataDir, "installs", "node", "24.13.0", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
			assert.equal(resolveMiseShimSdkEntry(shim), expected);
			// 别名目录（lts）不参与数值比较；非垫片路径交回 resolvePiSdkEntry，不在这里猜。
			assert.equal(resolveMiseShimSdkEntry(join(dataDir, "installs", "node", "24.13.0", "pi.cmd")), undefined);
		}),
	);
});

test("resolvePiAuthHostLaunch: mise 垫片不再报 no-pi-entry，改用真实包的 SDK 入口", () => {
	withTempDir((dir) =>
		withoutMiseInstallPath(() => {
			const appPath = writeAppDir(dir);
			const dataDir = join(dir, "mise");
			const shim = writeMiseLayout(dataDir, ["24.13.0"]);
			const launch = resolvePiAuthHostLaunch({
				settings: BASE_SETTINGS,
				locator: fakeLocator({ command: shim, windowsLaunch: { channel: "cmd-shim", reason: "unrecognized" } }),
				userDataPath: join(dir, "userData"),
				appPath,
				resourcesPath: join(dir, "unused"),
				isPackaged: false,
			});
			// 修复前：垫片还原与向上找包根都失败 → no-pi-entry → 输入预测/提示词增强/登录全部不可用。
			assert.equal(launch.ok, true);
			assert.equal(launch.sdkEntry, join(dataDir, "installs", "node", "24.13.0", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
			assert.equal(launch.env.PIDECK_PI_SDK_ENTRY, launch.sdkEntry);
		}),
	);
});

/** 按平台写一个「运行时可执行文件」：只验证路径选择，不关心文件内容。 */
function writeRuntimeFile(dir, programName) {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${programName}${process.platform === "win32" ? ".exe" : ""}`);
	writeFileSync(file, "");
	return file;
}

/** 便携 node 的可执行文件（层级与 piRuntimePaths 一致：POSIX 多一层 bin/）。 */
function writePortableNode(userDataPath) {
	const binDir = process.platform === "win32" ? join(userDataPath, "pi-runtime", "node") : join(userDataPath, "pi-runtime", "node", "bin");
	return writeRuntimeFile(binDir, "node");
}

/**
 * 造一个 bun 全局安装布局：`<root>/bin/pi[.exe]` 垫片 + `<root>/install/global/node_modules/<pkg>`。
 * Windows 的垫片是 bun.exe 的副本（旁边还有私有格式的 `pi.exe.bunx`），POSIX 是软链；
 * 这里造「存在且不是 JS」的最小形态即可。
 */
function writeBunLayout(rootDir, { withPackage = true } = {}) {
	mkdirSync(join(rootDir, "bin"), { recursive: true });
	const shim = join(rootDir, "bin", process.platform === "win32" ? "pi.exe" : "pi");
	writeFileSync(shim, "");
	if (withPackage) writePiPackage(join(rootDir, "install", "global", "node_modules", "@earendil-works", "pi-coding-agent"));
	return shim;
}

test("resolveBunShimSdkEntry 从 bun 全局垫片去 install/global/node_modules 取包", () => {
	withTempDir((dir) => {
		const shim = writeBunLayout(join(dir, "bun"));
		assert.equal(resolveBunShimSdkEntry(shim), join(dir, "bun", "install", "global", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
		// 非 bun 布局（普通 bin 目录）不在这里猜。
		assert.equal(resolveBunShimSdkEntry(join(dir, "npm-prefix", "pi.exe")), undefined);
	});
});

test("resolvePiAuthHostLaunch: bun 全局安装（c:\\Users\\x\\.bun\\bin\\pi.exe）不再报 no-pi-entry", () => {
	withTempDir((dir) => {
		const appPath = writeAppDir(dir);
		const shim = writeBunLayout(join(dir, ".bun"));
		const launch = resolvePiAuthHostLaunch({
			settings: BASE_SETTINGS,
			locator: fakeLocator({ command: shim, windowsLaunch: { channel: "cmd-shim" } }),
			userDataPath: join(dir, "userData"),
			appPath,
			resourcesPath: join(dir, "unused"),
			isPackaged: false,
		});
		// 修复前：垫片不是 .cmd（没得还原）+ 向上找不到 node_modules → no-pi-entry，
		// 输入预测 / 提示词增强 / 登录全部不可用。
		assert.equal(launch.ok, true, `bun 全局安装应能解析出 SDK 入口：${launch.detail}`);
		assert.equal(launch.sdkEntry, join(dir, ".bun", "install", "global", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
		assert.equal(launch.env.PIDECK_PI_SDK_ENTRY, launch.sdkEntry);
	});
});

test("resolvePiAuthHostLaunch: bun 垫片在但 install/global 里没有包时仍报 no-pi-entry", () => {
	withTempDir((dir) => {
		const appPath = writeAppDir(dir);
		const shim = writeBunLayout(join(dir, ".bun"), { withPackage: false });
		const launch = resolvePiAuthHostLaunch({
			settings: BASE_SETTINGS,
			locator: fakeLocator({ command: shim, windowsLaunch: { channel: "cmd-shim" } }),
			userDataPath: join(dir, "userData"),
			appPath,
			resourcesPath: join(dir, "unused"),
			isPackaged: false,
		});
		assert.equal(launch.ok, false);
		assert.equal(launch.reason, "no-pi-entry");
		// 诊断细节保留垫片路径，便于看出装的是什么形态的 pi。
		assert.equal(launch.detail, shim);
	});
});

test("助手运行时：用户 node > 用户 bun > 便携 node（便携目录即使进了 PATH 也排最后）", () => {
	withTempDir((dir) => {
		const appPath = writeAppDir(dir);
		// 非 bun 布局的 pi（npm 全局垫片形态），让运行时选择独立于 SDK 入口解析。
		const prefix = join(dir, "npm-prefix");
		writePiPackage(join(prefix, "node_modules", "@earendil-works", "pi-coding-agent"));
		writeFileSync(join(prefix, "pi.cmd"), "@echo off\n");
		const userDataPath = join(dir, "userData");
		const portableNode = writePortableNode(userDataPath);
		const userNode = writeRuntimeFile(join(dir, "user-bin"), "node");
		const userBun = writeRuntimeFile(join(dir, "bun-bin"), "bun");
		const launchWithPath = (dirs, userData = userDataPath) =>
			resolvePiAuthHostLaunch({
				settings: BASE_SETTINGS,
				locator: fakeLocator({ command: join(prefix, "pi.cmd"), windowsLaunch: { channel: "cmd-shim" }, env: { PATH: dirs.join(delimiter) } }),
				userDataPath: userData,
				appPath,
				resourcesPath: join(dir, "unused"),
				isPackaged: false,
			});

		// 1) 用户的 node 最优先（修复前便携 node 抢在前面）。
		assert.equal(launchWithPath([join(dir, "user-bin"), join(dir, "bun-bin"), portableNode]).nodeExe, userNode);
		// 2) 没有 node：用户自己的 bun 也优先于 PiDeck 便携 node。
		assert.equal(launchWithPath([join(dir, "bun-bin"), portableNode]).nodeExe, userBun);
		// 3) 只有便携 node 时仍然用它兼容—跳过便携目录不能让「本来能用」变成裸命令名。
		assert.equal(launchWithPath([portableNode]).nodeExe, portableNode);
		// 4) 什么都没有（连便携 node 也没装）：交回裸命令名，让 spawn 报 ENOENT，错误仍然可诊断。
		assert.equal(launchWithPath([join(dir, "empty-bin")], join(dir, "no-portable")).nodeExe, process.platform === "win32" ? "node.exe" : "node");
	});
});

test("助手运行时：pi 是 bun 全局安装时用同一份安装的 bun（PATH 上既没 node 也没 bun）", () => {
	withTempDir((dir) => {
		const appPath = writeAppDir(dir);
		const shim = writeBunLayout(join(dir, ".bun"));
		const bunExe = writeRuntimeFile(join(dir, ".bun", "bin"), "bun");
		const launch = resolvePiAuthHostLaunch({
			settings: BASE_SETTINGS,
			locator: fakeLocator({ command: shim, windowsLaunch: { channel: "cmd-shim" }, env: { PATH: join(dir, "empty-bin") } }),
			userDataPath: join(dir, "userData"),
			appPath,
			resourcesPath: join(dir, "unused"),
			isPackaged: false,
		});
		// bun 装了 pi 的机器上常常没有 node（连 PiDeck 便携 node 也没装）：pi 自己跑的 bun 就是最合适的运行时。
		assert.equal(launch.ok, true, `bun 全局安装应能解析出 SDK 入口：${launch.detail}`);
		assert.equal(launch.nodeExe, bunExe);
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
		// npm 全局垫片：Windows 是 pi.cmd，POSIX 是无扩展名的 pi。两个都写，
		// 让本用例在任意平台都能走到「裸命令名 → PATH 解析」这条路径。
		writeFileSync(join(prefix, "pi"), "#!/usr/bin/env node\n");
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

test("resolvePiAuthHostLaunch: 按 proxyModel 套用模型名单，并给出可直接比对的代理指纹", () => {
	withTempDir((dir) => {
		const appPath = writeAppDir(dir);
		const prefix = join(dir, "npm-prefix");
		writePiPackage(join(prefix, "node_modules", "@earendil-works", "pi-coding-agent"));
		writeFileSync(join(prefix, "pi.cmd"), "@echo off\n");
		writeFileSync(join(prefix, "pi"), "#!/usr/bin/env node\n");
		const originalPath = process.env.PATH;
		process.env.PATH = prefix;
		const launchFor = (settings, proxyModel) =>
			resolvePiAuthHostLaunch({
				settings,
				proxyModel,
				locator: fakeLocator({ command: "pi", env: { PATH: prefix } }),
				userDataPath: join(dir, "userData"),
				appPath,
				resourcesPath: join(dir, "unused"),
				isPackaged: false,
			});
		try {
			const base = { ...BASE_SETTINGS, piProxyUrl: "http://127.0.0.1:7890", piProxyBypass: "", piProxyModels: ["kimi-coding/kimi-k2"] };
			// 名单内：全局开关关着也要走代理（与 pi 会话名单语义一致，复用全局 URL）。
			const listed = launchFor(base, { provider: "kimi-coding", modelId: "kimi-k2" });
			assert.equal(listed.ok, true);
			assert.equal(listed.env.HTTPS_PROXY, "http://127.0.0.1:7890");
			assert.equal(listed.env.NODE_USE_ENV_PROXY, "1");
			// 名单外：全局开关开着也强制直连（不注入任何代理键）。
			const unlisted = launchFor({ ...base, piProxyEnabled: true }, { provider: "deepseek", modelId: "deepseek-chat" });
			assert.equal(unlisted.ok, true);
			assert.equal(unlisted.env.HTTPS_PROXY, undefined);
			assert.equal(unlisted.env.NODE_USE_ENV_PROXY, undefined);
			// 指纹必须区分这三种状态：常驻侧车靠它判断能不能复用旧进程。
			assert.notEqual(listed.proxyKey, unlisted.proxyKey);
			const changedUrl = launchFor({ ...base, piProxyUrl: "http://127.0.0.1:7891" }, { provider: "kimi-coding", modelId: "kimi-k2" });
			assert.equal(changedUrl.ok, true);
			assert.notEqual(changedUrl.proxyKey, listed.proxyKey);
			// 名单未启用时跟随全局开关：开关关 = 直连，开关开 = 走代理。
			const followOff = launchFor({ ...base, piProxyEnabled: false, piProxyModels: [] }, { provider: "kimi-coding", modelId: "kimi-k2" });
			const followOn = launchFor({ ...base, piProxyEnabled: true, piProxyModels: [] }, { provider: "kimi-coding", modelId: "kimi-k2" });
			assert.equal(followOff.env.HTTPS_PROXY, undefined);
			assert.equal(followOn.env.HTTPS_PROXY, "http://127.0.0.1:7890");
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
