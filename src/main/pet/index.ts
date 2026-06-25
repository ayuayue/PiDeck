import { ipcMain, type BrowserWindow } from "electron";
import type { AgentManager } from "../pi/AgentManager";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AgentTab, AppSettings, PetManifest } from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";
import { PetWindow, detectPetWindowCaps } from "./PetWindow";
import { PetStateBridge } from "./PetStateBridge";
import { PetPackageManager } from "./PetPackageManager";
import { PetPatrol } from "./PetPatrol";

export type PetSystemDeps = {
	agentManager: AgentManager;
	settingsStore: SettingsStore;
	getMainWindow: () => BrowserWindow | null;
	recreateMainWindow?: () => Promise<BrowserWindow>;
};

export class PetSystem {
	readonly petWindow = new PetWindow();
	readonly packageManager = new PetPackageManager();
	readonly patrol: PetPatrol;
	private bridge: PetStateBridge;
	private registered = false;

	constructor(private readonly deps: PetSystemDeps) {
		this.patrol = new PetPatrol(
			() => this.petWindow.window,
			() => this.deps.settingsStore.get().petPatrolPauseMin ?? 5,
		);
		this.bridge = new PetStateBridge(
			() => this.petWindow.window,
			this.patrol,
			() => this.deps.settingsStore.get().petPatrolEnabled ?? true,
		);
	}

	async start() {
		this.registerIpc();
		this.bridge.attach(this.deps.agentManager);

		const s = this.deps.settingsStore.get();
		if (s.petEnabled) {
			await this.petWindow.create(s.petScale ?? 1);
			this.pushCaps();
			// 延迟推送，让宠物先以 idle 亮相
			setTimeout(() => {
				const tabs = this.deps.agentManager.list();
				if (tabs.some(t => t.status !== "closed")) this.bridge.pushNow(tabs);
			}, 600);
			await this.pushCurrentSprite();
		}
	}

	stop() {
		this.bridge.detach();
		this.petWindow.destroy();
	}

	// ── IPC ──

	private registerIpc() {
		if (this.registered) return;
		this.registered = true;

		const { settingsStore, agentManager, getMainWindow, recreateMainWindow } = this.deps;
		const C = ipcChannels;

		ipcMain.handle(C.petList, () => this.packageManager.list());
		ipcMain.handle(C.petGetCurrent, () => this.packageManager.get(settingsStore.get().petId));

		ipcMain.handle(C.petSetEnabled, async (_e, v: boolean) => {
			const prev = settingsStore.get();
			await this.reactToSettings(prev, await settingsStore.update({ petEnabled: !!v }));
		});
		ipcMain.handle(C.petSetId, async (_e, id: string) => {
			const prev = settingsStore.get();
			await this.reactToSettings(prev, await settingsStore.update({ petId: id }));
		});
		ipcMain.handle(C.petMoveWindow, async (_e, pos: { x: number; y: number }) => this.petWindow.moveTo(pos.x, pos.y));
		ipcMain.handle(C.petPreviewMode, async (_e, mode: string) => {
			const win = this.petWindow.window;
			if (win && !win.isDestroyed()) win.webContents.send(C.petPreviewMode, mode);
		});

		ipcMain.handle(C.petFocusAgent, async () => {
			let main = getMainWindow();
			if ((!main || main.isDestroyed()) && recreateMainWindow) main = await recreateMainWindow();
			if (!main) return;
			if (!main.isVisible()) main.show();
			main.focus();
			const agentId = this.bridge.currentState?.activeAgentId;
			if (agentId) main.webContents.send(C.petFocusAgentTarget, { agentId });
		});

		// 测试：模拟真实的 failed/review 状态 + 通知 + 自动恢复 idle（与 PetStateBridge 行为一致）
		ipcMain.handle(C.petTestNotify, async (_e, type: "error" | "done") => {
			const win = this.petWindow.window;
			if (!win || win.isDestroyed()) return;
			const ts = Date.now();
			if (type === "error") {
				win.webContents.send(C.petState, { mode: "failed", runningCount: 0, errorCount: 1, activeAgentId: null, timestamp: ts });
				win.webContents.send(C.petNotify, { type: "error", text: "Agent 出错了", timestamp: performance.now() });
				setTimeout(() => {
					if (win && !win.isDestroyed()) win.webContents.send(C.petState, { mode: "idle", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: Date.now() });
				}, 4000);
			} else {
				win.webContents.send(C.petState, { mode: "review", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: ts });
				win.webContents.send(C.petNotify, { type: "done", text: "任务完成，记得 Review", timestamp: performance.now() });
				setTimeout(() => {
					if (win && !win.isDestroyed()) win.webContents.send(C.petState, { mode: "idle", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: Date.now() });
				}, 4000);
			}
		});

		ipcMain.handle(C.petTease, () => this.bridge.tease());
	}

	// ── 设置响应 ──

	async reactToSettings(prev: AppSettings, next: AppSettings) {
		// petEnabled 翻转
		if (next.petEnabled !== prev.petEnabled) {
			if (next.petEnabled) {
				await this.petWindow.create(next.petScale ?? 1);
				this.pushCaps();
				this.bridge.pushNow(this.deps.agentManager.list());
				await this.pushCurrentSprite();
			} else {
				this.patrol.stop();
				this.petWindow.destroy();
			}
			return;
		}
		if (!next.petEnabled) return;

		if (next.petId !== prev.petId) await this.pushCurrentSprite();
		if (next.petAlwaysOnTop !== prev.petAlwaysOnTop) this.petWindow.setAlwaysOnTop(next.petAlwaysOnTop);
		if (next.petScale !== prev.petScale && next.petScale) this.petWindow.resize(next.petScale);
		if (next.petPatrolEnabled !== prev.petPatrolEnabled) {
			(next.petPatrolEnabled && this.bridge.currentState?.mode === "idle") ? this.patrol.start() : this.patrol.stop();
		}
	}

	private pushCaps() {
		const win = this.petWindow.window;
		if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.petCaps, detectPetWindowCaps());
	}

	private async pushCurrentSprite() {
		const manifest = await this.packageManager.get(this.deps.settingsStore.get().petId);
		const win = this.petWindow.window;
		if (manifest && win && !win.isDestroyed()) win.webContents.send(ipcChannels.petCurrentSprite, manifest);
	}
}
