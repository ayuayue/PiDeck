/** `migrate.mjs` 的类型声明（只覆盖宿主进程用到的部分）。 */

export function migrateLegacyProjectDirs(
	root: string,
	cwds: (string | undefined)[],
): { moved: { from: string; to: string }[]; skipped: { from: string; to: string; reason: string }[] };
