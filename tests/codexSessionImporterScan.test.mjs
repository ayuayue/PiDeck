import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * CodexSessionImporter 扫描防 OOM 单测。
 *
 * 背景（真实崩溃）：~/.codex/sessions 下 rollouts/ 轨迹文件体积巨大，旧实现 scan()
 * 会 Promise.all 全量并发 readFile + 逐行 JSON.parse，内存峰值随目录总大小线性增长，
 * 扫描时 OOM 被系统静默杀进程（无任何日志）。修复：
 * 1. collectJsonl 跳过 rollouts/ 目录；
 * 2. scan 只读每个文件头部 1MB（session_meta/preview 都在前部），坏行/半行容错；
 * 3. 分块并发（SCAN_CONCURRENCY=6）限制同时驻留的缓冲数。
 *
 * 2026-09 用户消息新格式：Codex Desktop 把每轮的 event_msg/user_message 事件移除，
 * 用户输入直接作为 response_item role:user 写盘（前面带 <recommended_plugins>/
 * <environment_context> 等注入包装）。导入器只支持新格式；旧 event_msg 不再识别。
 */
function loadTranspiled(sourcePath, sandbox) {
	const source = readFileSync(sourcePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	vm.runInNewContext(outputText, sandbox, { filename: sourcePath });
	return sandbox.exports;
}

function loadImporter(homePath) {
	// 统一沙箱加载器：相对 import 自动按**源文件目录**解析，不再手写 require 桥。
	const load = createTsSandbox({ stubs: { electron: { app: { getPath: () => homePath }, shell: {} } } });
	const mod = load("src/main/sessions/CodexSessionImporter.ts");
	return { ...mod, importer: new mod.CodexSessionImporter() };
}

function sessionJsonl(id, cwd) {
	const lines = [];
	lines.push(
		JSON.stringify({
			type: "session_meta",
			payload: { id, cwd, timestamp: "2026-08-10T10:00:00.000Z", model: "gpt-5" },
		}),
	);
	// 两条对话轮次：assistant 回复在前（preview 取第一条非空文本），user 问题在后（title 来源）。
	// 新格式：user 是 response_item role:user，内部带 content_item_kinds=[user.text]。
	for (let i = 0; i < 2; i++) {
		lines.push(
			JSON.stringify({
				type: "response_item",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `回复 ${i}` }] },
			}),
		);
		lines.push(
			JSON.stringify({
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: `问题 ${i}` }],
					internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
				},
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

