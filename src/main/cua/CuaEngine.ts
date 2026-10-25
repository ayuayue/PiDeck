import { clickAt, GetForegroundWindow, HWND_NOTOPMOST, HWND_TOPMOST, IsWindow, koffiAddress, moveMouseAbsolute, pressKeyCombo, scrollAt, SetWindowPos, ShowWindow, SW_RESTORE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE, SWP_SHOWWINDOW, typeUnicode, VK_MAP, type WindowInfo } from "./CuaWin32";
import { analyzeWindows, findWindowByTitle, getPrimaryDisplay, getVirtualDisplay, type OcclusionInfo } from "./CuaWindowAnalyzer";
import { CuaGate, type CuaActionMeta, type CuaActionType } from "./CuaGate";

/**
 * High-level CUA engine: window activation, input injection, and state queries.
 *
 * Activation strategy (validated by probe5):
 * 1. Find the target window and its visible title-bar point.
 * 2. Temporarily make it TOPMOST so it can receive input even if not foreground.
 * 3. Click a visible point on its title bar to bring it to the foreground.
 * 4. Remove the TOPMOST flag so we do not permanently alter the user's window stack.
 *
 * This works around Windows' foreground-lock restrictions where
 * SetForegroundWindow fails across processes.
 */

export type CuaActionOptions = {
	/** If provided, try to activate the matching window before acting. */
	activateTarget?: string;
	/** If true, require that the action coordinate is not fully occluded. */
	requireVisible?: boolean;
	/** Runtime identity attached to the approval request. */
	meta?: CuaActionMeta;
};

export type CuaEngineConfig = {
	/** Default delay between window operations in milliseconds. */
	defaultDelayMs: number;
};

export type CuaActionResult = {
	sent: number;
	error?: string;
	gateDecision?: string;
};

export class CuaEngine {
	private config: CuaEngineConfig;
	private gate: CuaGate;

	constructor(config: CuaEngineConfig = { defaultDelayMs: 80 }, gate?: CuaGate) {
		this.config = config;
		this.gate = gate ?? new CuaGate();
	}

	// -------------------------------------------------------------------------
	// Read-only operations (no gate check needed)
	// -------------------------------------------------------------------------

	listWindows(includeInvisible = false): OcclusionInfo[] {
		return analyzeWindows({ includeInvisible });
	}

	getDisplay(): { width: number; height: number } {
		return getPrimaryDisplay();
	}

	/**
	 * Virtual desktop bounds covering every monitor, in absolute physical pixels.
	 * This is the space cua_click / cua_list_windows rects live in.
	 */
	getVirtualDesktop(): { x: number; y: number; width: number; height: number } {
		return getVirtualDisplay();
	}

	getForegroundWindow(): OcclusionInfo | undefined {
		const analyzed = analyzeWindows();
		return analyzed.find((info) => info.window.isForeground);
	}

	findWindow(titleSubstring: string): OcclusionInfo | undefined {
		return findWindowByTitle(titleSubstring);
	}

