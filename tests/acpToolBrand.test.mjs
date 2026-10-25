/**
 * ACP 工具品牌推断（2026-10 用户反馈：输入框后端下拉与回复行头只显示通用终端图标，
 * 分不清当前会话是 OpenCode 还是 Codex）。
 *
 * 关键约束：登记的工具没有 presetId，品牌只能从 command/args/name 推断，
 * 且匹配顺序敏感——`npx -y @agentclientprotocol/claude-agent-acp` 里的 "agent"
 * 不能把它判成 Cursor Agent 的 `agent acp`。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveAcpToolBrand } = loadTsCommonJs("src/renderer/src/components/session/acpToolBrand.ts");
const { ACP_TOOL_PRESETS } = loadTsCommonJs("src/shared/acpToolPresets.ts");

/** 预设形态的期望品牌：与 ACP_TOOL_PRESETS 的命令一一对应（预设只是预填表单，用户可改）。 */
const EXPECTED_BY_PRESET = {
	gemini: "gemini",
	"claude-agent": "claude",
	codex: "codex",
	kimi: "kimi",
	qwen: "qwen",
	opencode: "opencode",
	"cursor-agent": "cursor",
	codebuddy: "codebuddy",
	minimax: "minimax",
};

test("每个内置预设都能推断出品牌（不会退化成通用终端图标）", () => {
	for (const preset of ACP_TOOL_PRESETS) {
		const brand = resolveAcpToolBrand({ command: preset.command, args: preset.args, name: preset.name });
		assert.equal(brand, EXPECTED_BY_PRESET[preset.id], `${preset.id}（${preset.command} ${preset.args.join(" ")}）应推断为 ${EXPECTED_BY_PRESET[preset.id]}，实际 ${brand}`);
		assert.notEqual(brand, "generic", `${preset.id} 不得回退 generic`);
	}
});

test("npx 形态：claude-agent-acp 不得被 Cursor Agent 的 agent acp 抢走", () => {
	assert.equal(resolveAcpToolBrand({ command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"], name: "Claude Agent" }), "claude");
	assert.equal(resolveAcpToolBrand({ command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"], name: "Codex CLI" }), "codex");
	assert.equal(resolveAcpToolBrand({ command: "agent", args: ["acp"], name: "Cursor Agent" }), "cursor");
});

test("用户改名/改路径后仍按命令与参数判定", () => {
	// 显示名被用户改掉：命令里的品牌仍然生效
	assert.equal(resolveAcpToolBrand({ command: "opencode", args: ["acp"], name: "我的小工具" }), "opencode");
	// 命令是绝对路径/包装脚本：参数或显示名里的品牌作为兜底线索
	assert.equal(resolveAcpToolBrand({ command: "C:\\tools\\run.cmd", args: ["--acp"], name: "Kimi CLI" }), "kimi");
	assert.equal(resolveAcpToolBrand({ command: "npx", args: ["-y", "some-wrapper", "--"], name: "MiniMax Code" }), "minimax");
});

test("自定义工具回退 generic（不假装成某个品牌）", () => {
	assert.equal(resolveAcpToolBrand({ command: "my-agent", args: [], name: "My Agent" }), "generic");
	assert.equal(resolveAcpToolBrand({ command: "python", args: ["acp_server.py"], name: "自研 ACP" }), "generic");
});
