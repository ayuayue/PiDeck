/**
 * 系统级划词的编排层：全局快捷键 → 取词 → 弹浮窗。
 *
 * 依赖全部注入（window / readSelection / shortcuts / logger），因此本模块可脱离
 * Electron 运行时单测；真正的 electron 绑定只在 createElectronShortcutBridge 里。
 *
 * 三条产品规则：
 * 1. 再入保护：取词是异步的（剪贴板轮询最长 600ms），快捷键连按/系统重复投递
 *    必须被吞掉，否则会出现两次模拟复制互相覆盖剪贴板；
 * 2. 可见时再按 = 收起（不是重新取词）：浮窗有焦点时模拟复制只会拿到空选区，
 *    「再按快捷键收起」才是用户预期；
 * 3. 注册失败要可诊断：被其它应用占用时 globalShortcut.register 返回 false，
 *    调用方据此提示用户改键，服务自己只落日志不打扰用户。
 */
import { globalShortcut } from "electron";
import { SELECTION_TOOL_TEXT_MAX_CHARS, type SelectionToolShowPayload, type SelectionToolWindowState } from "../../shared/types/selectionTool";
import type { SelectionToolWindow } from "./SelectionToolWindow";
import type { SystemSelectionReadResult } from "./systemSelectionReader";
import { readSystemSelection } from "./systemSelectionReader";

export type SelectionToolLogger = {
	info: (scope: string, message: string, detail?: unknown) => unknown;
	warn: (scope: string, message: string, detail?: unknown) => unknown;
	error: (scope: string, message: string, detail?: unknown) => unknown;
};

/** globalShortcut 最小接口：测试可注入替身，避免真实注册系统级快捷键。 */
export type SelectionToolShortcutBridge = {
	register: (accelerator: string, callback: () => void) => boolean;
	unregister: (accelerator: string) => void;
};

export type SelectionToolServiceDeps = {
	window: SelectionToolWindow;
	logger?: SelectionToolLogger | null;
	/** 覆盖取词实现（单测用）；缺省走 systemSelectionReader。 */
	readSelection?: () => Promise<SystemSelectionReadResult>;
	/** 覆盖快捷键注册（单测用）；缺省走 electron globalShortcut。 */
	shortcuts?: SelectionToolShortcutBridge;
	/** 取词模拟复制前后抑制「复制即触发」监听，避免哨兵/恢复内容触发第二个浮窗。 */
	suppressClipboardWatcher?: (durationMs: number) => void;
};

const LOG_SCOPE = "selection-tool";

/** 缺省快捷键桥：唯一直接接触 electron globalShortcut 的地方。 */
export function createElectronShortcutBridge(): SelectionToolShortcutBridge {
	return {
		register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
		unregister: (accelerator) => {
			globalShortcut.unregister(accelerator);
		},
	};
}

export class SelectionToolService {
	private readonly deps: SelectionToolServiceDeps;
	private readonly shortcuts: SelectionToolShortcutBridge;
	private accelerator: string | null = null;
	private capturing = false;
	private disposed = false;

	constructor(deps: SelectionToolServiceDeps) {
		this.deps = deps;
		this.shortcuts = deps.shortcuts ?? createElectronShortcutBridge();
	}

	getState(): SelectionToolWindowState {
		return { ...this.deps.window.getState(), shortcutRegistered: this.accelerator !== null, shortcut: this.accelerator };
	}

	/** Escape / 关闭按钮 / 主进程收起：统一走窗口，不产生副作用。 */
	hide(): void {
		this.deps.window.hide();
	}

	/** 当前已注册的快捷键（null = 未注册，如系统级划词被关掉或注册失败）。 */
	getRegisteredShortcut(): string | null {
		return this.accelerator;
	}

	/**
	 * 剪贴板触发入口：外部应用复制文字后直接展示（不模拟复制、不改剪贴板）。
	 * 与快捷键触发共用同一个浮窗；同一时间只有一个实例。
	 */
	async showText(text: string): Promise<void> {
		if (this.disposed || this.capturing) return;
		const normalized = text.trim();
		if (!normalized) return;
		await this.deps.window.show({ text: normalized.slice(0, SELECTION_TOOL_TEXT_MAX_CHARS) });
	}

	/**
	 * 快捷键触发入口。永不抛：取词失败也弹窗，让用户看到「没读到选区」而不是毫无反馈。
	 */
	async trigger(): Promise<void> {
		if (this.disposed || this.capturing) return;
		this.capturing = true;
		try {
			if (this.getState().visible) {
				this.hide();
				return;
			}
			// 模拟复制会写哨兵/恢复剪贴板；期间抑制复制监听，避免同一动作触发两次浮窗。
			this.deps.suppressClipboardWatcher?.(2500);
			const result = this.deps.readSelection ? await this.deps.readSelection() : await readSystemSelection();
			if (!result.ok) {
				this.deps.logger?.info(LOG_SCOPE, "System selection capture failed", { reason: result.reason });
				await this.deps.window.show({ text: "", reason: result.reason });
				return;
			}
			const payload: SelectionToolShowPayload = { text: result.text };
			await this.deps.window.show(payload);
		} catch (error) {
			// 兜底：任何未预期异常都不能让快捷键「按下没反应」。
			this.deps.logger?.warn(LOG_SCOPE, "Selection trigger failed", { error: error instanceof Error ? error.message : String(error) });
			await this.deps.window.show({ text: "", reason: "capture-failed" });
		} finally {
			this.capturing = false;
		}
	}

	/**
	 * 注册/替换全局快捷键。先注销旧键再注册新键（Electron 同一 accelerator 重复注册
	 * 返回 false，改键场景必须先释放）；返回 false 时调用方提示用户改键。
	 */
	registerShortcut(accelerator: string): boolean {
		if (this.disposed) return false;
		const next = accelerator.trim();
		this.unregisterShortcut();
		if (!next) return false;
		let registered = false;
		try {
			registered = this.shortcuts.register(next, () => {
				void this.trigger();
			});
		} catch (error) {
			this.deps.logger?.warn(LOG_SCOPE, "Global shortcut registration threw", { accelerator: next, error: error instanceof Error ? error.message : String(error) });
			return false;
		}
		if (!registered) {
			this.deps.logger?.warn(LOG_SCOPE, "Global shortcut registration rejected", { accelerator: next });
			return false;
		}
		this.accelerator = next;
		return true;
	}

	/** 语义等价命名（设置页改快捷键/启动装配时读起来更直白）。 */
	setShortcut(accelerator: string): boolean {
		return this.registerShortcut(accelerator);
	}

	/** 注销当前快捷键（关闭系统级划词 / 注册新键前）：未注册时是 no-op。 */
	unregisterShortcut(): void {
		const current = this.accelerator;
		this.accelerator = null;
		if (!current) return;
		try {
			this.shortcuts.unregister(current);
		} catch (error) {
			this.deps.logger?.warn(LOG_SCOPE, "Global shortcut unregister threw", { accelerator: current, error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** teardown 短名：与 unregisterShortcut 同义。 */
	unregister(): void {
		this.unregisterShortcut();
	}

	/** 退出应用：注销快捷键并销毁浮窗；幂等。 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unregisterShortcut();
		this.deps.window.dispose();
	}
}
