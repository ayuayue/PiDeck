/**
 * pi-deck-gui-bridge —— `ctx.gui`：GUI 专属扩展点的**装配层**（§7）。
 *
 * **形态原则**：`ctx.gui` 的方法与 `ctx.ui` **同形** ——
 * 同样的 `set*` 命名、同样的 `(…, theme) => Component` 工厂、
 * 同样的「传 `undefined` 即恢复默认」、同样的「带 `key` 可多贡献共存」。
 * 作者不学新概念，只是多了几个可挂的位置。
 *
 * **权力边界：只追加**（§7.4）—— 扩展只能往预留位置**插入**内容，
 * **不改动、不顶替** PiDeck 原有 UI。因此这里**不实现**「接管 / 顶替」分支。
 *
 * **零构建**：`factory` 与 `render()` 都跑在 pi 的 Node 进程里，
 * 只产出可序列化的 `GuiNode`。扩展里**不允许** React / JSX，**不接触 DOM**。
 *
 * 模块划分（原为单文件，按「作者契约 / 规格 / 装配」三件事拆开）：
 * - `pi-deck-gui-bridge-gui-types.ts` —— 作者看到的公开类型（`GuiComponent` / `ctx.gui` 形状）
 * - `pi-deck-gui-bridge-gui-spec.ts`  —— 白名单、上限、校验、状态容器（纯规格）
 * - 本文件 —— 落点 setter、命名空间装配、`ctx` 注入、模块级降级入口
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuiNode, OverlayOptions, Tone, UINode } from "./pi-deck-gui-bridge-types";
import type { BridgeRuntime } from "./pi-deck-gui-bridge-runtime";
import { registerAction } from "./pi-deck-gui-bridge-serialize";
import { createBridgeTheme } from "./pi-deck-gui-bridge-theme";
import {
	countNodes,
	DEFAULT_ORDER,
	guiState,
	GUI_SLOT_METHODS,
	type GuiContribution,
	type GuiSlotMethod,
	isGuiComponent,
	isValidGuiNode,
	MAX_NODES,
	resetGuiStateForTests,
	slotTargetId,
} from "./pi-deck-gui-bridge-gui-spec";
import type {
	GuiComponent,
	GuiCustomFactory,
	GuiCustomOptions,
	GuiFactory,
	GuiHandle,
	GuiKeybindings,
	GuiNamespace,
	GuiSlotOptions,
	GuiSurface,
	GuiTheme,
} from "./pi-deck-gui-bridge-gui-types";

// 作者契约与规格层对外再导出：扩展只需 import 本模块即可拿到全部公开面。
export { GUI_SLOT_METHODS, isValidGuiNode, isGuiComponent, resetGuiStateForTests } from "./pi-deck-gui-bridge-gui-spec";
export type { GuiSlotMethod, GuiNamespaceState, GuiContribution } from "./pi-deck-gui-bridge-gui-spec";
export type { GuiComponent, GuiCustomFactory, GuiCustomOptions, GuiFactory, GuiHandle, GuiKeybindings, GuiNamespace, GuiSlotOptions, GuiSurface, GuiTheme } from "./pi-deck-gui-bridge-gui-types";

const log = (message: string): void => {
	process.stderr.write(`[pi-deck-gui-bridge] ${message}\n`);
};

// ── 贡献求值与推送 ──────────────────────────────────────────────

/** 求值一个贡献的组件（缓存；重设时替换并 dispose 旧的）。 */
function resolveContribution(contribution: GuiContribution, runtime: BridgeRuntime): GuiNode | null {
	if (!contribution.valid) return null;
	if (!contribution.component) {
		try {
			const surface = createSurface(runtime, `gui-${contribution.key}`);
			const result = contribution.factory(surface, guiTheme(), guiState(runtime).ctx as ExtensionContext);
			if (isGuiComponent(result)) {
				contribution.component = result;
			} else if (isValidGuiNode(result)) {
				// 直接返回 GuiNode：包一层极简组件
				const node = result;
				contribution.component = { render: () => node };
			} else {
				log(`落点 ${slotTargetId(contribution.method, contribution.key)} 的 factory 返回值非法（既不是 GuiComponent 也不是 GuiNode），该贡献隐藏`);
				contribution.valid = false;
				return null;
			}
		} catch (error) {
			log(`落点 ${slotTargetId(contribution.method, contribution.key)} 的 factory 抛错，该贡献隐藏: ${error instanceof Error ? error.message : String(error)}`);
			contribution.valid = false;
			return null;
		}
	}
	try {
		const node = contribution.component.render();
		if (!isValidGuiNode(node)) {
			log(`落点 ${slotTargetId(contribution.method, contribution.key)} 的 render() 返回值非法，该贡献隐藏`);
			contribution.valid = false;
			return null;
		}
		if (countNodes(node) > MAX_NODES) {
			log(`落点 ${slotTargetId(contribution.method, contribution.key)} 节点数超限（> ${MAX_NODES}），该贡献隐藏`);
			contribution.valid = false;
			return null;
		}
		return node;
	} catch (error) {
		log(`落点 ${slotTargetId(contribution.method, contribution.key)} 的 render() 抛错，该贡献隐藏: ${error instanceof Error ? error.message : String(error)}`);
		contribution.valid = false;
		return null;
	}
}

