/**
 * 版本号比较（semver 数字段 + 预发布语义）。
 *
 * 从 githubFeed 抽出（v0.7.4 更新链路切 electron-updater 后不再需要 feed 解析模块），
 * 扩展更新检查（ExtensionManager）等仍依赖同一比较语义：
 *   - 数字段逐段比较，缺省补 0；
 *   - 数字段全等时，带预发布标识（如 0.7.2-beta）低于同号正式版（0.7.2），
 *     这样 beta 测试客户端在正式版发布后能收到升级提示，正式版不会被拉回预发布版。
 */

export function normalizeVersion(version: string): string {
	return version.trim().replace(/^v/i, "");
}

export function compareVersions(left: string, right: string): number {
	const leftParts = normalizeVersion(left).split(/[.-]/);
	const rightParts = normalizeVersion(right).split(/[.-]/);
	const leftCore = leftParts.map(toNumericPart);
	const rightCore = rightParts.map(toNumericPart);
	const length = Math.max(leftCore.length, rightCore.length);
	for (let index = 0; index < length; index += 1) {
		const diff = (leftCore[index] ?? 0) - (rightCore[index] ?? 0);
		if (diff !== 0) return diff;
	}
	// 数字段全部相等时，带预发布标识的版本低于同号正式版（与 semver 一致）。
	const leftPrerelease = hasPrereleaseTag(leftParts);
	const rightPrerelease = hasPrereleaseTag(rightParts);
	if (leftPrerelease !== rightPrerelease) return leftPrerelease ? -1 : 1;
	return 0;
}

function toNumericPart(part: string): number {
	return Number.parseInt(part, 10) || 0;
}

/** 版本号里是否带非数字段（如 beta/rc），即 semver 预发布标识。 */
function hasPrereleaseTag(parts: string[]): boolean {
	return parts.some((part) => !/^\d+$/.test(part));
}
