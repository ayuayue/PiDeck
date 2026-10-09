/**
 * 一次性修复：清除「指向包安装目录」的顶层 `extensions` 精确规则（历史迁移残留）。
 *
 * 为什么需要它：旧禁用记录迁移曾把「指向包安装的禁用记录」写成顶层 `extensions` 的
 * `-<包目录>`（当时按「整包停用」的意图，但写错了数组）。pi 的精确匹配只认资源文件路径，
 * 包目录规则对 pi 是惰性的（不影响加载），却会被列表投影按值相等命中，把包内扩展显示成
 * 已停用——用户点开关后写 packages 成功、刷新后又弹回（Windows 上就这样，Linux 只是没残留）。
 *
 * 修复是幂等的：每次启动扫一遍 <pi npm root>/node_modules，按「精确等于某个已安装包目录」
 * 删规则；没有残留时不写文件。放在迁移门禁里（Agent spawn 前）执行，保证 UI 读到的是修好的投影。
 */

import { readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { PiResourceScope } from "../../shared/types/piResources";
import type { PiResourceConfigService } from "./PiResourceConfigService";

/** 修复结果：skipped = 磁盘上已无残留（或本层没有包安装）。 */
export type PackageRootRuleRepairResult = { status: "skipped" | "cleaned" | "failed"; removed: string[]; error?: string };

export type PackageRootRuleRepairDeps = {
	service: Pick<PiResourceConfigService, "stripPackageRootResourceRules">;
	/** pi 的 npm 包安装根（install 目录下的 node_modules）；项目层是 <root>/.pi/npm/node_modules。 */
	npmRoot: (scope: PiResourceScope) => string;
	logger?: { info: (scope: string, message: string, detail?: unknown) => void; warn: (scope: string, message: string, detail?: unknown) => void };
};

/** 读目录项；读不到（不存在/权限）返回空数组。 */
function readDirEntries(dir: string): Dirent[] {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/**
 * 扫描已安装的包目录（含 @scope 一层）。
 * 读不到时返回空数组：修复是尽力而为，不能因此阻塞启动。
 */
export function scanInstalledPackageDirs(npmRoot: string): string[] {
	const dirs: string[] = [];
	for (const entry of readDirEntries(npmRoot)) {
		if (!entry.isDirectory()) continue;
		const full = join(npmRoot, entry.name);
		if (!entry.name.startsWith("@")) {
			dirs.push(full);
			continue;
		}
		// 单个 scope 目录读失败只跳过它。
		for (const child of readDirEntries(full)) {
			if (child.isDirectory()) dirs.push(join(full, child.name));
		}
	}
	return dirs;
}

/** 执行一次修复（幂等）。 */
export async function runPackageRootRuleRepair(deps: PackageRootRuleRepairDeps, scope: PiResourceScope): Promise<PackageRootRuleRepairResult> {
	const packageDirs = scanInstalledPackageDirs(deps.npmRoot(scope));
	if (packageDirs.length === 0) return { status: "skipped", removed: [] };
	try {
		const result = await deps.service.stripPackageRootResourceRules(scope, packageDirs);
		if (!result.ok) {
			deps.logger?.warn("resources", "Package-root resource rule repair failed", { scope: scope.scope, error: result.error });
			return { status: "failed", removed: [], ...(result.error ? { error: result.error } : {}) };
		}
		if (result.removed.length === 0) return { status: "skipped", removed: [] };
		deps.logger?.info("resources", "Removed stale package-root resource rules", { scope: scope.scope, removed: result.removed });
		return { status: "cleaned", removed: result.removed };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.logger?.warn("resources", "Package-root resource rule repair threw", { scope: scope.scope, error: message });
		return { status: "failed", removed: [], error: message };
	}
}
