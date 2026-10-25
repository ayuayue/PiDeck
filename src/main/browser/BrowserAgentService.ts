import type { WebContents } from "electron";
import { BrowserController } from "./BrowserController";
import { BrowserGuestRegistry } from "./BrowserGuestRegistry";
import { BrowserCdpSession } from "./cdpSession";
import { captureBrowserScreenshot } from "./browserScreenshot";
import { CuaGate, type CuaApprovalRequest, type CuaApprovalResponse } from "../cua/CuaGate";

/**
 * 浏览器 Agent 的装配层：
 * - registry 保存 did-attach-webview 拿到的 guest；
 * - cdp 租约控制 debugger 的独占使用；
 * - gate 是**独立于 CUA** 的审批门实例（独立开关 + 独立 autoApprove 默认值）；
 * - 对 host 只暴露 controller/gate，工具注册由 CuaMcpServer 决定。
 */

export type BrowserAgentServiceDeps = {
	/** 运行时枚举全部 webContents（生产传 webContents.getAllWebContents）。 */
	listAllWebContents: () => WebContents[];
	/** 是否属于内置浏览器分区（生产传 session 身份比较）。 */
	isBrowserPanelGuest: (guest: WebContents) => boolean;
	/** 每次写操作时实时解析 browserAgentAutoApprove。 */
	getAutoApprove: () => boolean;
};

export type BrowserAgentApprovalHandler = (request: CuaApprovalRequest) => Promise<CuaApprovalResponse>;

export class BrowserAgentService {
	private readonly registry: BrowserGuestRegistry;
	private readonly cdp = new BrowserCdpSession();
	readonly gate: CuaGate;
	readonly controller: BrowserController;

	constructor(deps: BrowserAgentServiceDeps) {
		this.registry = new BrowserGuestRegistry({
			listAll: deps.listAllWebContents,
			isBrowserPanelGuest: deps.isBrowserPanelGuest,
			// 页面导航（含 SPA 路由）→ 旧 ref 全部失效；页面不可信，不能靠页面自觉清理 data-pideck-ref。
			onGuestNavigated: () => this.controller?.invalidateSnapshot(),
		});
		this.gate = new CuaGate({ enabled: false, autoApprove: deps.getAutoApprove });
		this.controller = new BrowserController({
			registry: this.registry,
			cdp: this.cdp,
			gate: this.gate,
			capture: captureBrowserScreenshot,
		});
	}

	/** did-attach-webview 时调用；重复 attach 幂等。 */
	attachGuest(guest: WebContents): void {
		this.registry.attach(guest);
	}

	isEnabled(): boolean {
		return this.gate.isEnabled();
	}

	setEnabled(enabled: boolean): void {
		this.gate.setEnabled(enabled);
	}

	/** 复用 CuaIpcManager 的审批推送（同一套渲染层对话框/队列），不新增 IPC 通道。 */
	setApprovalHandler(handler: BrowserAgentApprovalHandler | null): void {
		this.gate.setApprovalHandler(handler);
	}

	getToolDeps(): { controller: BrowserController; gate: CuaGate; enabled: () => boolean } {
		return { controller: this.controller, gate: this.gate, enabled: () => this.isEnabled() };
	}

	dispose(): void {
		this.registry.dispose();
		this.cdp.dispose();
	}
}
