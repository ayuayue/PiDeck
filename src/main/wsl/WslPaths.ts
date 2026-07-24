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
	constructor(
		readonly code: WslPathErrorCode,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "WslPathError";
	}
}

function normalizeLinuxPath(path: string): string {
	const normalized = normalizePosix(path.replace(/\\/g, "/"));
	if (normalized === "." || normalized === "/") return "/";
	return normalized.replace(/\/+$/, "");
}

function ensureMatchingDistro(actual: string, expected: string): void {
	if (actual.toLowerCase() === expected.toLowerCase()) return;
	throw new WslPathError(
		"WSL_DISTRO_MISMATCH",
		`Selected path belongs to "${actual}", but the active WSL distribution is "${expected}".`,
	);
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
export function normalizeSelectedWslProjectPath(
	path: string,
	environment: Pick<WslEnvironment, "distro">,
): string {
	if (parseWslUncPath(path)) return toWindowsHostPath(path, environment);
	return toWslLinuxPath(path, environment);
}

export function isWslDistroMismatchError(error: unknown): boolean {
	return error instanceof WslPathError
		? error.code === "WSL_DISTRO_MISMATCH"
		: error instanceof Error && error.message.includes("WSL_DISTRO_MISMATCH");
}
