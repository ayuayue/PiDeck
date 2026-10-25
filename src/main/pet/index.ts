import { ipcMain, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { AgentManager } from "../pi/AgentManager";
import type { SettingsStore } from "../settings/SettingsStore";
import { DEFAULT_PET_SCALE, type AgentTab, type AgentUiRequest, type AppSettings, type PetManifest, type PetNotification } from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";
import { NOTIFICATION_DURATION_MS, effectiveUIFontSize } from "../../shared/petNotificationLayout";
import { EMPTY_NOTIFICATION_QUEUE, nextNotificationQueueState, onNotificationTimerElapse, type NotificationQueueState } from "./notificationQueue";
import { PetWindow, detectPetWindowCaps } from "./PetWindow";
import { PetStateBridge, type PetStateCopyKey } from "./PetStateBridge";
import { PetPackageManager } from "./PetPackageManager";
import { PetPatrol } from "./PetPatrol";
import { registerPetSpriteProtocol } from "./petSpriteProtocol";

export type PetSystemDeps = {
	agentManager: AgentManager;
	settingsStore: SettingsStore;
	getMainWindow: () => BrowserWindow | null;
	resolveSessionId: (agentId: string) => string | undefined;
	recreateMainWindow?: () => Promise<BrowserWindow>;
	translate?: (key: PetCopyKey, params?: Record<string, string | number>) => string;
};

type PetCopyKey = PetStateCopyKey | "pet.switch" | "pet.close";

const defaultPetCopy: Record<PetCopyKey, string> = {
	"pet.switch": "Switch pet",
	"pet.close": "Close pet",
	"pet.doneNotification": "{title} completed",
	"pet.agentError": "{title} encountered a problem",
	"pet.waitingNotification": "{title} needs your input",
	"pet.doneSuffix": "completed",
	"pet.errorSuffix": "encountered a problem",
	"pet.waitingSuffix": "needs your input",
};

export class PetSystem {
	readonly petWindow = new PetWindow();
	readonly packageManager = new PetPackageManager();
	readonly patrol: PetPatrol;
	private bridge: PetStateBridge;
	private registered = false;
	private offOutput: (() => void) | null = null;
	private offSettled: (() => void) | null = null;
	/** 非持久化提醒（error/done）展示计时器：到点收缩窗口并推送 null */
	private notifTimer: NodeJS.Timeout | null = null;
	/** 提醒队列状态：当前展示 + 排队的 persistent waiting（见 notificationQueue） */
	private notifQueue: NotificationQueueState = EMPTY_NOTIFICATION_QUEUE;

	constructor(private readonly deps: PetSystemDeps) {
		this.patrol = new PetPatrol(
			() => this.petWindow.window,
			() => this.deps.settingsStore.get().petPatrolPauseMin ?? 5,
			(x, y) => this.petWindow.moveTo(x, y),
		);
		this.bridge = new PetStateBridge(
			() => this.petWindow.window,
			this.patrol,
			() => this.isPatrolEnabled(),
			(key, params) => this.translate(key, params),
			(n) => this.handleNotification(n),
		);
		// 巡游只在业务态为 idle 时进行；业务转 running/出错/待输入时立即让位（多任务并发保护）
		this.patrol.setBusinessIdleCheck(() => this.bridge.businessMode() === "idle");
	}

	private isPatrolEnabled() {
		return (this.deps.settingsStore.get().petPatrolEnabled ?? true) && detectPetWindowCaps().freePosition;
	}

	private translate(key: PetCopyKey, params: Record<string, string | number> = {}): string {
		const translated = this.deps.translate?.(key, params) ?? defaultPetCopy[key];
		return translated.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match));
	}

	async start() {
		// 雪碧图协议：manifest 只带 pideck-pet:// URL，<img> 按需请求主进程读文件
		// （不再经 IPC 搬运 base64 大字符串；scheme 特权声明见 index.ts ready 前注册）
		registerPetSpriteProtocol({
			resolveSpritePath: (petId) => this.packageManager.resolveSpritePath(petId),
			roots: this.packageManager.spriteRoots(),
		});
		this.registerIpc();
		this.bridge.attach(this.deps.agentManager);
		// 等待操作：复用主进程输出订阅，只消费已规范化的 agents:ui-request（set/delete pending 由 AgentManager 保证）
		this.offOutput = this.deps.agentManager.onOutput((channel, payload) => {
			if (channel !== ipcChannels.agentsUiRequest || !payload || typeof payload !== "object") return;
			this.bridge.updateUIRequest(payload as AgentUiRequest);
		});
		// 已完成：AgentManager 确认成功 settled 后回调（abort/重试/压缩不触发）
		this.offSettled = this.deps.agentManager.onAgentSettled((info) => this.bridge.onAgentSettled(info));

		const s = this.deps.settingsStore.get();
		if (s.petEnabled) {
			await this.petWindow.create(s.petScale ?? DEFAULT_PET_SCALE, effectiveUIFontSize(s.uiFontSize, s.fontSize));
			// 延迟 600ms 兜底推送初始数据，等待宠物窗 React 挂载并注册 IPC 监听器。
			// 立即发送会被新窗口丢弃（监听器尚未就绪）。React 初始态为 idle + null sprite，
			// 即使首次推送丢失也显示降级绘制。主动 petReady 信号到后会再推一次以覆盖兜底。
			setTimeout(() => {
				this.pushCaps();
				this.bridge.pushNow(this.deps.agentManager.list());
				// 窗口重建期间若已有 pending 交互请求，恢复 waiting 气泡（pushNow 只推聚合状态）
				this.bridge.pushWaitingNow();
				void this.pushCurrentSprite();
			}, 600);
		}
	}

	stop() {
		this.clearNotifTimer();
		this.notifQueue = EMPTY_NOTIFICATION_QUEUE;
		this.offOutput?.();
		this.offOutput = null;
		this.offSettled?.();
		this.offSettled = null;
		this.bridge.detach();
		this.petWindow.destroy();
	}

	// ── 提醒展示与窗口 reflow ──

	/**
	 * 通知出口：窗口扩展 + 推送 + 计时。waiting 为持久化提醒（不自动消失）；
	 * error/done 展示 NOTIFICATION_DURATION_MS 后收缩窗口并推送 null；
	 * waiting 在非持久化提醒展示期间到达时排队，非持久化覆盖 waiting 时保存并恢复。
	 */
	private handleNotification(n: PetNotification | null) {
		const prevActive = this.notifQueue.active;
		const next = nextNotificationQueueState(this.notifQueue, n);
		this.notifQueue = next;
		const active = next.active;

		if (active && active === n) {
			// incoming 成为当前展示（未排队）：扩展窗口 + 推送
			this.petWindow.setNotificationVisible(true);
			const win = this.petWindow.window;
			if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.petNotify, n);
		}

		// waiting 清空信号且正展示 persistent → 立即收起（waiting 无计时器）
		if (!n && prevActive?.persistent) {
			this.clearNotification();
			return;
		}

		// 计时管理：仅当非持久化 active 发生变化（新 error/done 展示）时启动/重置；
		// 排队 waiting 不重置计时器，非持久化覆盖 waiting 时计时器正常启动
		if (active && !active.persistent && active !== prevActive) {
			this.clearNotifTimer();
			this.notifTimer = setTimeout(() => {
				this.notifTimer = null;
				const afterElapse = onNotificationTimerElapse(this.notifQueue);
				this.notifQueue = afterElapse;
				if (afterElapse.active) {
					// 恢复排队中的 waiting
					this.petWindow.setNotificationVisible(true);
					const win = this.petWindow.window;
					if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.petNotify, afterElapse.active);
				} else {
					this.clearNotification();
				}
			}, NOTIFICATION_DURATION_MS);
		}
	}

	private clearNotification() {
		this.clearNotifTimer();
		this.petWindow.setNotificationVisible(false);
		const win = this.petWindow.window;
		if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.petNotify, null);
	}

	private clearNotifTimer() {
		if (this.notifTimer) {
			clearTimeout(this.notifTimer);
			this.notifTimer = null;
		}
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
		// 渲染层入参一律不可信：NaN/缺字段会让 setBounds 抛 TypeError（unhandledRejection），边界处拦掉
		ipcMain.handle(C.petMoveWindow, async (_e, pos: { x: number; y: number }) => {
			if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
			this.petWindow.moveTo(pos.x, pos.y);
		});
		ipcMain.handle(C.petMoveBy, async (_e, delta: { dx: number; dy: number }) => {
			if (!delta || !Number.isFinite(delta.dx) || !Number.isFinite(delta.dy)) return;
			if (!this.petWindow.exists) return;
			const [x, y] = this.petWindow.window!.getPosition();
			// ipcMain.handle 对同一通道是串行执行的，setPosition 是同步的，不会产生增量竞争
			this.petWindow.moveTo(x + delta.dx, y + delta.dy);
		});
		ipcMain.handle(C.petPreviewMode, async (_e, mode: string) => {
			// 预览模式是渲染层内部枚举，只做形态校验白名单不做：新增预览模式不改主进程
			if (typeof mode !== "string" || mode.length === 0 || mode.length > 64) return;
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
			const sessionId = agentId ? this.deps.resolveSessionId(agentId) : undefined;
			if (sessionId) main.webContents.send(C.petFocusAgentTarget, { sessionId });
		});

		// 测试：模拟真实的 failed/review 状态 + 通知 + 自动恢复 idle（与 PetStateBridge 行为一致）
		ipcMain.handle(C.petTestNotify, async (_e, type: "error" | "done") => {
			const win = this.petWindow.window;
			if (!win || win.isDestroyed()) return;
			const ts = Date.now();
			if (type === "error") {
				win.webContents.send(C.petState, { mode: "failed", runningCount: 0, errorCount: 1, activeAgentId: null, timestamp: ts });
				this.handleNotification({
					type: "error",
					text: this.translate("pet.agentError", { title: "Agent" }),
					timestamp: ts,
					title: "Agent",
					status: this.translate("pet.errorSuffix"),
				});
				setTimeout(() => {
					if (win && !win.isDestroyed()) win.webContents.send(C.petState, { mode: "idle", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: Date.now() });
				}, 4000);
			} else {
				win.webContents.send(C.petState, { mode: "review", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: ts });
				this.handleNotification({
					type: "done",
					text: this.translate("pet.doneNotification", { title: "Agent" }),
					timestamp: ts,
					title: "Agent",
					status: this.translate("pet.doneSuffix"),
				});
				setTimeout(() => {
					if (win && !win.isDestroyed()) win.webContents.send(C.petState, { mode: "idle", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: Date.now() });
				}, 4000);
			}
		});

		ipcMain.handle(C.petTease, () => this.bridge.tease());
		// 拖拽起止：开始时停巡游；结束时先纠正透明窗可能产生的尺寸漂移，再按 idle 状态恢复巡游。
		ipcMain.handle(C.petDragState, (_e, dragging: boolean) => {
			const isDragging = !!dragging;
			this.bridge.onDragState(isDragging);
			if (!isDragging) this.petWindow.ensureTargetSize();
		});

		// 宠物窗就绪信号：React 已挂载且 IPC 监听器已注册，安全推送初始数据
		ipcMain.on(C.petReady, () => {
			const win = this.petWindow.window;
			if (!win || win.isDestroyed()) return;
			this.pushCaps();
			this.bridge.pushNow(this.deps.agentManager.list());
			// 挂载前可能已有 pending 交互请求（等待操作），补推 waiting 气泡
			this.bridge.pushWaitingNow();
			void this.pushCurrentSprite();
		});

		// 右键上下文菜单：关闭宠物 / 切换宠物
		ipcMain.handle(C.petContextMenu, async () => {
			const pets = await this.packageManager.list();
			const currentId = settingsStore.get().petId;
			const template: MenuItemConstructorOptions[] = [];

			// 切换宠物子菜单
			if (pets.length > 0) {
				template.push({
					label: this.translate("pet.switch"),
					submenu: pets.map((p) => ({
						label: p.displayName ?? p.id,
						type: "radio" as const,
						checked: p.id === currentId,
						click: async () => {
							const prev = settingsStore.get();
							const next = await settingsStore.update({ petId: p.id });
							await this.reactToSettings(prev, next);
						},
					})),
				});
				template.push({ type: "separator" });
			}

			// 关闭宠物
			template.push({
				label: this.translate("pet.close"),
				click: async () => {
					const prev = settingsStore.get();
					const next = await settingsStore.update({ petEnabled: false });
					await this.reactToSettings(prev, next);
					// 通知主窗口刷新设置状态（如设置页已打开，同步显示 toggle 关闭）
					const main = this.deps.getMainWindow();
					if (main && !main.isDestroyed()) {
						main.webContents.send(C.settingsApplyWindow, next);
					}
				},
			});

			const menu = Menu.buildFromTemplate(template);
			menu.popup({});
		});
	}

	// ── 设置响应 ──

	async reactToSettings(prev: AppSettings, next: AppSettings) {
		// petEnabled 翻转
		if (next.petEnabled !== prev.petEnabled) {
			if (next.petEnabled) {
				await this.petWindow.create(next.petScale ?? DEFAULT_PET_SCALE, effectiveUIFontSize(next.uiFontSize, next.fontSize));
				// 延迟 600ms 兜底推送，petReady 信号到后会再推一次覆盖兜底值
				setTimeout(() => {
					this.pushCaps();
					this.bridge.pushNow(this.deps.agentManager.list());
					this.bridge.pushWaitingNow();
					void this.pushCurrentSprite();
				}, 600);
			} else {
				this.patrol.stop();
				this.clearNotifTimer();
				this.notifQueue = EMPTY_NOTIFICATION_QUEUE;
				this.petWindow.destroy();
			}
			return;
		}
		if (!next.petEnabled) return;

		if (next.petId !== prev.petId) await this.pushCurrentSprite();
		if (next.petAlwaysOnTop !== prev.petAlwaysOnTop) this.petWindow.setAlwaysOnTop(next.petAlwaysOnTop);
		if (next.petScale !== prev.petScale && next.petScale) this.petWindow.resize(next.petScale);
		// 有效 UI 字号变化：气泡槽位高度随字号变化
		if (next.fontSize !== prev.fontSize || next.uiFontSize !== prev.uiFontSize) {
			this.petWindow.setFontMode(effectiveUIFontSize(next.uiFontSize, next.fontSize));
		}
		// 缩放 / 字号 / 字体栈都会改宠物窗外观。窗口尺寸由 PetWindow 改，
		// 绘制比例必须同步推给 renderer，否则会出现「窗大图小」或精灵被裁切。
		if (next.petScale !== prev.petScale || next.fontSize !== prev.fontSize || next.uiFontSize !== prev.uiFontSize || next.fontFamilyBase !== prev.fontFamilyBase || next.fontFamilyBaseCustom !== prev.fontFamilyBaseCustom) {
			this.pushAppearance(next);
		}
		if (next.petPatrolEnabled !== prev.petPatrolEnabled) {
			this.isPatrolEnabled() && this.bridge.currentState?.mode === "idle" ? this.patrol.start() : this.patrol.stop();
		}
	}

	private pushCaps() {
		const win = this.petWindow.window;
		if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.petCaps, detectPetWindowCaps());
	}

	/** 把当前外观设置推给宠物窗（缩放、字号、字体栈） */
	private pushAppearance(settings: AppSettings) {
		const win = this.petWindow.window;
		if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.settingsApplyWindow, settings);
	}

	private async pushCurrentSprite() {
		const manifest = await this.packageManager.get(this.deps.settingsStore.get().petId);
		const win = this.petWindow.window;
		if (manifest && win && !win.isDestroyed()) win.webContents.send(ipcChannels.petCurrentSprite, manifest);
	}
}