test("codex scan: skips rollouts/ trajectory files", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-scan-rollouts-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(join(sessions, "s1", "rollouts"), { recursive: true });
		// rollouts/ 内的轨迹文件（体积巨大、非独立会话）必须被跳过
		writeFileSync(join(sessions, "s1", "rollouts", "r1.jsonl"), sessionJsonl("r1", project));
		// 非 rollouts 目录的普通会话照常收集
		writeFileSync(join(sessions, "s1", "session.jsonl"), sessionJsonl("s1", project));
		// 根级散落的 .jsonl（非 session 目录结构）也应收集
		writeFileSync(join(sessions, "loose.jsonl"), sessionJsonl("loose", project));

		const { CodexSessionImporter } = loadImporter(home);
		const summaries = await new CodexSessionImporter().scan(project);
		// [...沙箱数组]：vm 内创建的数组原型与测试 realm 不同，deepEqual 会因原型差异误报
		const ids = [...summaries.map((s) => s.id)].sort();
		assert.deepEqual(ids, ["loose", "s1"], "rollouts/ 文件不应出现在扫描结果中");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex scan: oversized file is read head-only, broken lines tolerated", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-scan-big-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(sessions, { recursive: true });
		// 超过 1MB 的会话：session_meta 在前部，中后部填充 + 坏 JSON 行
		// （旧实现会全量 parse 到坏行抛错，或直接 OOM）
		const path = join(sessions, "big.jsonl");
		writeFileSync(path, sessionJsonl("big", project) + "x".repeat(1024 * 1024) + "\n" + '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{broken');

		const { CodexSessionImporter } = loadImporter(home);
		const summaries = await new CodexSessionImporter().scan(project);
		assert.equal(summaries.length, 1, "头部完整的大文件应正常出现在扫描结果");
		assert.equal(summaries[0].id, "big");
		assert.equal(summaries[0].title, "问题 0", "title 取第一条 user 消息（在前部）");
		assert.ok(summaries[0].preview.length > 0, "preview 取第一条非空文本（在前部）");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex scan: small file summary matches full parse (no behavior change)", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-scan-small-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "small.jsonl"), sessionJsonl("small", project));

		const { CodexSessionImporter } = loadImporter(home);
		const summaries = await new CodexSessionImporter().scan(project);
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].title, "问题 0");
		assert.equal(summaries[0].preview, "回复 0");
		// 2 user + 2 assistant 消息（converted 内 session/codex_import/model_change 不计入 messageCount）
		assert.equal(summaries[0].messageCount, 4);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex scan: only parses sessions of the selected project", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-scan-projectfilter-"));
	try {
		const projA = join(home, "projA");
		const projB = join(home, "projB");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(join(sessions, "a"), { recursive: true });
		mkdirSync(join(sessions, "b"), { recursive: true });
		// projB 会话正文含坏行：若预过滤失效（旧行为全量解析）该文件会拖慢/报错，
		// 预过滤后 projB 只读头部 64KB 即被丢弃，扫描不受影响
		writeFileSync(join(sessions, "a", "session.jsonl"), sessionJsonl("a", projA));
		writeFileSync(join(sessions, "b", "session.jsonl"), sessionJsonl("b", projB) + "\n" + '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{broken');

		const { CodexSessionImporter } = loadImporter(home);
		const summaries = await new CodexSessionImporter().scan(projA);
		assert.deepEqual([...summaries.map((s) => s.id)], ["a"], "只应返回当前项目（projA）的会话，projB 的坏正文文件被预过滤跳过");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex scan: meta head filter tolerates broken leading lines", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-scan-metahead-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(sessions, { recursive: true });
		// meta 前有坏行（手改/损坏的会话）：预过滤应跳过坏行找到 meta
		writeFileSync(join(sessions, "dirty.jsonl"), '{"type":"turn_context","payload":{"cwd":"x"}}\n' + "not-json\n" + sessionJsonl("dirty", project));
		// 完全没有 meta 的文件（如手放的数据文件）：应被跳过而不是报错
		writeFileSync(join(sessions, "nometa.jsonl"), '{"type":"response_item","payload":{}}\n'.repeat(4));

		const { CodexSessionImporter } = loadImporter(home);
		const summaries = await new CodexSessionImporter().scan(project);
		assert.deepEqual([...summaries.map((s) => s.id)], ["dirty"], "坏行应被跳过，无 meta 文件应被静默排除");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex import: multi-hundred-MB session streams without loading it whole", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-import-stream-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(sessions, { recursive: true });
		const path = join(sessions, "huge.jsonl");
		// 模拟巨型会话：正文含 3 条 10MB 的 function_call_output（~30MB）。
		// 旧全量实现会整文件 readFile + 逐行 JSON.parse（峰值数百 MB，OOM 被系统静默杀进程）；
		// 流式实现只驻留单行，任意大小都能导入。
		const bigOutput = "x".repeat(10 * 1024 * 1024);
		const bigLines = [1, 2, 3].map((n) =>
			JSON.stringify({
				type: "response_item",
				payload: {
					type: "function_call_output",
					call_id: `c${n}`,
					output: bigOutput,
					timestamp: `2026-08-10T10:00:0${n}.000Z`,
				},
			}),
		);
		writeFileSync(path, sessionJsonl("huge", project) + bigLines.join("\n") + "\n");

		const { CodexSessionImporter } = loadImporter(home);
		const report = await new CodexSessionImporter().import(project, [path]);
		assert.equal(report.results[0].success, true);
		// 4 条常规消息（2 assistant + 2 user）+ 3 条 toolResult（大行）
		assert.equal(report.results[0].messageCount, 7);

		// 目标文件结构：头部 3 条固定记录（session/codex_import/model_change）+ 7 消息 + 1 条 session_info
		const targetLines = readFileSync(report.results[0].targetPath, "utf8").trim().split("\n");
		assert.equal(targetLines.length, 3 + 7 + 1);
		assert.deepEqual(
			targetLines.slice(0, 3).map((line) => JSON.parse(line).type),
			["session", "codex_import", "model_change"],
		);
		assert.equal(JSON.parse(targetLines[targetLines.length - 1]).type, "session_info");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// 回归 2026-09：Codex 的语义化工具行（custom_tool_call / web_search_call /
// tool_search_call / image_generation_call）过去被整段跳过 —— 导入后的会话里
// 文件修改、命令执行、联网检索全部凭空消失。它们必须与 function_call 同一套
// pi 形态（assistant.toolCall + 配对 toolResult）落盘。
test("codex import: non-standard tool lines become toolCall + paired toolResult", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-tools-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(sessions, { recursive: true });
		const lines = [
			JSON.stringify({ type: "session_meta", payload: { id: "thread-tools", cwd: project, timestamp: "2026-08-10T10:00:00.000Z" } }),
			// 标准 function_call（既有能力，防回归）
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:01.000Z", payload: { type: "function_call", call_id: "c1", name: "shell_command", arguments: '{"command":"ls"}' } }),
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:02.000Z", payload: { type: "function_call_output", call_id: "c1", output: "ok" } }),
			// custom_tool_call（apply_patch）：参数是裸 patch 文本
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:03.000Z", payload: { type: "custom_tool_call", call_id: "c2", name: "apply_patch", input: "*** Begin Patch\n*** Add File: a.md\n+x\n*** End Patch\n", status: "completed" } }),
			JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c2", output: '{"output":"Success. Updated the following files:\nA a.md\n","metadata":{"exit_code":0}}', timestamp: "2026-08-10T10:00:04.000Z" } }),
			// web_search_call：只有查询词，没有结果正文
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:05.000Z", payload: { type: "web_search_call", status: "completed", action: { type: "search", query: "codex rollout format", queries: ["codex rollout format"] } } }),
			// image_generation_call：小图内联，大图占位
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:06.000Z", payload: { type: "image_generation_call", id: "ig1", status: "generating", revised_prompt: "一张示意图", result: "iVBORw0KGgoAAAANSUhEUg==" } }),
		];
		writeFileSync(join(sessions, "tools.jsonl"), `${lines.join("\n")}\n`);

		const { CodexSessionImporter } = loadImporter(home);
		const report = await new CodexSessionImporter().import(project, [join(sessions, "tools.jsonl")]);
		assert.equal(report.results[0].success, true);

		const entries = readFileSync(report.results[0].targetPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.type === "message");

		const toolCalls = entries.flatMap((entry) => (entry.message?.content ?? []).filter((block) => block.type === "toolCall").map((block) => ({ ...block, ts: entry.timestamp })));
		const toolResults = entries.filter((entry) => entry.message?.role === "toolResult").map((entry) => entry.message);
		const names = [...toolCalls.map((call) => call.name)].sort();

		assert.deepEqual(names, ["apply_patch", "image_generation", "shell_command", "web_search"], "四类工具都要落成 toolCall");
		assert.equal(toolResults.length, 4, "每个调用都要有配对结果行");

		// custom_tool_call 的 patch 正文保留在参数里
		const patchCall = toolCalls.find((call) => call.name === "apply_patch");
		assert.match(patchCall.arguments.input, /\*\*\* Begin Patch/);
		const patchResult = toolResults.find((result) => result.toolCallId === "c2");
		assert.equal(patchResult.isError, false);
		assert.match(patchResult.content[0].text, /Success\. Updated/);
		assert.equal(patchResult.toolName, "apply_patch");

		// 小图直接内联成 pi image 块
		const imageResult = toolResults.find((result) => result.toolName === "image_generation");
		assert.equal(imageResult.content[0].type, "image");
		assert.equal(imageResult.content[0].mimeType, "image/png");

		// 标准 function_call 仍按原样配对（带派生耗时）
		const shellResult = toolResults.find((result) => result.toolCallId === "c1");
		assert.equal(shellResult.toolName, "shell_command");
		assert.equal(typeof shellResult.durationMs, "number");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// 回归 2026-10：Codex 一轮并行工具调用会写成连续多条 response_item function_call，
// 逐条转成单 call assistant 会让 pi 请求转换把除最后一个 call 外的 toolResult 判成
// 「前面没有 tool_calls 的 tool 消息」（严格供应商 400）。连续的并行调用必须合并为
// 一条 assistant（OpenAI 并行 tool_calls 语义），全部 toolResult 紧随其后完成配对。
test("codex import: 连续 function_call（并行调用）合并为一条 assistant，toolResult 全部配对", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-parallel-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(sessions, { recursive: true });
		const lines = [
			JSON.stringify({ type: "session_meta", payload: { id: "thread-parallel", cwd: project, timestamp: "2026-08-10T10:00:00.000Z" } }),
			JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "并行跑两条命令" }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } } }),
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:01.000Z", payload: { type: "function_call", call_id: "call_a", name: "shell_command", arguments: '{"command":"ls"}' } }),
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:01.100Z", payload: { type: "function_call", call_id: "call_b", name: "shell_command", arguments: '{"command":"pwd"}' } }),
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:02.000Z", payload: { type: "function_call_output", call_id: "call_a", output: "a.ts" } }),
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:02.100Z", payload: { type: "function_call_output", call_id: "call_b", output: "/proj" } }),
			JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "两条命令都完成了" }] } }),
		];
		writeFileSync(join(sessions, "parallel.jsonl"), `${lines.join("\n")}\n`);

		const { CodexSessionImporter } = loadImporter(home);
		const report = await new CodexSessionImporter().import(project, [join(sessions, "parallel.jsonl")]);
		assert.equal(report.results[0].success, true);

		const entries = readFileSync(report.results[0].targetPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.type === "message");

		const merged = entries.find((entry) => entry.message?.role === "assistant" && (entry.message.content ?? []).some((block) => block.type === "toolCall"));
		assert.ok(merged, "应有含 toolCall 的 assistant 消息");
		const calls = merged.message.content.filter((block) => block.type === "toolCall");
		assert.deepEqual(
			calls.map((call) => call.id),
			["call_a", "call_b"],
			"两个并行调用必须合并进同一条 assistant",
		);

		const mergedIndex = entries.indexOf(merged);
		const following = entries.slice(mergedIndex + 1, mergedIndex + 3);
		assert.deepEqual(
			following.map((entry) => [entry.message?.role, entry.message?.toolCallId]),
			[
				["toolResult", "call_a"],
				["toolResult", "call_b"],
			],
			"toolResult 必须紧跟合并 assistant 且全部配对（不允许孤儿）",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// 回归 2026-10（真实样本 codex_019d38d5）：Codex 会把 assistant 文本写在并行 function_call
// 与 function_call_output 之间（call,call,text,out,out）。文本若单独成条，pi 请求转换会在
// 新 assistant 边界重置挂起集，全部 output 变孤儿（严格供应商 400）。连续的同一轮 assistant
// 内容必须并为一条（文本跟在 call 后面），output 紧随其后完成配对。
test("codex import: call 与 output 之间穿插的 assistant 文本并入同一条，不产生孤儿", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-interleave-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(sessions, { recursive: true });
		const lines = [
			JSON.stringify({ type: "session_meta", payload: { id: "thread-interleave", cwd: project, timestamp: "2026-08-10T10:00:00.000Z" } }),
			JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } } }),
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:01.000Z", payload: { type: "function_call", call_id: "call_x", name: "shell_command", arguments: '{"command":"ls"}' } }),
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:01.100Z", payload: { type: "function_call", call_id: "call_y", name: "shell_command", arguments: '{"command":"pwd"}' } }),
			// 关键：assistant 文本插在 call 与 output 之间（真实 rollout 里模型边执行边解说）
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:01.500Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "两条命令执行中……" }] } }),
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:02.000Z", payload: { type: "function_call_output", call_id: "call_x", output: "a.ts" } }),
			JSON.stringify({ type: "response_item", timestamp: "2026-08-10T10:00:02.100Z", payload: { type: "function_call_output", call_id: "call_y", output: "/proj" } }),
		];
		writeFileSync(join(sessions, "interleave.jsonl"), `${lines.join("\n")}\n`);

		const { CodexSessionImporter } = loadImporter(home);
		const report = await new CodexSessionImporter().import(project, [join(sessions, "interleave.jsonl")]);
		assert.equal(report.results[0].success, true);

		const entries = readFileSync(report.results[0].targetPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.type === "message");

		const merged = entries.find((entry) => entry.message?.role === "assistant" && (entry.message.content ?? []).some((block) => block.type === "toolCall"));
		assert.ok(merged, "应有含 toolCall 的 assistant 消息");
		const ids = merged.message.content.filter((block) => block.type === "toolCall").map((call) => call.id);
		assert.deepEqual(ids, ["call_x", "call_y"], "两个并行调用必须在同一条 assistant 里");
		assert.ok(
			merged.message.content.some((block) => block.type === "text" && block.text.includes("执行中")),
			"穿插文本必须并入同一条 assistant",
		);

		const mergedIndex = entries.indexOf(merged);
		const following = entries.slice(mergedIndex + 1, mergedIndex + 3);
		assert.deepEqual(
			following.map((entry) => [entry.message?.role, entry.message?.toolCallId]),
			[
				["toolResult", "call_x"],
				["toolResult", "call_y"],
			],
			"toolResult 必须紧跟合并 assistant 且全部配对（不允许孤儿）",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
