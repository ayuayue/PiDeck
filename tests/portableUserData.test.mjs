/**
 * 启动期 userData 解析（resolveAppUserDataDir 判定）与正式包目录规则；
 * 另覆盖安装版历史根更名（pi-desktop → PiDeck）在启动序列里的位置。
 * - 打包态：shared 模式共用 / channel-dev 模式独立，由决策指针驱动（决策结果由入参传入，纯函数）；
 * - 便携 exe 共用目录落 exe 同级 data/，与安装版隔离，避免同版本单实例锁互相静默退出；
 * - 未打包调试态走 pi-desktop-dev(±分支后缀)；显式目录（e2e/--user-data-dir）优先。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PACKAGED_USER_DATA_NAME, PACKAGED_USER_DATA_NAME_NEW, PORTABLE_USER_DATA_DIR_NAME, resolvePackagedUserDataDir, resolveAppUserDataDir, resolveChannelDevDataDir, isPortablePackagedEnv } = loadTsCommonJs("src/main/portableUserData.ts");

test("安装版 userData 用新名 PiDeck", () => {
	assert.equal(PACKAGED_USER_DATA_NAME_NEW, "PiDeck");
	assert.equal(
		resolvePackagedUserDataDir({
			platform: "win32",
			env: {},
			appData: "C:\\Users\\me\\AppData\\Roaming",
		}),
		join("C:\\Users\\me\\AppData\\Roaming", PACKAGED_USER_DATA_NAME_NEW),
	);
});

test("历史名仍导出（迁移器旧根解析的唯一来源）", () => {
	assert.equal(PACKAGED_USER_DATA_NAME, "pi-desktop");
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
	assert.equal(isPortablePackagedEnv({ PORTABLE_EXECUTABLE_DIR: "D:\\tools\\phids" }, "win32"), true);
});

test("非 Windows 忽略 PORTABLE_EXECUTABLE_DIR", () => {
	assert.equal(
		resolvePackagedUserDataDir({
			platform: "linux",
			env: { PORTABLE_EXECUTABLE_DIR: "/tmp/phids" },
			appData: "/home/me/.config",
		}),
		join("/home/me/.config", PACKAGED_USER_DATA_NAME_NEW),
	);
	assert.equal(isPortablePackagedEnv({ PORTABLE_EXECUTABLE_DIR: "/tmp/phids" }, "linux"), false);
});

test("主进程正式版先跑 userData 更名迁移，再走 resolveAppUserDataDir 判定，启动失败有 catch", () => {
	const src = readFileSync("src/main/index.ts", "utf8");
	assert.match(src, /from "\.\/portableUserData"/);
	// 契约：改名必须发生在 setPath 之前，且迁移结果参与共用目录落点
	assert.match(src, /runUserDataNameMigration\(\{/);
	assert.match(src, /portableOrExplicit:\s*isPortablePackagedEnv\(\)/);
	assert.match(src, /recordUserDataNameMigrationNotice\(userDataNameMigrationResult\)/);
	assert.match(src, /fallbackSharedDir:\s*userDataNameMigrationResult\?\.userDataPath\s*\?\?\s*fallbackSharedDataDir/);
	// 契约：打包态（含 dev 通道安装包）与便携版都经 resolveAppUserDataDir 判定
	assert.match(src, /resolveAppUserDataDir\(\{\s*explicitDir:\s*gatedExplicitUserDataDir,/);
	assert.match(src, /isPackaged:\s*app\.isPackaged,/);
	// 契约：启动顺序（IPC 注册→飞书注册→建窗→首启备份）。中间可插入其他装配（统一接口聚合层、
	// 微信桥、划词浮窗预热等），所以按标记位置比较先后，不用跨大段代码的单一正则（2026-10 多次误红）。
	// 2027-02 性能治理：ensureInitialBackups 的全量 JSON 解析移到 createWindow 之后的 setImmediate，
	// 不再挡首帧（见 src/main/index.ts 就近注释），因此备份排在建窗之后。
	const startupOrder = ["registerIpc();", "registerFeishuIpc({", "await createWindow();", "configBackupManager?.ensureInitialBackups();"].map((marker) => src.indexOf(marker));
	assert.ok(
		startupOrder.every((index) => index > 0),
		"启动关键步骤必须都存在",
	);
	assert.deepEqual(
		[...startupOrder].sort((a, b) => a - b),
		startupOrder,
		"启动顺序必须是 IPC 注册 → 飞书注册 → 建窗 → 首启备份",
	);
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
		join("C:\\Users\\me\\AppData\\Roaming", PACKAGED_USER_DATA_NAME_NEW),
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

test("resolveChannelDevDataDir：安装版 dev 独立目录落 %APPDATA%/PiDeck-channel-dev", () => {
	assert.equal(resolveChannelDevDataDir({ appDataDir: "C:\\Users\\me\\AppData\\Roaming" }), join("C:\\Users\\me\\AppData\\Roaming", "PiDeck-channel-dev"));
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
