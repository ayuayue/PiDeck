/**
 * 会话级 atomFamily 释放登记表（2027-02 性能治理）。
 *
 * Jotai 的 atomFamily 没有自动 GC：按 sessionId 建实例后必须显式 .remove()，
 * 否则一次运行内打开过的每个会话都会永久留下若干原子实例（含整段文本/命令表）。
 * 原先只有 removeSessionStateAtom 里手工列出的 9 个 + agent 维度的 3 个有释放路径，
 * composer 六件套、命令表、outline、runtime UI 等 15 个 family 完全没有。
 *
 * 为什么用登记表而不是在 session-atoms 里逐个 import：各 atoms 模块之间存在环
 *（session-selectors 依赖 session-atoms），互相 import family 会让模块初始化顺序
 * 变脆。登记表是**零依赖叶子模块**：各模块在自己的 family 定义后登记一次，
 * 删除会话时遍历调用 remove —— 单向依赖，无环。
 */
type RemovableFamily = { remove: (key: string) => void };

const sessionFamilies: RemovableFamily[] = [];

/**
 * 额外的会话级清理 atom（写 atom，入参 sessionId）：给「数据不在 atomFamily 里」
 * 的模块登记（例如 DSH 提问回显的 Record 键，条目里带整段回答文本）。
 * 登记的是 atom 而不是普通回调：清理需要 set 其他 atom，只有写 atom 才有 setter；
 * 仍由本叶子模块中转，避免各 atoms 模块互相 import 成环。
 */
const sessionDisposalAtoms: Array<{ write: unknown }> = [];

/** 登记一个「(sessionId) => void」写 atom，会话删除时由 removeSessionStateAtom 执行。 */
export function registerSessionDisposalAtom(writable: { write: unknown }): void {
	sessionDisposalAtoms.push(writable);
}

/** 取全部已登记的清理 atom（供调用方逐个 set）。 */
export function getSessionDisposalAtoms(): readonly { write: unknown }[] {
	return sessionDisposalAtoms;
}

/**
 * 在 family 定义后调用一次（模块求值期），登记进会话删除时的释放清单。
 * 泛型保留入参自身类型：包装后 family 仍可按 (key) => Atom 调用，调用点零改动。
 */
export function registerSessionFamilyForDisposal<F extends RemovableFamily>(family: F): F {
	sessionFamilies.push(family);
	return family;
}

/** 会话被删除时释放全部已登记 family 的该键实例（幂等：未创建过的键 remove 是 no-op）。 */
export function removeRegisteredSessionFamilies(sessionId: string): void {
	for (const family of sessionFamilies) {
		try {
			family.remove(sessionId);
		} catch {
			// 单个 family 释放失败不影响其余（例如自定义 atomFamily 已释放）
		}
	}
}
