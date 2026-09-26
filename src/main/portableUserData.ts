import { join } from "node:path";
import type { UpdateChannel } from "../shared/types/app";
import type { DataEnvMode } from "../shared/types/dataEnv";

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

export interface AppUserDataInput {
	/** e2e 隔离 / --user-data-dir 调试的显式目录；由调用方按 dev/E2E 态门控后传入。 */
	explicitDir?: string;
	isPackaged: boolean;
	/** 未打包调试态的目录（%APPDATA%\pi-desktop-dev[±分支后缀]，由调用方拼好）。 */
	unpackagedDevDir: string;
	/** 当前构建通道（任务 2 的 UpdateChannel）。 */
	channel: UpdateChannel;
	/** dev 决策指针的 dataMode；无决策为 null。stable 恒为 null。 */
	devDataMode: DataEnvMode | null;
	/** dev 独立数据目录（由 resolveChannelDevDataDir 预先算好传入，保持本函数纯净）。 */
	channelDevDataDir: string;
	/** 共用目录（打包态原 resolvePackagedUserDataDir 结果）。 */
	fallbackSharedDir: string;
}

/**
 * 启动期 userData 目录判定（index.ts 装配，单测覆盖；决策结果由入参传入，本函数保持纯函数）：
 * 1. 显式目录优先（e2e 隔离 / 多实例调试，避免读到真实用户数据）；
 * 2. 未打包调试态走 pi-desktop-dev(±分支后缀)，开发数据与发行数据隔离；
 * 3. 打包态——shared 模式共用 / channel-dev 模式独立，由决策指针驱动：
 *    仅 dev 构建且决策为 channel-dev 时落独立目录（resolveChannelDevDataDir），
 *    无决策（首启前的临时会话）与 shared 决策均落共用目录（fallbackSharedDir，
 *    即原 resolvePackagedUserDataDir 结果）。并行运行仍依赖「按版本互斥」的
 *    单实例锁（instance-locks/<version>.lock，见 singleInstance.ts）。
 */
export function resolveAppUserDataDir(input: AppUserDataInput): string {
	if (input.explicitDir) return input.explicitDir;
	if (!input.isPackaged) return input.unpackagedDevDir;
	// 仅 dev 构建且用户已选独立环境时才分流；无决策（首启前的临时会话）与 shared 均落共用目录。
	if (input.channel === "dev" && input.devDataMode === "channel-dev") return input.channelDevDataDir;
	return input.fallbackSharedDir;
}

/** dev 独立数据目录：安装版 %APPDATA%/pi-desktop-channel-dev；便携版 exe 同级 data-channel-dev/。 */
export function resolveChannelDevDataDir(env: { appDataDir: string; portableExeDir?: string }): string {
	if (env.portableExeDir) return join(env.portableExeDir, "data-channel-dev");
	return join(env.appDataDir, "pi-desktop-channel-dev");
}
