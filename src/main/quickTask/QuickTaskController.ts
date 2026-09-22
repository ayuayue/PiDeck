import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import type { BrowserWindow, Rectangle } from "electron";
import type { QuickTaskErrorCode, QuickTaskState } from "../../shared/types/quickTask";

/** 校验失败带稳定错误码，渲染层据此本地化；不让原始 message 跨 IPC 直接进 UI。 */
export class QuickTaskPathError extends Error {
	constructor(readonly code: QuickTaskErrorCode) {
		super(code);
		this.name = "QuickTaskPathError";
	}
}

/** Reject malformed launch paths before project lookup or creation. Never invokes a shell. */
export async function validateQuickTaskPath(value: unknown): Promise<string> {
	if (typeof value !== "string" || !value || value.length > 32767 || /[\u0000-\u001f"]/u.test(value) || !isAbsolute(value)) throw new QuickTaskPathError("invalidPath");
	const path = normalize(value);
	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(path);
	} catch {
		// 路径不存在 / 中间目录不是目录：对用户都是「这个目录打不开」。
		throw new QuickTaskPathError("notFound");
	}
	if (!stats.isDirectory()) throw new QuickTaskPathError("notDirectory");
	try {
		await access(path, constants.R_OK);
	} catch {
		throw new QuickTaskPathError("permissionDenied");
	}
	return path;
}

/**
 * 把任意异常收敛成稳定错误码。
 * 注入式 validatePath（测试替身）可能抛裸 Error，这里按 errno 文案兜底归类。
 */
export function quickTaskErrorCode(error: unknown): QuickTaskErrorCode {
	if (error instanceof QuickTaskPathError) return error.code;
	const message = error instanceof Error ? error.message : String(error);
	if (/EACCES|EPERM/u.test(message)) return "permissionDenied";
	if (/ENOENT|ENOTDIR/u.test(message)) return "notFound";
	return "unknown";
}

/** Fits the task surface in the current display without changing saved workbench bounds. */
export function compactTaskBounds(bounds: Rectangle, workArea: Rectangle): Rectangle {
	const width = Math.min(720, workArea.width);
	const height = Math.min(760, workArea.height);
	return { width, height, x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width)), y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height)) };
}

/** Owns native geometry and a replayable launch intent, not sessions or model execution. */
export class QuickTaskController {
	private state: QuickTaskState = { active: false, requestId: 0 };
	private saved: { bounds: Rectangle; minimum: number[]; maximized: boolean; fullscreen: boolean } | null = null;
	private window: BrowserWindow | null = null;
	private cancelFullscreenTransition: (() => void) | null = null;
	constructor(private readonly deps: { getWindow: () => BrowserWindow | null; workArea: (bounds: Rectangle) => Rectangle; publish: (state: QuickTaskState) => void; validatePath?: (path: unknown) => Promise<string> }) {}
	getState(): QuickTaskState {
		return { ...this.state };
	}
	isActive(): boolean {
		return this.state.active;
	}
	getWorkbenchBounds(): Rectangle | undefined {
		return this.saved?.bounds;
	}
	async open(path: string): Promise<void> {
		const requestId = this.state.requestId + 1;
		// A renderer fetching state during validation must not create a draft from an unchecked path.
		this.state = { active: true, requestId };
		this.enterCompact();
		try {
			const validated = await (this.deps.validatePath ?? validateQuickTaskPath)(path);
			if (this.state.requestId !== requestId || !this.state.active) return;
			this.state = { active: true, requestId, path: validated };
		} catch (error) {
			if (this.state.requestId !== requestId || !this.state.active) return;
			this.state = { active: true, requestId, path, error: quickTaskErrorCode(error) };
		}
		this.deps.publish(this.getState());
	}
	private enterCompact(): void {
		const window = this.deps.getWindow();
		if (!window || window.isDestroyed()) return;
		if (this.window !== window) {
			this.cancelFullscreenTransition?.();
			this.cancelFullscreenTransition = null;
			this.saved = null;
			this.window = window;
		}
		// Restore before capturing geometry: restoring a minimized maximized window after setBounds
		// would otherwise replace the newly applied compact dimensions.
		if (window.isMinimized()) window.restore();
		if (!this.saved) {
			this.saved = { bounds: window.getNormalBounds(), minimum: window.getMinimumSize(), maximized: window.isMaximized(), fullscreen: window.isFullScreen() };
			const saved = this.saved;
			const applyCompact = () => {
				this.cancelFullscreenTransition = null;
				if (!this.state.active || window.isDestroyed()) return;
				if (window.isMaximized()) window.unmaximize();
				const workArea = this.deps.workArea(saved.bounds);
				window.setMinimumSize(Math.min(480, workArea.width), Math.min(480, workArea.height));
				window.setBounds(compactTaskBounds(saved.bounds, workArea));
			};
			// Electron's fullscreen transition can be asynchronous. Apply geometry only afterwards.
			if (saved.fullscreen) {
				window.once("leave-full-screen", applyCompact);
				this.cancelFullscreenTransition = () => window.removeListener("leave-full-screen", applyCompact);
				window.setFullScreen(false);
			} else applyCompact();
		}
		window.show();
		window.focus();
	}
	/** Closing compact mode returns to the workbench; running tasks continue unchanged. */
	exit(): void {
		this.cancelFullscreenTransition?.();
		this.cancelFullscreenTransition = null;
		const window = this.deps.getWindow();
		if (window && !window.isDestroyed() && this.saved) {
			window.setMinimumSize(this.saved.minimum[0] ?? 880, this.saved.minimum[1] ?? 600);
			window.setBounds(this.saved.bounds);
			if (this.saved.maximized) window.maximize();
			if (this.saved.fullscreen) window.setFullScreen(true);
		}
		this.saved = null;
		this.state = { ...this.state, active: false };
		this.deps.publish(this.getState());
	}
}
