/** 未激活 ACP 会话「历史恢复提示」的判定（utils/acpSessionRestore 纯函数单测）。 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveAcpRestoreHint } = loadTsCommonJs("src/renderer/src/utils/acpSessionRestore.ts");

const TOOLS = [
	{ id: "t-gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"], enabled: true },
	{ id: "t-codex", name: "Codex CLI", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"], enabled: true },
];

test("未激活 + acpSessionId + 工具在表：显示恢复提示（带工具名，静态引导态）", () => {
	const hint = resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: "t-gemini" }, undefined, TOOLS);
	assert.equal(hint.kind, "restore");
	assert.equal(hint.toolName, "Gemini CLI");
	assert.equal(hint.activating, false);
});

test("新草稿（无 acpSessionId）不显示：没有可恢复的历史", () => {
	assert.equal(resolveAcpRestoreHint({ backend: "acp", acpToolId: "t-gemini" }, undefined, TOOLS), undefined);
});

test("激活完成（idle/running）不显示：历史已重放进时间线", () => {
	assert.equal(resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: "t-gemini" }, { agentId: "acp:agent-1", status: "idle" }, TOOLS), undefined);
	assert.equal(resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: "t-gemini" }, { agentId: "acp:agent-1", status: "running" }, TOOLS), undefined);
});

test("激活中（runtime starting）：切换为加载态提示，而非静态引导", () => {
	const hint = resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: "t-gemini" }, { agentId: "acp:agent-1", status: "starting" }, TOOLS);
	assert.equal(hint.kind, "restore");
	assert.equal(hint.toolName, "Gemini CLI");
	assert.equal(hint.activating, true);
});

test("激活已终结（error/closed）回到不提示：错误态由时间线/运行时链路表达", () => {
	assert.equal(resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: "t-gemini" }, { agentId: "acp:agent-1", status: "error" }, TOOLS), undefined);
	assert.equal(resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: "t-gemini" }, { agentId: "acp:agent-1", status: "closed" }, TOOLS), undefined);
});

test("pi/dsh 等其他后端不显示", () => {
	assert.equal(resolveAcpRestoreHint({ backend: "pi", acpSessionId: "x" }, undefined, TOOLS), undefined);
	assert.equal(resolveAcpRestoreHint({ backend: "dsh", acpSessionId: "x" }, undefined, TOOLS), undefined);
});

test("绑定工具被删 → 只读降级引导（不发恢复提示误导有新历史）", () => {
	assert.equal(resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: "t-gone" }, undefined, TOOLS)?.kind, "tool-missing");
	// 老数据没有 acpToolId（迁移兜底）也按工具缺失处理。
	assert.equal(resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: null }, undefined, TOOLS)?.kind, "tool-missing");
});

test("激活窗口合成事件（agentId 空占位 + starting）同样算激活中", () => {
	// 审计发现 A 的渲染侧配套：bind 前主进程只发得出 session 级合成 starting
	//（agentId=""），加载态判定不得依赖真实 agentId 存在。
	const hint = resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: "t-gemini" }, { agentId: "", status: "starting" }, TOOLS);
	assert.equal(hint.kind, "restore");
	assert.equal(hint.activating, true);
});

test("detach 后（agentId 被清、status detached）回到静态引导而非加载态", () => {
	const hint = resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: "t-gemini" }, { agentId: undefined, status: "detached" }, TOOLS);
	assert.equal(hint.kind, "restore");
	assert.equal(hint.activating, false);
});
