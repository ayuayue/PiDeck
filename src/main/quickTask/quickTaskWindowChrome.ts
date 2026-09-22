/**
 * 紧凑模式（右键小任务）与主窗口几何的接线层——从 `main/index.ts` 抽出。
 *
 * 为什么单独成模块：入口只该做装配，而「关窗保存工作台几何」「紧凑模式拦截关闭」
 * 「冷启动 / 第二实例的 --quick-task 意图」这三件事横跨窗口生命周期。散在 4000+ 行的入口里
 * 既难单测，也容易在后续改窗口逻辑时被漏掉——最典型的是把紧凑模式的 720×760 当成用户偏好
 * 存进 lastWindowBounds，下次启动就是一个莫名其妙的小窗口。
 *
 * 职责边界：本模块只做「启动意图 → 控制器调用」的转译与 Electron 依赖注入。
 * 紧凑模式的状态机仍在 `QuickTaskController`；会话、运行时、模型调用一概不碰。
 */
import { app, screen, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { QuickTaskState } from "../../shared/types/quickTask";
import type { FocusTarget } from "../utils/focusTarget";
import { QuickTaskController } from "./QuickTaskController";

export type QuickTaskWindowChromeDeps = {
	/** 主窗口读取器：mainWindow 是模块级可空变量，必须每次现取而不是捕获快照。 */
	getWindow: () => BrowserWindow | null;
	/** 持久化工作台几何（由 index.ts 装配为 saveLastWindowBounds(userData, …)）。 */
	saveWorkbenchBounds: (size: { width: number; height: number }) => void;
};

export class QuickTaskWindowChrome {
	readonly controller: QuickTaskController;
	constructor(private readonly deps: QuickTaskWindowChromeDeps) {
		this.controller = new QuickTaskController({
			getWindow: deps.getWindow,
			workArea: (bounds) => screen.getDisplayMatching(bounds).workArea,
			publish: (state: QuickTaskState) => {
				const window = deps.getWindow();
				if (window && !window.isDestroyed()) window.webContents.send(ipcChannels.quickTaskChanged, state);
			},
		});
	}

	/**
	 * 关窗时保存工作台几何。
	 * 紧凑模式激活期间窗口是 720×760，此时必须存控制器捕获的 saved bounds，
	 * 否则会把小窗口尺寸写进 lastWindowBounds（下次启动直接变窄）。
	 */
	saveWorkbenchBoundsOnClose(window: BrowserWindow): void {
		if (window.isDestroyed()) return;
		const workbench = this.controller.getWorkbenchBounds();
		const normal = workbench ?? (window.isMaximized() || window.isFullScreen() ? window.getNormalBounds() : window.getBounds());
		this.deps.saveWorkbenchBounds({ width: normal.width, height: normal.height });
	}

	/**
	 * 紧凑模式下关闭窗口 = 返回工作台（任务继续运行），不是退出应用。
	 * 返回 true 表示本次 close 已被消费，调用方应立即 return。
	 */
	interceptClose(event: { preventDefault(): void }): boolean {
		if (!this.controller.isActive()) return false;
		event.preventDefault();
		this.controller.exit();
		return true;
	}

	/**
	 * 冷启动 / 第二实例的启动意图。
	 * quick-task 意图由本模块消费并返回 true；普通意图（打开项目 / 会话）会先退出紧凑模式
	 * 再交回调用方继续处理，避免「小窗口还开着，主窗口又切了会话」的两套呈现同时存在。
	 */
	async applyLaunchTarget(target: FocusTarget | undefined): Promise<boolean> {
		if (target?.quickTaskPath || target?.quickTaskDesktop) {
			await this.controller.open(target.quickTaskDesktop ? app.getPath("desktop") : target.quickTaskPath!);
			return true;
		}
		if (this.controller.isActive()) this.controller.exit();
		return false;
	}
}
