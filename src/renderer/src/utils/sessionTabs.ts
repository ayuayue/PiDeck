/**
 * 会话 Tab 栏的固定（pin）与拖拽排序纯逻辑。
 *
 * 不变量：tabs 数组始终为 [pinned...] + [normal...]（固定在前），
 * 由本模块的操作维护；渲染层直接按 tabs 顺序展示即可。
 *
 * 另有 VS Code 式「预览 Tab」：previewId 指向至多一个斜体临时 Tab；
 * 单击打开会替换预览，双击（或显式永久打开）后变为常驻 Tab。
 * 注意：pinned 是「钉在前面」；preview 是「临时预览」，二者正交。
 */

export type SessionTabOpenMode = "preview" | "permanent";

/**
 * 以预览方式打开会话（VS Code 单击文件）：
 * - 已是常驻 Tab：不改列表，也不降级为预览；
 * - 已是当前预览：不变；
 * - 否则：替换旧预览 Tab，并登记为新预览。
 */
export function openPreviewSessionTab(tabs: string[], pinned: readonly string[], previewId: string | null, sessionId: string): { tabs: string[]; previewId: string | null } {
	if (!sessionId) return { tabs: [...tabs], previewId };
	const isResident = tabs.includes(sessionId) && sessionId !== previewId;
	// 已在列表且无需改 preview 时复用原数组，避免侧栏重复打开把 jotai Tab 列表打成每帧新引用。
	if (isResident) return { tabs, previewId };
	if (sessionId === previewId && tabs.includes(sessionId)) {
		return { tabs, previewId };
	}

	let next = tabs.filter((id) => id !== previewId || id === sessionId);
	if (!next.includes(sessionId)) {
		const pinnedTabs = next.filter((id) => pinned.includes(id));
		const normalTabs = next.filter((id) => !pinned.includes(id));
		next = [...pinnedTabs, ...normalTabs, sessionId];
	}
	return { tabs: next, previewId: sessionId };
}

/**
 * 以常驻方式打开会话（VS Code 双击 / 钉住预览）：
 * - 不在列表则追加到普通区末尾；
 * - 若正是预览 Tab，则清除 preview 标记（斜体 → 正体）。
 */
export function openPermanentSessionTab(tabs: string[], pinned: readonly string[], previewId: string | null, sessionId: string): { tabs: string[]; previewId: string | null } {
	if (!sessionId) return { tabs: [...tabs], previewId };
	const alreadyOpen = tabs.includes(sessionId);
	const nextPreview = previewId === sessionId ? null : previewId;
	// 已常驻且预览标记不变：复用原数组，registerOpenSession 才不会每帧写 jotai。
	if (alreadyOpen && nextPreview === previewId) {
		return { tabs, previewId: nextPreview };
	}
	let next = [...tabs];
	if (!alreadyOpen) {
		const pinnedTabs = next.filter((id) => pinned.includes(id));
		const normalTabs = next.filter((id) => !pinned.includes(id));
		next = [...pinnedTabs, ...normalTabs, sessionId];
	}
	return { tabs: next, previewId: nextPreview };
}

/** 切换固定状态：pin 后移入固定区末尾；unpin 后移入普通区开头（紧跟固定区）。 */
export function togglePinSessionTab(tabs: readonly string[], pinned: readonly string[], sessionId: string): { tabs: string[]; pinned: string[] } {
	const isPinned = pinned.includes(sessionId);
	const nextPinned = isPinned ? pinned.filter((id) => id !== sessionId) : [...pinned, sessionId];
	const rest = tabs.filter((id) => id !== sessionId);
	const nextTabs = [...rest.filter((id) => nextPinned.includes(id)), ...(isPinned ? [] : [sessionId]), ...rest.filter((id) => !nextPinned.includes(id)), ...(isPinned ? [sessionId] : [])];
	return { tabs: nextTabs, pinned: nextPinned };
}

/**
 * 拖拽排序：source 插入到 target 前/后。
 * - 同区内拖动：仅在对应区间内重排；
 * - 交叉拖动（固定 ↔ 普通）：自动转换 source 的固定状态（与 VS Code/浏览器一致），
 *   插入目标区间对应位置。
 */
export function reorderSessionTabs(tabs: readonly string[], pinned: readonly string[], sourceId: string, targetId: string, position: "before" | "after"): { tabs: string[]; pinned: string[] } {
	if (sourceId === targetId) return { tabs: [...tabs], pinned: [...pinned] };
	const sourcePinned = pinned.includes(sourceId);
	const targetPinned = pinned.includes(targetId);
	// 交叉拖放：源进入目标区域，同步固定集合
	const nextPinned = sourcePinned === targetPinned ? [...pinned] : sourcePinned ? pinned.filter((id) => id !== sourceId) : [...pinned, sourceId];

	const rest = tabs.filter((id) => id !== sourceId);
	const pinnedList = rest.filter((id) => nextPinned.includes(id));
	const normalList = rest.filter((id) => !nextPinned.includes(id));
	const insert = (list: string[], ref: string, pos: "before" | "after") => {
		const index = list.indexOf(ref);
		const at = index === -1 ? list.length : index + (pos === "after" ? 1 : 0);
		return [...list.slice(0, at), sourceId, ...list.slice(at)];
	};
	const nextPinnedList = targetPinned ? insert(pinnedList, targetId, position) : pinnedList;
	const nextNormalList = targetPinned ? normalList : insert(normalList, targetId, position);
	return { tabs: [...nextPinnedList, ...nextNormalList], pinned: nextPinned };
}

/**
 * Ctrl+Tab 循环切换：按 Tab 栏顺序返回目标会话 id（到头回绕）。
 * 当前会话不在 Tab 列表（分屏聚焦外会话/无 Tab）时，正向切到首个、反向切到末个；
 * 不足 2 个 Tab 无处可切，返回 null。
 */
export function cycleSessionTab(tabs: readonly string[], currentSessionId: string | undefined, direction: 1 | -1): string | null {
	if (tabs.length < 2) return null;
	const index = currentSessionId ? tabs.indexOf(currentSessionId) : -1;
	if (index === -1) return direction === 1 ? tabs[0] : (tabs[tabs.length - 1] ?? null);
	return tabs[(index + direction + tabs.length) % tabs.length] ?? null;
}
