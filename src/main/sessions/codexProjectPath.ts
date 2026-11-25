import { mountedDriveToWindowsPath, parseWslUncPath } from "../wsl/WslPaths";

export function codexProjectPathKey(path?: string): string {
	const cwd = String(path ?? "");
	const wsl = parseWslUncPath(cwd);
	if (wsl && mountedDriveToWindowsPath(wsl.linuxPath) === null) {
		return `//wsl.localhost/${wsl.distro.toLowerCase()}${wsl.linuxPath}`;
	}
	// cwd 可能来自另一平台。仅 Windows 盘符和共享路径忽略大小写，POSIX 目录名按原样比较。
	const windowsPath = /^[a-z]:[\\/]/i.test(cwd) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(cwd);
	const normalized = windowsPath ? cwd.replace(/\\/g, "/").toLowerCase() : cwd;
	return normalized.replace(/\/+$/, "");
}
