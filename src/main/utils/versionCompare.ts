/**
 * 版本号比较（完整 semver 语义：核心数字段 + 预发布标识 + 忽略 build 元数据）。
 *
 * 从 githubFeed 抽出（v0.7.4 更新链路切 electron-updater 后不再需要 feed 解析模块），
 * 更新链路（通道切换 / mac 手动更新 / releaseSelection）与扩展检查（ExtensionManager）依赖同一比较语义：
 *   - 核心数字段逐段比较（缺省补 0）；
 *   - 核心全等时，无预发布标识的正式版更高（0.8.0 > 0.8.0-beta.9）：beta 客户端在正式版发布后
 *     能收到升级提示，正式版也不会被拉回预发布版；
 *   - 双方都带预发布时标识逐段比较：纯数字按数值（beta.9 < beta.10）、含字母按字典序且高于纯数字
 *     （1.0.0-1 < 1.0.0-alpha）、前缀相同时标识少者更低（1.0.0-alpha < 1.0.0-alpha.1）；
 *   - `+build` 元数据不参与优先级（semver 规定）。
 * 返回值只保证符号语义（<0 / 0 / >0），消费方不得依赖具体幅值。
 */

export function normalizeVersion(version: string): string {
	return version.trim().replace(/^v/i, "");
}

/** 解析结果：核心数字段数组 + 预发布标识数组（正式版为空数组）。 */
interface ParsedVersion {
	core: number[];
	prerelease: string[];
}

export function compareVersions(left: string, right: string): number {
	const leftParsed = parseVersion(left);
	const rightParsed = parseVersion(right);
	const coreLength = Math.max(leftParsed.core.length, rightParsed.core.length);
	for (let index = 0; index < coreLength; index += 1) {
		const diff = (leftParsed.core[index] ?? 0) - (rightParsed.core[index] ?? 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return comparePrerelease(leftParsed.prerelease, rightParsed.prerelease);
}

/** 宽松解析 `major.minor.patch[-prerelease][+build]`：非数字核心段按 0 处理，不抛错（兼容脏输入）。 */
function parseVersion(version: string): ParsedVersion {
	// build 元数据（+ 起全部）不参与优先级，先剥离；再按首个连字符切出预发布标识段。
	const withoutBuild = normalizeVersion(version).split("+")[0] ?? "";
	const [mainPart = "", prereleasePart = ""] = withoutBuild.split("-", 2);
	const core = mainPart.split(".").map(toNumericPart);
	const prerelease = prereleasePart === "" ? [] : prereleasePart.split(".");
	return { core, prerelease };
}

function toNumericPart(part: string): number {
	return Number.parseInt(part, 10) || 0;
}

/** 预发布标识比较：无标识（正式版）更高；逐段按 semver 规则（见文件头），前缀相同时标识少者更低。 */
function comparePrerelease(left: string[], right: string[]): number {
	if (left.length === 0 && right.length === 0) return 0;
	if (left.length === 0) return 1;
	if (right.length === 0) return -1;
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const leftIdentifier = left[index];
		const rightIdentifier = right[index];
		if (leftIdentifier === undefined) return -1;
		if (rightIdentifier === undefined) return 1;
		if (leftIdentifier === rightIdentifier) continue;
		const leftNumeric = isNumericIdentifier(leftIdentifier);
		const rightNumeric = isNumericIdentifier(rightIdentifier);
		if (leftNumeric && rightNumeric) {
			const diff = Number.parseInt(leftIdentifier, 10) - Number.parseInt(rightIdentifier, 10);
			if (diff !== 0) return diff > 0 ? 1 : -1;
			continue;
		}
		// 一方纯数字、一方含字母：纯数字标识更低（semver：数字标识总是低于字母标识）。
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
		return leftIdentifier < rightIdentifier ? -1 : 1;
	}
	return 0;
}

function isNumericIdentifier(identifier: string): boolean {
	return /^\d+$/.test(identifier);
}
