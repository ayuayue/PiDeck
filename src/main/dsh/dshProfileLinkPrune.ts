/** DSH profile 里指向旧 runtime 安装的包链接清理（runtime 升级后的自愈）。
 *
 * 0.2.0-rc.2 → 0.2.1-rc.1 升级暴露：`<profile>/node_modules` 下可能残留指向上一个
 * runtime 版本的 `@deepseek-ai/*` 符号链接（早期 profile 初始化/link 后端遗留）。
 * app-boot 的兼容性 preflight 按 `parentURL` 走 Node 查找链，profile 的 node_modules
 * 先于 runtime 命中，于是读到旧版 manifest 并禁用整行：
 * `disabling profile plugin row "preset-standard": Plugin @deepseek-ai/dsh-agent-preset@0.2.0-rc.2
 * is incompatible with dsh 0.2.1-rc.1` → 预注册表为空 → `Unknown agent preset: standard`。
 *
 * 只删「指向本机其它 runtime 安装、或目标已失效」的链接；指向当前 runtime 的链接、
 * pnpm/用户自建链接与普通目录一律不动（判定依据是链接目标是否落在 runtimes 根内）。
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface PrunedProfileLink {
	/** 被删除的符号链接路径。 */
	readonly path: string;
	/** 链接当时指向的真实路径（旧 runtime 或已失效目标）。 */
	readonly target: string;
}

/** `child` 是否位于 `parent` 目录树内（大小写不敏感平台统一折叠；不包含 parent 本身）。 */
function isInside(parent: string, child: string): boolean {
	const folded = process.platform === "win32";
	const rel = relative(folded ? parent.toLowerCase() : parent, folded ? child.toLowerCase() : child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** `node_modules` 顶层的链接（含 `@scope/*` 一层），与 app-boot 的 `symlinksUnder` 同口径。 */
function linkPaths(modulesDir: string): string[] {
	const links: string[] = [];
	if (!existsSync(modulesDir)) return links;
	for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
		const path = join(modulesDir, entry.name);
		if (entry.isSymbolicLink()) {
			links.push(path);
			continue;
		}
		if (!entry.name.startsWith("@") || !entry.isDirectory()) continue;
		for (const child of readdirSync(path, { withFileTypes: true })) {
			const childPath = join(path, child.name);
			if (child.isSymbolicLink()) links.push(childPath);
		}
	}
	return links;
}

/**
 * 删除 profile 中指向其它 runtime 安装（或已失效）的包链接。
 * @param profileDir DSH profile 根目录（`<dshHome>/.pideck/profile`）。
 * @param runtimeNodeModules 当前 runtime 的 `node_modules` 绝对路径；与它同级的
 *   `runtimes/dsh/<其它版本>` 被视为过期来源。
 * @returns 实际删除的链接；被占用/无权限时保留并跳过（宿主侧 preflight 仍会拒绝不兼容行）。
 */
export function pruneStaleRuntimeLinks(profileDir: string, runtimeNodeModules: string): PrunedProfileLink[] {
	const runtimeRoot = dirname(runtimeNodeModules);
	const runtimesDir = dirname(runtimeRoot);
	const pruned: PrunedProfileLink[] = [];
	for (const link of linkPaths(join(profileDir, "node_modules"))) {
		let rawTarget: string;
		try {
			// lstat 已确认是链接；readlink 对 Windows junction 同样可用。
			if (!lstatSync(link).isSymbolicLink()) continue;
			rawTarget = resolve(dirname(link), readlinkSync(link));
		} catch {
			continue;
		}
		const target = existsSync(rawTarget) ? realpathSync(rawTarget) : rawTarget;
		// 旧 runtime：落在 runtimes 根内但不在当前 runtime 树内。悬空链按原样路径判。
		if (!isInside(runtimesDir, target) || isInside(runtimeRoot, target)) continue;
		try {
			unlinkSync(link);
			pruned.push({ path: link, target });
		} catch {
			/* 杀软/占用短暂锁住：保留链接，下次启动再试。 */
		}
	}
	return pruned;
}

/** 供日志使用：`<scope>/<name> -> <target>` 单行摘要。 */
export function describePrunedProfileLinks(pruned: readonly PrunedProfileLink[]): string {
	return pruned.map((entry) => `${entry.path.split(`${sep}node_modules${sep}`).pop() ?? entry.path} -> ${entry.target}`).join("; ");
}
