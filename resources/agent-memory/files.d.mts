/** `files.mjs` 的类型声明（只覆盖宿主进程用到的部分）。 */

export function readRaw(filePath: string): string;
export function readEntries(root: string, target: string, projectId?: string): string[];
export function writeAtomic(filePath: string, content: string): void;
export function mutateEntries(
	root: string,
	target: string,
	projectId: string,
	mutator: (entries: string[]) => { entries: string[]; result: unknown },
): { changed: boolean; result: unknown; dropped: number; count: number };
export function readAllEntries(projectId: string, root: string): Record<string, string[]>;
