/**
 * 通用列表重排（拖拽 / 手柄方向键）的纯函数。
 *
 * 消费者：供应商卡片（竖向 + 网格两种布局）、智能体市场（卡片网格）、收藏列表（单列）。
 * 与 `providerOrder.ts` 的分工：那边只管「这些名字按什么顺序展示」的商品逻辑，
 * 移动/邻居/落点这类几何与位移算法收在这里，两个模块共享同一份实现，避免两套顺序规则漂移。
 *
 * 约定：所有函数都返回输入的一个置换（不增不减、不丢未知 key），调用方可以安全地直接持久化；
 * 无实际位移时返回与原数组逐项相同的新数组，调用方据 `sameOrder` 判断是否跳过写盘。
 */

/** 拖拽时写进 dataTransfer 的私有 MIME：外部拖入的文本/链接不会被当成列表项重排。 */
export const LIST_REORDER_DRAG_MIME = "application/x-pideck-list-item";

export type ReorderPosition = "before" | "after";

/** 网格（多行自动换行）按卡片内左右半区判前后，单列列表按上下半区判前后。 */
export type ReorderOrientation = "grid" | "list";

export type ReorderDropTarget = { key: string; position: ReorderPosition };

/** 相对视口（`getBoundingClientRect`）的条目矩形，拖拽期间每帧现算，不缓存。 */
export type ReorderItemRect = { key: string; left: number; top: number; width: number; height: number };

export type ReorderPointer = { x: number; y: number };

/** 两个顺序是否逐项相同（长度与每个位置都一致）。 */
export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((key, index) => key === right[index]);
}

/**
 * 把 fromKey 移动到锚点 anchorKey 的前/后，返回新的完整顺序。
 * 拖拽落点与手柄方向键（↑/↓）共用这一个入口：
 * - 拖拽：anchor = 悬停的条目，position 由落点几何决定；
 * - ↑ 键：anchor = 可见列表里的上一个条目，position = "before"；
 * - ↓ 键：anchor = 可见列表里的下一个条目，position = "after"。
 * 无位移（同名、key 不存在）时返回原序副本。
 */
export function moveKeyRelative(keys: readonly string[], fromKey: string, anchorKey: string, position: ReorderPosition): string[] {
	const current = [...keys];
	const fromIndex = current.indexOf(fromKey);
	if (fromIndex < 0 || fromKey === anchorKey || current.indexOf(anchorKey) < 0) return current;
	current.splice(fromIndex, 1);
	// 先摘除再定位：锚点在摘除后可能前移一位，必须重新取索引。
	const insertAt = current.indexOf(anchorKey) + (position === "after" ? 1 : 0);
	current.splice(insertAt, 0, fromKey);
	return current;
}

/** 可见列表里 key 的上一个（delta=-1）或下一个（delta=1）条目；越界返回 null。 */
export function neighborKey(visibleKeys: readonly string[], key: string, delta: -1 | 1): string | null {
	const index = visibleKeys.indexOf(key);
	if (index < 0) return null;
	const target = index + delta;
	if (target < 0 || target >= visibleKeys.length) return null;
	return visibleKeys[target] ?? null;
}

/**
 * 手柄 ↑/↓ 键盘重排：以可见邻居为锚点，在完整列表上执行一次移动。
 * 过滤视图下锚点取「看得见的那一个」，隐藏条目在完整顺序里的相对位置可能被动挪一位，
 * 但可见区的相对顺序不会被破坏。返回 null 表示已经在边界（调用方保持原序、不要写盘）。
 */
export function moveKeyByStep(fullKeys: readonly string[], visibleKeys: readonly string[], key: string, delta: -1 | 1): string[] | null {
	const anchor = neighborKey(visibleKeys, key, delta);
	if (!anchor) return null;
	return moveKeyRelative(fullKeys, key, anchor, delta < 0 ? "before" : "after");
}

/**
 * 指针位置 → 落点（插到哪个条目的前/后）。
 *
 * 1. 指针在某个条目矩形内：网格按左右半区、列表按上下半区判前后。刻意只用一条轴——
 *    卡片右半 + 上沿这种位置如果两轴同时判定，会出现「指针一动落点就翻面」的抖动。
 * 2. 指针落在卡片之间（gap）或容器留白：退到「中心最近」的条目，再用同一条规则判前后。
 *    网格里指针纵向出了卡片范围按上下判（跨行落点），否则按左右判（同行换位）。
 * 3. 没有条目可用时返回 null（调用方按「拖回原位」处理，不写盘）。
 *
 * 尺寸为 0 的条目（display:none / 折叠）不参与计算：它们的矩形塌在 (0,0)，
 * 会把容器左上角的落点错误吸走。
 */
export function resolveReorderDropTarget(items: readonly ReorderItemRect[], pointer: ReorderPointer, orientation: ReorderOrientation): ReorderDropTarget | null {
	const visibleItems = items.filter((item) => item.width > 0 || item.height > 0);
	if (visibleItems.length === 0) return null;
	const inside = visibleItems.find((item) => pointer.x >= item.left && pointer.x <= item.left + item.width && pointer.y >= item.top && pointer.y <= item.top + item.height);
	if (inside) return positionFor(inside, pointer, orientation);

	let nearest = visibleItems[0];
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (const item of visibleItems) {
		const dx = pointer.x - (item.left + item.width / 2);
		const dy = pointer.y - (item.top + item.height / 2);
		const distance = dx * dx + dy * dy;
		if (distance < nearestDistance) {
			nearest = item;
			nearestDistance = distance;
		}
	}
	return positionFor(nearest, pointer, orientation);
}

function positionFor(item: ReorderItemRect, pointer: ReorderPointer, orientation: ReorderOrientation): ReorderDropTarget {
	// 网格：纵向已经离开卡片（行间缝隙 / 容器外）时按上下判，同行内按左右判。
	const vertical = orientation === "list" || pointer.y < item.top || pointer.y > item.top + item.height;
	const after = vertical ? pointer.y >= item.top + item.height / 2 : pointer.x >= item.left + item.width / 2;
	return { key: item.key, position: after ? "after" : "before" };
}
