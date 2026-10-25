/**
 * 手动更新推荐安装包的设备标签（纯函数，UI 只负责 t()）。
 *
 * 主进程只提供结构化字段（platform/arch/kind/translated），具体文案走 i18n；
 * 这样新增语言不需要改主进程，也不会把中文文案写进快照。
 */

import type { AppManualUpdateRelease } from "../../../shared/types";
import type { TranslationKey } from "../i18n";

export type UpdateTargetLabel = {
	key: TranslationKey;
	params?: Record<string, string>;
};

export function manualUpdateTargetLabel(release: Pick<AppManualUpdateRelease, "platform" | "arch" | "kind" | "translated">): UpdateTargetLabel {
	if (release.platform === "darwin") {
		if (release.arch === "arm64") {
			return { key: release.translated ? "settings.updateTargetMacArm64Rosetta" : "settings.updateTargetMacArm64" };
		}
		return { key: "settings.updateTargetMacX64" };
	}
	if (release.platform === "win32") {
		if (release.kind === "portable") return { key: "settings.updateTargetWinPortable" };
		if (release.kind === "zip") return { key: "settings.updateTargetWinZip" };
		return { key: "settings.updateTargetWinInstalled" };
	}
	const arch = release.arch === "arm64" ? "arm64" : "x64";
	if (release.kind === "deb") return { key: "settings.updateTargetLinuxDeb", params: { arch } };
	if (release.kind === "tar.gz") return { key: "settings.updateTargetLinuxArchive", params: { arch } };
	return { key: "settings.updateTargetLinuxAppImage", params: { arch } };
}
