/**
 * 启动期 userData 解析（resolveAppUserDataDir 三分支）与正式包目录规则。
 * - 打包态：stable 与 dev 通道（PiDeck Dev）安装包共用正式目录（刻意决策，双包切换不丢配置）；
 * - 便携 exe 落 exe 同级 data/，与安装版隔离，避免同版本单实例锁互相静默退出；
 * - 未打包调试态走 pi-desktop-dev(±分支后缀)；显式目录（e2e/--user-data-dir）优先。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PACKAGED_USER_DATA_NAME, PORTABLE_USER_DATA_DIR_NAME, resolvePackagedUserDataDir, resolveAppUserDataDir } = loadTsCommonJs("src/main/portableUserData.ts");

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
	// 契约：打包态（含 dev 通道安装包）与便携版都经 resolveAppUserDataDir 三分支判定
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
			appData: "C:\\Users\\me\\AppData\\Roaming",
		}),
		"D:\\e2e-profile",
	);
});

test("resolveAppUserDataDir：未打包调试态走 pi-desktop-dev(±分支后缀)", () => {
	assert.equal(
		resolveAppUserDataDir({
			unpackagedDevDir: join("C:\\Users\\me\\AppData\\Roaming", "pi-desktop-dev-feature-x"),
			isPackaged: false,
			appData: "C:\\Users\\me\\AppData\\Roaming",
		}),
		join("C:\\Users\\me\\AppData\\Roaming", "pi-desktop-dev-feature-x"),
	);
});

test("resolveAppUserDataDir：打包态（stable 与 dev 通道安装包）共用 pi-desktop", () => {
	// dev 通道安装包也是打包态：与 stable 共用正式数据目录是刻意决策
	assert.equal(
		resolveAppUserDataDir({
			unpackagedDevDir: join("C:\\Users\\me\\AppData\\Roaming", "pi-desktop-dev"),
			isPackaged: true,
			appData: "C:\\Users\\me\\AppData\\Roaming",
			platform: "win32",
			env: {},
		}),
		join("C:\\Users\\me\\AppData\\Roaming", PACKAGED_USER_DATA_NAME),
	);
});

test("resolveAppUserDataDir：打包态 Windows 便携版落 exe 同级 data/", () => {
	assert.equal(
		resolveAppUserDataDir({
			unpackagedDevDir: join("C:\\Users\\me\\AppData\\Roaming", "pi-desktop-dev"),
			isPackaged: true,
			appData: "C:\\Users\\me\\AppData\\Roaming",
			platform: "win32",
			env: { PORTABLE_EXECUTABLE_DIR: "D:\\tools\\PiDeckDev" },
		}),
		join("D:\\tools\\PiDeckDev", PORTABLE_USER_DATA_DIR_NAME),
	);
});
