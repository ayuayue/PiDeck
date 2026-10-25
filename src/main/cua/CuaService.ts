/**
 * CuaService — main-process assembly for the CUA capability (Plan A / T7).
 *
 * Responsibilities:
 *   - Own the singleton CuaGate + CuaEngine.
 *   - Start the in-process MCP Streamable HTTP host (CuaMcpHttpHost) on
 *     127.0.0.1 with a random bearer token.
 *   - Wire the gate's approval handler to the renderer dialog via CuaIpcManager.
 *   - Register/unregister the `pideck-cua` MCP entry in ~/.pi/agent/mcp.json.
 *
 * Lifecycle is driven by the `cuaEnabled` setting: the host only listens (and
 * the pi MCP entry only exists) while CUA is enabled. This keeps the default
 * posture "off": no listener, no pi config mutation.
 *
 * Everything Electron-specific lives in CuaIpcManager, so this module is a thin
 * orchestrator that the main index can register with quitCleanup.
 */

import { randomBytes } from "node:crypto";
import type { BrowserWindow } from "electron";
import { CuaEngine } from "./CuaEngine";
import { CuaGate } from "./CuaGate";
import type { CuaMcpHttpHost } from "./CuaMcpHttpHost";
import { ensureCuaMcpRegistered, unregisterCuaMcp } from "./CuaMcpRegistration";
import type { CuaMcpBrowserTools } from "./CuaMcpServer";
import { CuaIpcManager, type CuaIpcDeps } from "../ipc/cuaIpc";
import type { BrowserAgentService } from "../browser/BrowserAgentService";

export type CuaServiceDeps = {
	/** Current main window (may be null before/after window lifecycle). */
	getMainWindow: () => BrowserWindow | null;
	/** Structured logger. */
	log: (domain: string, message: string, details?: Record<string, unknown>) => void;
	/**
	 * 免审批设置的实时读取（cuaAutoApprove）：每次写操作 check 时解析，
	 * 改设置无需重启/重接线。缺省视为关闭。
	 */
	getAutoApprove?: () => boolean;
	/**
	 * 浏览器 Agent（可选）：与 CUA 共用同一个 MCP host 与 mcp.json 条目，
	 * 但开关、gate 实例与 autoApprove 全部独立（docs/browser-agent-plan.md §7.2）。
	 */
	browserAgent?: BrowserAgentService;
};

export class CuaService {
	private deps: CuaServiceDeps;
	private gate: CuaGate;
	private engine: CuaEngine;
	private ipc: CuaIpcManager;
	private host: CuaMcpHttpHost | null = null;
	private running = false;
	/** 能力开关（host 存活 ≠ 能力启用）：start() 前由 applySettings 写入。 */
	private cuaEnabled = false;
	private browserEnabled = false;

	constructor(deps: CuaServiceDeps) {
		this.deps = deps;
		// Gate starts CLOSED and only opens while the MCP host is actually
		// listening (start()) — previously it was hard-coded on at construction,
		// so cua:get-state reported enabled=true even when cuaEnabled=false and
		// no endpoint existed (state misreport).
		this.gate = new CuaGate({
			enabled: false,
			autoApprove: () => this.deps.getAutoApprove?.() ?? false,
		});
		this.engine = new CuaEngine({ defaultDelayMs: 80 }, this.gate);

		const ipcDeps: CuaIpcDeps = {
			gate: this.gate,
			mainWindow: deps.getMainWindow,
			log: deps.log,
		};
		this.ipc = new CuaIpcManager(ipcDeps);
		this.ipc.register();

		// Route approvals straight to the renderer dialog (in-process, no HTTP hop).
		this.gate.setApprovalHandler(this.ipc.createApprovalHandler());
		// 浏览器审批复用同一 CuaIpcManager（同一套对话框/队列，不新增 IPC 通道），
		// 但 gate 实例独立：浏览器开关/自动审批不会影响 CUA 的桌面注入。
		this.deps.browserAgent?.setApprovalHandler(this.ipc.createApprovalHandler());
	}

	isRunning(): boolean {
		return this.running;
	}

