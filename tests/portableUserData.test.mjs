/**
 * 启动期 userData 解析（resolveAppUserDataDir 判定）与正式包目录规则。
 * - 打包态：shared 模式共用 / channel-dev 模式独立，由决策指针驱动（决策结果由入参传入，纯函数）；
 * - 便携 exe 共用目录落 exe 同级 data/，与安装版隔离，避免同版本单实例锁互相静默退出；
 * - 未打包调试态走 pi-desktop-dev(±分支后缀)；显式目录（e2e/--user-data-dir）优先。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PACKAGED_USER_DATA_NAME, PORTABLE_USER_DATA_DIR_NAME, resolvePackagedUserDataDir, resolveAppUserDataDir, resolveChannelDevDataDir } = loadTsCommonJs("src/main/portableUserData.ts");

test("安装版仍用历史 %APPDATA%/pi-desktop", () => {
	assert.equal(
		resolvePackagedUserDataDir({
			platform: "win32",
			env: {},
			appData: "C:\\Users\\me\\AppData\\Roaming",
		}),
		join("C:\\Users\\me\\AppData\\Roaming", PACKAGED_USER_DATA_NAME),
	);
});

test("Windows 便携 exe 落到 exe 同级 data/，不与安装版抢锁", () => {
	assert.equal(
		resolvePackagedUserDataDir({
			platform: "win32",
			env: { PORTABLE_EXECUTABLE_DIR: "D:\\tools\\phids" },
			appData: "C:\\Users\\me\\AppData\\Roaming",
		}),
		join("D:\\tools\\phids", PORTABLE_USER_DATA_DIR_NAME),
	);
});

test("非 Windows 忽略 PORTABLE_EXECUTABLE_DIR", () => {
	assert.equal(
		resolvePackagedUserDataDir({
			platform: "linux",
			env: { PORTABLE_EXECUTABLE_DIR: "/tmp/phids" },
			appData: "/home/me/.config",
		}),
		join("/home/me/.config", PACKAGED_USER_DATA_NAME),
	);
});

test("主进程正式版走 resolveAppUserDataDir，启动失败有 catch", () => {
	const src = readFileSync("src/main/index.ts", "utf8");
	assert.match(src, /from "\.\/portableUserData"/);
	// 契约：打包态（含 dev 通道安装包）与便携版都经 resolveAppUserDataDir 判定
	assert.match(src, /resolveAppUserDataDir\(\{\s*explicitDir:\s*gatedExplicitUserDataDir,/);
	assert.match(src, /isPackaged:\s*app\.isPackaged,/);
	assert.match(src, /registerIpc\(\);\s*registerFeishuIpc\(\);\s*(?:\/\/[^\n]*\n\s*)*configBackupManager\?\.ensureInitialBackups\(\);\s*await createWindow\(\);/s);
	assert.match(src, /Application startup failed/);
	assert.match(src, /showErrorBox/);
});

test("resolveAppUserDataDir：显式目录优先（e2e / --user-data-dir 调试）", () => {
	assert.equal(
		resolveAppUserDataDir({
			explicitDir: "D:\\e2e-profile",
			unpackagedDevDir: join("C:\\Users\\me\\AppData\\Roaming", "pi-desktop-dev"),
			isPackaged: true,
			channel: "dev",
			devDataMode: "channel-dev",
			channelDevDataDir: "D:\\independent",
			fallbackSharedDir: "D:\\shared",
		}),
		"D:\\e2e-profile",
	);
});

test("resolveAppUserDataDir：未打包调试态走 pi-desktop-dev(±分支后缀)，不读决策", () => {
	assert.equal(
		resolveAppUserDataDir({
			unpackagedDevDir: join("C:\\Users\\me\\AppData\\Roaming", "pi-desktop-dev-feature-x"),
			isPackaged: false,
			channel: "dev",
			devDataMode: "channel-dev",
			channelDevDataDir: "D:\\independent",
			fallbackSharedDir: "D:\\shared",
		}),
		join("C:\\Users\\me\\AppData\\Roaming", "pi-desktop-dev-feature-x"),
	);
});

test("dev 打包态 + 决策 channel-dev → 独立目录", () => {
	const dir = resolveAppUserDataDir({
		unpackagedDevDir: join("C:\\Users\\me\\AppData\\Roaming", "pi-desktop-dev"),
		isPackaged: true,
		channel: "dev",
		devDataMode: "channel-dev",
		channelDevDataDir: "/appdata/pi-desktop-channel-dev",
		fallbackSharedDir: "/appdata/pi-desktop",
	});
	assert.equal(dir, "/appdata/pi-desktop-channel-dev");
});

test("dev 打包态 + 无决策或 shared → 共用目录", () => {
	assert.equal(resolveAppUserDataDir({ unpackagedDevDir: "/dev", isPackaged: true, channel: "dev", devDataMode: null, channelDevDataDir: "/d", fallbackSharedDir: "/s" }), "/s");
	assert.equal(resolveAppUserDataDir({ unpackagedDevDir: "/dev", isPackaged: true, channel: "dev", devDataMode: "shared", channelDevDataDir: "/d", fallbackSharedDir: "/s" }), "/s");
});

test("resolveAppUserDataDir：stable 打包态 → 共用目录（不读决策）", () => {
	// stable 通道即使数据目录里有 channel-dev 决策也落共用目录：分流只对 dev 构建生效
	assert.equal(
		resolveAppUserDataDir({
			unpackagedDevDir: join("C:\\Users\\me\\AppData\\Roaming", "pi-desktop-dev"),
			isPackaged: true,
			channel: "stable",
			devDataMode: "channel-dev",
			channelDevDataDir: join("C:\\Users\\me\\AppData\\Roaming", "pi-desktop-channel-dev"),
			fallbackSharedDir: resolvePackagedUserDataDir({
				platform: "win32",
				env: {},
				appData: "C:\\Users\\me\\AppData\\Roaming",
			}),
		}),
		join("C:\\Users\\me\\AppData\\Roaming", PACKAGED_USER_DATA_NAME),
	);
});

test("resolveAppUserDataDir：打包态便携版 shared 决策 → 共用目录（exe 同级 data/）", () => {
	// fallbackSharedDir 是打包态原 resolvePackagedUserDataDir 结果：便携共用行为由入参保持
	assert.equal(
		resolveAppUserDataDir({
			unpackagedDevDir: join("C:\\Users\\me\\AppData\\Roaming", "pi-desktop-dev"),
			isPackaged: true,
			channel: "dev",
			devDataMode: "shared",
			channelDevDataDir: join("D:\\tools\\PiDeckDev", "data-channel-dev"),
			fallbackSharedDir: resolvePackagedUserDataDir({
				platform: "win32",
				env: { PORTABLE_EXECUTABLE_DIR: "D:\\tools\\PiDeckDev" },
				appData: "C:\\Users\\me\\AppData\\Roaming",
			}),
		}),
		join("D:\\tools\\PiDeckDev", PORTABLE_USER_DATA_DIR_NAME),
	);
});

test("resolveChannelDevDataDir：便携版 dev 独立目录落 exe 同级 data-channel-dev/", () => {
	assert.equal(resolveChannelDevDataDir({ appDataDir: "C:\\Users\\me\\AppData\\Roaming", portableExeDir: "D:\\tools\\PiDeckDev" }), join("D:\\tools\\PiDeckDev", "data-channel-dev"));
});

test("resolveChannelDevDataDir：安装版 dev 独立目录落 %APPDATA%/pi-desktop-channel-dev", () => {
	assert.equal(resolveChannelDevDataDir({ appDataDir: "C:\\Users\\me\\AppData\\Roaming" }), join("C:\\Users\\me\\AppData\\Roaming", "pi-desktop-channel-dev"));
});

test("resolveAppUserDataDir：dev 打包态便携版 + 决策 channel-dev → exe 同级 data-channel-dev/", () => {
	const exeDir = "D:\\tools\\PiDeckDev";
	assert.equal(
		resolveAppUserDataDir({
			unpackagedDevDir: join("C:\\Users\\me\\AppData\\Roaming", "pi-desktop-dev"),
			isPackaged: true,
			channel: "dev",
			devDataMode: "channel-dev",
			channelDevDataDir: resolveChannelDevDataDir({ appDataDir: "C:\\Users\\me\\AppData\\Roaming", portableExeDir: exeDir }),
			fallbackSharedDir: resolvePackagedUserDataDir({
				platform: "win32",
				env: { PORTABLE_EXECUTABLE_DIR: exeDir },
				appData: "C:\\Users\\me\\AppData\\Roaming",
			}),
		}),
		join(exeDir, "data-channel-dev"),
	);
});
