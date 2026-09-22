import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentMessageProjector, buildActiveBranchEntryIds } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts", {
	stubs: {
		"./messageContent": {
			extractMessageText: (content) =>
				Array.isArray(content)
					? content
							.filter((item) => item?.type === "text")
							.map((item) => item.text ?? "")
							.join("\n")
					: typeof content === "string"
						? content
						: "",
		},
		// ./sessionEntryIds 不再打桩：entryId 槽位判定（isRoleMessageRole）是 0.86 system
		// 条目对齐的回归点，必须用生产实现，否则测试只能证明桩的行为。该模块无依赖，可直接加载。
	},
});

function translate(key, params = {}) {
	if (key === "session.imagePlaceholder") return "[image]";
	if (key === "mainTool.truncated") return `[truncated ${params.omitted}/${params.total}]`;
	return key;
}

function createProjector(isAskAborted = () => false) {
	return new AgentMessageProjector({ translate, isAskAborted });
}

test("keeps thinking-only history turns and their entry IDs aligned", () => {
	const messages = createProjector().convert(
		"agent",
		[
			{ role: "user", content: [{ type: "text", text: "Inspect this" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "thinking", thinking: "Check the history" }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "read-1", content: [{ type: "text", text: "file" }], timestamp: 3 },
		],
		["entry-user", "entry-thinking", "entry-tool"],
	);

	assert.deepEqual(
		messages.map((message) => message.meta.entryId),
		["entry-user", "entry-thinking", "entry-tool"],
	);
	assert.equal(messages[1].role, "assistant");
	assert.equal(messages[1].text, "");
	assert.equal(messages[1].thinking, "Check the history");
});

test("restores image-only history messages with a localized placeholder", () => {
	const messages = createProjector().convert(
		"agent",
		[
			{
				role: "user",
				content: [{ type: "image", data: "base64-data", mime_type: "image/jpeg" }],
				timestamp: 1,
			},
		],
		["entry-image"],
	);

	assert.equal(messages[0].text, "[image]");
	assert.equal(messages[0].images.length, 1);
	assert.equal(messages[0].images[0].type, "image");
	assert.equal(messages[0].images[0].data, "base64-data");
	assert.equal(messages[0].images[0].mimeType, "image/jpeg");
	assert.equal(messages[0].meta.entryId, "entry-image");
});

test("restores assistant image-only history messages (PiDeck imagegen persistence)", () => {
	const messages = createProjector().convert(
		"agent",
		[
			{
				role: "assistant",
				// 生图落盘格式：Anthropic 风格 source 包装（与 SessionHistoryReader 同协议）
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
					},
				],
				timestamp: 3,
				api: "openai-images",
				provider: "siliconflow",
				model: "Kwai-Kolors/Kolors",
			},
		],
		["entry-image-gen"],
	);

	assert.equal(messages.length, 1);
	assert.equal(messages[0].role, "assistant");
	// 生图落盘记录必须保留 imageGen 元数据，才能进入带复制/保存操作的最终回答。
	assert.equal(messages[0].text, "[image]");
	assert.equal(messages[0].meta.imageGen.status, "complete");
	assert.equal(messages[0].images.length, 1);
	assert.equal(messages[0].images[0].type, "image");
	assert.equal(messages[0].images[0].data, "iVBORw0KGgo=");
	assert.equal(messages[0].images[0].mimeType, "image/png");
	assert.equal(messages[0].meta.entryId, "entry-image-gen");
});

test("restores tool arguments while bounding retained historical output", () => {
	const hugeResult = `${"a".repeat(9_000)}\nEND-MARKER`;
	const messages = createProjector().convert(
		"agent",
		[
			{
				role: "assistant",
				timestamp: 10,
				content: [
					{
						type: "toolCall",
						id: "write-1",
						name: "write",
						arguments: { path: "src/app.ts", content: "export const answer = 42;" },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "write-1",
				content: [{ type: "text", text: hugeResult }],
				timestamp: 25,
			},
		],
		["entry-call", "entry-result"],
	);

	const toolMessage = messages[0];
	assert.equal(toolMessage.meta.toolName, "write");
	assert.match(toolMessage.meta.args, /src\/app\.ts/);
	assert.ok(toolMessage.meta.result.length < 8_100);
	assert.match(toolMessage.meta.result, /^a+/);
	assert.match(toolMessage.meta.result, /END-MARKER$/);
	assert.equal(toolMessage.meta.durationMs, 15);
});

test("marks recovered ask_question cards unanswered when that agent was cancelled", () => {
	const messages = createProjector((agentId) => agentId === "cancelled-agent").convert(
		"cancelled-agent",
		[
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "ask-1",
						name: "ask_question",
						arguments: { question: "Continue?" },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "ask-1",
				content: [],
				details: {
					question: "Continue?",
					type: "confirm",
					answered: true,
					answer: true,
					answerLabel: "Yes",
				},
			},
		],
		["entry-call", "entry-result"],
	);

	assert.equal(messages[0].meta._askCard.question, "Continue?");
	assert.equal(messages[0].meta._askCard.type, "confirm");
	assert.equal(messages[0].meta._askCard.answered, false);
	assert.equal(messages[0].meta._askCard.answer, null);
	assert.equal(messages[0].meta._askCard.answerLabel, undefined);
	assert.equal(messages[0].meta._askCard.options, undefined);
});

test("returns only role message entries on the active branch", () => {
	const ids = buildActiveBranchEntryIds(
		[
			{ id: "session", parentId: null, type: "session" },
			{ id: "message-1", parentId: "session", type: "message", message: { role: "user" } },
			{ id: "model", parentId: "message-1", type: "model_change" },
			{ id: "message-2", parentId: "model", type: "message", message: { role: "assistant" } },
			{ id: "discarded", parentId: "message-1", type: "message", message: { role: "assistant" } },
		],
		"message-2",
	);

	assert.deepEqual(Array.from(ids), ["message-1", "message-2"]);
});

test("skips pi 0.86 system message entries when aligning entry ids", () => {
	// 0.86 起系统提示/工具清单变更也是 type:"message"，但不消费 entryId 槽位：
	// 不过滤会让后续消息整体错位，编辑/删除/重发会落到相邻条目上。
	const ids = buildActiveBranchEntryIds(
		[
			{ id: "session", parentId: null, type: "session" },
			{ id: "sys-0", parentId: "session", type: "message", message: { role: "system" } },
			{ id: "message-1", parentId: "sys-0", type: "message", message: { role: "user" } },
			{ id: "sys-1", parentId: "message-1", type: "message", message: { role: "system" } },
			{ id: "message-2", parentId: "sys-1", type: "message", message: { role: "assistant" } },
		],
		"message-2",
	);

	assert.deepEqual(Array.from(ids), ["message-1", "message-2"]);
});
