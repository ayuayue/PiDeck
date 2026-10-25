import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * PiDeck 相关内置智能体（小助手 / 问题诊断 / 插件开发）的出厂契约。
 *
 * 这些提示词是「给模型读的产品内容」：不是寒暄，必须覆盖事实来源、可执行流程、
 * 边界与输出格式。断言只钉关键事实与安全边界，不锁具体措辞（允许后续润色）。
 */
const { BUILTIN_AGENT_SEEDS, getBuiltinSeed } = loadTsCommonJs("src/main/agents/builtinAgents.ts");
const { AGENT_PROFILE_DESCRIPTION_MAX_CHARS, AGENT_PROFILE_ICON_MAX_CHARS, AGENT_PROFILE_NAME_MAX_CHARS, AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS, BUILTIN_PIDECK_DIAGNOSTIC_AGENT_ID, BUILTIN_PIDECK_HELPER_AGENT_ID, BUILTIN_PIDECK_PLUGIN_DEV_AGENT_ID, BUILTIN_TRANSLATE_AGENT_ID } =
	loadTsCommonJs("src/shared/types/agentProfile.ts");

const pideckSeeds = BUILTIN_AGENT_SEEDS.filter((seed) => seed.id.startsWith("builtin-pideck-"));
const seedOf = (id) => {
	const seed = pideckSeeds.find((item) => item.id === id);
	assert.ok(seed, "缺少内置种子：" + id);
	return seed;
};

test("新增三个 PiDeck 内置智能体：稳定 id、分类与出厂元数据", () => {
	assert.deepEqual(
		Array.from(pideckSeeds, (seed) => seed.id),
		[BUILTIN_PIDECK_HELPER_AGENT_ID, BUILTIN_PIDECK_DIAGNOSTIC_AGENT_ID, BUILTIN_PIDECK_PLUGIN_DEV_AGENT_ID],
	);
	assert.deepEqual(
		Array.from(pideckSeeds, (seed) => seed.name),
		["PiDeck 小助手", "PiDeck 问题诊断助手", "PiDeck 插件开发助手"],
	);
	assert.deepEqual(
		Array.from(pideckSeeds, (seed) => seed.category),
		["general", "analysis", "coding"],
	);
	assert.equal(
		pideckSeeds.every((seed) => seed.builtin === true),
		true,
	);
	// 翻译官仍在且排在首位：划词默认回退与既有用户数据都依赖它。
	assert.equal(BUILTIN_AGENT_SEEDS[0].id, BUILTIN_TRANSLATE_AGENT_ID);
	assert.equal(getBuiltinSeed(BUILTIN_PIDECK_PLUGIN_DEV_AGENT_ID)?.name, "PiDeck 插件开发助手");
});

test("小助手提示词：覆盖产品边界、功能地图、事实来源与求助路径", () => {
	const prompt = seedOf(BUILTIN_PIDECK_HELPER_AGENT_ID).systemPrompt;
	for (const keyword of ["PiDeck", "不是 pi 的分支", "https://github.com/ayuayue/PiDeck", "AGENTS.md", "README.md", "问题反馈", "DSH", "智能体", "定时任务", "插件", "typecheck", "不要编造"]) {
		assert.match(prompt, new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "小助手提示词缺少：" + keyword);
	}
	assert.ok(prompt.length > 2_000, "小助手提示词过短，无法覆盖功能地图");
});

test("问题诊断提示词：诊断报告、日志路径、体检项、Issue 规范与隐私边界", () => {
	const prompt = seedOf(BUILTIN_PIDECK_DIAGNOSTIC_AGENT_ID).systemPrompt;
	for (const keyword of [
		"问题反馈",
		"环境诊断",
		"生成诊断报告",
		"导出日志包",
		"app-YYYY-MM-DD.log",
		"model-traces",
		"pi.installed",
		"disk.space",
		"memory.rss",
		"instance.locks",
		"https://github.com/ayuayue/PiDeck/issues",
		"bug:",
		"Steps to reproduce",
		"gh issue create",
		"[redacted]",
		"auth.json",
		"置信度",
		"分层定位",
	]) {
		assert.match(prompt, new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "诊断提示词缺少：" + keyword);
	}
	// 不得引导模型索要密钥原文或未经确认就外发 issue。
	assert.match(prompt, /不要主动索要 auth\.json/);
	assert.match(prompt, /用户明确同意/);
	assert.ok(prompt.length > 2_500, "诊断提示词过短，无法覆盖排障流程");
});

test("插件开发提示词：宿主插件边界、manifest、权限、API、调试与打包链路", () => {
	const prompt = seedOf(BUILTIN_PIDECK_PLUGIN_DEV_AGENT_ID).systemPrompt;
	for (const keyword of [
		"docs/host-plugin-dev-guide.md",
		"docs/host-plugins.md",
		"pideck-plugin.json",
		"window.pideck",
		"sessions.read",
		"network.https",
		"service.local",
		"billion-context",
		"CSP",
		"textContent",
		"重新扫描",
		"授权并启用",
		"pack-host-plugin.mjs",
		"plugin-changed",
		"rate-limited",
		"不要 fetch",
		"不是 pi 扩展",
	]) {
		assert.match(prompt, new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "插件开发提示词缺少：" + keyword);
	}
	assert.ok(prompt.length > 4_000, "插件开发提示词过短，无法覆盖开发与分发流程");
});

test("三个提示词都互不相同、在字段上限内，且能展开为完整 AgentProfile", () => {
	assert.equal(new Set(pideckSeeds.map((seed) => seed.systemPrompt)).size, pideckSeeds.length);
	for (const seed of pideckSeeds) {
		assert.ok(seed.name.length > 0 && seed.name.length <= AGENT_PROFILE_NAME_MAX_CHARS, seed.id + " 名称超限");
		assert.ok(seed.description.length > 0 && seed.description.length <= AGENT_PROFILE_DESCRIPTION_MAX_CHARS, seed.id + " 简介超限");
		assert.ok(seed.icon.length <= AGENT_PROFILE_ICON_MAX_CHARS, seed.id + " 图标超限");
		assert.ok(seed.systemPrompt.length <= AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS, seed.id + " 提示词超限");
	}
});
