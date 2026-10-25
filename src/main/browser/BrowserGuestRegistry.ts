import type { WebContents } from "electron";
import { selectBrowserGuest, type BrowserGuestCandidate } from "./browserTarget";

/**
 * 当前内置浏览器 guest 的进程内登记表。
 *
 * 为什么需要：主进程在 did-attach-webview 里已经拿到 guest，但只做了安全校验就丢弃
 * （src/main/index.ts:2229-2244）；Agent 要操作页面必须留住引用。
 *
 * 生命周期配对（AGENTS 稳定性约束）：attach 时登记并挂 destroyed 清理，dispose 时摘掉监听。
 * 抽屉收起/全屏切换会销毁并重建 webview，因此这里必须允许同 id 反复登记、且 resolve 不缓存引用。
 */

export type BrowserGuestRegistryDeps = {
	/** 运行时枚举全部 webContents（生产传 webContents.getAllWebContents）。 */
	listAll: () => WebContents[];
	/** 判定是否属于内置浏览器分区（生产传 session 身份比较；Electron 43 的 session.partition 是 undefined）。 */
	isBrowserPanelGuest: (guest: WebContents) => boolean;
	/**
	 * 页面导航（含 SPA 的 did-navigate-in-page）后回调：controller 借此清 lastSnapshot，
	 * 旧 ref 全部失效。ref 是 data-pideck-ref DOM 属性，页面是不可信输入——不监听导航的话，
	 * 新页面可以自植属性让旧 ref 命中任意元素（把 agent 的点击重定向到转账/删除按钮）。
	 */
	onGuestNavigated?: (guest: WebContents) => void;
};

export class BrowserGuestRegistry {
	private readonly guests = new Map<number, WebContents>();
	private readonly cleanups = new Map<number, () => void>();
	private readonly navigated = new Map<number, () => void>();

	constructor(private readonly deps: BrowserGuestRegistryDeps) {}

	/** did-attach-webview 时登记。重复登记同一 guest 直接忽略，避免重复挂监听。 */
	attach(guest: WebContents): void {
		if (guest.isDestroyed() || this.guests.has(guest.id)) return;
		this.guests.set(guest.id, guest);
		const cleanup = () => {
			if (this.guests.get(guest.id) === guest) this.guests.delete(guest.id);
			this.cleanups.delete(guest.id);
		};
		this.cleanups.set(guest.id, cleanup);
		guest.once("destroyed", cleanup);
		// 导航即失效：did-navigate 覆盖整页跳转，did-navigate-in-page 覆盖 SPA 路由/hash 变化。
		const onNavigate = () => this.deps.onGuestNavigated?.(guest);
		this.navigated.set(guest.id, onNavigate);
		guest.on("did-navigate", onNavigate);
		guest.on("did-navigate-in-page", onNavigate);
	}

	detach(id: number): void {
		const guest = this.guests.get(id);
		if (!guest) return;
		const cleanup = this.cleanups.get(id);
		if (cleanup) guest.removeListener("destroyed", cleanup);
		const onNavigate = this.navigated.get(id);
		if (onNavigate) {
			guest.removeListener("did-navigate", onNavigate);
			guest.removeListener("did-navigate-in-page", onNavigate);
		}
		this.cleanups.delete(id);
		this.navigated.delete(id);
		this.guests.delete(id);
	}

	/**
	 * 解析当前可操作的 guest。
	 * 先看登记表；登记表为空时按分区身份从运行时列表兜底（覆盖"attach 早于 registry 装配"的重建场景）。
	 * 返回 null = 浏览器面板当前没打开 / guest 已销毁，调用方回 browser_not_open。
	 */
	resolve(): BrowserGuestCandidate<WebContents> | null {
		for (const [id, guest] of [...this.guests]) {
			if (guest.isDestroyed()) this.detach(id);
		}
		const registered = [...this.guests.values()];
		const fromRegistry = selectBrowserGuest(registered, this.deps.isBrowserPanelGuest);
		if (fromRegistry) return fromRegistry;
		return selectBrowserGuest(this.deps.listAll(), this.deps.isBrowserPanelGuest);
	}

	dispose(): void {
		for (const id of [...this.guests.keys()]) this.detach(id);
	}
}
