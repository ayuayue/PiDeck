/** `db.mjs` 的类型声明（只覆盖宿主进程用到的部分）。 */

export type IndexStats = { ok: true; entries: number; sessions: number; messages: number } | { ok: false; reason: string };

export function openDatabase(root: string): { db: unknown } | { disabled: string };
export function loadSqliteDriver(): { DatabaseSync: new (path: string) => unknown } | null;
export function indexStats(root: string): IndexStats;
export function sessionMessages(root: string, sessionId: string, options?: { limit?: number }): { ok: boolean; reason?: string; userTurns: number; messages: { role: string; content: string; timestamp: string }[] };
export function clearIndex(root: string): { ok: boolean; reason?: string; removed?: number };
export function hasCjk(text: string): boolean;
/** 每条记忆的写入时间（ISO 串），键是条目原文 content。 */
export function entryTimes(root: string, target: string): Map<string, string>;
