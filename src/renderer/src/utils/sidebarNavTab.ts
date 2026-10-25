/**
 * 侧栏 Chats/项目分段切换的本地缓存。
 *
 * 与展开集合相同的双写策略：localStorage 作首屏同步缓存，settings.json 作跨进程可靠落盘。
 * dev 模式强杀进程时 localStorage 可能来不及写入，settings.json 才是权威来源。
 * 无旧 key 需要迁移；缺省为 chats（打开侧栏先看到当前项目会话，而不是项目列表）。
 */

export const SIDEBAR_NAV_TAB_KEY = "pid:sidebar-nav-tab";

/** 侧栏分段：active（活动 Agent）/ chats（历史会话）/ projects（项目）。 */
export type SidebarNavTab = "active" | "chats" | "projects";

export const DEFAULT_SIDEBAR_NAV_TAB: SidebarNavTab = "chats";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 只接受 active/chats/projects；其它字符串或 JSON 垃圾一律视为未设置。 */
export function parseSidebarNavTab(raw: string | null | undefined): SidebarNavTab | null {
	if (raw === "active" || raw === "chats" || raw === "projects") return raw;
	return null;
}

export function readSidebarNavTab(storage?: StorageLike): SidebarNavTab | null {
	if (!storage) return null;
	try {
		return parseSidebarNavTab(storage.getItem(SIDEBAR_NAV_TAB_KEY));
	} catch {
		return null;
	}
}

export function writeSidebarNavTab(storage: StorageLike | undefined, tab: SidebarNavTab) {
	if (!storage) return;
	try {
		storage.setItem(SIDEBAR_NAV_TAB_KEY, tab);
	} catch {
		// localStorage 不可用时静默忽略；settings.json 仍会落盘
	}
}
