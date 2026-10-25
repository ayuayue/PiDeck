import { statSync } from "node:fs";
import { join } from "node:path";

export type AppTimes = {
	/** 打包构建时间（ISO）；开发态为 package.json 写入时间。 */
	buildTime?: string;
	/** 安装时间（ISO，仅打包态）；安装/升级复制 exe 时由系统更新其 mtime。 */
	installedAt?: string;
};

/**
 * 取文件 mtime 的 ISO 字符串；文件不存在/不可读时返回 undefined。
 * 这就是版本展示的“时间来源”——目录项 mtime 恰好对应打包/安装动作发生的时刻。
 */
function mtimeIso(filePath: string): string | undefined {
	try {
		const stat = statSync(filePath);
		return stat.isFile() ? new Date(stat.mtimeMs).toISOString() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 解析「关于」面板的两个时间戳：
 * - 打包态：buildTime = resources/app.asar 的 mtime（NSIS/zip 打包完成时刻，随包分发不变）；
 *   installedAt = 可执行文件 mtime（Windows 安装版升级时覆盖写入，macOS 同理按 .app 替换）。
 * - 开发态：只有 buildTime = 项目 package.json mtime（避免 execPath 是 Electron 壳，误报安装时间）。
 */
export function resolveAppTimes(input: { isPackaged: boolean; resourcesPath: string; appPath: string; execPath: string }): AppTimes {
	if (input.isPackaged) {
		return {
			buildTime: mtimeIso(join(input.resourcesPath, "app.asar")),
			installedAt: mtimeIso(input.execPath),
		};
	}
	// 开发态：优先 electron-vite 构建产物（out/main/index.js 的 mtime ≈ 最近一次构建时刻，
	// 最接近「打包时间」语义）；无产物时退回 package.json 写入时间（源码更新时刻）。
	const buildOutput = join(input.appPath, "out", "main", "index.js");
	return { buildTime: mtimeIso(buildOutput) ?? mtimeIso(join(input.appPath, "package.json")) };
}
