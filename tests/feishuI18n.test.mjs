import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 简体/繁体判定是真实实现（不是桩），与主进程共用同一份规则
const { isTraditionalChineseLanguageTag } = loadTsCommonJs(`${process.cwd()}/src/shared/types/settings.ts`);

function transpile(path) {
	return ts.transpileModule(readFileSync(path, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModule(path, imports = {}) {
	const sandbox = {
		exports: {},
		Buffer,
		require: (name) => {
			if (Object.hasOwn(imports, name)) return imports[name];
			throw new Error(`unexpected require: ${name}`);
		},
	};
	vm.runInNewContext(transpile(path), sandbox, { filename: path });
	return sandbox.exports;
}

// 繁体词典由 zh-CN 源生成（scripts/genZhTwCopy.mjs），生成文件只 import type，可独立加载后注入。
const { feishuZhTW } = loadModule("src/main/feishu/FeishuI18n.zh-TW.ts");
const i18n = loadModule("src/main/feishu/FeishuI18n.ts", {
	"./FeishuI18n.zh-TW": { feishuZhTW },
	"../../shared/types/settings": { isTraditionalChineseLanguageTag },
});

test("Feishu copy defaults to zh-CN and supports en-US interpolation", () => {
	assert.equal(i18n.normalizeFeishuLocale(undefined), "zh-CN");
	assert.equal(i18n.normalizeFeishuLocale("en-GB"), "en-US");
	assert.equal(i18n.feishuT("zh-CN", "model.switched", { model: "openai/gpt-4o" }), "✅ 已切换模型为: openai/gpt-4o");
	assert.equal(i18n.feishuT("en-US", "model.switched", { model: "openai/gpt-4o" }), "✅ Switched model to: openai/gpt-4o");
});

test("Feishu copy supports Traditional Chinese without touching the Feishu API language field", () => {
	assert.equal(i18n.normalizeFeishuLocale("zh-TW"), "zh-TW");
	assert.equal(i18n.normalizeFeishuLocale("zh_Hant_TW"), "zh-TW");
	// 飞书富文本 API 只认 zh/en，繁体沿用 zh 而不是新值
	assert.equal(i18n.feishuLanguage("zh-TW"), "zh");
	assert.equal(i18n.feishuT("zh-TW", "model.switched", { model: "openai/gpt-4o" }), "✅ 已切換模型為: openai/gpt-4o");
});

test("model picker localizes packaging without changing model identifiers", () => {
	const modelPicker = loadModule("src/main/feishu/ModelPickerCard.ts", {
		"./FeishuI18n": i18n,
	});
	const card = modelPicker.buildModelPickerCard({
		current: "openai/gpt-4o",
		locale: "en-US",
		models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o 原名" }],
	});
	const serialized = JSON.stringify(card);

	assert.equal(card.header.title.content, "Switch model");
	assert.match(serialized, /Current model: `openai\/gpt-4o`/);
	assert.match(serialized, /GPT-4o 原名/);
	assert.match(serialized, /"modelId":"gpt-4o"/);
});

test("run state localizes lifecycle copy and never exposes raw Agent errors", () => {
	const runState = loadModule("src/main/feishu/CardRunState.ts", {
		"./FeishuI18n": i18n,
	});
	let state = runState.createInitialState();
	state = runState.reduceFromPiEvent(state, { type: "agent_start" }, "en-US");
	state = runState.reduceFromPiEvent(
		state,
		{
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "Agent internal reasoning" },
		},
		"en-US",
	);
	state = runState.reduceFromPiEvent(
		state,
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				toolCall: { id: "tool-1", name: "read", input: { filePath: "C:/work/用户文件.txt" } },
			},
		},
		"en-US",
	);
	state = runState.reduceFromPiEvent(
		state,
		{
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { id: "tool-1", isError: false } },
		},
		"en-US",
	);
	state = runState.reduceFromPiEvent(
		state,
		{
			type: "agent_end",
			stopReason: "error",
			error: "provider-secret raw failure",
		},
		"en-US",
	);
	const serialized = JSON.stringify(state);

	assert.match(serialized, /Agent started/);
	assert.match(serialized, /Started thinking/);
	assert.match(serialized, /Tool completed: read/);
	assert.match(serialized, /C:\/work\/用户文件\.txt/);
	assert.match(serialized, /The Agent run failed/);
	assert.doesNotMatch(serialized, /provider-secret raw failure/);
});

test("run card translates wrappers while preserving Agent output and file paths", () => {
	const richText = loadModule("src/main/feishu/rich-text.ts");
	const renderer = loadModule("src/main/feishu/CardRenderer.ts", {
		"./FeishuI18n": i18n,
		"./rich-text": richText,
	});
	const card = renderer.renderRunCard(
		{
			blocks: [{ kind: "tool", tool: { id: "1", name: "read", input: { filePath: "C:/工作区/report.md" }, status: "done" } }],
			reasoning: { content: "", active: false },
			footer: null,
			terminal: "error",
			errorMsg: "raw provider stack trace",
			startedAt: Date.now(),
			meta: { durationMs: 1200 },
			trail: [],
			outputText: "Agent 原文 output",
		},
		{ locale: "en-US" },
	);
	const serialized = JSON.stringify(card);

	assert.match(serialized, /Agent 原文 output/);
	assert.match(serialized, /C:\/工作区\/report\.md/);
	assert.match(serialized, /The Agent run failed/);
	assert.match(serialized, /Done/);
	assert.doesNotMatch(serialized, /raw provider stack trace/);
});

test("FeishuBridge keeps provider and process error details out of outbound copy", () => {
	const source = readFileSync("src/main/feishu/FeishuBridge.ts", "utf8");
	assert.doesNotMatch(source, /Agent 错误: \$\{msg\}/);
	assert.doesNotMatch(source, /切换失败: \$\{e instanceof Error/);
	assert.doesNotMatch(source, /创建会话失败: \$\{msg\}/);
	assert.doesNotMatch(source, /发送文件失败: \$\{e instanceof Error/);
	assert.doesNotMatch(source, /正文写入失败：\$\{reason\}/);
	assert.match(source, /logErr\("\[飞书 Bridge\] Agent 运行失败:", e\)/);
	assert.match(source, /logErr\("\[飞书 Bridge\] 模型切换失败:", e\)/);

	// d8f5e3901 把飞书 IPC 迁出 index.ts 后，出站文案的 IPC 面在 ipc/feishuIpc.ts（locale 经 deps 注入）；
	// 正则空白容忍，避免格式化再次断言。
	const feishuIpcSource = readFileSync("src/main/ipc/feishuIpc.ts", "utf8");
	assert.match(feishuIpcSource, /feishuT\(deps\.getCurrentLocale\(\),\s*"bridge\.defaultBotName"\)/);
	assert.match(feishuIpcSource, /feishuT\(deps\.getCurrentLocale\(\),\s*"bridge\.botAddFailed"\)/);
	assert.doesNotMatch(feishuIpcSource, /return \{ success: false, error: error instanceof Error \? error\.message/);
});
