/**
 * pi-deck-gui-bridge 参考示例 —— **纯 TUI 扩展**。
 *
 * 这个扩展**完全不知道 PiDeck 存在**：不 import 任何 PiDeck 相关包，
 * 只用 pi 官方的 `ctx.ui` 与 `@earendil-works/pi-tui` 组件。
 *
 * 它在 TUI 里本来就能工作；在 RPC（PiDeck）里，桥上线前这些点**全是 no-op**，
 * 上线后全部出现。这正是验收口径（§11.2 Phase 1 完成标志）：
 *
 * > 装一个只写了 `ctx.ui.setHeader/setFooter/setWidget/setStatus/setWorkingMessage`、
 * > 完全不知道 PiDeck 存在的扩展，重启 PiDeck 后这五处在 GUI 里全部出现，
 * > 且点列表能触发扩展回调。
 *
 * ## 安装
 *
 * 它不是 PiDeck 内置扩展（不被 `-e` 注入）。要试用：
 * 把它复制到 `~/.pi/agent/extensions/` 下，或在 pi 启动时用 `-e <绝对路径>` 指定。
 *
 * ## 它演示了什么
 *
 * | 演示点 | 用的 API |
 * |---|---|
 * | 顶部区 | `setHeader(factory)` |
 * | 底部状态区 | `setFooter(factory)` |
 * | 状态栏（多 key 共存） | `setStatus(key, text)` |
 * | 输入框挂件（组件形式） | `setWidget(key, factory)` |
 * | 流式状态行 | `setWorkingMessage` / `setWorkingIndicator` |
 * | 折叠思考块标签 | `setHiddenThinkingLabel` |
 * | 会话标题 | `setTitle` |
 * | 交互 + 事件回灌 | `SelectList` 的 `onSelect` / `onSelectionChange` |
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, SelectList, Text, VStack, type SelectItem, type SelectListTheme, type Theme } from "@earendil-works/pi-tui";

/** 输入框挂件的 key（同一 key 重复设置 = 后设覆盖）。 */
const WIDGET_KEY = "pi-gui-slot-hello:menu";

/** 可选动作。点选后经桥回灌，触发下面的 onSelect。 */
const ITEMS: SelectItem[] = [
	{ value: "greet", label: "打个招呼", description: "在时间线里写一句问候" },
	{ value: "status", label: "更新状态栏", description: "改一下状态栏文字" },
	{ value: "title", label: "改会话标题", description: "设置窗口/标签标题" },
];

export default function piGuiSlotHello(pi: ExtensionAPI): void {
	/** 用户选中的动作（仅用于演示，真实扩展会做别的事）。 */
	let lastPicked: string | undefined;

	/**
	 * SelectList 需要一份主题。
	 *
	 * 桥给扩展的 theme 是**语义版**（`fg` 产哨兵而非 ANSI），因此这里
	 * 直接用 `ctx.ui.theme` 即可 —— 在 TUI 里得到 ANSI，在 GUI 里得到语义色。
	 */
	function makeSelectTheme(theme: Theme): SelectListTheme {
		return {
			selectedPrefix: (text) => theme.fg("accent", `→ ${text}`),
			selectedText: (text) => theme.bold(text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("muted", text),
			noMatch: (text) => theme.fg("warning", text),
		};
	}

	/** 建输入框上方的挂件（组件形式 —— RPC 下以前被直接丢弃）。 */
	function buildWidget(ctx: ExtensionContext) {
		return (theme: Theme) => {
			const list = new SelectList(ITEMS, ITEMS.length, makeSelectTheme(theme));

			// ★ 事件回灌的落点：GUI 上点一项，桥会调 setSelectedIndex + handleInput("\r")，
			//   于是这个回调被原样触发 —— 扩展作者感觉不到桥在中间。
			list.onSelect = (item) => {
				lastPicked = item.value;
				ctx.ui.notify(`选中了：${item.label}`, "info");

				if (item.value === "greet") {
					ctx.ui.setStatus("pi-gui-slot-hello:last", "已打招呼");
				} else if (item.value === "status") {
					ctx.ui.setStatus("pi-gui-slot-hello:last", `状态更新于 ${new Date().toLocaleTimeString()}`);
				} else if (item.value === "title") {
					ctx.ui.setTitle("pi-gui-slot-hello 会话");
				}
			};

			// 高亮变化：桥用方向键序列驱动，同样会触发这里
			list.onSelectionChange = (item) => {
				lastPicked = item.value;
			};

			const box = new Box(1, 0);
			const stack = new VStack();
			stack.addChild(new Text(theme.fg("accent", "── pi-gui-slot-hello ──")));
			stack.addChild(list);
			box.addChild(stack);
			return box;
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		// ── 顶部区 ──────────────────────────────────────────────
		ctx.ui.setHeader((_tui, theme) => {
			const box = new Box(0, 0);
			box.addChild(new Text(theme.fg("accent", "⬢ pi-gui-slot-hello 已加载")));
			return box;
		});

		// ── 底部状态区 ──────────────────────────────────────────
		ctx.ui.setFooter((_tui, theme, footerData) => {
			const box = new Box(0, 0);
			const stack = new VStack();
			const branch = footerData?.gitBranch ? ` · 分支 ${footerData.gitBranch}` : "";
			stack.addChild(new Text(theme.fg("muted", `pi-gui-slot-hello${branch}`)));
			if (lastPicked) stack.addChild(new Text(theme.fg("muted", `上次选中：${lastPicked}`)));
			box.addChild(stack);
			return box;
		});

		// ── 状态栏（多 key 共存）────────────────────────────────
		ctx.ui.setStatus("pi-gui-slot-hello:ready", "示例扩展就绪");

		// ── 输入框挂件（组件形式）──────────────────────────────
		ctx.ui.setWidget(WIDGET_KEY, buildWidget(ctx), { placement: "aboveEditor" });

		// ── 流式状态行 ──────────────────────────────────────────
		ctx.ui.setWorkingMessage("示例扩展正在思考…");
		ctx.ui.setWorkingIndicator({ frames: ["◐", "◓", "◑", "◒"], intervalMs: 120 });

		// ── 折叠思考块标签 ──────────────────────────────────────
		ctx.ui.setHiddenThinkingLabel("示例扩展的思考过程");

		// ── 会话标题 ────────────────────────────────────────────
		ctx.ui.setTitle("pi-gui-slot-hello");
	});

	// 会话结束：把贡献清干净（传 undefined = 恢复默认），避免残留
	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setHeader(undefined);
		ctx.ui.setFooter(undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus("pi-gui-slot-hello:ready", undefined);
		ctx.ui.setStatus("pi-gui-slot-hello:last", undefined);
		ctx.ui.setWorkingMessage(undefined);
		ctx.ui.setWorkingIndicator(undefined);
		ctx.ui.setHiddenThinkingLabel(undefined);
	});
}