/**
 * 模型轨迹解析器测试：OpenAI / Anthropic 双方言 → 统一视图模型。
 * 数据形态取自真实 pi 请求体样本（userData/logs/model-traces 实录）：
 * - OpenAI：system 在 messages[0]、assistant.tool_calls、role="tool" 结果、tools[].function
 * - Anthropic：顶层 system、content 块数组（text/thinking/tool_use/tool_result）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseModelTracePayload, summarizeTraceMessage } = loadTsCommonJs("src/renderer/src/utils/modelTraceParse.ts");

test("OpenAI 方言：system 抽取、tool_calls 与 tool 结果各自成块", () => {
	const payload = {
		model: "glm-5.3",
		stream: true,
		max_completion_tokens: 8192,
		reasoning_effort: "medium",
		messages: [
			{ role: "system", content: "你是 pi 编码代理。\n\n# 技能\n- 搜索" },
			{
				role: "user",
				content: [
					{ type: "text", text: "帮我看下这个 bug" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,xxx" } },
				],
			},
			{ role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"path":"src/a.ts"}' } }] },
			{ role: "tool", tool_call_id: "call_1", content: "文件内容…" },
			{ role: "assistant", content: "看完了，问题在 X。" },
		],
		tools: [{ type: "function", function: { name: "read", description: "读取文件" } }],
	};
	const view = parseModelTracePayload(JSON.stringify(payload));
	assert.equal(view.dialect, "openai");
	assert.equal(view.model, "glm-5.3");
	assert.equal(view.stream, true);
	assert.equal(view.maxTokens, 8192);
	assert.equal(view.reasoningEffort, "medium");
	// system 从消息流抽出，单独成区
	assert.equal(view.system.text, "你是 pi 编码代理。\n\n# 技能\n- 搜索");
	assert.equal(view.system.segments.length, 2);
	// 消息流不含 system 行；user 块含图片占位
	assert.equal(view.messages.length, 4);
	assert.equal(view.messages[0].role, "user");
	assert.ok(
		view.messages[0].blocks.some((b) => b.type === "image"),
		"user 消息应含图片占位块",
	);
	// assistant 的 tool_calls → tool_call 块（工具名 + 参数 JSON 文本）
	const assistant = view.messages[1];
	assert.equal(assistant.role, "assistant");
	const call = assistant.blocks.find((b) => b.type === "tool_call");
	assert.equal(call.name, "read");
	assert.equal(call.id, "call_1");
	assert.ok(call.args.includes("src/a.ts"));
	// role=tool 的结果消息
	const tool = view.messages[2];
	assert.equal(tool.role, "tool");
	assert.equal(tool.blocks[0].type, "tool_result");
	assert.equal(tool.blocks[0].text, "文件内容…");
	assert.equal(view.messages[3].blocks[0].text, "看完了，问题在 X。");
	// 工具定义归一（OpenAI function 包装 → name/description）
	assert.equal(view.tools.length, 1);
	assert.equal(view.tools[0].name, "read");
	assert.equal(view.tools[0].description, "读取文件");
});

test("Anthropic 方言：顶层 system、content 块数组、tool_result 归 tool 角色", () => {
	const payload = {
		model: "claude-opus-4",
		max_tokens: 4096,
		system: [
			{ type: "text", text: "系统提示 A" },
			{ type: "text", text: "系统提示 B" },
		],
		messages: [
			{ role: "user", content: [{ type: "text", text: "分析一下" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "先看目录" },
					{ type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "a.ts\nb.ts" }] }] },
		],
		tools: [{ name: "bash", description: "执行命令", input_schema: {} }],
	};
	const view = parseModelTracePayload(JSON.stringify(payload));
	assert.equal(view.dialect, "anthropic");
	// 顶层 system 块数组拼接
	assert.equal(view.system.text, "系统提示 A\n系统提示 B");
	assert.equal(view.messages.length, 3);
	// thinking + tool_use 块
	const assistant = view.messages[1];
	const thinking = assistant.blocks.find((b) => b.type === "thinking");
	assert.equal(thinking.text, "先看目录");
	const call = assistant.blocks.find((b) => b.type === "tool_call");
	assert.equal(call.name, "bash");
	assert.ok(call.args.includes("ls"));
	// tool_result 块（内容是块数组 → 拼文本），展示角色归 tool
	const result = view.messages[2];
	assert.equal(result.role, "tool");
	const resultBlock = result.blocks[0];
	assert.equal(resultBlock.type, "tool_result");
	assert.equal(resultBlock.text, "a.ts\nb.ts");
	assert.equal(resultBlock.id, "tu_1");
	// Anthropic 工具定义直接有 name
	assert.equal(view.tools[0].name, "bash");
});

test("截断 / 畸形 payload 不抛异常，降级 truncated 视图", () => {
	const truncated = parseModelTracePayload('{"model":"x","messages":[{"role":"user","con');
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.dialect, "unknown");
	assert.equal(truncated.messages.length, 0);
	assert.ok(truncated.parseError, "应带解析失败原因");
	// 非对象 payload 同样安全
	assert.equal(parseModelTracePayload("[1,2]").truncated, true);
	assert.equal(parseModelTracePayload("null").truncated, true);
});

test("system 为字符串、消息 content 为字符串的极简形态可解析", () => {
	const view = parseModelTracePayload(JSON.stringify({ model: "m", system: "系统提示", messages: [{ role: "user", content: "你好" }] }));
	assert.equal(view.dialect, "anthropic");
	assert.equal(view.system.text, "系统提示");
	assert.equal(view.messages[0].blocks[0].text, "你好");
});

test("消息摘要：文本截断、工具调用显示工具名", () => {
	const view = parseModelTracePayload(
		JSON.stringify({
			messages: [
				{ role: "user", content: `${"很长的用户消息".repeat(30)}结尾` },
				{ role: "assistant", content: null, tool_calls: [{ function: { name: "bash", arguments: '{"command":"npm test"}' } }] },
			],
		}),
	);
	assert.ok(summarizeTraceMessage(view.messages[0]).length <= 96, "文本摘要不超过 96 字符");
	assert.ok(summarizeTraceMessage(view.messages[1]).startsWith("bash("), "工具调用摘要以工具名开头");
});