/** 把某个贡献推给 PiDeck（内容变了才发）。 */
function pushContribution(contribution: GuiContribution, runtime: BridgeRuntime, force = false): void {
	const targetId = slotTargetId(contribution.method, contribution.key);
	const node = resolveContribution(contribution, runtime);
	const hash = node ? JSON.stringify(node) : "null";
	if (!force && hash === contribution.lastHash) return;
	contribution.lastHash = hash;
	// 附上 order / title，PiDeck 侧据此排序与渲染分组标题（§7.1-B）
	const payload = node ? withSlotMeta(node, contribution.options) : null;
	runtime.transport.push({ type: "ui-update", targetId, node: payload });
}

/** 把 order / title 作为节点元信息带上（不改节点 kind，PiDeck 侧读 `slot` 字段）。 */
function withSlotMeta(node: GuiNode, options: GuiSlotOptions): GuiNode {
	// 展开节点并附上 slot：类型上 slot 已是所有节点的可选公共字段（types.ts 的 NodeBase），
	// 故这里的赋值是类型安全的，不需要 as 断言。
	return {
		...node,
		slot: {
			order: Number.isFinite(options.order) ? (options.order as number) : DEFAULT_ORDER,
			title: options.title,
			placement: options.placement,
		},
	};
}

// ── 主题与画布 ──────────────────────────────────────────────────

let cachedGuiTheme: GuiTheme | null = null;

/** GUI 主题（语义档，不产 ANSI，不指定色值）。 */
export function guiTheme(): GuiTheme {
	if (cachedGuiTheme) return cachedGuiTheme;
	const base = createBridgeTheme();
	cachedGuiTheme = {
		...base,
		tones: ["default", "muted", "accent", "success", "warning", "danger"],
		variants: ["solid", "outline", "ghost"],
	};
	return cachedGuiTheme;
}

/** 键位语义（与 TUI 同名，便于移植）。 */
const GUI_KEYS: Record<string, string> = {
	up: "up",
	down: "down",
	left: "left",
	right: "right",
	enter: "enter",
	escape: "escape",
	tab: "tab",
	space: "space",
	backspace: "backspace",
	pageUp: "pageUp",
	pageDown: "pageDown",
	home: "home",
	end: "end",
};

export function guiKeybindings(): GuiKeybindings {
	return {
		keys: GUI_KEYS,
		matches(action: string, key: string) {
			return GUI_KEYS[action] === key;
		},
	};
}

