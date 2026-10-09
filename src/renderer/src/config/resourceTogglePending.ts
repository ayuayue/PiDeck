/**
 * 资源开关（扩展 / 技能 / 提示词）的乐观更新状态：纯策略，三个 Tab 共用。
 *
 * 背景：开关此前是「写盘成功后再等一次全量刷新才翻转」，而扩展页的刷新要跑 pi list +
 * 每个 npm 包的 npm view（秒级），用户看到的是点了没反应、过一会儿才跳。这里让点击立刻
 * 用目标值覆盖该行显示，写盘 + 刷新完成后由调用方清除覆盖；清除即回滚到数据真值，
 * 失败路径不需要额外的反向写入。
 *
 * key 用行身份：扩展 scope:source、技能 id、提示词 path（同一 Tab 内一致即可）。
 */
export type PendingToggleMap = Readonly<Record<string, boolean>>;

/** 该行是否有进行中的开关（进行中的行不再接受第二次点击）。 */
export function isTogglePending(pending: PendingToggleMap, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(pending, key);
}

/** 行当前应显示的值：有乐观覆盖就用覆盖值（含 false），否则用数据真值。 */
export function resolveToggleEnabled(pending: PendingToggleMap, key: string, derivedEnabled: boolean): boolean {
	return isTogglePending(pending, key) ? pending[key] === true : derivedEnabled;
}

/** 标记乐观覆盖 = 用户点击的目标值；重复标记同值时返回原对象，避免多余重渲染。 */
export function markTogglePending(pending: PendingToggleMap, key: string, enabled: boolean): PendingToggleMap {
	if (isTogglePending(pending, key) && pending[key] === enabled) return pending;
	return { ...pending, [key]: enabled };
}

/**
 * 数据回落后按目标值结算：该行真值已经等于目标值、或该行已从列表消失时清除覆盖。
 * 刷新还没落地时必须保留覆盖——否则开关会「弹一下（回旧值）再翻过去」。
 * 无待清项时返回原对象。
 */
export function settleTogglePending(pending: PendingToggleMap, derived: Readonly<Record<string, boolean | undefined>>): PendingToggleMap {
	let next: Record<string, boolean> | null = null;
	for (const key of Object.keys(pending)) {
		const current = derived[key];
		if (current === undefined || current === pending[key]) {
			next ??= { ...pending };
			delete next[key];
		}
	}
	return next ?? pending;
}

/** 清除乐观覆盖（写盘与刷新结束后调用）；无该 key 时返回原对象。 */
export function clearTogglePending(pending: PendingToggleMap, key: string): PendingToggleMap {
	if (!isTogglePending(pending, key)) return pending;
	const next: Record<string, boolean> = { ...pending };
	delete next[key];
	return next;
}
