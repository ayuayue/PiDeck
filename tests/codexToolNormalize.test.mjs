import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * Codex 非标准工具行归一单测（codexToolNormalize.ts）。
 *
 * 背景：pi 只认 function_call / function_call_output；Codex 还有一批语义化工具行
 * （custom_tool_call / web_search_call / tool_search_call / image_generation_call /
 * agent_message）。过去它们被整段跳过 —— 导入后的会话中间工具调用凭空消失。
 */

function loadModule() {
	const source = readFileSync("src/main/sessions/codexToolNormalize.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { exports: {}, module: { exports: {} } };
	sandbox.exports = sandbox.module.exports;
	vm.runInNewContext(outputText, sandbox, { filename: "codexToolNormalize.ts" });
	return sandbox.module.exports;
}

test("custom_tool_call: apply_patch 裸文本与 exec JSON 字符串都收进 arguments", () => {
	const { normalizeCodexToolLine } = loadModule();

	const patch = normalizeCodexToolLine({ type: "custom_tool_call", call_id: "call_1", name: "apply_patch", input: "*** Begin Patch\n*** Add File: a.md\n" }, "fb");
	assert.equal(patch.call.id, "call_1");
	assert.equal(patch.call.name, "apply_patch");
	assert.equal(patch.call.arguments.input, "*** Begin Patch\n*** Add File: a.md\n");
	assert.equal(patch.result, undefined, "结果在后续 custom_tool_call_output 行里");

	const exec = normalizeCodexToolLine({ type: "custom_tool_call", call_id: "call_2", name: "exec", input: '{"cmd":"ls"}' }, "fb");
	assert.deepEqual(JSON.parse(JSON.stringify(exec.call.arguments)), { cmd: "ls" }, "JSON 字符串 input 解析成对象");

	// 缺 call_id 时用兜底 id，保证 toolCall/toolResult 仍能配对
	const noId = normalizeCodexToolLine({ type: "custom_tool_call", name: "exec", input: "x" }, "fallback-id");
	assert.equal(noId.call.id, "fallback-id");
});

test("custom_tool_call_output: 解析 output/metadata，非 0 退出码标 isError", () => {
	const { parseCodexToolOutput } = loadModule();

	const ok = parseCodexToolOutput('{"output":"Success. Updated the following files:\\nA a.md\\n","metadata":{"exit_code":0,"duration_seconds":0.1}}');
	assert.equal(ok.isError, false);
	assert.match(ok.text, /Success\. Updated/);

	const failed = parseCodexToolOutput('{"output":"boom","metadata":{"exit_code":1}}');
	assert.equal(failed.isError, true);
	assert.equal(failed.text, "boom");

	// 非 JSON 输出原样保留，不丢内容
	const raw = parseCodexToolOutput("plain text output");
	assert.equal(raw.text, "plain text output");
	assert.equal(raw.isError, false);
});

test("web_search_call: 查询词进 arguments，结果行说明未保存正文", () => {
	const { normalizeCodexToolLine } = loadModule();
	const line = normalizeCodexToolLine({ type: "web_search_call", status: "completed", action: { type: "search", query: "q1", queries: ["q1", "q2"] } }, "fb");
	assert.equal(line.call.name, "web_search");
	assert.equal(line.call.arguments.query, "q1");
	assert.deepEqual(JSON.parse(JSON.stringify(line.call.arguments.queries)), ["q1", "q2"]);
	assert.ok(line.result, "web_search_call 自带占位结果，避免工具卡永远处于运行中");
	assert.equal(line.skipResult, false);
});

test("tool_search_call 与 tool_search_output 按 call_id 配对，输出压成工具名清单", () => {
	const { normalizeCodexToolLine, codexToolSearchOutputText } = loadModule();

	const call = normalizeCodexToolLine({ type: "tool_search_call", call_id: "ts_1", arguments: { query: "browser", limit: 8 } }, "fb");
	assert.equal(call.call.name, "tool_search");
	assert.equal(call.skipResult, true, "结果由随后的 tool_search_output 行提供");

	const text = codexToolSearchOutputText({
		type: "tool_search_output",
		call_id: "ts_1",
		tools: [
			{
				type: "namespace",
				name: "codex_app",
				tools: [
					{ type: "function", name: "automation_update" },
					{ type: "function", name: "list_threads" },
				],
			},
			{ type: "function", name: "web_search" },
		],
	});
	assert.match(text, /匹配到 3 个工具/);
	assert.match(text, /codex_app\.automation_update/);
	assert.match(text, /web_search/);

	assert.equal(codexToolSearchOutputText({ tools: [] }), "（无匹配工具）");
});

test("image_generation_call: 提示词进 arguments，base64 结果单独取出", () => {
	const { normalizeCodexToolLine, codexImageGenerationResult } = loadModule();

	const line = normalizeCodexToolLine({ type: "image_generation_call", id: "ig_1", status: "generating", revised_prompt: "一张示意图" }, "fb");
	assert.equal(line.call.name, "image_generation");
	assert.equal(line.call.arguments.prompt, "一张示意图");
	assert.equal(line.skipResult, true, "图片结果由调用方按体积护栏决定内联或占位");

	assert.equal(codexImageGenerationResult({ result: "iVBORw0KGgo=" }), "iVBORw0KGgo=");
	assert.equal(codexImageGenerationResult({ result: 42 }), "");
});

test("agent_message: 可读正文作结果，纯加密正文不产出结果行", () => {
	const { normalizeCodexToolLine } = loadModule();

	const withText = normalizeCodexToolLine({ type: "agent_message", id: "am_1", author: "/root/a", recipient: "/root/b", content: [{ type: "input_text", text: "Message Type: MESSAGE\nTask name: /root" }] }, "fb");
	assert.equal(withText.call.name, "agent_message");
	assert.deepEqual(JSON.parse(JSON.stringify(withText.call.arguments)), { author: "/root/a", recipient: "/root/b" });
	assert.equal(withText.skipResult, false);
	assert.match(withText.result.text, /Message Type: MESSAGE/);

	const encryptedOnly = normalizeCodexToolLine({ type: "agent_message", id: "am_2", content: [{ type: "encrypted_content", encrypted_content: "gAAAAA" }] }, "fb");
	assert.equal(encryptedOnly.skipResult, true, "只有加密正文时不写空结果行");
	assert.equal(encryptedOnly.result, undefined);
});

test("非工具行返回 null（消息/推理等继续走原路径）", () => {
	const { normalizeCodexToolLine } = loadModule();
	for (const payload of [{ type: "message", role: "assistant" }, { type: "reasoning" }, { type: "function_call" }, { type: "compaction" }, {}]) {
		assert.equal(normalizeCodexToolLine(payload, "fb"), null, `${JSON.stringify(payload)} 不应被当成非标准工具行`);
	}
});