/** 创建画布对象（factory 第一参数）。 */
function createSurface(runtime: BridgeRuntime, elementId: string): GuiSurface {
	return {
		hostTheme: guiTheme(),
		hostSize: { width: 80, height: 24 },
		requestRender() {
			// 由 ticker 统一重画；这里只做语义标记
		},
		close(result?: unknown) {
			void runtime;
			void result;
			void elementId;
		},
	};
}

// ── 落点 setter 工厂（§7.1-B 全部方法）──────────────────────────

/**
 * 创建一个 keyed 落点 setter。
 *
 * 语义（照抄 pi 自己的规则，不发明新的，§7.5）：
 * - `factory` 返回值：`GuiComponent`（有 `render()`）或 `GuiNode`，两者都接受
 * - 传 `undefined` → 移除该 `key`，位置回到原样（不占位）
 * - 同 `key` 重复设置 → 后设覆盖
 * - 不同 `key` → 共存，按 `order`（缺省 1000）升序；同 `order` 按 key 字母序
 *
 * runtime 由闭包绑定，**不依赖模块级可变引用** —— 否则 `createGuiNamespace(runtime)`
 * 与「当前 runtime」会脱钩（多会话/多实例下会串台）。
 */
function makeSlotSetter(method: GuiSlotMethod, runtime: BridgeRuntime) {
	return function setSlot(key: unknown, factory: unknown, options?: unknown): void {
		// 校验：key 必填非空字符串
		if (typeof key !== "string" || !key.trim()) {
			log(`${method} 的 key 必填且非空，本次调用被跳过`);
			return;
		}
		// 校验：factory 必须是函数或 undefined
		if (factory !== undefined && factory !== null && typeof factory !== "function") {
			log(`${method} 的 factory 必须是函数或 undefined，本次调用被跳过`);
			return;
		}
		const state = guiState(runtime);
		const mapKey = `${method}:${key}`;
		const existing = state.contributions.get(mapKey);

		if (factory === undefined || factory === null) {
			if (existing) {
				try {
					existing.component?.dispose?.();
				} catch {
					/* 扩展的 dispose 抛错不影响桥 */
				}
				state.contributions.delete(mapKey);
			}
			runtime.transport.push({ type: "ui-update", targetId: slotTargetId(method, key), node: null });
			return;
		}

		// 校验 order 是有限数字
		const rawOrder = (options as GuiSlotOptions | undefined)?.order;
		const order = typeof rawOrder === "number" && Number.isFinite(rawOrder) ? rawOrder : DEFAULT_ORDER;

		if (existing) {
			try {
				existing.component?.dispose?.();
			} catch {
				/* no-op */
			}
		}
		const contribution: GuiContribution = {
			method,
			key,
			factory: factory as GuiFactory,
			options: { ...(options as GuiSlotOptions | undefined), order },
			valid: true,
			owner: currentOwner(),
		};
		state.contributions.set(mapKey, contribution);
		pushContribution(contribution, runtime, true);
	};
}

// ── 当前上下文（供模块级函数降级路径用）──────────────────────────

let currentRuntimeRef: BridgeRuntime | null = null;
let currentOwnerRef = "unknown";

function currentRuntime(): BridgeRuntime | null {
	return currentRuntimeRef;
}

function currentOwner(): string {
	return currentOwnerRef;
}

/** 由主扩展在挂载时注入当前 runtime 与归属扩展名。 */
export function setCurrentGuiRuntime(runtime: BridgeRuntime | null, owner: string): void {
	currentRuntimeRef = runtime;
	currentOwnerRef = owner;
}

// ── `ctx.gui` 对象 ──────────────────────────────────────────────

