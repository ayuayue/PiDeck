import type { WebContents } from "electron";
import { BrowserAgentError, errorMessage } from "./browserErrors";

/** 一条 CDP 命令的发送函数（sessionId 用于 worker/子 target，页面主 frame 不需要）。 */
export type CdpSend = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;

export type BrowserCdpSessionOptions = {
	/** 单条 CDP 命令超时（默认 8s；截图/导航在调用侧另设更长等待）。 */
	commandTimeoutMs?: number;
};

/**
 * CDP 会话租约：webContents.debugger 是**独占**的（PoC 实测二次 attach 抛 Debugger is already attached），
 * 而仓库里 MemoryMonitor 也会在 PIDECK_MEMORY_PROFILE=1 时 attach 所有 webContents。
 *
 * 策略（docs/browser-agent-plan.md §8）：
 * - 每次动作 attach → 执行 → detach，把冲突窗口压到最小；
 * - 只 detach 自己 attach 的（租约表），别人的 attach 一律不抢，回 cdp_busy；
 * - attach 失败不重试，调用方可降级 executeJavaScript 并把 degraded 标记回给模型。
 *
 * 并发正确性（引用计数）：多个工具调用并发进入时（多 agent 会话共用同一 controller/cdp），
 * 第一个进入者负责 attach，后来者复用同一租约；只有最后一个使用者结束才 detach。
 * 此前按"谁 attach 谁 detach"结算，先进入者会在复用者运行中途 detach，
 * 导致后者的 Input 序列断裂（mousePressed 发出而 mouseReleased 缺失）。
 */
type CdpLease = { guest: WebContents; users: number };

export class BrowserCdpSession {
	private readonly leases = new Map<number, CdpLease>();

	constructor(private readonly options: BrowserCdpSessionOptions = {}) {}

	async withGuest<T>(guest: WebContents, run: (send: CdpSend) => Promise<T>): Promise<T> {
		const existing = this.leases.get(guest.id);
		if (existing) {
			existing.users += 1;
			try {
				return await run(this.sender(guest));
			} finally {
				existing.users -= 1;
				if (existing.users <= 0) this.release(existing);
			}
		}
		if (guest.debugger.isAttached()) {
			throw new BrowserAgentError("cdp_busy", "该页面已被其他调试器占用（DevTools 或内存探针），请关闭后重试");
		}
		try {
			guest.debugger.attach("1.3");
		} catch (error) {
			throw new BrowserAgentError("cdp_unavailable", errorMessage(error));
		}
		const lease: CdpLease = { guest, users: 1 };
		this.leases.set(guest.id, lease);
		try {
			return await run(this.sender(guest));
		} finally {
			lease.users -= 1;
			if (lease.users <= 0) this.release(lease);
		}
	}

	/** 应用退出/服务 dispose 时兜底释放，避免把 guest 锁在 attached 状态。 */
	dispose(): void {
		for (const lease of [...this.leases.values()]) {
			lease.users = 0;
			this.release(lease);
		}
	}

	private sender(guest: WebContents): CdpSend {
		return (method, params, sessionId) => this.command(guest, method, params, sessionId);
	}

	private release(lease: CdpLease): void {
		if (this.leases.get(lease.guest.id) !== lease) return;
		if (lease.users > 0) return;
		this.leases.delete(lease.guest.id);
		try {
			if (!lease.guest.isDestroyed() && lease.guest.debugger.isAttached()) lease.guest.debugger.detach();
		} catch {
			// best-effort：guest 已销毁或已被 DevTools 接管时 detach 会抛，忽略即可。
		}
	}

	private command(guest: WebContents, method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
		const timeoutMs = this.options.commandTimeoutMs ?? 8000;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				// 超时≠取消：底层命令仍可能稍后落地（Input 事件延迟执行），调用方语义上按失败处理。
				reject(new BrowserAgentError("cdp_timeout", `CDP ${method} 超时（${timeoutMs}ms）`));
			}, timeoutMs);
			guest.debugger.sendCommand(method, params, sessionId).then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					clearTimeout(timer);
					// guest 中途销毁是"页面没了"而不是"调试器被占"，单独定性避免模型误判重试方向。
					if (guest.isDestroyed()) {
						reject(new BrowserAgentError("browser_guest_gone", "浏览器页面已关闭"));
						return;
					}
					reject(new BrowserAgentError("cdp_unavailable", errorMessage(error)));
				},
			);
		});
	}
}
