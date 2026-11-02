/** `sessions.mjs` 的类型声明（只覆盖宿主进程用到的部分）。 */

export type IndexSourcesResult = { indexed: number; skipped: number; failed: number; sessions: string[] };

export function indexSources(
	root: string,
	sources: readonly { backend: string; dir: string; project?: string }[],
): IndexSourcesResult;