/** 创建 `ctx.gui` 对象（落点 setter + 交互与服务）。 */
export function createGuiNamespace(runtime: BridgeRuntime): GuiNamespace {
	const state = guiState(runtime);
	const setters = Object.fromEntries(Object.keys(GUI_SLOT_METHODS).map((method) => [method, makeSlotSetter(method as GuiSlotMethod, runtime)])) as Record<GuiSlotMethod, ReturnType<typeof makeSlotSetter>>;

	const namespace: GuiNamespace = {
		...setters,
		theme: guiTheme(),

		async custom<T>(factory: GuiCustomFactory<T>, options?: GuiCustomOptions): Promise<T> {
			return new Promise<T>((resolve) => {
				let settled = false;
				const finish = (result: T): void => {
					if (settled) return;
					settled = true;
					try {
						component?.dispose?.();
					} catch {
						/* no-op */
					}
					state.overlays.delete(elementId);
					runtime.transport.push({ type: "overlay", elementId, node: null });
					resolve(result);
				};
				const elementId = `gui-overlay-${state.overlaySeq++}`;
				const handle: GuiHandle = {
					element: elementId,
					update(next: GuiNode) {
						if (!isValidGuiNode(next)) {
							log(`overlay ${elementId} 的 update() 收到非法节点，忽略`);
							return;
						}
						state.overlays.set(elementId, { node: next, options });
						runtime.transport.push({ type: "overlay-update", elementId, node: next });
					},
					close(result?: unknown) {
						finish(result as T);
					},
				};
				const surface: GuiSurface = {
					hostTheme: guiTheme(),
					hostSize: { width: 80, height: 24 },
					requestRender() {},
					close(result?: unknown) {
						finish(result as T);
					},
				};
				let component: GuiComponent | null = null;
				try {
					const result = factory(surface, guiTheme(), guiKeybindings(), (r: T) => finish(r));
					// factory 可能是 async
					void Promise.resolve(result)
						.then((resolved) => {
							if (isGuiComponent(resolved)) component = resolved;
							else if (isValidGuiNode(resolved)) component = { render: () => resolved };
							else {
								log(`ctx.gui.custom 的 factory 返回值非法，覆盖层隐藏`);
								finish(undefined as T);
								return;
							}
							const node = component.render();
							if (!isValidGuiNode(node)) {
								log(`ctx.gui.custom 的 render() 返回值非法，覆盖层隐藏`);
								finish(undefined as T);
								return;
							}
							state.overlays.set(elementId, { node, options, onDismiss: options?.onDismiss });
							runtime.transport.push({
								type: "overlay",
								elementId,
								node,
								options: options
									? { modal: options.modal, position: options.position, size: options.size }
									: undefined,
							});
							options?.onHandle?.(handle);
						})
						.catch((error) => {
							log(`ctx.gui.custom 的 factory 抛错，覆盖层取消: ${error instanceof Error ? error.message : String(error)}`);
							finish(undefined as T);
						});
				} catch (error) {
					log(`ctx.gui.custom 抛错，覆盖层取消: ${error instanceof Error ? error.message : String(error)}`);
					finish(undefined as T);
				}
			});
		},

		command(id: string, handler: () => void) {
			if (typeof id !== "string" || !id.trim() || typeof handler !== "function") {
				log("ctx.gui.command 参数非法，跳过");
				return;
			}
			state.commands.set(id, handler);
			runtime.transport.push({ type: "ui-update", targetId: `gui:command:${id}`, node: null });
		},

		toast(message: string, options) {
			const actions = (options?.actions ?? []).map((action) => ({
				label: action.label,
				actionId: registerAction(action.onPress),
			}));
			const node: GuiNode = {
				kind: "toast",
				id: `toast-${state.overlaySeq++}`,
				message: String(message ?? ""),
				tone: options?.tone ?? "default",
				actions,
			};
			runtime.transport.push({ type: "ui-update", targetId: `gui:toast:${node.id}`, node });
		},

		async confirm(title: string, body: GuiNode, options?): Promise<boolean> {
			return new Promise<boolean>((resolve) => {
				const elementId = `gui-confirm-${state.overlaySeq++}`;
				const node: GuiNode = {
					kind: "modal",
					id: elementId,
					title: String(title ?? ""),
					children: [body],
					actions: [
						{
							kind: "button",
							id: `${elementId}-cancel`,
							label: options?.cancelLabel ?? "取消",
							variant: "ghost",
							actionId: registerAction(() => {
								state.overlays.delete(elementId);
								runtime.transport.push({ type: "overlay", elementId, node: null });
								resolve(false);
							}),
						},
						{
							kind: "button",
							id: `${elementId}-ok`,
							label: options?.confirmLabel ?? "确定",
							variant: "solid",
							actionId: registerAction(() => {
								state.overlays.delete(elementId);
								runtime.transport.push({ type: "overlay", elementId, node: null });
								resolve(true);
							}),
						},
					],
				};
				state.overlays.set(elementId, { node, options: { modal: true, position: "center" } });
				runtime.transport.push({ type: "overlay", elementId, node, options: { modal: true, position: "center" } });
			});
		},

		overlay(node: GuiNode, options?: OverlayOptions & { onDismiss?: () => void }): GuiHandle {
			const elementId = `gui-overlay-${state.overlaySeq++}`;
			if (!isValidGuiNode(node)) {
				log("ctx.gui.overlay 收到非法节点，返回空句柄");
				return { element: elementId, update() {}, close() {} };
			}
			state.overlays.set(elementId, { node, options, onDismiss: options?.onDismiss });
			runtime.transport.push({ type: "overlay", elementId, node, options: { modal: options?.modal, position: options?.position, size: options?.size } });
			return {
				element: elementId,
				update(next: GuiNode) {
					if (!isValidGuiNode(next)) {
						log(`overlay ${elementId} 的 update() 收到非法节点，忽略`);
						return;
					}
					state.overlays.set(elementId, { node: next, options, onDismiss: options?.onDismiss });
					runtime.transport.push({ type: "overlay-update", elementId, node: next });
				},
				close() {
					state.overlays.delete(elementId);
					runtime.transport.push({ type: "overlay", elementId, node: null });
				},
			};
		},

		icon(name: string, svgPath: string) {
			if (typeof name !== "string" || !name.trim()) {
				log("ctx.gui.icon 的 name 必填，跳过");
				return;
			}
			state.icons.set(name, String(svgPath ?? ""));
		},
	};
	return namespace;
}

