/**
 * 第 12 步（Wave 1）：项目级 WSL 身份解析。
 *
 * 项目自带 `wslDistro` / `wslUser` 时优先使用；缺省字段回退全局设置（兼容一个版本，第 14 步删除）。
 * 这里只做纯解析，不启动 wsl.exe、不读磁盘；调用方拿到的仍是「用户/发行版」字符串。
 */
export type WslProjectLike = {
	environment?: "windows" | "wsl";
	wslDistro?: string;
	wslUser?: string;
	wslHostId?: string;
};

export type WslSettingsLike = {
	wslEnabled?: boolean;
	wslDistro?: string;
	wslUser?: string;
};

export type WslProjectIdentity = { distro: string; user: string; hostId?: string };

/** 全局 WSL 来源只有这三项会改变资源目录与 spawn 环境。 */
export function hasWslSettingsChanged(previous: WslSettingsLike, next: WslSettingsLike): boolean {
	return previous.wslEnabled !== next.wslEnabled || previous.wslDistro !== next.wslDistro || previous.wslUser !== next.wslUser;
}

export function resolveProjectWslIdentity(project: WslProjectLike | undefined, settings: WslSettingsLike): WslProjectIdentity | undefined {
	if (project?.environment !== "wsl") return undefined;
	const distro = (project.wslDistro ?? settings.wslDistro ?? "").trim();
	const user = (project.wslUser ?? settings.wslUser ?? "").trim();
	if (distro.length === 0 || user.length === 0) return undefined;
	return { distro, user, ...(project.wslHostId !== undefined ? { hostId: project.wslHostId } : {}) };
}

/**
 * 应用唯一的 WSL 身份（开发设置里的 enabled/distro/user）。
 *
 * 配置/资源页的 WSL 目标就指这一个环境：关掉开关、缺 distro 或 user 一律返回 undefined，
 * 调用方 fail closed（不退回本机目录），而不是按某个项目或「上次选中的档案」猜。
 */
export function resolveSettingsWslIdentity(settings: WslSettingsLike): { distro: string; user: string } | undefined {
	if (settings.wslEnabled !== true) return undefined;
	const distro = (settings.wslDistro ?? "").trim();
	const user = (settings.wslUser ?? "").trim();
	if (distro.length === 0 || user.length === 0) return undefined;
	return { distro, user };
}
