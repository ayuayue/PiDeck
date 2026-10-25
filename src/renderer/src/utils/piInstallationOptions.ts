import type { PiInstallation, PiInstallationSource } from "../../../shared/types";
import type { TranslationKey } from "../i18n";

/**
 * 「检测到多个 pi 安装」时的展示规则（纯函数，配 tests/piInstallationOptions.test.mjs）。
 *
 * 为什么把规则抽到这里：主进程已经决定了列表顺序与 isActive/shellDefault/isNewest，
 * 渲染层只该做「哪个徽章、哪个文案 key」这种可单测的映射，
 * 不要把产品规则散在 JSX 的条件表达式里。
 */

/** 列表项上只展示一个徽章：当前使用 > 终端默认 > 较新，避免一行堆三个标签。 */
export type PiInstallationBadge = "active" | "shellDefault" | "newest";

export function piInstallationBadge(installation: PiInstallation): PiInstallationBadge | null {
	if (installation.isActive) return "active";
	if (installation.shellDefault) return "shellDefault";
	if (installation.isNewest) return "newest";
	return null;
}

const SOURCE_KEYS: Record<PiInstallationSource, TranslationKey> = {
	managed: "environment.installSourceManaged",
	"package-manager": "environment.installSourcePackageManager",
	portable: "environment.installSourcePortable",
	custom: "environment.installSourceCustom",
	path: "environment.installSourcePath",
};

export function piInstallationSourceKey(source: PiInstallationSource): TranslationKey {
	return SOURCE_KEYS[source] ?? "environment.installSourcePath";
}

/** 徽章文案 key（无徽章时为 null）。 */
export function piInstallationBadgeKey(badge: PiInstallationBadge | null): TranslationKey | null {
	if (badge === "active") return "environment.installBadgeActive";
	if (badge === "shellDefault") return "environment.installBadgeShellDefault";
	if (badge === "newest") return "environment.installBadgeNewest";
	return null;
}

/** 版本展示：探测失败过就明说，而不是显示空版本号让人以为装好了。 */
export function piInstallationVersionKey(installation: PiInstallation): TranslationKey | null {
	return installation.version ? null : "environment.installVersionUnknown";
}

/**
 * 是否值得渲染选择列表。
 * 只有一份安装时不需要选择（现有「检测通过」卡片已经够了），
 * 多份时必须让用户自己选——静默用其中一份正是这次要修的坑。
 */
export function shouldOfferInstallationChoice(installations: PiInstallation[]): boolean {
	return installations.length > 1;
}

/**
 * 列表分组：自动发现的 vs 用户自己添加的。
 * 分组而不是分成两个控件，是本次合并两块设置的目的：
 * 用户看的是「PiDeck 能用哪几个 pi」，来源只是标签，不该决定去哪个控件里找。
 */
export function groupInstallations(installations: readonly PiInstallation[]): { detected: PiInstallation[]; userAdded: PiInstallation[] } {
	const detected: PiInstallation[] = [];
	const userAdded: PiInstallation[] = [];
	for (const item of installations) {
		(item.userAdded ? userAdded : detected).push(item);
	}
	return { detected, userAdded };
}

/** 行内操作：当前使用项不需要「使用」，只有用户添加的项能编辑/移除。 */
export function installationRowActions(installation: PiInstallation): { canUse: boolean; canEdit: boolean; canRemove: boolean } {
	const userAdded = installation.userAdded === true;
	return { canUse: !installation.isActive, canEdit: userAdded, canRemove: userAdded };
}

/** 版本比较徽章（当前使用 > 终端默认 > 较新/较旧）；较旧只在多份且版本不同时提示。 */
export function piInstallationVersionNoteKey(installation: PiInstallation, hasNewest: boolean): TranslationKey | null {
	if (installation.isNewest) return "environment.installBadgeNewest";
	// 「较旧」只在别的安装真的更新时提示：单一安装时不拿它吓用户。
	if (hasNewest && installation.version) return "environment.installBadgeOlder";
	return null;
}
