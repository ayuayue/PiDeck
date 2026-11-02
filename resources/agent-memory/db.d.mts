/** `db.mjs` 的类型声明（只覆盖宿主进程用到的部分）。 */

export type IndexStats = { ok: true; entries: number; sessions: number; messages: number } | { ok: false; reason: string };

export function openDatabase(root: string): { db: unknown } | { disabled: string };
export function loadSqliteDriver(): { DatabaseSync: new (path: string) => unknown } | null;
export function indexStats(root: string): IndexStats;
export function sessionMessages(root: string, sessionId: string, options?: { limit?: number }): { ok: boolean; reason?: string; userTurns: number; messages: { role: string; content: string; timestamp: string }[] };
export function clearIndex(root: string): { ok: boolean; reason?: string; removed?: number };
export function hasCjk(text: string): boolean;
