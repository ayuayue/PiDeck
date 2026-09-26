import { join } from "node:path";

/**
 * 正式版 userData 目录名。
 * 安装版继续用历史 %APPDATA%/pi-desktop，避免改名后读不到旧 settings/projects。
 */
export const PACKAGED_USER_DATA_NAME = "pi-desktop";

/** 便携版把数据放在 exe 同级 data/，与安装版隔离。 */
export const PORTABLE_USER_DATA_DIR_NAME = "data";

export type PackagedUserDataInput = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	appData: string;
};

/**
 * 解析正式包装后的 userData。
 * Windows 便携 exe 由 electron-builder 注入 PORTABLE_EXECUTABLE_DIR；
 * 若仍落到安装版同一目录，同版本单实例锁会让第二次启动静默退出（表现为「点了没反应」）。
 */
export function resolvePackagedUserDataDir(input: PackagedUserDataInput): string {
	const platform = input.platform ?? process.platform;
	const env = input.env ?? process.env;
	const portableDir = env.PORTABLE_EXECUTABLE_DIR?.trim();
	if (platform === "win32" && portableDir) {
		return join(portableDir, PORTABLE_USER_DATA_DIR_NAME);
	}
	return join(input.appData, PACKAGED_USER_DATA_NAME);
}

export type AppUserDataInput = {
	/** e2e 隔离 / --user-data-dir 调试的显式目录；由调用方按 dev/E2E 态门控后传入。 */
	explicitDir?: string;
	/** 未打包调试态的目录（%APPDATA%\pi-desktop-dev[±分支后缀]，由调用方拼好）。 */
	unpackagedDevDir: string;
	isPackaged: boolean;
	appData: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
};

/**
 * 启动期 userData 目录三分判定（index.ts 装配，单测覆盖）：
 * 1. 显式目录优先（e2e 隔离 / 多实例调试，避免读到真实用户数据）；
 * 2. 未打包调试态走 pi-desktop-dev(±分支后缀)，开发数据与发行数据隔离；
 * 3. 打包态——stable 与 dev 通道（PiDeck Dev）安装包**共用**正式数据目录
 *    （pi-desktop / Windows 便携版 exe 同级 data/）。双通道共用数据是刻意决策
 *    （2026-09）：用户在两个通道安装包之间切换不丢 settings/会话/扩展配置。
 *    并行运行依赖「按版本互斥」的单实例锁（instance-locks/<version>.lock）：
 *    stable 与 dev 通道版本号不同即可并存，同版本会复用窗口（见 singleInstance.ts）。
 */
export function resolveAppUserDataDir(input: AppUserDataInput): string {
	if (input.explicitDir) return input.explicitDir;
	if (!input.isPackaged) return input.unpackagedDevDir;
	return resolvePackagedUserDataDir({ appData: input.appData, platform: input.platform, env: input.env });
}
