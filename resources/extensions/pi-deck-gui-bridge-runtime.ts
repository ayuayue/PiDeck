/**
 * pi-deck-gui-bridge —— 拦截层 + 渲染 ticker（§5 / §6.4）。
 *
 * **只接管原本被丢掉的点，不动已经工作的点**（§5.3）：
 * 即使桥某处失败，PiDeck 现有行为完全不受影响。
 *
 * 拦截的靶子（RPC 模式下全是空实现，Phase 0 已读源码确证）：
 * - `setStatus`     → 全量接管（PiDeck 侧只认 pideck:auto-title，其余丢弃）
 * - `setFooter` / `setHeader` → 调 factory 拿活组件
 * - `setWidget(key, factory)` → 组件形式（字符串形式保持原路！）
 * - `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator`
 * - `setHiddenThinkingLabel` / `setTitle` / `setEditorComponent`
 *
 * **不拦截**（§5.4，写进作者文档）：
 * - `custom()` —— 字符行画笔，风格不合；GUI 对应物是 `ctx.gui.custom()`
 * - `onTerminalInput()` —— GUI 里没有终端
 * - `addAutocompleteProvider()` —— GUI 输入框有自己的补全器
 */

import type { UIBridgeUpdate } from "./pi-deck-gui-bridge-types";
import type { UIBridgeTransport } from "./pi-deck-gui-bridge-transport";
import { repushGuiState, findContributionNode } from "./pi-deck-gui-bridge-gui";
import { hashUINode, serialize, componentOf, invokeAction } from "./pi-deck-gui-bridge-serialize";
import { createBridgeTheme, type BridgeTheme } from "./pi-deck-gui-bridge-theme";
import { loadPiTui, type PiTuiComponent, type PiTuiModule } from "./pi-deck-gui-bridge-tui";
import type { GuiComponent } from "./pi-deck-gui-bridge-gui-types";

/** 落点 id（与 PiDeck 侧约定）。 */
export const TARGET = {
	header: "header",
	footer: "footer",
	editor: "editor",
	widgetPrefix: "widget:",
	guiPrefix: "gui:",
} as const;

/** 被跟踪的一个落点。 */
type TrackedEntry = {
	/** 组件工厂（每次重设时替换）。 */
	factory?: (...args: unknown[]) => PiTuiComponent | undefined | Promise<PiTuiComponent | undefined>;
	/** 已求值的组件实例（缓存：避免每 tick 造新实例，见 Phase 0 S5）。 */
	component?: PiTuiComponent;
	/** 上次推送的树哈希（变更检测，§6.4）。 */
	lastHash?: string;
	/** 上次推送的节点树（供 resync 复用）。 */
	lastNode?: ReturnType<typeof serialize>;
	/** 该落点当前是否有贡献。 */
	active: boolean;
	/** 组件被替换时调用旧实例的 dispose（§12.4）。 */
	dispose?: () => void;
};

/** 桥的运行时状态。 */
export type BridgeState = {
	status: Map<string, string>;
	workingMessage: string | undefined;
	workingVisible: boolean | undefined;
	workingFrames: string[] | undefined;
	hiddenThinkingLabel: string | undefined;
	title: string | undefined;
	tracked: Map<string, TrackedEntry>;
};

export function createBridgeState(): BridgeState {
	return {
		status: new Map(),
		workingMessage: undefined,
		workingVisible: undefined,
		workingFrames: undefined,
		hiddenThinkingLabel: undefined,
		title: undefined,
		tracked: new Map(),
	};
}

/** 桥的一次运行实例（每个 pi 进程一份）。 */
export type BridgeRuntime = {
	state: BridgeState;
	transport: UIBridgeTransport;
	theme: BridgeTheme;
	/** 包装 ctx.ui（幂等）。 */
	wrapUI: (ui: Record<string, unknown>) => void;
	/** 启动 ticker。 */
	startTicker: () => void;
	/** 停止 ticker 并清空全部贡献（会话结束/卸载时调用）。 */
	shutdown: () => void;
	/** 某个扩展卸载 → 清掉它名下的贡献（§7.7）。 */
	clearOwner: (owner: string) => void;
	/** 全量重推。 */
	resync: () => void;
	/** 包装对象是否已安装（幂等检查）。 */
	isWrapped: () => boolean;
};

