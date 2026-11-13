/**
 * Web 端数据转换单测：chatMessagesToUiMessages（历史 ChatMessage → useChat UIMessage）。
 * 验证：角色映射（user/assistant，其它角色兜底 assistant）、thinking 注入
 * reasoning part、正文注入 text part、空消息/无 thinking 的边界。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { chatMessagesToUiMessages } = loadTsCommonJs("src/renderer/src/web/webApi.ts");

function message(overrides = {}) {
	return {
		id: "m1",
		agentId: "a1",
		role: "assistant",
		text: "hello",
		timestamp: 1,
		...overrides,
	};
}

test("maps user role to user and text part", () => {
	const result = chatMessagesToUiMessages([message({ role: "user", text: "hi" })]);
	assert.equal(result.length, 1);
	assert.equal(result[0].role, "user");
	assert.equal(result[0].parts.length, 1);
	assert.equal(result[0].parts[0].type, "text");
	assert.equal(result[0].parts[0].text, "hi");
});

test("maps assistant role to assistant and text part", () => {
	const result = chatMessagesToUiMessages([message({ role: "assistant", text: "hi" })]);
	assert.equal(result[0].role, "assistant");
	assert.equal(result[0].parts[0].type, "text");
});

test("falls back non-user roles to assistant", () => {
	for (const role of ["system", "tool", "error"]) {
		const result = chatMessagesToUiMessages([message({ role })]);
		assert.equal(result[0].role, "assistant", `role ${role} should map to assistant`);
	}
});

test("injects reasoning part before text when thinking present", () => {
	const result = chatMessagesToUiMessages([message({ thinking: "推理内容", text: "正文" })]);
	assert.equal(result[0].parts.length, 2);
	assert.equal(result[0].parts[0].type, "reasoning");
	assert.equal(result[0].parts[0].text, "推理内容");
	assert.equal(result[0].parts[1].type, "text");
	assert.equal(result[0].parts[1].text, "正文");
});

test("omits text part when text empty", () => {
	const result = chatMessagesToUiMessages([message({ text: "" })]);
	assert.equal(result[0].parts.length, 0);
});

test("keeps stable ids from message", () => {
	const result = chatMessagesToUiMessages([message({ id: "stable-id" })]);
	assert.equal(result[0].id, "stable-id");
});

test("maps tool messages with meta to expandable tool parts (P2)", () => {
	const result = chatMessagesToUiMessages([message({ id: "t1", role: "tool", text: "done", meta: { toolName: "bash", args: { command: "ls" }, result: { code: 0 } } })]);
	assert.equal(result.length, 1);
	// 工具回合归入 assistant 轮次，供时间线展开工具卡
	assert.equal(result[0].role, "assistant");
	const part = result[0].parts[0];
	assert.equal(part.type, "tool-bash");
	assert.equal(part.state, "output-available");
	assert.equal(part.toolCallId, "hist-t1");
	assert.deepEqual(part.input, { command: "ls" });
	assert.deepEqual(part.output, { code: 0 });
});

test("parses stringified tool args and flags error tools (P2)", () => {
	const parsed = chatMessagesToUiMessages([message({ id: "t2", role: "tool", text: "done", meta: { toolName: "bash", args: '{"command":"git status"}' } })]);
	// JSON.parse 在 vm realm 里执行，deepEqual 前先 JSON 归一到宿主对象
	assert.deepEqual(JSON.parse(JSON.stringify(parsed[0].parts[0].input)), { command: "git status" });

	// 非 JSON 字符串的 args 原样保留（截断的 args 不丢）
	const raw = chatMessagesToUiMessages([message({ id: "t3", role: "tool", text: "done", meta: { toolName: "bash", args: "truncated…" } })]);
	assert.equal(raw[0].parts[0].input, "truncated…");

	const failed = chatMessagesToUiMessages([message({ id: "t4", role: "tool", text: "✗ boom", meta: { toolName: "bash", isError: true, detailText: "exit 1" } })]);
	assert.equal(failed[0].parts[0].state, "output-error");
	assert.equal(failed[0].parts[0].errorText, "exit 1");
});

test("tool messages without a tool name fall back to plain text", () => {
	const result = chatMessagesToUiMessages([message({ id: "t5", role: "tool", text: "无名工具", meta: {} })]);
	assert.equal(result[0].parts.length, 1);
	assert.equal(result[0].parts[0].type, "text");
	assert.equal(result[0].parts[0].text, "无名工具");
});

test("maps historical user images to file parts and skips oversized ones (P2)", () => {
	const result = chatMessagesToUiMessages([
		message({
			role: "user",
			text: "看图",
			images: [{ type: "image", mimeType: "image/png", data: "abc" }, { type: "image", mimeType: "image/png", data: "x".repeat(4 * 1024 * 1024 + 1) }, { type: "image", mimeType: "image/jpeg" }, { type: "file" }],
		}),
	]);
	const fileParts = result[0].parts.filter((part) => part.type === "file");
	assert.equal(fileParts.length, 1);
	assert.equal(fileParts[0].mediaType, "image/png");
	assert.equal(fileParts[0].data, "data:image/png;base64,abc");
});

test("carries timestamp/endedAt/model in UIMessage metadata for the timeline", () => {
	const result = chatMessagesToUiMessages([
		message({ id: "u1", role: "user", text: "问题", timestamp: 1000, meta: { entryId: "e-user" } }),
		message({ id: "a1", role: "assistant", text: "回答", timestamp: 1100, meta: { entryId: "e-a", endedAt: 2600 }, model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } }),
		message({ id: "t1", role: "tool", text: "bash", timestamp: 1300, meta: { toolName: "bash" } }),
	]);
	const [userMessage, assistantMessage, toolMessage] = result;
	// 用户提问时间 + 原 meta（entryId 供 fork/编辑）
	assert.equal(userMessage.metadata.timestamp, 1000);
	assert.equal(userMessage.metadata.entryId, "e-user");
	// 助手回复时间 / 结束点（耗时）/ 本轮模型
	assert.equal(assistantMessage.metadata.timestamp, 1100);
	assert.equal(assistantMessage.metadata.endedAt, 2600);
	assert.deepEqual(JSON.parse(JSON.stringify(assistantMessage.metadata.model)), { provider: "anthropic", modelId: "claude-sonnet-4-5" });
	// 工具条目也带时间戳：轮末耗时要把工具动作算进结束点
	assert.equal(toolMessage.metadata.timestamp, 1300);
	assert.equal("model" in toolMessage.metadata, false);
});
