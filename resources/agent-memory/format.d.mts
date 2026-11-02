/** `format.mjs` 的类型声明（只覆盖宿主进程用到的部分）。 */

export function parseEntries(text: string): string[];
export function renderEntries(entries: string[]): string;
export function normalizeKey(content: string): string;
export function dedupeEntries(entries: string[]): string[];
export function trimEntries(entries: string[], budget: { maxChars: number; maxEntries: number }): { entries: string[]; dropped: number };
export function parseFailureEntry(block: string): { category: string; content: string };
export function formatFailureEntry(category: string, content: string): string;
export function entryCategory(block: string): string;
