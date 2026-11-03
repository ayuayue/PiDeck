/** `tools.mjs` 的类型声明（只覆盖宿主进程学习循环用到的部分）。 */

export class MemoryToolError extends Error {
	constructor(code: string, message?: string);
}

export type AddMemoryResult = {
	ok: true;
	target: string;
	scope: "global" | "project" | "device";
	projectId: string;
	duplicate: boolean;
	count: number;
	dropped: number;
	budget?: { maxChars: number; maxEntries: number };
	/** `dropped > 0` 时才出现：被预算裁剪丢弃的最老条目片段。 */
	trimmed?: { count: number; oldest: string[]; hint: string };
};

export function addMemory(
	root: string,
	input: { target?: string; content: string; category?: string; projectId?: string },
): AddMemoryResult;

export function syncTarget(root: string, target: string, projectId: string, options?: { force?: boolean }): { target: string; scope: string; projectId: string; entries: string[] };
