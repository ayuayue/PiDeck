/**
 * ACP 工具的品牌推断（纯函数，渲染层展示用）。
 *
 * 登记工具时用户只填命令/参数/显示名——`AcpToolConfig` 没有 presetId（预设只是预填表单，
 * 见 shared/acpToolPresets.ts），所以品牌只能从这三者推断。推断不出来的自定义工具返回
 * "generic"，由调用方回退通用终端图标，不假装成某个品牌。
 *
 * 输入框后端下拉与消息行头都靠它把「ACP」这个通用名换成各家的品牌标记
 * （用户反馈：选了 OpenCode 却看不出来是 OpenCode 还是 Codex）。
 */
import type { AcpToolConfig } from "../../../../shared/types/acp";

export type AcpToolBrand = "gemini" | "claude" | "codex" | "kimi" | "qwen" | "opencode" | "cursor" | "codebuddy" | "minimax" | "generic";

/**
 * 关键词表，**顺序敏感**：
 * - 先具体后宽泛，包名里带品牌的（npx 形态）先命中；
 * - `agent acp`（Cursor Agent 官方命令，无包名）必须排在 claude/codex 之后，
 *   否则 `npx -y @agentclientprotocol/claude-agent-acp` 会被判成 cursor。
 */
const BRAND_KEYWORDS: ReadonlyArray<readonly [AcpToolBrand, readonly string[]]> = [
	["claude", ["claude"]],
	["codex", ["codex"]],
	["codebuddy", ["codebuddy"]],
	["kimi", ["kimi", "moonshot"]],
	["qwen", ["qwen"]],
	["gemini", ["gemini"]],
	["opencode", ["opencode"]],
	["minimax", ["minimax"]],
	["cursor", ["cursor", "agent acp"]],
];

/** 判定文本 = 命令 + 参数 + 显示名（小写）：npx 包名里就是品牌名，用户改的显示名也算线索。 */
export function resolveAcpToolBrand(tool: Pick<AcpToolConfig, "command" | "args" | "name">): AcpToolBrand {
	const haystack = [tool.command, ...tool.args, tool.name].join(" ").toLowerCase();
	for (const [brand, keywords] of BRAND_KEYWORDS) {
		if (keywords.some((keyword) => haystack.includes(keyword))) return brand;
	}
	return "generic";
}
