import { isAbsolute } from "node:path";

/**
 * 用户自己添加的 pi 候选路径的清洗与校验（纯函数，配 tests/piCustomPaths.test.mjs）。
 *
 * 为什么要单独一层：这批路径来自渲染层的输入框与文件选择器，属于**不可信输入**，
 * 会被写进 settings 并用于列表展示与「切换到这份」。核心约束：
 * - 只接受绝对路径或 `wsl://` 标记（相对路径在 PiDeck 里没有意义，且会让检测链路走错分支）；
 * - 去重（Windows 下大小写不敏感，与其他配置项的处理一致）；
 * - 有条数上限，避免手工改 settings.json 或渲染层异常时把设置文件和列表撑爆。
 *
 * 注意：本函数只回答「能不能存」，不做「能不能跑」——可执行性由 PiLocator.validateCustomPath
 * 实跑 `--version` 判定，两者刻意分开（存一份暂时失效的路径是允许的，用户之后可以修）。
 */

/** 候选路径上限：够用且能挡住爆炸式脏数据。 */
export const PI_CUSTOM_PATHS_LIMIT = 20;
/** 单条路径长度上限：Linux PATH_MAX 是 4096，留出余量即可。 */
const PI_CUSTOM_PATH_MAX_LENGTH = 4096;

export type PiCustomPathsSanitizeResult = {
	/** 清洗后的结果（保序、去重、已剔除非法项） */
	paths: string[];
	/** 被丢弃的原始输入（供调用方记日志/回显，不写进设置） */
	rejected: string[];
};

/** 是否为可接受的路径形态：绝对路径（POSIX / Windows 盘符 / UNC）或 `wsl://` 标记。 */
export function isAcceptablePiCustomPath(value: string): boolean {
	if (value.startsWith("wsl://")) return true;
	if (isAbsolute(value)) return true;
	// Windows 盘符路径：node:path 的 isAbsolute 在当前平台语义下判断，
	// 用户在 Windows 上粘贴 `D:\pi\pi.cmd`、在 Linux 上粘贴 `/opt/pi` 都要能存下来。
	return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value);
}

function dedupeKey(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value;
}

/**
 * 清洗任意输入为合法的候选路径数组。
 * 非数组一律当空数组处理（渲染层未初始化时可能传 undefined）。
 */
export function sanitizePiCustomPaths(input: unknown, platform: NodeJS.Platform = process.platform): PiCustomPathsSanitizeResult {
	if (!Array.isArray(input)) return { paths: [], rejected: [] };
	const paths: string[] = [];
	const rejected: string[] = [];
	const seen = new Set<string>();
	for (const raw of input) {
		if (typeof raw !== "string") {
			rejected.push(String(raw));
			continue;
		}
		const value = raw.trim();
		if (!value || value.length > PI_CUSTOM_PATH_MAX_LENGTH || !isAcceptablePiCustomPath(value)) {
			rejected.push(value);
			continue;
		}
		const key = platform === "win32" ? value.toLowerCase() : value;
		if (seen.has(key)) continue; // 重复项静默合并，不算拒绝
		seen.add(key);
		paths.push(value);
		if (paths.length >= PI_CUSTOM_PATHS_LIMIT) break;
	}
	return { paths, rejected };
}

/** 从数组里移除一条路径（Windows 下大小写不敏感），供「移除」操作使用。 */
export function removePiCustomPath(paths: readonly string[], target: string, platform: NodeJS.Platform = process.platform): string[] {
	const key = platform === "win32" ? target.trim().toLowerCase() : target.trim();
	return paths.filter((path) => (platform === "win32" ? path.trim().toLowerCase() : path.trim()) !== key);
}

/**
 * 新增/替换一条路径：同 key 视为同一条（原地更新，保留位置），否则追加。
 * 「编辑自定义路径」与「添加」都走这里，行为一致且可测。
 */
export function upsertPiCustomPath(paths: readonly string[], next: string, platform: NodeJS.Platform = process.platform): string[] {
	const sanitized = sanitizePiCustomPaths([...paths, next], platform);
	return sanitized.paths;
}
