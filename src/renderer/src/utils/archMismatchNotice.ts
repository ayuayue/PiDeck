/**
 * 架构错包提示的纯判定逻辑（hook 见 hooks/useArchMismatchNotice.ts）。
 *
 * 背景（2026-10 用户反馈）：Release 页 x64 dmg 无架构后缀，M 系列用户当成默认包安装，
 * 整个 Chromium/V8 全程 Rosetta 转译，表现为「应用很卡」。Electron 的
 * runningUnderArm64Translation 能精确判定该状态；这里只做纯函数判定，便于单测。
 */

/** 「不再提示」持久化键（localStorage，渲染层私有）。 */
export const ARCH_MISMATCH_DISMISSED_KEY = "pid:arch-mismatch-notice-dismissed-v1";

export type ArchMismatchStatus = {
	platform: string;
	runningUnderArm64Translation: boolean;
};

/**
 * 是否需要提示换装原生 arm64 包。
 * 只在 macOS 提示：Windows 发行物目前只有 x64，ARM Windows 用户没有原生包可换，
 * 提示只会造成困扰。
 */
export function shouldShowArchMismatchNotice(status: ArchMismatchStatus, dismissed: boolean): boolean {
	if (dismissed) return false;
	return status.platform === "darwin" && status.runningUnderArm64Translation === true;
}

/** releasesUrl（形如 https://github.com/ayuayue/PiDeck/releases）→ /latest 页（302 到最新 tag）。 */
export function buildLatestReleaseUrl(releasesUrl: string): string {
	return `${releasesUrl.replace(/\/+$/, "")}/latest`;
}
