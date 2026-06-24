import { ipcMain, type BrowserWindow } from "electron";
import type { AgentManager } from "../pi/AgentManager";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AgentTab, AppSettings, PetManifest } from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";
import { PetWindow } from "./PetWindow";
import { PetStateBridge } from "./PetStateBridge";
import { PetPackageManager } from "./PetPackageManager";

/**
 * 桌面宠物系统出口（设计文档第 2、9、10 节）。
 *
 * 聚合三个子模块的生命周期与 IPC：
 *  - PetWindow        透明悬浮窗
 *  - PetStateBridge   AgentManager 状态聚合 → pet:state 推送
 *  - PetPackageManager 内置 + petdex 包扫描
 *
 * 全部为新增模块，默认 petEnabled=false 关闭，不触碰三栏主界面与现有 IPC。
 */

export type PetSystemDeps = {
	agentManager: AgentManager;
	settingsStore: SettingsStore;
	/** 主窗口 getter，用于点击宠物时把主窗拉起 */
	getMainWindow: () => BrowserWindow | null;
};

export class PetSystem {
	readonly petWindow = new PetWindow();
	readonly packageManager = new PetPackageManager();
	private bridge: PetStateBridge;
	private registered = false;

	constructor(private readonly deps: PetSystemDeps) {
		this.bridge = new PetStateBridge(() => this.petWindow.window);
	}

	/** 应用 ready 后调用：注册 IPC + 订阅状态 + 按设置决定是否开窗 */
	async start() {
		this.registerIpc();
		// 订阅 AgentManager 状态（主进程内部钩子，见 AgentManager.addStateListener）
		this.bridge.attach(this.deps.agentManager);

		const settings = this.deps.settingsStore.get();
		if (settings.petEnabled) {
			await this.petWindow.create();
			// 立即推送一次当前状态，避免等待去抖导致宠物窗初始空白
			this.bridge.pushNow(this.deps.agentManager.list());
			await this.pushCurrentSprite();
		}
	}

	/** 应用退出前调用：解除订阅并销毁窗口 */
	stop() {
		this.bridge.detach();
		this.petWindow.destroy();
	}

	private registerIpc() {
		if (this.registered) return;
		this.registered = true;

		// 列出可用宠物包（设置面板下拉选项 + 宠物窗加载 sprite）
		ipcMain.handle(ipcChannels.petList, async (): Promise<PetManifest[]> => {
			return this.packageManager.list();
		});

		// 宠物窗挂载时主动拉取当前选中宠物，避免 start() 推送早于渲染层注册监听而丢失
		ipcMain.handle(ipcChannels.petGetCurrent, async (): Promise<PetManifest | null> => {
			const settings = this.deps.settingsStore.get();
			return this.packageManager.get(settings.petId);
		});

		// 开关宠物：更新设置后交由 reactToSettings 统一驱动窗口创建/销毁
		ipcMain.handle(ipcChannels.petSetEnabled, async (_e, value: boolean) => {
			const prev = this.deps.settingsStore.get();
			const next = await this.deps.settingsStore.update({ petEnabled: !!value });
			await this.reactToSettings(prev, next);
		});

		// 切换当前宠物：更新设置后由 reactToSettings 热推送新 sprite（无需重建窗口）
		ipcMain.handle(ipcChannels.petSetId, async (_e, id: string) => {
			const prev = this.deps.settingsStore.get();
			const next = await this.deps.settingsStore.update({ petId: id });
			await this.reactToSettings(prev, next);
		});

		// 拖拽移动窗口
		ipcMain.handle(ipcChannels.petMoveWindow, async (_e, pos: { x: number; y: number }) => {
			this.petWindow.moveTo(pos.x, pos.y);
		});

		// 点击宠物跳转活跃 Agent：恢复 Dock + 拉起主窗并聚焦 + 通知主窗切到活跃 Agent tab
		ipcMain.handle(ipcChannels.petFocusAgent, async () => {
			const main = this.deps.getMainWindow();
			if (!main || main.isDestroyed()) return;
			if (!main.isVisible()) main.show();
			main.focus();
			const agentId = this.bridge.currentState?.activeAgentId;
			if (agentId) {
				main.webContents.send(ipcChannels.petFocusAgentTarget, { agentId });
			}
		});
	}

	/**
	 * 设置变化时驱动宠物窗。统一入口：设置面板走 settings.update，pet:set-enabled/setId 也复用本方法。
	 * - petEnabled 翻转：创建/销毁窗口
	 * - petId 变化（已启用）：热推送新 sprite，宠物窗 onSprite 重新加载，无需重建窗口
	 * - petAlwaysOnTop 变化：调整置顶
	 */
	async reactToSettings(prev: AppSettings, next: AppSettings) {
		if (next.petEnabled !== prev.petEnabled) {
			if (next.petEnabled) {
				await this.petWindow.create();
				this.bridge.pushNow(this.deps.agentManager.list());
				await this.pushCurrentSprite();
			} else {
				this.petWindow.destroy();
			}
			return;
		}
		if (!next.petEnabled) return;
		if (next.petId !== prev.petId) {
			await this.pushCurrentSprite();
		}
		if (next.petAlwaysOnTop !== prev.petAlwaysOnTop) {
			this.petWindow.setAlwaysOnTop(next.petAlwaysOnTop);
		}
	}

	/** 推送当前选中宠物的 manifest 给宠物窗，让其加载对应 spritesheet（切换宠物热加载） */
	private async pushCurrentSprite() {
		const settings = this.deps.settingsStore.get();
		const manifest = await this.packageManager.get(settings.petId);
		const win = this.petWindow.window;
		if (manifest && win && !win.isDestroyed()) {
			win.webContents.send(ipcChannels.petCurrentSprite, manifest);
		}
	}
}