	isPointVisible(x: number, y: number): boolean {
		const analyzed = analyzeWindows();
		for (const info of analyzed) {
			if (!info.window.isVisible) continue;
			const r = info.window.rect;
			if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
				// Topmost window containing the point: visible only if the point
				// survives inside one of its un-occluded fragments.
				return info.visibleRects.some((piece) => x >= piece.x && x < piece.x + piece.width && y >= piece.y && y < piece.y + piece.height);
			}
		}
		// Not inside any window → bare desktop, which is visible.
		return true;
	}

	// -------------------------------------------------------------------------
	// Window activation
	// -------------------------------------------------------------------------

	async activateWindow(titleSubstring: string): Promise<{ success: boolean; window?: WindowInfo; method: string; error?: string }> {
		const info = findWindowByTitle(titleSubstring);
		if (!info) {
			return { success: false, method: "none", error: `Window not found: ${titleSubstring}` };
		}

		const hwnd = info.window.hwnd as unknown as object;
		if (!IsWindow(hwnd)) {
			return { success: false, method: "none", error: "Window handle is no longer valid" };
		}

		if (info.window.isForeground) {
			return { success: true, window: info.window, method: "already-foreground" };
		}

		const titleBarPoint = info.titleBarPoint;
		if (!titleBarPoint) {
			return { success: false, method: "none", error: "Target window is fully occluded; no safe title-bar point" };
		}

		// Temporarily raise above other windows so the title bar click lands;
		// try/finally guarantees the TOPMOST flag is always reverted, even when
		// the click injection throws mid-sequence (previously the flag leaked
		// and the user's window stayed stuck above everything else).
		ShowWindow(hwnd, SW_RESTORE);
		SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
		try {
			const display = getVirtualDisplay();
			clickAt(titleBarPoint.x, titleBarPoint.y, "left", display.width, display.height, display.x, display.y);
			await this.sleep(this.config.defaultDelayMs);
		} finally {
			SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
		}

		const nowForeground = this.hwndValue(GetForegroundWindow()) === info.window.hwnd;

		return {
			success: nowForeground,
			window: info.window,
			method: "topmost-click",
			error: nowForeground ? undefined : "Window did not become foreground after click",
		};
	}

	// -------------------------------------------------------------------------
	// Write operations (gate-checked)
	// -------------------------------------------------------------------------

	async click(sessionId: string, x: number, y: number, button: "left" | "right" | "middle" = "left", options: CuaActionOptions = {}): Promise<CuaActionResult> {
		const decision = await this.gate.check("click" as CuaActionType, sessionId, { x, y, button }, options.meta);
		if (!decision.allowed) {
			return { sent: 0, error: decision.reason ?? "denied", gateDecision: "denied" };
		}

		if (options.activateTarget) {
			const activation = await this.activateWindow(options.activateTarget);
			if (!activation.success) {
				return { sent: 0, error: activation.error };
			}
		}

		const display = getVirtualDisplay();

		if (options.requireVisible) {
			const visible = this.isPointVisible(x, y);
			if (!visible) {
				return { sent: 0, error: `Target coordinate (${x},${y}) is occluded` };
			}
		}

		return { sent: clickAt(x, y, button, display.width, display.height, display.x, display.y), gateDecision: "allowed" };
	}

	/**
	 * Double click with a SINGLE approval: previously CuaTools called click()
	 * twice, which forced the user through two sequential approval dialogs for
	 * one logical action (and the second could still time out while the first
	 * physical click had already landed). One gate check, then both clicks.
	 */
	async doubleClick(sessionId: string, x: number, y: number, button: "left" | "right" | "middle" = "left", options: CuaActionOptions = {}): Promise<CuaActionResult> {
		const decision = await this.gate.check("click" as CuaActionType, sessionId, { x, y, button, double: true }, options.meta);
		if (!decision.allowed) {
			return { sent: 0, error: decision.reason ?? "denied", gateDecision: "denied" };
		}

		if (options.activateTarget) {
			const activation = await this.activateWindow(options.activateTarget);
			if (!activation.success) {
				return { sent: 0, error: activation.error };
			}
		}

		const display = getVirtualDisplay();
		const first = clickAt(x, y, button, display.width, display.height, display.x, display.y);
		const second = clickAt(x, y, button, display.width, display.height, display.x, display.y);
		return { sent: first + second, gateDecision: "allowed" };
	}

	async type(sessionId: string, params: { text?: string; key?: string; modifiers?: string[] }, options: CuaActionOptions = {}): Promise<CuaActionResult> {
		const decision = await this.gate.check("type" as CuaActionType, sessionId, params, options.meta);
		if (!decision.allowed) {
			return { sent: 0, error: decision.reason ?? "denied", gateDecision: "denied" };
		}

		if (params.text !== undefined) {
			return { sent: typeUnicode(params.text), gateDecision: "allowed" };
		}

		if (params.key !== undefined) {
			const vk = VK_MAP[params.key.toLowerCase()];
			if (vk === undefined) {
				return { sent: 0, error: `Unknown key: ${params.key}` };
			}
			const modVks = (params.modifiers ?? []).map((m) => {
				const mvk = VK_MAP[m.toLowerCase()];
				if (mvk === undefined) throw new Error(`Unknown modifier: ${m}`);
				return mvk;
			});
			return { sent: pressKeyCombo(vk, modVks), gateDecision: "allowed" };
		}

		return { sent: 0, error: "Either text or key must be provided" };
	}

	async scroll(sessionId: string, x: number, y: number, deltaY: number = -120, deltaX: number = 0, options: CuaActionOptions = {}): Promise<CuaActionResult> {
		const decision = await this.gate.check("scroll" as CuaActionType, sessionId, { x, y, deltaY, deltaX }, options.meta);
		if (!decision.allowed) {
			return { sent: 0, error: decision.reason ?? "denied", gateDecision: "denied" };
		}

		const display = getVirtualDisplay();
		return { sent: scrollAt(x, y, deltaY, deltaX, display.width, display.height, display.x, display.y), gateDecision: "allowed" };
	}

	// -------------------------------------------------------------------------
	// Mouse move (no gate — move is not destructive)
	// -------------------------------------------------------------------------

	moveMouse(x: number, y: number): number {
		const display = getVirtualDisplay();
		return moveMouseAbsolute(x, y, display.width, display.height, display.x, display.y);
	}

	// -------------------------------------------------------------------------
	// Gate accessors
	// -------------------------------------------------------------------------

	getGate(): CuaGate {
		return this.gate;
	}

	// -------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------

	private hwndValue(hwnd: object): number {
		return Number(koffiAddress(hwnd));
	}

	private sleep(ms: number): Promise<void> {
		// Was a busy-wait loop that burned the Electron main-process event loop
		// for the full delay (80ms per activation). A timer promise keeps the
		// process responsive while the OS settles the foreground switch.
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
