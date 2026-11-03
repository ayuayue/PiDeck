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
		return linuxPathToWslUnc(unc.linuxPath, environment.distro);
	}

	const drive = path.match(/^([A-Za-z]):(?:[\\/](.*))?$/);
	if (drive) {
		const suffix = drive[2]?.replace(/[\\/]+/g, "\\") ?? "";
		return `${drive[1].toUpperCase()}:\\${suffix}`.replace(/\\+$/, suffix ? "" : "\\");
	}

	const mountedDrive = path.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
	if (mountedDrive) {
		const suffix = mountedDrive[2]?.replace(/\//g, "\\") ?? "";
		return `${mountedDrive[1].toUpperCase()}:\\${suffix}`.replace(/\\+$/, suffix ? "" : "\\");
	}

	if (/^[\\/]{2}/.test(path)) {
		throw new WslPathError("INVALID_WSL_PATH", `Unsupported network path "${path}".`);
	}
	if (path.startsWith("/")) return linuxPathToWslUnc(path, environment.distro);

	throw new WslPathError("INVALID_WSL_PATH", `Cannot convert relative path "${path}" for Windows access.`);
}

/** Keeps the existing /mnt storage convention while preserving WSL-internal projects as UNC. */
export function normalizeSelectedWslProjectPath(path: string, environment: Pick<WslEnvironment, "distro">): string {
	if (parseWslUncPath(path)) return toWindowsHostPath(path, environment);
	return toWslLinuxPath(path, environment);
}

/**
 * 按路径添加项目（右键菜单 / 快捷任务，不经目录选择框）时的 WSL 归一。
 *
 * 这三个入口拿到的是现成路径，可能是 `\\wsl.localhost\<distro>\...`、WSL 内的绝对
 * Linux 路径（/home、/root、/mnt/d），也可能根本是宿主盘符目录。返回规范 UNC 供入库；
 * 返回 null 表示“不是 WSL 路径”，由调用方决定当 Windows 项目还是直接拒绝——
 * 早先这类路径一律按 windows 环境入库，WSL 模式下会被可见性过滤掉（添加了却找不到）。
 * 发行版不匹配抛 WSL_DISTRO_MISMATCH。
 */
export function normalizeWslProjectAddPath(path: string, distro: string): string | null {
	const trimmed = path.trim();
	const unc = parseWslUncPath(trimmed);
	if (unc) {
		ensureMatchingDistro(unc.distro, distro);
		return linuxPathToWslUnc(unc.linuxPath, distro);
	}
	if (trimmed.startsWith("/")) return linuxPathToWslUnc(trimmed, distro);
	return null;
}

export function isWslDistroMismatchError(error: unknown): boolean {
	return error instanceof WslPathError ? error.code === "WSL_DISTRO_MISMATCH" : error instanceof Error && error.message.includes("WSL_DISTRO_MISMATCH");
}
