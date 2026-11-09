/**
 * macOS 运行时签名探测：当前 .app 是否由 Developer ID Application 证书签名。
 *
 * 用途只有一个——决定更新交付模式（deliveryPlan.ts）：MacUpdater/Squirrel.Mac 替换包时会校验
 * 签名，ad-hoc 发行物走应用内更新必定在安装阶段失败，必须退回手动下载。
 *
 * 为什么用 codesign 而不是构建期标记：签名在 electron-builder 阶段才发生，vite 构建时不知道；
 * 配置说「签了」但实际被跳过的事故（#347）正是产物与配置脱节造成的，所以看产物本身。
 * `codesign -dv` 本地执行、无网络，典型耗时几十毫秒，只在主进程装配更新服务时跑一次；
 * 任何异常（非 mac、未打包、codesign 缺失、超时）一律判 false → manual，fail-closed 到更保守的路径。
 */

import { spawnSync } from "node:child_process";
import { posix } from "node:path";

/** 从 `codesign -dv --verbose=2` 输出判断是否 Developer ID Application 叶子证书签名。 */
export function parseDeveloperIdSignature(output: string): boolean {
	return /^Authority=Developer ID Application:/m.test(String(output ?? ""));
}

/** `/Applications/PiDeck.app/Contents/MacOS/PiDeck` → `/Applications/PiDeck.app`。不是 bundle 布局时返回 null。 */
export function resolveAppBundlePath(execPath: string): string | null {
	// bundle 布局是 macOS 的 POSIX 路径；固定用 posix 实现，跨平台单测才能得到与产线一致的结论
	// （默认 path.resolve 在 Windows 上会把 /Applications 改写成当前盘符 + 反斜杠）。
	const bundle = posix.resolve(execPath, "..", "..", "..");
	return bundle.endsWith(".app") ? bundle : null;
}

export type DetectMacDeveloperIdSignatureDeps = {
	platform?: NodeJS.Platform;
	isPackaged?: boolean;
	execPath?: string;
	/** 测试注入：返回 codesign 合并后的 stdout+stderr（codesign 把 -dv 信息写到 stderr）。 */
	runCodesign?: (appPath: string) => string;
};

/** codesign -dv 的描述写在 stderr 且退出码为 0——spawnSync 才能同时拿到两路输出（execFileSync 成功时丢 stderr）。 */
function defaultRunCodesign(appPath: string): string {
	const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=2", appPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`codesign inspection failed (${result.status ?? result.signal})`);
	return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/**
 * 同步探测：仅 macOS + 已打包时真的跑 codesign，其它情况直接 false。
 * 同步是因为 UpdateService 在主进程 registerIpc() 同步装配期就要知道交付模式。
 */
export function detectMacDeveloperIdSignature(deps: DetectMacDeveloperIdSignatureDeps = {}): boolean {
	const platform = deps.platform ?? process.platform;
	const isPackaged = deps.isPackaged ?? false;
	if (platform !== "darwin" || !isPackaged) return false;
	const appPath = resolveAppBundlePath(deps.execPath ?? process.execPath);
	if (!appPath) return false;
	try {
		const run = deps.runCodesign ?? defaultRunCodesign;
		return parseDeveloperIdSignature(run(appPath));
	} catch {
		return false;
	}
}
