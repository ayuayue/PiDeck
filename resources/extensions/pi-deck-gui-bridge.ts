/**
 * pi-deck-gui-bridge —— 桥扩展主入口。
 *
 * **交付物**：把 pi 在 RPC 模式下被丢弃的声明式 UI 扩展点接回 PiDeck。
 *
 * ## 拦截时机（Phase 0 S1 实测结论）
 *
 * pi 的 `runner.js:553` 用 `get ui() { return runner.uiContext }` **活取值**返回
 * **一份共享实例**。因此桥只要在拿到 `ctx` 后对 `runner.uiContext` 做一次属性替换，
 * 同一进程内**其余全部扩展**随后取到的 `ctx.ui` 都已是包装版。
 *
 * 桥不「抢在 RPC 降级之前」，而是**替换掉降级后的空实现** —— 比计划预期更简单。
 *
 * ## 实现纪律（§14）
 *
 * - 零构建：纯 `.ts`，无 React / JSX / CSS / Vite
 * - fail-safe：桥的任何失败只表现为「某个点在 GUI 里没出现」
 * - 只补不拆：`setWidget(string[])` 等已工作的点保持原路
 * - 只调公开方法回灌；未知组件降级 ANSI；永不抛错
 * - 幂等：`/reload` 后包装对象仍是同一单例、ticker 只有一个
 *
 * ## 不映射的三个点（§5.4，必须写进作者文档）
 *
 * | 点 | 为什么不映射 |
 * |---|---|
 * | `ctx.ui.custom()` | 它画的是 `render(width): string[]` 即**字符行**，观感是终端风，与 GUI 原生风格不合。GUI 的对应物是 `ctx.gui.custom()` |
 * | `ctx.ui.onTerminalInput()` | 语义是「监听原始终端按键」，GUI 里没有终端 |
 * | `ctx.ui.addAutocompleteProvider()` | GUI 输入框有自己的补全机制 |
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHttpTransport, createNullTransport, type UIBridgeTransport } from "./pi-deck-gui-bridge-transport";
import { getBridgeRuntime, type BridgeRuntime } from "./pi-deck-gui-bridge-runtime";
import { installGuiNamespace } from "./pi-deck-gui-bridge-gui";
import { loadPiTui } from "./pi-deck-gui-bridge-tui";

const log = (message: string): void => {
	process.stderr.write(`[pi-deck-gui-bridge] ${message}\n`);
};

/**
 * 进程级单例状态。
 *
 * `/reload` 会重新执行扩展模块（新模块实例），但 pi 的 `runner.uiContext`
 * 仍是**同一对象**。因此「是否已包装」必须记在 **ui 对象自己身上**
 * （见 runtime 的 `__pideckBridgeWrapped`），而不是模块变量 —— 模块变量在
 * reload 后是新的，会误判为未包装而重复叠加包装。
 */
let runtime: BridgeRuntime | null = null;

/** 取通路：env 缺失时返回 null 通路（桥整体静默，pi 行为不变，§12.4）。 */
function ensureTransport(): UIBridgeTransport {
	return createHttpTransport(log);
}

/** 取（或创建）桥运行时。 */
function ensureRuntime(): BridgeRuntime {
	if (!runtime) {
		runtime = getBridgeRuntime(ensureTransport());
	}
	return runtime;
}

/**
 * 把桥挂到 `ctx.ui` 上。
 *
 * 这是整个方案的支点：`ctx.ui` 是共享单例的活 getter（Phase 0 S1 实测），
 * 所以在这里 patch 一次即可覆盖所有扩展。
 */
function attachBridge(ctx: ExtensionContext, where: string): void {
	try {
		const ui = ctx.ui as unknown as Record<string, unknown>;
		if (!ui || typeof ui !== "object") return;
		const bridge = ensureRuntime();

		// 通路不可用（纯终端跑 pi）→ 静默不工作，但**仍然挂 ctx.gui**，
		// 这样扩展 import 我们的模块级函数不会拿到 undefined。
		if (!bridge.transport.available) {
			if (!(ui as { __pideckBridgeNotified?: boolean }).__pideckBridgeNotified) {
				Object.defineProperty(ui, "__pideckBridgeNotified", { value: true, enumerable: false, configurable: true });
				log("PIDECK_BRIDGE_URL 未设置：桥静默不工作（纯终端模式，pi 行为不变）");
			}
		}

		const alreadyWrapped = (ui as { __pideckBridgeWrapped?: boolean }).__pideckBridgeWrapped === true;
		bridge.wrapUI(ui);
		if (!alreadyWrapped) {
			bridge.startTicker();
			// pi-tui 加载结果只在首次报告一次（诊断用）
			const tuiResult = loadPiTui();
			if (tuiResult.module) {
				log(`pi-tui 已加载: ${tuiResult.via}`);
			} else {
				log(`pi-tui 加载失败，适配器退化为形状判定: ${tuiResult.error}`);
			}
			log(`桥已在 ${where} 挂载`);
		}

		// ctx.gui 命名空间（§7）：挂 getter，挂不上则退化为模块级导出
		installGuiNamespace(ctx, bridge);
	} catch (error) {
		// 任何失败都只意味着「某个点在 GUI 里没出现」，绝不影响 pi（§14.5）
		log(`attachBridge 抛错（已吞，pi 不受影响）: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export default function piDeckGuiBridgeExtension(pi: ExtensionAPI): void {
	// session_start 是最早能拿到 ctx 的稳定时机，也是包装的最佳落点。
	pi.on("session_start", async (_event, ctx) => {
		attachBridge(ctx, "session_start");
	});

	// agent_start 兜底：某些路径（如 /reload 之后）可能没走 session_start。
	pi.on("agent_start", async (_event, ctx) => {
		attachBridge(ctx, "agent_start");
	});

	// 会话结束：停 ticker、清贡献（§7.7）
	pi.on("session_shutdown", async () => {
		try {
			runtime?.shutdown();
		} catch (error) {
			log(`shutdown 抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}

/** 供扩展作者 import 的模块级入口（ctx.gui 挂不上时的降级路径，§7.5）。 */
export { guiSet, guiCustom, guiToast, guiConfirm, guiOverlay, guiIcon } from "./pi-deck-gui-bridge-gui";
export type { GuiComponent, GuiFactory, GuiHandle, GuiSlotOptions, GuiSurface, GuiTheme, GuiKeybindings } from "./pi-deck-gui-bridge-gui";
export type { GuiNode, Tone, Variant, UINode } from "./pi-deck-gui-bridge-types";