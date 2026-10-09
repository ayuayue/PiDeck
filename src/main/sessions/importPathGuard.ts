import { resolve } from "node:path";

/**
 * 导入源路径守卫（2026-03 外部会话导入器安全审计后收口）。
 *
 * 背景：7 个外部会话导入器（Codex/Claude/Cursor/Kimi/KimiWork/WorkBuddy/Minimax）
 * 原各自做「斜杠归一 + 小写化 + startsWith 前缀」的词法校验，不解析 `..`——
 * 渲染层或恶意会话索引传入 `<root>/../../../任意文件` 可通过前缀检查，
 * 构成任意文件读取（内容还会经导入错误信息回传渲染层）。Minimax 实现更弱，
 * 连 `/` 边界都没有（兄弟目录 `sessions-evil/` 也通过）。
 *
 * 语义：先 path.resolve 消解 `..` 与冗余段，再做大小写/斜杠归一后的
 * 「等于根 或 以根+分隔符 开头」判定。所有渲染层可达的导入源校验必须走这里，
 * 不再各自手写 startsWith。
 */

function normalizeForCompare(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** candidate 是否落在 root 之内（含等于 root）。Windows 大小写不敏感语义。 */
export function isPathInsideRoot(root: string, candidate: string): boolean {
	// resolve 消解 `..`：词法前缀通过但语义出根的路径在此现形
	const resolvedRoot = normalizeForCompare(resolve(root));
	const resolvedCandidate = normalizeForCompare(resolve(candidate));
	if (resolvedCandidate === resolvedRoot) return true;
	return resolvedCandidate.startsWith(`${resolvedRoot}/`);
}

/** 校验失败即抛结构化错误（label 用于区分导入器来源）。 */
export function assertSourceWithinRoot(root: string, candidate: string, label: string): void {
	if (!isPathInsideRoot(root, candidate)) {
		throw new Error(`${label} session path is outside its source root`);
	}
}