// ── 注入：在 ctx 上挂 gui getter（§7.5）─────────────────────────

/**
 * 在 `ctx` 上挂 `gui` getter。
 *
 * 若 `ctx` 被 freeze 挂不上，退化为**模块级函数**（`guiSet` / `guiCustom` / …）
 * 供扩展 import（代价：不再是「零新概念」）。
 */
export function installGuiNamespace(ctx: ExtensionContext, runtime: BridgeRuntime): void {
	try {
		const namespace = createGuiNamespace(runtime);
		const state = guiState(runtime);
		state.ctx = ctx;
		// 模块级降级路径也要能拿到 runtime
		setCurrentGuiRuntime(runtime, detectOwner());

		if (Object.prototype.hasOwnProperty.call(ctx, "gui")) {
			return; // 已挂过（幂等）
		}
		try {
			Object.defineProperty(ctx, "gui", {
				get: () => namespace,
				enumerable: false,
				configurable: true,
			});
			log("ctx.gui 已挂载（GUI 专属扩展点 + 作画工厂可用）");
		} catch (error) {
			// ctx 被 freeze → 退化为模块级函数（§7.5 / §13.7）
			log(`ctx.gui 无法挂到 ctx（可能被 freeze），退化为模块级函数: ${error instanceof Error ? error.message : String(error)}`);
		}
	} catch (error) {
		log(`installGuiNamespace 抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 猜测当前扩展名（用于卸载即清）。 */
function detectOwner(): string {
	try {
		const stack = new Error().stack ?? "";
		const match = stack.match(/[\\/]([^\\/]+)\.(ts|js|mjs|cjs):/g);
		if (match && match.length > 1) {
			const candidate = match[match.length - 1].replace(/^[\\/]/, "").replace(/\.(ts|js|mjs|cjs):$/, "");
			if (candidate && !candidate.includes("pi-deck-gui-bridge")) return candidate;
		}
	} catch {
		// 忽略
	}
	return "unknown";
}

// ── 模块级降级入口（ctx 被 freeze 时供扩展 import，§7.5）─────────

/** 模块级落点设置（ctx.gui 挂不上时的降级路径）。 */
export function guiSet(method: GuiSlotMethod, key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions): void {
	const runtime = currentRuntime();
	if (!runtime) {
		log(`guiSet(${method}) 在桥未挂载时被调用，忽略`);
		return;
	}
	if (!(method in GUI_SLOT_METHODS)) {
		log(`guiSet 收到白名单外的方法名 "${method}"，跳过`);
		return;
	}
	makeSlotSetter(method, runtime)(key, factory, options);
}

/** 模块级 custom（降级路径）。 */
export function guiCustom<T = unknown>(factory: GuiCustomFactory<T>, options?: GuiCustomOptions): Promise<T> {
	const runtime = currentRuntime();
	if (!runtime) {
		log("guiCustom 在桥未挂载时被调用，返回 undefined");
		return Promise.resolve(undefined as T);
	}
	return createGuiNamespace(runtime).custom(factory, options);
}

/** 模块级 toast（降级路径）。 */
export function guiToast(message: string, options?: { tone?: Tone; actions?: { label: string; onPress: () => void }[] }): void {
	const runtime = currentRuntime();
	if (!runtime) return;
	createGuiNamespace(runtime).toast(message, options);
}

/** 模块级 confirm（降级路径）。 */
export function guiConfirm(title: string, body: GuiNode, options?: { confirmLabel?: string; cancelLabel?: string }): Promise<boolean> {
	const runtime = currentRuntime();
	if (!runtime) return Promise.resolve(false);
	return createGuiNamespace(runtime).confirm(title, body, options);
}

/** 模块级 overlay（降级路径）。 */
export function guiOverlay(node: GuiNode, options?: OverlayOptions & { onDismiss?: () => void }): GuiHandle {
	const runtime = currentRuntime();
	if (!runtime) return { element: "noop", update() {}, close() {} };
	return createGuiNamespace(runtime).overlay(node, options);
}

/** 模块级 icon（降级路径）。 */
export function guiIcon(name: string, svgPath: string): void {
	const runtime = currentRuntime();
	if (!runtime) return;
	createGuiNamespace(runtime).icon(name, svgPath);
}

// ── 卸载清理（§7.7 要求 3）──────────────────────────────────────

/** 清掉某扩展名下的全部 GUI 贡献（扩展禁用/卸载时调用）。 */
export function clearGuiContributions(runtime: BridgeRuntime, owner: string): void {
	const state = guiState(runtime);
	for (const [mapKey, contribution] of state.contributions) {
		if (contribution.owner !== owner) continue;
		try {
			contribution.component?.dispose?.();
		} catch {
			/* no-op */
		}
		state.contributions.delete(mapKey);
		runtime.transport.push({ type: "ui-update", targetId: slotTargetId(contribution.method, contribution.key), node: null });
	}
}

/** 当前贡献数（诊断/测试用）。 */
export function guiContributionCount(runtime: BridgeRuntime): number {
	return guiState(runtime).contributions.size;
}

/**
 * 重导出交互回调的注册/触发入口。
 *
 * `ctx.gui` 的按钮 `onPress` 等回调走「actionId → 进程内回调」这条链
 * （§7.2 / §14.14：回调**不序列化**）。实现落在 serialize 模块（与 nodeId 回灌同源），
 * 这里重导出，让扩展作者只需 import 一个 GUI 模块。
 */
export { registerAction, invokeAction } from "./pi-deck-gui-bridge-serialize";

export type { UINode } from "./pi-deck-gui-bridge-types";