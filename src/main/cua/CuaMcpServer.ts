/**
 * CuaMcpServer — MCP Server factory exposing host tools to pi.
 *
 * Architecture (Plan A, decided after the T7 blocker):
 * - The MCP server runs INSIDE the PiDeck Electron main process, served over
 *   the Streamable HTTP transport (see CuaMcpHttpHost). This keeps screen
 *   capture and webview access available (Electron-only) and matches the
 *   original design intent: no separate subprocess is exposed.
 * - pi connects via the `url` field in ~/.pi/agent/mcp.json.
 * - Tool registration lives in CuaTools.ts / browserMcpTools.ts, shared with any other transport.
 *
 * Security: CUA injects real mouse/keyboard input; browser tools drive the
 * built-in webview (which carries the user signed-in session). Both write
 * paths route through a fail-closed CuaGate instance.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserController } from "../browser/BrowserController";
import { registerBrowserTools } from "../browser/browserMcpTools";
import type { CuaEngine } from "./CuaEngine";
import type { CuaGate } from "./CuaGate";
import { registerCuaTools } from "./CuaTools";

/** 浏览器能力的注册参数：enabled 在每次 MCP 会话初始化时求值，开关改了只需新会话即可生效。 */
export type CuaMcpBrowserTools = {
	enabled: () => boolean;
	controller: BrowserController;
	gate: CuaGate;
};

export type CuaMcpServerOptions = {
	/** true（默认）= 注册 CUA 工具。生产传真实开关，避免只为浏览器启动 host 时暴露桌面注入工具。 */
	cuaEnabled?: boolean;
	browser?: CuaMcpBrowserTools;
};

/**
 * Create a fresh McpServer instance with the enabled tool groups registered.
 *
 * One instance per MCP session/transport: the SDK requires a 1:1 binding
 * between a Server and a connected transport.
 */
export function createCuaMcpServer(engine: CuaEngine, gate: CuaGate, options: CuaMcpServerOptions = {}): McpServer {
	const server = new McpServer(
		{ name: "pideck-cua", version: "0.1.0" },
		{
			capabilities: {
				tools: {},
			},
		},
	);

	// host 存活 ≠ 能力启用：只为已启用的能力注册工具。
	if (options.cuaEnabled ?? true) registerCuaTools(server, engine, gate);
	if (options.browser?.enabled()) registerBrowserTools(server, { controller: options.browser.controller });

	return server;
}
