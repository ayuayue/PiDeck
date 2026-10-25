import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { SessionCommandError, SessionRuntimeTarget, TerminalShell, TerminalTarget } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import { listSystemFontFamilies } from "../fonts/SystemFonts";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";

export type TerminalIpcDeps = {
	appLogger: Pick<AppLogger, "info">;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	terminalManager: TerminalSessionManager;
	toSessionCommandIpcError: (error: SessionCommandError) => Error;
};

export function registerTerminalIpc({ appLogger, sessionRuntimeCoordinator, terminalManager, toSessionCommandIpcError }: TerminalIpcDeps): void {
	/**
	 * 终端目标必须可落地：agent 目标校验 runtime 绑定（session/agent/generation 一致）；
	 * project 目标（引导页/未激活 agent/历史会话）不依赖 runtime，直接以 cwd 隔离。
	 */
	const requireTerminalTarget = (target: TerminalTarget) => {
		if (target.kind === "project") {
			// cwd 为渲染层传来的项目路径，仅作为 shell 启动目录与隔离键，不做额外校验
			return target;
		}
		const validated = sessionRuntimeCoordinator.validateTarget(target);
		if (!validated.ok) throw toSessionCommandIpcError(validated.error);
		return validated;
	};

	ipcMain.handle(ipcChannels.terminalList, (_event, target: TerminalTarget) => {
		requireTerminalTarget(target);
		return terminalManager.list(target);
	});
	ipcMain.handle(ipcChannels.terminalEnsure, (_event, target: TerminalTarget) => {
		requireTerminalTarget(target);
		return terminalManager.ensure(target);
	});
	ipcMain.handle(ipcChannels.terminalCreate, async (_event, target: TerminalTarget, shell?: TerminalShell) => {
		requireTerminalTarget(target);
		const result = await terminalManager.create(target, shell);
		void appLogger.info("terminal", "Terminal created", {
			kind: target.kind,
			sessionId: target.kind === "agent" ? target.sessionId : undefined,
			agentId: target.kind === "agent" ? target.agentId : undefined,
			tabId: result.id,
		});
		return result;
	});
	// 入参类型校验（安全约束 2）：data 直达 pty.write（原生调用），非字符串会同步 throw 变成
	// 渲染层 rejection；tabId 查不到本身是静默语义，一并挡在边界。无效载荷属于渲染层 bug，
	// 与 manager 侧「迟到输入静默忽略」保持同一哲学：不 throw、不重试。
	ipcMain.handle(ipcChannels.terminalInput, (_event, tabId: string, data: string) => {
		if (typeof tabId !== "string" || typeof data !== "string") return;
		terminalManager.input(tabId, data);
	});
	// cols/rows 直达原生 pty.resize：非有限数字（NaN/Infinity/字符串）会以 NaN 落到 ConPTY，
	// 行为未定义；下限钳制在 manager 侧已有（Math.max(2/1)），这里只挡类型。
	ipcMain.handle(ipcChannels.terminalResize, (_event, tabId: string, cols: number, rows: number) => {
		if (typeof tabId !== "string" || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
		terminalManager.resize(tabId, cols, rows);
	});
	ipcMain.handle(ipcChannels.terminalClose, (_event, tabId: string) => {
		if (typeof tabId !== "string") return;
		terminalManager.close(tabId);
		void appLogger.info("terminal", "Terminal closed", { tabId });
	});
	// shell 候选列表（供「选择 Shell」下拉）：只读平台探测结果，无入参可校验
	ipcMain.handle(ipcChannels.terminalShells, () => terminalManager.listShells());
	// 系统字体族列表（供终端设置页的字体下拉）：只读枚举 + 进程内缓存，无入参可校验。
	// 枚举失败返回空数组，下拉退化为「跟随代码字体」一项，不阻断设置页。
	ipcMain.handle(ipcChannels.terminalFonts, () => listSystemFontFamilies());
}
