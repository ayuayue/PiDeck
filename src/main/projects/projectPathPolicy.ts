/**
 * 项目路径策略（纯函数）：判断自动导入是否应按会话 cwd 注册侧栏项目。
 *
 * 背景：删除「目录不存在」的项目后，启动时 DSH 外部会话同步仍会按 header.cwd
 * 调用 ProjectStore.add()，把已删的临时目录（尤其是 e2e 的 pideck-mockpi-*）
 * 连同会话一起加回侧栏。
 */

/** 项目显示名最大长度：超出拒绝，避免恶意/误输入撑爆侧栏。 */
export const PROJECT_DISPLAY_NAME_MAX_LENGTH = 120;

/**
 * 规范化项目显示名（纯函数）：折叠内部空白后 trim。
 * 空名或超长抛错（带稳定错误码，主进程边界校验与渲染层提示共用同一定义）。
 * 重命名只改显示 label，不触碰磁盘目录。
 */
export function sanitizeProjectDisplayName(name: string): string {
	const clean = name.replace(/\s+/g, " ").trim();
	if (!clean) throw new Error("PROJECT_NAME_REQUIRED");
	if (clean.length > PROJECT_DISPLAY_NAME_MAX_LENGTH) {
		throw new Error(`PROJECT_NAME_TOO_LONG:${PROJECT_DISPLAY_NAME_MAX_LENGTH}`);
	}
	return clean;
}

/** 比较用路径键：去尾部分隔符、统一斜杠；Windows 忽略大小写。 */
export function projectPathKey(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "").replace(/\\/g, "/");
	return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/**
 * 测试/一次性隔离目录：E2E 与临时 userData 的 cwd。
 * 这些目录本就不该进入开发者本机的项目列表。
 */
export function isEphemeralProjectPath(path: string): boolean {
	const key = projectPathKey(path);
	return (
		/\/pideck-mockpi-/.test(key)
		|| /\/pideck-e2e-/.test(key)
		|| /\/pideck-git-e2e/.test(key)
		|| /\/pideck-history-/.test(key)
		|| /\/pideck-preview-promote-e2e/.test(key)
		|| /\/pideck-wb-/.test(key)
		|| /\/pideck-fv-/.test(key)
		|| /\/pideck-feishu-e2e/.test(key)
	);
}

/** 用户已从侧栏移除的路径（目录可能还在，也不能被自动导入再注册）。 */
export function isDismissedProjectPath(
	path: string,
	dismissed: readonly string[],
): boolean {
	const key = projectPathKey(path);
	return dismissed.some((item) => projectPathKey(item) === key);
}

/**
 * 自动导入是否允许按 cwd 建项目。
 * 临时目录、已移除记录、磁盘上已不存在的目录一律拒绝——否则「删了重启又回来」。
 */
export function shouldAutoRegisterForeignCwd(
	cwd: string,
	options: {
		dismissedPaths?: readonly string[];
		pathExists?: boolean;
	} = {},
): boolean {
	if (isEphemeralProjectPath(cwd)) return false;
	if (isDismissedProjectPath(cwd, options.dismissedPaths ?? [])) return false;
	if (options.pathExists === false) return false;
	return true;
}
