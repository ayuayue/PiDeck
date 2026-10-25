/**
 * 解析 DSH runtime 应该跟随哪个应用 Release。
 *
 * dev 分支通常是 `0.x.y-beta`，仓库不会为每个开发版本创建同名 GitHub Release；
 * 因此 dev 默认跟随 latest，只有维护者显式设置 tag 时才锁定指定 Release。
 * 已安装包则默认跟随自身版本 tag，避免把正式版误下载成另一版应用的 runtime。
 */
export function resolveDshRuntimeReleaseTag(input: { explicitTag?: string; isPackaged: boolean; appVersion: string }): string | undefined {
	const explicitTag = input.explicitTag?.trim();
	if (explicitTag) return explicitTag;
	if (!input.isPackaged) return undefined;

	const version = input.appVersion.trim();
	return version ? `v${version}` : undefined;
}
