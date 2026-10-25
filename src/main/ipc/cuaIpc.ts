/**
 * CUA IPC handlers（src/main/ipc/cuaIpc.ts）
 *
 * 渲染层 ↔ 主进程的 CUA 审批门通信：
 * - cuaGetState: 渲染层拉取 CUA 开关状态
 * - cuaSetState: 渲染层设置 CUA 开关
 * - cuaApprovalResponse: 渲染层回传审批结果
 * - cuaApprovalRequest: 主进程 → 渲染层推送审批请求（subscribe 模式）
 *
 * CUA MCP Server（主进程内）→ CuaGate.approvalHandler → pendingApprovals → IPC → 渲染层
 */

import { ipcMain, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { randomUUID } from "node:crypto";
import type { CuaGate, CuaApprovalRequest, CuaApprovalResponse } from "../cua";

export type CuaIpcDeps = {
	/** The CuaGate instance (shared with the in-process MCP host). */
	gate: CuaGate;
	/** Main browser window for sending IPC to renderer. */
	mainWindow: () => BrowserWindow | null;
	log: (domain: string, message: string, details?: Record<string, unknown>) => void;
};

type PendingApproval = {
	requestId: string;
	resolve: (response: CuaApprovalResponse) => void;
	timeoutId: NodeJS.Timeout;
};

export class CuaIpcManager {
	private pendingApprovals = new Map<string, PendingApproval>();
	private deps: CuaIpcDeps;

	constructor(deps: CuaIpcDeps) {
		this.deps = deps;
	}

	/**
	 * Register all CUA IPC handlers.
	 */
	register(): void {
		ipcMain.handle(ipcChannels.cuaGetState, () => {
			return {
				enabled: this.deps.gate.isEnabled(),
				sessionOverrides: this.deps.gate.getSessionOverrides(),
			};
		});

		ipcMain.handle(ipcChannels.cuaSetState, async (_event, value: unknown) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				return { enabled: this.deps.gate.isEnabled(), sessionOverrides: this.deps.gate.getSessionOverrides() };
			}
			const patch = value as {
				enabled?: unknown;
				sessionOverride?: { sessionId?: unknown; enabled?: unknown } | null;
			};

			if (typeof patch.enabled === "boolean") {
				this.deps.gate.setEnabled(patch.enabled);
			}

			// 输入校验在边界：sessionOverride 结构非法时忽略并记录，不写入 gate。
			const override = patch.sessionOverride;
			if (override != null && typeof override === "object") {
				const validId = typeof override.sessionId === "string" && override.sessionId.trim().length > 0;
				const validFlag = typeof override.enabled === "boolean" || override.enabled === null;
				if (validId && validFlag) {
					this.deps.gate.setSessionOverride(override.sessionId as string, override.enabled as boolean | null);
				} else {
					this.deps.log("cua", "cuaSetState: ignored invalid sessionOverride", {
						sessionIdType: typeof override.sessionId,
						enabledType: typeof override.enabled,
					});
				}
			}

			return {
				enabled: this.deps.gate.isEnabled(),
				sessionOverrides: this.deps.gate.getSessionOverrides(),
			};
		});

		ipcMain.handle(ipcChannels.cuaApprovalResponse, async (_event, requestId: unknown, response: unknown) => {
			if (typeof requestId !== "string" || !requestId.trim()) {
				this.deps.log("cua", "approval response: invalid requestId");
				return;
			}

			const pending = this.pendingApprovals.get(requestId);
			if (!pending) {
				this.deps.log("cua", "approval response: unknown requestId", { requestId });
				return;
			}

			clearTimeout(pending.timeoutId);
			this.pendingApprovals.delete(requestId);

			// 渲染层数据不可信：allowed 必须是严格 boolean、reason 必须是字符串，
			// 任何越界形态一律当作拒绝（fail closed），防止 truthy 值绕过审批。
			let result: CuaApprovalResponse = { allowed: false, reason: "invalid_response" };
			if (response && typeof response === "object" && !Array.isArray(response)) {
				const candidate = response as { allowed?: unknown; reason?: unknown };
				if (typeof candidate.allowed === "boolean") {
					result = {
						allowed: candidate.allowed,
						reason: typeof candidate.reason === "string" ? candidate.reason : undefined,
					};
				}
			}

			pending.resolve(result);
		});
	}

	/**
	 * Create the requestApproval callback for the in-process CuaGate.
	 * This pushes the approval request to the renderer via IPC and waits for response.
	 */
	createApprovalHandler(): (request: CuaApprovalRequest) => Promise<CuaApprovalResponse> {
		return (request) => {
			return new Promise<CuaApprovalResponse>((resolve) => {
				const requestId = randomUUID();
				const timeoutId = setTimeout(() => {
					this.pendingApprovals.delete(requestId);
					resolve({ allowed: false, reason: "approval_timeout" });
				}, 30000);

				this.pendingApprovals.set(requestId, { requestId, resolve, timeoutId });

				const win = this.deps.mainWindow();
				if (!win || win.isDestroyed()) {
					clearTimeout(timeoutId);
					this.pendingApprovals.delete(requestId);
					resolve({ allowed: false, reason: "no_window" });
					return;
				}

				win.webContents.send(ipcChannels.cuaApprovalRequest, {
					requestId,
					...request,
				});
			});
		};
	}

	/**
	 * Unregister all CUA IPC handlers and clear pending approvals.
	 */
	dispose(): void {
		for (const [id, pending] of this.pendingApprovals) {
			clearTimeout(pending.timeoutId);
			pending.resolve({ allowed: false, reason: "disposed" });
		}
		this.pendingApprovals.clear();

		ipcMain.removeHandler(ipcChannels.cuaGetState);
		ipcMain.removeHandler(ipcChannels.cuaSetState);
		ipcMain.removeHandler(ipcChannels.cuaApprovalResponse);
	}
}

export function registerCuaIpc(deps: CuaIpcDeps): CuaIpcManager {
	const manager = new CuaIpcManager(deps);
	manager.register();
	return manager;
}
