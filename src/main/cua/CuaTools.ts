/**
 * CUA MCP tool registration — shared by the in-process HTTP host (Plan A) and
 * the legacy standalone stdio server.
 *
 * Extracted from CuaMcpServer so both transports register an identical tool
 * surface and the implementation lives in exactly one place.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CuaEngine } from "./CuaEngine";
import type { CuaGate } from "./CuaGate";
import { tryListCuaDisplays } from "./CuaDisplay";
import { captureScreen } from "./CuaFrame";

/**
 * Register the six CUA tools on an McpServer instance.
 *
 * Read-only tools (cua_capture / cua_list_windows / cua_get_state) do not pass
 * through the gate. Write tools (cua_click / cua_type / cua_scroll) route
 * through engine methods that check the gate (kill switch + approval).
 *
 * Coordinate contract: cua_click/cua_scroll take absolute physical pixels of
 * the virtual desktop (origin may be negative). cua_get_state lists every
 * display with that rect, and cua_capture echoes the captured display's rect so
 * a screenshot pixel converts as rect.x + imageX * rect.width / width.
 */
export function registerCuaTools(server: McpServer, engine: CuaEngine, gate: CuaGate): void {
	// -------------------------------------------------------------------------
	// cua_capture — single display capture (read-only)
	// -------------------------------------------------------------------------
	server.registerTool(
		"cua_capture",
		{
			description:
				'Capture one display and return a JPEG image. displayId comes from cua_get_state.displays (a displayId or sourceId) or is "primary". The response screenRect is that display in absolute click coordinates: x = screenRect.x + imageX * screenRect.width / width, y = screenRect.y + imageY * screenRect.height / height.',
			inputSchema: {
				displayId: z.string().optional().describe('Display to capture: a displayId or sourceId from cua_get_state.displays, or "primary". Omit for primary.'),
				maxLongEdge: z.number().int().min(16).max(8192).default(1280).describe("Resize so the longer edge <= this (16-8192)."),
				quality: z.number().int().min(1).max(100).default(75).describe("JPEG quality 1-100."),
			},
		},
		async (args) => {
			const frame = await captureScreen({
				displayId: args.displayId,
				maxLongEdge: args.maxLongEdge,
				quality: args.quality,
			});

			return {
				content: [
					{
						type: "image",
						data: frame.base64,
						mimeType: frame.mimeType,
					},
					{
						type: "text",
						text: JSON.stringify({
							width: frame.width,
							height: frame.height,
							displayId: frame.displayId,
							screenDisplayId: frame.screenDisplayId,
							screenRect: frame.screenRect,
							scaleFactor: frame.scaleFactor,
							isPrimary: frame.isPrimary,
							timestampMs: frame.timestampMs,
							durationMs: frame.durationMs,
							base64Length: frame.base64.length,
						}),
					},
				],
			};
		},
	);

	// -------------------------------------------------------------------------
	// cua_list_windows — list visible top-level windows (read-only)
	// -------------------------------------------------------------------------
	server.registerTool(
		"cua_list_windows",
		{
			description: "List visible top-level windows with Z-order and geometry.",
			inputSchema: {
				includeInvisible: z.boolean().default(false),
			},
		},
		async (args) => {
			const windows = engine.listWindows(args.includeInvisible);
			// isVisible 必须进契约：includeInvisible=true 时调用方要能区分隐藏窗口，
			// 否则开关形同虚设（历史漏字段回归，由 MCP 层测试兜底）。
			const summary = windows.map((info) => ({
				hwnd: info.window.hwnd,
				title: info.window.title,
				pid: info.window.pid,
				zIndex: info.window.zIndex,
				rect: info.window.rect,
				isVisible: info.window.isVisible,
				isForeground: info.window.isForeground,
				isTopmost: info.window.isTopmost,
				occludedArea: info.occludedArea,
				titleBarPoint: info.titleBarPoint,
			}));

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(summary, null, 2),
					},
				],
			};
		},
	);

	// -------------------------------------------------------------------------
	// cua_click — click at absolute screen coordinates (write, gated)
	// -------------------------------------------------------------------------
	server.registerTool(
		"cua_click",
		{
			description: "Click at absolute screen coordinates.",
			inputSchema: {
				x: z.number().int().describe("Absolute screen X coordinate."),
				y: z.number().int().describe("Absolute screen Y coordinate."),
				button: z.enum(["left", "right", "middle"]).default("left"),
				double: z.boolean().default(false),
				activateTarget: z.string().optional().describe("Optional target window title substring to activate before clicking."),
				sessionId: z.string().describe("PiDeck session ID for approval gate."),
				agentId: z.string().optional().describe("PiDeck agent id (approval attribution)."),
				runtimeGeneration: z.number().int().optional().describe("Session runtime generation (approval attribution)."),
			},
		},
		async (args) => {
			const meta = { agentId: args.agentId, runtimeGeneration: args.runtimeGeneration };
			// Double click routes to a dedicated engine method so the whole gesture
			// is covered by ONE approval (see CuaEngine.doubleClick).
			const result = args.double
				? await engine.doubleClick(args.sessionId, args.x, args.y, args.button, { activateTarget: args.activateTarget, meta })
				: await engine.click(args.sessionId, args.x, args.y, args.button, {
						activateTarget: args.activateTarget,
						meta,
					});

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ sent: result.sent, error: result.error, gate: result.gateDecision }),
					},
				],
				isError: !!result.error,
			};
		},
	);

	// -------------------------------------------------------------------------
	// cua_type — keyboard input (write, gated)
	// -------------------------------------------------------------------------
	server.registerTool(
		"cua_type",
		{
			description: "Type a text string or press key combinations.",
			inputSchema: {
				text: z.string().max(4000).optional().describe("Text to type (Unicode supported, max 4000 chars)."),
				key: z.string().optional().describe("Key name: enter, tab, escape, backspace, delete, space, arrows, home, end, pageup, pagedown."),
				modifiers: z
					.array(z.enum(["ctrl", "alt", "shift", "win"]))
					.optional()
					.describe("Modifiers for key combos."),
				sessionId: z.string().describe("PiDeck session ID for approval gate."),
				agentId: z.string().optional().describe("PiDeck agent id (approval attribution)."),
				runtimeGeneration: z.number().int().optional().describe("Session runtime generation (approval attribution)."),
			},
		},
		async (args) => {
			const result = await engine.type(
				args.sessionId,
				{
					text: args.text,
					key: args.key,
					modifiers: args.modifiers,
				},
				{ meta: { agentId: args.agentId, runtimeGeneration: args.runtimeGeneration } },
			);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ sent: result.sent, error: result.error, gate: result.gateDecision }),
					},
				],
				isError: !!result.error,
			};
		},
	);

	// -------------------------------------------------------------------------
	// cua_scroll — mouse wheel scroll (write, gated)
	// -------------------------------------------------------------------------
	server.registerTool(
		"cua_scroll",
		{
			description: "Scroll the mouse wheel at absolute screen coordinates.",
			inputSchema: {
				x: z.number().int().describe("Absolute screen X coordinate."),
				y: z.number().int().describe("Absolute screen Y coordinate."),
				deltaY: z.number().int().min(-2400).max(2400).default(-120).describe("Windows wheel convention: positive=scroll up, negative=scroll down (default: one notch down)."),
				deltaX: z.number().int().min(-2400).max(2400).default(0).describe("Horizontal wheel: positive=right, negative=left."),
				sessionId: z.string().describe("PiDeck session ID for approval gate."),
				agentId: z.string().optional().describe("PiDeck agent id (approval attribution)."),
				runtimeGeneration: z.number().int().optional().describe("Session runtime generation (approval attribution)."),
			},
		},
		async (args) => {
			const result = await engine.scroll(args.sessionId, args.x, args.y, args.deltaY, args.deltaX, {
				meta: { agentId: args.agentId, runtimeGeneration: args.runtimeGeneration },
			});

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ sent: result.sent, error: result.error, gate: result.gateDecision }),
					},
				],
				isError: !!result.error,
			};
		},
	);

	// -------------------------------------------------------------------------
	// cua_get_state — read CUA state (read-only)
	// -------------------------------------------------------------------------
	server.registerTool(
		"cua_get_state",
		{
			description: "Read the current CUA state: all displays with their absolute rects, virtual desktop, gate status, foreground window.",
			inputSchema: {
				sessionId: z.string().optional().describe("PiDeck session ID to check session-level gate."),
			},
		},
		async (args) => {
			const display = engine.getDisplay();
			// 多显示器：display 只描述主屏尺寸；displays/virtualDesktop 才是点击坐标空间。
			// 非 Electron 宿主（node 测试/旧 stdio 服务）拿不到显示器列表，退化为空数组。
			const displays = tryListCuaDisplays() ?? [];
			const virtualDesktop = engine.getVirtualDesktop();
			const fg = engine.getForegroundWindow();
			const gateEnabled = gate.isEnabled();
			const sessionEnabled = args.sessionId ? gate.isSessionEnabled(args.sessionId) : gateEnabled;

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							display,
							displays,
							virtualDesktop,
							gateEnabled,
							sessionEnabled,
							// 免审批状态一并上报：Agent/用户可据此判断是否还会弹审批框。
							autoApprove: gate.isAutoApprove(),
							foregroundWindow: fg
								? {
										hwnd: fg.window.hwnd,
										title: fg.window.title,
										pid: fg.window.pid,
										rect: fg.window.rect,
									}
								: null,
						}),
					},
				],
			};
		},
	);
}
