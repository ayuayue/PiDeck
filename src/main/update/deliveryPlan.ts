/**
 * 应用更新交付模式判定（纯函数）。
 *
 * 只有「应用内下载 + 替换」能稳定完成的组合才走 automatic：
 * - Windows 安装版：electron-updater NSIS；
 * - Linux x64 AppImage：electron-updater AppImageUpdater（运行时注入 APPIMAGE）；
 * - macOS Developer ID 签名包：electron-updater MacUpdater（Squirrel.Mac 会校验新包签名，
 *   ad-hoc 包替换会在安装阶段失败，所以只有正式签名的发行物才 automatic）。
 *
 * macOS 是否签名由运行时探测（macCodeSignature.ts 读本机 codesign 输出），不是构建期标记：
 * 签名在 electron-builder 阶段完成，vite 构建时并不知道；而且产物级事实比配置更可信。
 *
 * Linux arm64 的 latest-linux.yml 只由 x64 job 上传，arm64 用户拿到的是 x64 包
 * （release.yml 已注明「arm64 暂以手动下载为主」）；deb / tar.gz 没有 APPIMAGE env，
 * AppImageUpdater 无法替换。这两类必须走 manual，否则会把用户卡在「下载成功但装不上」。
 */

import type { AppUpdateDeliveryMode, AppUpdateDeliveryReason } from "../../shared/types/app";

export type AppUpdateDeliveryPlan = {
	mode: AppUpdateDeliveryMode;
	reason: AppUpdateDeliveryReason;
};

export function resolveAppUpdateDeliveryPlan(input: { platform: NodeJS.Platform; arch: string; isAppImage?: boolean; macDeveloperIdSigned?: boolean }): AppUpdateDeliveryPlan {
	if (input.platform === "win32") return { mode: "automatic", reason: "automatic" };
	if (input.platform === "darwin") {
		return input.macDeveloperIdSigned === true ? { mode: "automatic", reason: "automatic" } : { mode: "manual", reason: "mac-unsigned" };
	}
	if (input.platform === "linux") {
		if (input.arch === "arm64" || input.arch === "aarch64") return { mode: "manual", reason: "linux-arm64" };
		if (input.isAppImage === true) return { mode: "automatic", reason: "automatic" };
		return { mode: "manual", reason: "linux-package-format" };
	}
	return { mode: "manual", reason: "unsupported" };
}
