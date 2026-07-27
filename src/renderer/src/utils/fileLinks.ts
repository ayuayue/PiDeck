const WINDOWS_DRIVE_PATH_RE = /^\/?[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_RE = /^\\\\[^\\/]+[\\/][^\\/]+/;
const RELATIVE_PATH_RE = /^(?:\.\.?[\\/]|[^\\/:*?"<>|]+[\\/])/;
const FILE_EXTENSION_RE = /\.[A-Za-z0-9][A-Za-z0-9._-]*(?::\d+(?::\d+)?)?$/;

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function stripFileLocation(path: string): string {
	return path.replace(/:\d+(?::\d+)?$/, "");
}

export function normalizeLocalFilePath(value: string): string | null {
	if (!value) return null;

	let path = value.startsWith("file://")
		? safeDecode(value.slice(7))
		: safeDecode(value);

	// Pi agents commonly emit /C:/... links so one Markdown form works across renderers.
	if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);

	const withoutLocation = stripFileLocation(path);
	const isWindowsPath = WINDOWS_DRIVE_PATH_RE.test(path) || WINDOWS_UNC_PATH_RE.test(path);
	const isUnixPath = path.startsWith("/") && !path.startsWith("//");
	const isRelativePath = RELATIVE_PATH_RE.test(path);
	const isBareFileName =
		!withoutLocation.includes(":") &&
		!withoutLocation.includes("#") &&
		!/[\\/]/.test(withoutLocation) &&
		FILE_EXTENSION_RE.test(path);
	const hasFileName = FILE_EXTENSION_RE.test(path);

	if (isWindowsPath || WINDOWS_UNC_PATH_RE.test(withoutLocation)) return path;
	if ((isUnixPath || isRelativePath) && hasFileName) return path;
	if (isBareFileName) return path;
	return null;
}

export function toInternalFileHref(value: string): string | null {
	const path = normalizeLocalFilePath(value);
	return path === null ? null : `file://${encodeURIComponent(path)}`;
}

export function filePathFromHref(href: string | undefined): string | null {
	if (!href?.startsWith("file://")) return null;
	return normalizeLocalFilePath(href);
}