const log = (message: string): void => {
	// stderr 不属于 RPC 协议，会进入 PiDeck 的日志面板，不污染 stdout JSONL
	process.stderr.write(`[pi-deck-gui-bridge] ${message}\n`);
};

/** 组件释放：有 dispose 就调，异常吞掉。 */
function disposeComponent(entry: TrackedEntry): void {
	const component = entry.component;
	entry.component = undefined;
	if (!component) return;
	try {
		component.dispose?.();
	} catch {
		// 扩展的 dispose 抛错不影响桥
	}
}

/**
 * 创建桥运行时。
 *
 * 只创建一次（模块级单例），`/reload` 后复用（§14.8 幂等）。
 */
export function createBridgeRuntime(transport: UIBridgeTransport): BridgeRuntime {
	const state = createBridgeState();
	const theme = createBridgeTheme();
	let ticker: NodeJS.Timeout | null = null;
	let wrapped = false;
	/** tui 引用：footer/header factory 需要它。RPC 下没有真 TUI，传一个最小替身。 */
	let tuiStub: unknown = null;
	/** footerData：pi 的 ReadonlyFooterDataProvider。RPC 下给最小替身。 */
	let footerDataStub: unknown = null;

	/** 取 pi-tui 模块（可能为 null → 适配器走形状判定）。 */
	function piTui(): PiTuiModule | null {
		return loadPiTui().module;
	}

	/**
	 * 求值一个落点的 factory 并缓存实例。
	 *
	 * Phase 0 S5 实测 factory 可重复调用且无副作用，但每 tick 重调会造大量实例，
	 * 因此仍缓存；重设（setXxx 再调）时替换并 dispose 旧的。
	 */
	function resolveComponent(targetId: string, entry: TrackedEntry): PiTuiComponent | undefined {
		if (entry.component) return entry.component;
		if (!entry.factory) return undefined;
		try {
			const result = entry.factory(tuiStub, theme, footerDataStub);
			// factory 允许返回 Promise（pi 的签名允许），但同步路径是主流；
			// Promise 情形本轮拿不到，等下一次 tick（下一轮缓存已就绪）。
			if (result && typeof (result as Promise<PiTuiComponent>).then === "function") {
				void (result as Promise<PiTuiComponent>).then((resolved) => {
					entry.component = resolved;
				}).catch(() => {
					entry.active = false;
				});
				return undefined;
			}
			entry.component = result as PiTuiComponent | undefined;
			return entry.component;
		} catch (error) {
			// factory 抛错 → 该落点隐藏，不牵连其他（§14.5）
			log(`落点 ${targetId} 的 factory 抛错，该落点隐藏: ${error instanceof Error ? error.message : String(error)}`);
			entry.active = false;
			return undefined;
		}
	}

	/** 重新求值某落点并推送（内容变了才发）。 */
	function pushTarget(targetId: string, force = false): void {
		const entry = state.tracked.get(targetId);
		if (!entry) return;
		if (!entry.active) {
			if (force || entry.lastHash !== "null") {
				entry.lastHash = "null";
				entry.lastNode = null;
				transport.push({ type: "ui-update", targetId, node: null });
			}
			return;
		}
		const component = resolveComponent(targetId, entry);
		const node = serialize(component);
		const hash = hashUINode(node);
		if (!force && hash === entry.lastHash) return;
		entry.lastHash = hash;
		entry.lastNode = node;
		transport.push({ type: "ui-update", targetId, node });
	}

	/** 重设一个落点的 factory（undefined = 移除）。 */
	function setTarget(targetId: string, factory: TrackedEntry["factory"] | undefined): void {
		const existing = state.tracked.get(targetId);
		if (existing) disposeComponent(existing);
		if (factory === undefined) {
			if (existing) {
				existing.active = false;
				existing.factory = undefined;
				existing.lastNode = null;
			} else {
				state.tracked.set(targetId, { active: false });
			}
			pushTarget(targetId);
			return;
		}
		const entry: TrackedEntry = existing ?? { active: false };
		entry.factory = factory;
		entry.active = true;
		state.tracked.set(targetId, entry);
		pushTarget(targetId, true);
	}

	/** 建最小 TUI 替身：factory 可能读 `tui.requestRender()` / `tui.terminal` 等。 */
	function ensureTuiStub(): unknown {
		if (tuiStub) return tuiStub;
		tuiStub = {
			requestRender: () => {},
			invalidate: () => {},
			// RPC 下没有终端尺寸概念，给一个保守值
			width: 80,
			height: 24,
			mode: "regular",
		};
		footerDataStub = {
			gitBranch: undefined,
			statuses: () => [],
		};
		return tuiStub;
	}

	/** 包装 ctx.ui 上的声明式方法（幂等）。 */
	function wrapUI(ui: Record<string, unknown>): void {
		if (!ui || typeof ui !== "object") return;
		ensureTuiStub();
		// 标记挂在 ui 对象上：即使桥被 /reload 重载，也认得出已包装过
		if ((ui as { __pideckBridgeWrapped?: boolean }).__pideckBridgeWrapped) {
			wrapped = true;
			return;
		}

		const target = ui as Record<string, unknown>;

		// ── setStatus：全量接管（PiDeck 只认 pideck:auto-title，其余丢弃）──
		const originalSetStatus = target.setStatus;
		target.setStatus = (key: unknown, text: unknown) => {
			try {
				const k = String(key ?? "");
				if (!k) return;
				if (text === undefined || text === null) state.status.delete(k);
				else state.status.set(k, String(text));
				transport.push({ type: "status", key: k, text: text === undefined || text === null ? undefined : String(text) });
			} catch (error) {
				log(`setStatus 包装抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
			}
			// 不调用 originalSetStatus：RPC 侧只认 pideck:auto-title，没必要再走一遍；
			// 但保留调用可以让「PiDeck 未升级」时旧行为（自动标题）继续工作。
			// 权衡：自动标题是 PiDeck 设计内行为（§7.7 第 5 条），不能破坏 → 仍转发原实现。
			try {
				if (typeof originalSetStatus === "function") (originalSetStatus as (k: unknown, t: unknown) => void).call(target, key, text);
			} catch {
				// 原实现抛错不影响桥
			}
		};

		// ── setFooter / setHeader：无 key，最后设置的胜出（pi 原语义）──
		const originalSetFooter = target.setFooter;
		target.setFooter = (factory: unknown) => {
			try {
				if (factory === undefined || factory === null) {
					setTarget(TARGET.footer, undefined);
				} else if (typeof factory === "function") {
					setTarget(TARGET.footer, factory as TrackedEntry["factory"]);
				}
			} catch (error) {
				log(`setFooter 包装抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				if (typeof originalSetFooter === "function") (originalSetFooter as (f: unknown) => void).call(target, factory);
			} catch {
				/* 原实现是 no-op */
			}
		};

		const originalSetHeader = target.setHeader;
		target.setHeader = (factory: unknown) => {
			try {
				if (factory === undefined || factory === null) {
					setTarget(TARGET.header, undefined);
				} else if (typeof factory === "function") {
					setTarget(TARGET.header, factory as TrackedEntry["factory"]);
				}
			} catch (error) {
				log(`setHeader 包装抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				if (typeof originalSetHeader === "function") (originalSetHeader as (f: unknown) => void).call(target, factory);
			} catch {
				/* 原实现是 no-op */
			}
		};

		// ── setWidget：字符串形式保持原路，组件形式桥接（§5.3）──
		const originalSetWidget = target.setWidget;
		target.setWidget = (key: unknown, content: unknown, options?: unknown) => {
			try {
				const k = String(key ?? "");
				if (!k) return;
				const placement = (options as { placement?: string } | undefined)?.placement;
				const targetId = `${TARGET.widgetPrefix}${k}${placement ? `:${placement}` : ""}`;
				if (typeof content === "function") {
					// 组件形式：RPC 下原实现会丢弃 → 桥接
					setTarget(targetId, content as TrackedEntry["factory"]);
					return; // 不调原实现（它只认 string[]）
				}
				if (content === undefined) {
					// 清除：桥侧也清掉组件形式留下的内容
					setTarget(targetId, undefined);
					try {
						if (typeof originalSetWidget === "function") (originalSetWidget as (...a: unknown[]) => void).call(target, key, content, options);
					} catch {
						/* no-op */
					}
					return;
				}
				// 字符串形式：保持原路（§14.4 只补不拆）
				if (typeof originalSetWidget === "function") (originalSetWidget as (...a: unknown[]) => void).call(target, key, content, options);
			} catch (error) {
				log(`setWidget 包装抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
			}
		};

		// ── setWorking* / setHiddenThinkingLabel / setTitle ──
		const originalSetWorkingMessage = target.setWorkingMessage;
		target.setWorkingMessage = (message?: unknown) => {
			try {
				state.workingMessage = message === undefined || message === null ? undefined : String(message);
				transport.push({ type: "working", message: state.workingMessage });
			} catch (error) {
				log(`setWorkingMessage 包装抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				if (typeof originalSetWorkingMessage === "function") (originalSetWorkingMessage as (m?: unknown) => void).call(target, message);
			} catch {
				/* no-op */
			}
		};

		const originalSetWorkingVisible = target.setWorkingVisible;
		target.setWorkingVisible = (visible: unknown) => {
			try {
				state.workingVisible = Boolean(visible);
				transport.push({ type: "working", visible: state.workingVisible });
			} catch (error) {
				log(`setWorkingVisible 包装抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				if (typeof originalSetWorkingVisible === "function") (originalSetWorkingVisible as (v: unknown) => void).call(target, visible);
			} catch {
				/* no-op */
			}
		};

		const originalSetWorkingIndicator = target.setWorkingIndicator;
		target.setWorkingIndicator = (options?: unknown) => {
			try {
				const frames = (options as { frames?: unknown } | undefined)?.frames;
				state.workingFrames = Array.isArray(frames) ? frames.map((f) => String(f)) : undefined;
				transport.push({ type: "working", frames: state.workingFrames });
			} catch (error) {
				log(`setWorkingIndicator 包装抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				if (typeof originalSetWorkingIndicator === "function") (originalSetWorkingIndicator as (o?: unknown) => void).call(target, options);
			} catch {
				/* no-op */
			}
		};

		const originalSetHiddenThinkingLabel = target.setHiddenThinkingLabel;
		target.setHiddenThinkingLabel = (label?: unknown) => {
			try {
				state.hiddenThinkingLabel = label === undefined || label === null ? undefined : String(label);
				transport.push({ type: "thinking-label", label: state.hiddenThinkingLabel });
			} catch (error) {
				log(`setHiddenThinkingLabel 包装抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				if (typeof originalSetHiddenThinkingLabel === "function") (originalSetHiddenThinkingLabel as (l?: unknown) => void).call(target, label);
			} catch {
				/* no-op */
			}
		};

		const originalSetTitle = target.setTitle;
		target.setTitle = (title: unknown) => {
			try {
				const value = String(title ?? "");
				state.title = value;
				transport.push({ type: "title", title: value });
			} catch (error) {
				log(`setTitle 包装抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				if (typeof originalSetTitle === "function") (originalSetTitle as (t: unknown) => void).call(target, title);
			} catch {
				/* no-op */
			}
		};

		// ── setEditorComponent：能翻译就翻译，不能就退回默认（§11.2 任务 2D）──
		const originalSetEditorComponent = target.setEditorComponent;
		target.setEditorComponent = (factory: unknown) => {
			try {
				if (factory === undefined || factory === null) {
					setTarget(TARGET.editor, undefined);
				} else if (typeof factory === "function") {
					setTarget(TARGET.editor, factory as TrackedEntry["factory"]);
				}
			} catch (error) {
				log(`setEditorComponent 包装抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				if (typeof originalSetEditorComponent === "function") (originalSetEditorComponent as (f: unknown) => void).call(target, factory);
			} catch {
				/* no-op */
			}
		};

		Object.defineProperty(target, "__pideckBridgeWrapped", { value: true, enumerable: false, configurable: true });
		wrapped = true;
		log("已包装 ctx.ui 的声明式扩展点（setStatus/setFooter/setHeader/setWidget/setWorking*/setHiddenThinkingLabel/setTitle/setEditorComponent）");
	}

	/** 渲染 ticker：10Hz 轮询 + 哈希去重（§6.4）。 */
	function startTicker(): void {
		if (ticker) return;
		ticker = setInterval(() => {
			try {
				for (const targetId of state.tracked.keys()) {
					pushTarget(targetId);
				}
			} catch (error) {
				// ticker 绝不因单次异常停摆
				log(`ticker 抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
			}
		}, 100);
		ticker.unref?.();
	}

	/** 关闭：停 ticker、清全部贡献、推空树。 */
	function shutdown(): void {
		if (ticker) clearInterval(ticker);
		ticker = null;
		for (const [targetId, entry] of state.tracked) {
			disposeComponent(entry);
			entry.active = false;
			if (entry.lastHash && entry.lastHash !== "null") {
				transport.push({ type: "ui-update", targetId, node: null });
			}
		}
		state.tracked.clear();
		state.status.clear();
	}

	/** 某个扩展卸载 → 清掉它名下的贡献（§7.7 要求 3）。 */
	function clearOwner(owner: string): void {
		const prefix = `${TARGET.guiPrefix}${owner}:`;
		for (const [targetId, entry] of state.tracked) {
			if (targetId.startsWith(prefix)) {
				disposeComponent(entry);
				entry.active = false;
				pushTarget(targetId);
			}
		}
	}

	/** 全量重推（PiDeck 要快照时用，§9.4）。 */
	function resync(): void {
		transport.push({ type: "resync" });
		for (const [key, text] of state.status) transport.push({ type: "status", key, text });
		if (state.workingMessage !== undefined || state.workingVisible !== undefined || state.workingFrames !== undefined) {
			transport.push({ type: "working", message: state.workingMessage, visible: state.workingVisible, frames: state.workingFrames });
		}
		if (state.title !== undefined) transport.push({ type: "title", title: state.title });
		if (state.hiddenThinkingLabel !== undefined) transport.push({ type: "thinking-label", label: state.hiddenThinkingLabel });
		for (const targetId of state.tracked.keys()) pushTarget(targetId, true);
		// ctx.gui 的贡献（setStatus 之外的 setSettingsSection 等）存在 gui.ts 的 state 里，
		// 不在上面这张 tracked 表里 —— 不补这一趟，PiDeck 清空状态后它们永远回不来。
		repushGuiState(runtime);
	}

	/** 处理 PiDeck 回灌的交互事件（§8.3）。 */
	function handleEvent(event: { type: string; nodeId?: string; targetId?: string; actionId?: string; index?: number; value?: string; key?: string; filter?: string; payload?: unknown }): void {
		try {
			if (event.type === "action" && event.actionId) {
				// ① 桥自己的回调（toast / confirm / 自定义对话框，由 registerAction 注册）
				if (invokeAction(event.actionId, event.payload)) return;
				// ② 落点贡献的回调：actionHandlers 是桥私有的，贡献只能走组件上的 handleAction。
				// 不补这一跳，落点树里所有按钮/勾选/页签都是“画得出、点不动”的死控件。
				// 带上 targetId：两个扩展用同一个 key 时，光靠 nodeId（自己的 id 可能跟对方撞）会投错人（§8.3）。
				if (event.nodeId) {
					const hit = findContributionNode(runtime, event.nodeId, event.targetId);
					callContributionAction(hit?.contribution.component, event.actionId, event.payload);
				}
				return;
			}
			const nodeId = event.nodeId;
			if (!nodeId) return;
			// ① pi-tui 组件：按 nodeId 找到活组件再调公开方法
			const component = componentOf(nodeId);
			if (component) {
				replayEvent(component, event);
				return;
			}
			// ② 落点贡献里的控件：节点**声明了 actionId 才回灌**，
			// 本地态控件（local）不声明就不打扰扩展，避免每次敲键都绕一圈
			const hit = findContributionNode(runtime, nodeId, event.targetId);
			const actionId = (hit?.node as { actionId?: string } | undefined)?.actionId;
			if (hit && actionId) callContributionAction(hit.contribution.component, actionId, eventPayload(event));
		} catch (error) {
			log(`事件回灌抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// runtime 先建好再注册回调：handleEvent 内部要用它做 guiState 查询，
	// 不能在建好之前被调到（transport 是异步的，但顺序上不留隐患）。
	const runtime: BridgeRuntime = {
		state,
		transport,
		theme,
		wrapUI,
		startTicker,
		shutdown,
		clearOwner,
		resync,
		isWrapped: () => wrapped,
	};

	transport.onEvent(handleEvent);
	// PiDeck 在轮询响应体里回 `resync: true` → 全量重推一次（§9.4）。
	// 落点是一次性推送：渲染层丢过状态（换 agent 绑定/会话切换/设置弹窗重开/应用重启）
	// 就不会自己回来，必须由 PiDeck 主动要一次快照。
	// 可选链：自定义/旧版 transport 没实现 onResync 时静默跳过，不炸会话（§14.5）。
	transport.onResync?.(resync);

	return runtime;
}

/** 每个 pi 进程一份桥运行时（稳定单例，§14.9）。 */
let sharedRuntime: BridgeRuntime | null = null;

/** 取（或创建）共享运行时。transport 只在首次生效。 */
export function getBridgeRuntime(transport: UIBridgeTransport): BridgeRuntime {
	if (!sharedRuntime) sharedRuntime = createBridgeRuntime(transport);
	return sharedRuntime;
}

/**
 * 关闭并丢弃进程级单例（正式路径，供 session_shutdown 调用）。
 *
 * /reload 语义：session_shutdown（reason=reload）先到，随后新 session_start——
 * 若不置空 sharedRuntime，新 session 会复用已 shutdown（transport closed）的旧
 * runtime，桥从此「静默死亡」。置空后由下一次 ensureRuntime 重建全新 runtime。
 * （`resetBridgeRuntimeForTests` 保留为测试别名语义，本函数是它的正式版。）
 */
export function shutdownBridgeRuntime(): void {
	sharedRuntime?.shutdown();
	sharedRuntime = null;
}

/** 仅测试用：重置单例（正式路径见 shutdownBridgeRuntime）。 */
export function resetBridgeRuntimeForTests(): void {
	shutdownBridgeRuntime();
}

// ── 事件回灌实现（§8.3，Phase 0 S4b 实测修正版）─────────────────

/**
 * pi-tui 组件需要的**原始字节序列**。
 *
 * ⚠️ **Phase 0 S4b 实测结论**：`handleInput` 匹配的是**全局 keybinding 定义**，
 * 不是 `Key.*` 常量（`Key.enter` 的值是字符串 `"enter"`，匹配 `tui.select.confirm` 为 false）。
 * 因此这里必须给**原始字节**。
 */
const KEY_BYTES: Record<string, string> = {
	enter: "\r",
	return: "\r",
	escape: "\u001b",
	esc: "\u001b",
	up: "\u001b[A",
	down: "\u001b[B",
	right: "\u001b[C",
	left: "\u001b[D",
	tab: "\t",
	backspace: "\u007f",
	space: " ",
	pageup: "\u001b[5~",
	pagedown: "\u001b[6~",
	home: "\u001b[H",
	end: "\u001b[F",
};

/** 把语义键名转成 handleInput 需要的原始字节。 */
export function keyToBytes(key: string): string | undefined {
	return KEY_BYTES[key.trim().toLowerCase()];
}

/**
 * 把事件携带的值取出来当 action 的 payload。
 *
 * 落点贡献只有 `handleAction(actionId, payload)` 一个交互入口（§14.14 回调不序列化），
 * 所以 input/select/key/filter 各自的值统一压成 payload。
 */
function eventPayload(event: { type: string; index?: number; value?: string; key?: string; filter?: string }): unknown {
	switch (event.type) {
		case "input":
			return event.value;
		case "select":
		case "navigate":
			return event.index;
		case "key":
			return event.key;
		case "filter":
			return event.filter;
		default:
			return undefined;
	}
}

/**
 * 调落点贡献的 `handleAction`。
 *
 * **回调抛错不能影响桥**（§14.5）：一个扩展的 bug 不能让其他落点、也不能让 pi 会话出问题。
 */
function callContributionAction(component: GuiComponent | undefined, actionId: string, payload?: unknown): boolean {
	const handler = component?.handleAction;
	if (typeof handler !== "function") return false;
	try {
		handler.call(component, actionId, payload);
		return true;
	} catch (error) {
		log(`落点贡献的 handleAction 抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/**
 * 把一次 GUI 交互回灌给活组件。
 *
 * **只调公开方法**（§14.7）：`setSelectedIndex` / `setFilter` / `handleInput` / `setValue`。
 * **绝不直接改私有字段** —— 那会让扩展的回调不触发，行为分叉。
 */
export function replayEvent(component: PiTuiComponent, event: { type: string; index?: number; value?: string; key?: string }): void {
	const anyComponent = component as unknown as Record<string, unknown>;
	switch (event.type) {
		case "select": {
			// 绝对定位 + CR 确认（CR 才会触发 onSelect，Phase 0 实测）
			const setSelectedIndex = anyComponent.setSelectedIndex;
			if (typeof setSelectedIndex === "function") (setSelectedIndex as (i: number) => void).call(component, Number(event.index ?? 0));
			component.handleInput?.("\r");
			break;
		}
		case "navigate": {
			// 仅移动高亮：setSelectedIndex 是裸 setter，不触发 onSelectionChange，
			// 故用方向键序列让组件自己走 notifySelectionChange（Phase 0 S4b 实测）。
			const current = Number(anyComponent.selectedIndex ?? 0);
			const wanted = Number(event.index ?? 0);
			const step = wanted > current ? "\u001b[B" : "\u001b[A";
			const times = Math.abs(wanted - current);
			if (times > 0 && times <= 200) {
				for (let i = 0; i < times; i += 1) component.handleInput?.(step);
			} else {
				const setSelectedIndex = anyComponent.setSelectedIndex;
				if (typeof setSelectedIndex === "function") (setSelectedIndex as (i: number) => void).call(component, wanted);
			}
			break;
		}
		case "filter": {
			const setFilter = anyComponent.setFilter;
			if (typeof setFilter === "function") (setFilter as (f: string) => void).call(component, String(event.value ?? ""));
			break;
		}
		case "input": {
			// 「设置输入框内容」用公开 setValue；逐字符 handleInput 是另一套语义
			const setValue = anyComponent.setValue;
			if (typeof setValue === "function") (setValue as (v: string) => void).call(component, String(event.value ?? ""));
			else component.handleInput?.(String(event.value ?? ""));
			break;
		}
		case "key": {
			const bytes = keyToBytes(String(event.key ?? ""));
			if (bytes) component.handleInput?.(bytes);
			break;
		}
		default:
			break;
	}
}

/** 诊断：当前跟踪的落点数。 */
export function trackedTargetCount(runtime: BridgeRuntime): number {
	return runtime.state.tracked.size;
}