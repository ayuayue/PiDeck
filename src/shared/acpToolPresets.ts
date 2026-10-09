/**
 * ACP 工具预设:开箱即用的 Agent Client Protocol agent 启动形态。
 *
 * 命令均来自各 CLI 官方文档核对(2026-10):
 * - Gemini CLI:`gemini --acp`(docs/cli/acp-mode.md,已从 --experimental-acp 毕业)
 * - Claude Agent:`npx -y @agentclientprotocol/claude-agent-acp`(Zed 维护的 SDK adapter,
 *   包已从 @zed-industries/claude-agent-acp 迁移到 @agentclientprotocol 组织)
 * - Codex CLI:`npx -y @agentclientprotocol/codex-acp`(ACP 官方 adapter,复用 Codex App Server)
 * - Kimi CLI:`kimi acp`(moonshotai/kimi-cli,需先在终端 `kimi` 里 /login)
 * - Qwen Code:`qwen --acp`(QwenLM/qwen-code,已从 --experimental-acp 毕业)
 * - OpenCode:`opencode acp`(opencode.ai/v2/docs/cli/acp,需先 `opencode auth login`)
 *
 * 预设只是「预填表单」:点击后进草稿行,用户仍可改命令/参数,保存走统一校验链
 * (validateTool + sanitizeAcpTools),不做任何绕过。npx/npm 形态在 Windows 上的
 * .cmd 垫片还原由 PiLocator.createInvocation 统一处理,预设无需关心平台。
 */
export type AcpToolPresetId = "gemini" | "claude-agent" | "codex" | "kimi" | "qwen" | "opencode";

export interface AcpToolPreset {
	/** 稳定标识(也用作 i18n 描述 key 后缀)。 */
	id: AcpToolPresetId;
	/** 预填显示名。 */
	name: string;
	/** 启动命令。 */
	command: string;
	/** 启动参数(数组语义,与 AcpToolConfig.args 一致)。 */
	args: string[];
	/** 项目主页(设置页可跳转的文档链接)。 */
	homepage: string;
}

export const ACP_TOOL_PRESETS: readonly AcpToolPreset[] = [
	{ id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"], homepage: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md" },
	{ id: "claude-agent", name: "Claude Agent", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"], homepage: "https://github.com/agentclientprotocol/claude-agent-acp" },
	{ id: "codex", name: "Codex CLI", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"], homepage: "https://github.com/agentclientprotocol/codex-acp" },
	{ id: "kimi", name: "Kimi CLI", command: "kimi", args: ["acp"], homepage: "https://github.com/moonshotai/kimi-cli" },
	{ id: "qwen", name: "Qwen Code", command: "qwen", args: ["--acp"], homepage: "https://github.com/QwenLM/qwen-code" },
	{ id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"], homepage: "https://opencode.ai/docs/cli/acp" },
];
