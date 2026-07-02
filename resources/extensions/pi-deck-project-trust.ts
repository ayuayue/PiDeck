/**
 * PiDeck Project Trust Extension
 *
 * 处理项目信任确认流程，遵循 pi 官方的 project_trust 事件协议。
 * 在 RPC 模式下，当 Agent 首次进入未信任的项目目录时，
 * 通过桌面端的 AskQuestionCard 弹窗让用户选择信任策略。
 *
 * 信任策略：
 *   - Trust + remember：永久信任，写入 trust.json
 *   - Trust this session：仅本次信任，不写入
 *   - Do not trust：拒绝信任，跳过项目级资源加载
 *   - Let built-in decide：让 pi 按默认配置决定
 *
 * 数据通过扩展 UI 协议（extension_ui_request/response）流转：
 *   AgentManager.handleUIRequest → 渲染进程 AskQuestionCard → sendUiResponse → PiProcess.sendRaw
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.on("project_trust", async (event, ctx) => {
		// 非交互模式（headless）不阻塞，直接让 pi 按默认配置决定。
		// PiDeck 桌面端 ctx.hasUI 始终为 true（RPC 模式下有 UI 协议）。
		if (!ctx.hasUI) {
			return { trusted: "undecided" };
		}

		const choice = await ctx.ui.select(
			`🔒 Project Trust Confirmation\n\nProject: ${event.cwd}`,
			[
				"Trust and remember (permanent trust)",
				"Trust this session only",
				"Do not trust this session",
				"Let pi decide with default config",
			],
			// 超时 60 秒，超时后 pi 按默认配置决定。
			60_000,
		);

		if (choice === "Trust and remember (permanent trust)") {
			return { trusted: "yes", remember: true };
		}
		if (choice === "Trust this session only") {
			return { trusted: "yes" };
		}
		if (choice === "Do not trust this session") {
			return { trusted: "no" };
		}

		// 用户未选择或选择了"默认配置决定"，让 pi 按 defaultProjectTrust 处理。
		return { trusted: "undecided" };
	});
}
