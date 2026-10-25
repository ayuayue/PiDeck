/**
 * 内置浏览器 guest 的选择逻辑（纯函数）。
 *
 * 事实约束（docs/browser-agent-plan.md §1.2 / §4）：
 * - 内置浏览器是主窗口里的 <webview> guest，partition 固定 persist:pideck-browser-panel；
 * - 宿主插件面板也是 webview，但 partition 是 host-plugin:<uuid>，由 session 身份天然排除；
 * - PiDeck 任意时刻最多 1 个 browser guest（切 tab 用 loadURL 复用同一 guest）。
 */

export type BrowserGuestLike = {
	id: number;
	isDestroyed(): boolean;
	getType(): string;
	getURL(): string;
	getTitle(): string;
};

export type BrowserGuestCandidate<T extends BrowserGuestLike> = {
	guest: T;
	id: number;
	url: string;
	title: string;
};

/**
 * 从列表里挑出当前可操作的浏览器 guest。
 * 取最后一个匹配项：getAllWebContents 的顺序不保证等于创建顺序，而"最近附着"的 guest 才是当前页面。
 */
export function selectBrowserGuest<T extends BrowserGuestLike>(guests: readonly T[], isBrowserPanelGuest: (guest: T) => boolean): BrowserGuestCandidate<T> | null {
	const matches = guests.filter((guest) => !guest.isDestroyed() && guest.getType() === "webview" && isBrowserPanelGuest(guest));
	const guest = matches.length > 0 ? matches[matches.length - 1] : null;
	if (!guest) return null;
	try {
		return { guest, id: guest.id, url: guest.getURL(), title: guest.getTitle() };
	} catch {
		// guest 在筛选与取 URL 之间被销毁：按"当前没有可操作页面"处理，不抛出到工具层。
		return null;
	}
}
