import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 绑定智能体的会话提示词可见性：
 * 「使用」创建绑定会话后，首轮由主进程把 systemPrompt 注入隐藏 agentMessage（时间线不可见），
 * 输入卡上方的角色设定卡必须能随时展开看到完整角色设定——发送消息之后也一直可见。
 */
const { resolveBoundSessionAgent } = loadTsCommonJs("src/renderer/src/utils/sessionAgentBinding.ts");
const bar = readFileSync("src/renderer/src/components/session/SessionAgentPromptBar.tsx", "utf8");
const composer = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

const agents = [
	{ id: "builtin-translate", name: "翻译官", systemPrompt: "你是翻译官" },
	{ id: "custom-writing", name: "写作助手", systemPrompt: "你是写作助手" },
];

test("按会话绑定解析智能体", () => {
	assert.equal(resolveBoundSessionAgent({ s1: "custom-writing" }, agents, "s1")?.id, "custom-writing");
	assert.equal(resolveBoundSessionAgent({ s1: "builtin-translate" }, agents, "s1")?.id, "builtin-translate");
});

test("未绑定 / 悬空绑定 / 无会话 id 都返回 null（不渲染半个提示条）", () => {
	assert.equal(resolveBoundSessionAgent({}, agents, "s1"), null);
	assert.equal(resolveBoundSessionAgent({ s1: "deleted-agent" }, agents, "s1"), null);
	assert.equal(resolveBoundSessionAgent({ s1: "custom-writing" }, agents, undefined), null);
	assert.equal(resolveBoundSessionAgent(undefined, agents, "s1"), null);
});

test("角色设定卡与待办/子代理同列：显示名称 + 可展开完整角色设定", () => {
	assert.match(bar, /<ComposerWidgetFrame data-testid="session-agent-prompt-bar"/, "必须使用 composer widget 统一卡片外框");
	assert.match(bar, /useComposerWidgetCollapsed\(`agent:\$\{sessionId\}`, true\)/, "折叠状态必须与其余 widget 共用同一份状态");
	assert.match(bar, /aria-expanded=\{!collapsed\}/);
	assert.match(bar, /agent\.systemPrompt/, "展开后必须显示完整提示词");
	assert.match(bar, /if \(!agent\) return null;/, "没有绑定智能体时整条不渲染");
	assert.match(bar, /agentPromptBar\.roleLabel/);
	assert.match(composer, /<SessionAgentPromptBar sessionId=\{props\.sessionId\} \/>/, "ComposerArea 必须挂载提示条");
	assert.match(composer, /\{props\.widgets\}\s*\{props\.agentBar\}\s*\{props\.queuePanel\}/, "提示条必须排在 widget 列，而不是贴着输入框");
});

test("中英文案同步提供", () => {
	for (const key of ["agentPromptBar.aria", "agentPromptBar.roleLabel", "agentPromptBar.pendingLabel", "agentPromptBar.pendingHint", "agentPromptBar.pendingCancel", "agentPromptBar.hint"]) {
		assert.match(zh, new RegExp('"' + key.replace(/\./g, "\\.") + '"'), key + " 缺少中文文案");
		assert.match(en, new RegExp('"' + key.replace(/\./g, "\\.") + '"'), key + " 缺少英文文案");
	}
	assert.match(zh, /"agentPromptBar\.hint": "仅在会话首次发送时注入一次/, "文案必须说明只注入首轮");
	assert.match(en, /"agentPromptBar\.hint": "Injected once on the session's first send/);
});