	/**
	 * 设置驱动的唯一生命周期入口（CUA 与浏览器能力共用 host）：
	 * - 任一能力启用 → 保证 host 在跑（不重复启动，避免 token/端口抖动）；
	 * - 两者都关 → 停 host 并注销 mcp.json；
	 * - gate 按能力分别开关，host 存活不代表 CUA 可用。
	 */
	async applySettings(next: { cuaEnabled: boolean; browserAgentEnabled: boolean }): Promise<void> {
		this.cuaEnabled = next.cuaEnabled;
		this.browserEnabled = Boolean(this.deps.browserAgent && next.browserAgentEnabled);
		this.gate.setEnabled(this.cuaEnabled);
		this.deps.browserAgent?.setEnabled(this.browserEnabled);
		const shouldRun = this.cuaEnabled || this.browserEnabled;
		if (shouldRun && !this.running) {
			try {
				await this.start({ cuaEnabled: this.cuaEnabled });
			} catch (error) {
				// host 起不来时浏览器 gate 也必须关掉（fail-closed）：没有端点就不该保留"已启用"状态。
				this.browserEnabled = false;
				this.deps.browserAgent?.setEnabled(false);
				throw error;
			}
		} else if (!shouldRun && this.running) {
			await this.stop();
		}
	}

	/** 浏览器工具组：host 每次建 McpServer 时按需取，未装配浏览器能力则返回 undefined。 */
	private buildBrowserTools(): CuaMcpBrowserTools | undefined {
		const browserAgent = this.deps.browserAgent;
		if (!browserAgent) return undefined;
		const deps = browserAgent.getToolDeps();
		return { enabled: deps.enabled, controller: deps.controller, gate: deps.gate };
	}

	/**
	 * Start the HTTP host and register with pi. Idempotent.
	 *
	 * 直接调用（测试/旧路径）默认按 CUA 能力开启处理；生产统一走 applySettings，
	 * 由它传入真实开关，避免"只为浏览器启动 host 时把 CUA gate 打开"。
	 */
	async start(options: { cuaEnabled?: boolean } = {}): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.cuaEnabled = options.cuaEnabled ?? true;

		const authToken = randomBytes(32).toString("hex");
		// 按需加载（2026-10 启动审计）：`@modelcontextprotocol/sdk` 是启动路径上最重的静态第三方
		// 依赖（冷 require 实测 ≈100ms），但 CUA 默认关闭、http host 只有这里用。改成动态 import 后，
		// 未开 CUA 的启动不再为它付模块解析成本；首次开启多一次性加载延迟（用户可感知为「点了稍等」）。
		const { CuaMcpHttpHost: CuaMcpHttpHostCtor } = await import("./CuaMcpHttpHost");
		this.host = new CuaMcpHttpHostCtor(
			{ port: 0, authToken },
			{
				engine: this.engine,
				gate: this.gate,
				// 每次 MCP 会话初始化时求值：只为已启用能力注册工具组。
				cuaEnabled: () => this.cuaEnabled,
				browser: this.buildBrowserTools(),
				onLog: (level, message) => this.deps.log("cua", message, { level }),
			},
		);

		try {
			await this.host.start();
			const url = this.host.getUrl();
			if (url) {
				const result = ensureCuaMcpRegistered({ url, bearerToken: authToken });
				this.deps.log("cua", `CUA MCP registered at ${url}`, { written: result.written });
			}
			this.gate.setEnabled(this.cuaEnabled);
		} catch (error) {
			this.running = false;
			this.gate.setEnabled(false);
			const message = error instanceof Error ? error.message : String(error);
			this.deps.log("cua", `CUA service start failed: ${message}`);
			throw error;
		}
	}

	/** Stop the host and unregister from pi. Idempotent. */
	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		// Close the kill switch first so nothing squeezes through mid-shutdown.
		this.gate.setEnabled(false);
		// host 停止 = 浏览器能力一并失效（fail-closed）；下次 applySettings 会按真实开关恢复。
		this.browserEnabled = false;
		this.deps.browserAgent?.setEnabled(false);

		try {
			unregisterCuaMcp();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.log("cua", `CUA MCP unregister failed: ${message}`);
		}

		const host = this.host;
		this.host = null;
		if (host) {
			try {
				await host.stop();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.deps.log("cua", `CUA HTTP host stop failed: ${message}`);
			}
		}
	}

	/** Full teardown for app quit. */
	async dispose(): Promise<void> {
		await this.stop();
		this.ipc.dispose();
	}
}
