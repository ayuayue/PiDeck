import { normalize as normalizePosix } from "node:path/posix";

export type WslEnvironment = {
	distro: string;
	user: string;
	linuxHome: string;
	windowsHome: string;
};

export type ParsedWslUncPath = {
	distro: string;
	linuxPath: string;
};

export type WslPathErrorCode = "WSL_DISTRO_MISMATCH" | "INVALID_WSL_PATH";

export class WslPathError extends Error {
	/** 不用构造器参数属性：本模块经 gitWsl→gitRun→rewind checkpointCore 被
	 *  tests/*.test.mjs 用 Node type stripping 直接加载，参数属性在 strip-only
	 *  模式下是语法错误（ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）。 */
	readonly code: WslPathErrorCode;
	constructor(code: WslPathErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "WslPathError";
		this.code = code;
	}
}

function normalizeLinuxPath(path: string): string {
	const normalized = normalizePosix(path.replace(/\\/g, "/"));
	if (normalized === "." || normalized === "/") return "/";
	return normalized.replace(/\/+$/, "");
}

function ensureMatchingDistro(actual: string, expected: string): void {
	if (actual.toLowerCase() === expected.toLowerCase()) return;
	throw new WslPathError("WSL_DISTRO_MISMATCH", `Selected path belongs to "${actual}", but the active WSL distribution is "${expected}".`);
}

/** Parses both \\wsl$ and \\wsl.localhost, including legacy forward-slash forms. */
export function parseWslUncPath(path: string): ParsedWslUncPath | null {
	const match = path.match(/^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i);
	if (!match) return null;
	const remainder = match[2]?.replace(/[\\/]+/g, "/") ?? "";
	return {
		distro: match[1],
		linuxPath: normalizeLinuxPath(`/${remainder}`),
	};
}

export function linuxPathToWslUnc(path: string, distro: string): string {
	if (!path.startsWith("/")) {
		throw new WslPathError("INVALID_WSL_PATH", `Expected an absolute Linux path, received "${path}".`);
	}
	const normalized = normalizeLinuxPath(path);
	const suffix = normalized === "/" ? "" : normalized.replace(/^\//, "").replace(/\//g, "\\");
	return `\\\\wsl.localhost\\${distro}${suffix ? `\\${suffix}` : ""}`;
}

/**
 * `/mnt/<盘符>[/子路径]` → `X:\子路径`，其余 Linux 路径返回 null。
 *
 * drvfs 挂载点在 Windows 侧**走不通 9P**：`\\wsl.localhost\<distro>\mnt\c\...` 的
 * stat 直接 EPERM，拿它当子进程 cwd 则 spawn ENOENT。凡是 `/mnt` 下的路径，宿主侧
 * 一律用盘符路径表达（同一个文件，但不经 9P）。
 */
export function mountedDriveToWindowsPath(linuxPath: string): string | null {
	const mountedDrive = linuxPath.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
	if (!mountedDrive) return null;
	const suffix = mountedDrive[2]?.replace(/\/+$/, "").replace(/\//g, "\\") ?? "";
	return `${mountedDrive[1].toUpperCase()}:\\${suffix}`.replace(/\\+$/, suffix ? "" : "\\");
}

export function createWslEnvironment(distro: string, user: string, linuxHome: string): WslEnvironment {
	if (!linuxHome || !linuxHome.startsWith("/")) {
		throw new WslPathError("INVALID_WSL_PATH", `WSL HOME must be absolute, received "${linuxHome}".`);
	}
	const normalizedHome = normalizeLinuxPath(linuxHome);
	return {
		distro,
		user,
		linuxHome: normalizedHome,
		windowsHome: linuxPathToWslUnc(normalizedHome, distro),
	};
}

export function toWslLinuxPath(path: string, environment: Pick<WslEnvironment, "distro">): string {
	if (!path) throw new WslPathError("INVALID_WSL_PATH", "Path is empty.");

	const unc = parseWslUncPath(path);
	if (unc) {
		ensureMatchingDistro(unc.distro, environment.distro);
		return unc.linuxPath;
	}

	const drive = path.match(/^([A-Za-z]):(?:[\\/](.*))?$/);
	if (drive) {
		const suffix = drive[2]?.replace(/[\\/]+/g, "/") ?? "";
		return normalizeLinuxPath(`/mnt/${drive[1].toLowerCase()}/${suffix}`);
	}

	if (/^[\\/]{2}/.test(path)) {
		throw new WslPathError("INVALID_WSL_PATH", `Unsupported network path "${path}".`);
	}
	if (path.startsWith("/")) return normalizeLinuxPath(path);

	throw new WslPathError("INVALID_WSL_PATH", `Cannot convert relative path "${path}" to WSL.`);
}

export function toWindowsHostPath(path: string, environment: Pick<WslEnvironment, "distro">): string {
	if (!path) throw new WslPathError("INVALID_WSL_PATH", "Path is empty.");

	const unc = parseWslUncPath(path);
	if (unc) {
		ensureMatchingDistro(unc.distro, environment.distro);
		// drvfs 在 Windows 侧不走 9P（stat EPERM、spawn cwd ENOENT），换成盘符路径。
		return mountedDriveToWindowsPath(unc.linuxPath) ?? linuxPathToWslUnc(unc.linuxPath, environment.distro);
	}

	const drive = path.match(/^([A-Za-z]):(?:[\\/](.*))?$/);
	if (drive) {
		const suffix = drive[2]?.replace(/[\\/]+/g, "\\") ?? "";
		return `${drive[1].toUpperCase()}:\\${suffix}`.replace(/\\+$/, suffix ? "" : "\\");
	}

	const mountedDrive = mountedDriveToWindowsPath(path);
	if (mountedDrive) return mountedDrive;

	if (/^[\\/]{2}/.test(path)) {
		throw new WslPathError("INVALID_WSL_PATH", `Unsupported network path "${path}".`);
	}
	if (path.startsWith("/")) return linuxPathToWslUnc(path, environment.distro);

	throw new WslPathError("INVALID_WSL_PATH", `Cannot convert relative path "${path}" for Windows access.`);
}

/**
 * 选中项目的入库形态：发行版内路径（/home、/root）保留 Linux 路径或规范 UNC，
 * drvfs（`/mnt/<盘符>`）一律用宿主盘符路径——Windows 侧打不开 `/mnt` 的 9P 映射，
 * 存下去就是「目录不存在 + Git 不可用 + 会话启动失败」。
 */
export function normalizeSelectedWslProjectPath(path: string, environment: Pick<WslEnvironment, "distro">): string {
	const linuxPath = toWslLinuxPath(path, environment);
	const mountedDrive = mountedDriveToWindowsPath(linuxPath);
	if (mountedDrive) return mountedDrive;
	return parseWslUncPath(path) ? linuxPathToWslUnc(linuxPath, environment.distro) : linuxPath;
}

/**
 * 按路径添加项目（右键菜单 / 快捷任务，不经目录选择框）时的 WSL 归一。
 *
 * 这三个入口拿到的是现成路径，可能是 `\\wsl.localhost\<distro>\...`、WSL 内的绝对
 * Linux 路径（/home、/root、/mnt/d），也可能根本是宿主盘符目录。返回规范 UNC（drvfs
 * 例外：返回宿主盘符路径，见 mountedDriveToWindowsPath）供入库；
 * 返回 null 表示“不是 WSL 路径”，由调用方决定当 Windows 项目还是直接拒绝——
 * 早先这类路径一律按 windows 环境入库，WSL 模式下会被可见性过滤掉（添加了却找不到）。
 * 发行版不匹配抛 WSL_DISTRO_MISMATCH。
 */
export function normalizeWslProjectAddPath(path: string, distro: string): string | null {
	const trimmed = path.trim();
	const wslForm = (linuxPath: string) => mountedDriveToWindowsPath(normalizeLinuxPath(linuxPath)) ?? linuxPathToWslUnc(linuxPath, distro);
	const unc = parseWslUncPath(trimmed);
	if (unc) {
		ensureMatchingDistro(unc.distro, distro);
		return wslForm(unc.linuxPath);
	}
	if (trimmed.startsWith("/")) return wslForm(trimmed);
	return null;
}

export function isWslDistroMismatchError(error: unknown): boolean {
	return error instanceof WslPathError ? error.code === "WSL_DISTRO_MISMATCH" : error instanceof Error && error.message.includes("WSL_DISTRO_MISMATCH");
}
