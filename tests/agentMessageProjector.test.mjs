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

/**
 * 端到端回归：「文件类工具参数 >8000 时，投影后仍能被渲染层解析出文件路径」。
 *
 * 事故（2027-02）：投影器对 meta.args 统一做 truncateForDetail(8000) 首尾截断，
 * 截断把「已省略 N 字符」插进 JSON 字符串中间 → args 不可解析 → 渲染层
 * getToolDiffTarget 取不到 file_path → 该文件从「修改的文件」清单里静默消失
 * （本机 60 会话实测丢 5.0%：213/4221，全部是 >8000 的 write/edit）。
 *
 * 上面的用例只放了 27 字节的 write 参数，测不到这条根因；这里把参数撑到 9000+，
 * 并把「投影输出」直接喂给渲染层的解析函数，钉住整条链路（而非只测 helper）。
 */
test("large write args stay parseable end-to-end so the renderer can still find the file", () => {
	const bigContent = Array.from({ length: 900 }, (_, index) => `export const line${index} = ${index};`).join("\n");
	assert.ok(JSON.stringify({ path: "src/big.ts", content: bigContent }).length > 8_000, "样本必须超过旧的 8000 上限");

	const messages = createProjector().convert(
		"agent",
		[
			{
				role: "assistant",
				timestamp: 10,
				content: [{ type: "toolCall", id: "write-big", name: "write", arguments: { path: "src/big.ts", content: bigContent } }],
			},
			{ role: "toolResult", toolCallId: "write-big", content: [{ type: "text", text: "ok" }], timestamp: 20 },
		],
		["entry-big-call", "entry-big-result"],
	);

	const toolMessage = messages[0];
	// 1) 投影出来的 args 必须是合法 JSON（截断回归的直接判据）
	const parsed = JSON.parse(toolMessage.meta.args);
	assert.equal(parsed.path, "src/big.ts");
	assert.equal(parsed.content, bigContent, "文件类工具的参数不得被截断");

	// 2) 渲染层解析函数必须能取到文件路径（用户可见行为的判据）
	const { getToolDiffTarget } = loadTsCommonJs("src/shared/fileChanges.ts");
	assert.equal(getToolDiffTarget(toolMessage)?.path, "src/big.ts");
});

test("non-file tools still truncate their args at the 8000 bound", () => {
	const hugeCommand = "echo " + "x".repeat(9_000);
	const messages = createProjector().convert(
		"agent",
		[
			{
				role: "assistant",
				timestamp: 10,
				content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: hugeCommand } }],
			},
			{ role: "toolResult", toolCallId: "bash-1", content: [{ type: "text", text: "done" }], timestamp: 20 },
		],
		["entry-bash-call", "entry-bash-result"],
	);
	// 输出型工具的 args 只是命令行，截断不影响功能，仍应受 8000 约束
	assert.ok(messages[0].meta.args.length < 8_100, "非文件类工具的 args 仍应截断");
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

test("assistant usage and durationMs reach meta for the trajectory ledger", () => {
	// pi 的 assistant 消息落盘时带 usage（含缓存/推理/费用）与 durationMs
	// （timestamp = 请求开始）。轨迹账本的 token 列与真实区间全靠这两个字段。
	const messages = createProjector().convert("agent", [
		{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1_000 },
		{
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			timestamp: 1_500,
			durationMs: 4_200,
			provider: "openai",
			model: "gpt-4.1",
			stopReason: "stop",
			usage: {
				input: 960,
				output: 1_011,
				cacheRead: 119_040,
				cacheWrite: 0,
				reasoning: 917,
				totalTokens: 121_011,
				cost: { input: 0.001, output: 0.002, total: 0.003 },
			},
		},
	]);

	const assistant = messages.find((message) => message.role === "assistant");
	assert.equal(assistant?.meta?.durationMs, 4_200);
	assert.equal(assistant?.meta?.startedAt, 1_500);
	assert.equal(assistant?.meta?.usage?.inputTokens, 960);
	assert.equal(assistant?.meta?.usage?.outputTokens, 1_011);
	assert.equal(assistant?.meta?.usage?.cacheReadTokens, 119_040);
	assert.equal(assistant?.meta?.usage?.cacheWriteTokens, 0);
	assert.equal(assistant?.meta?.usage?.reasoningTokens, 917);
	assert.equal(assistant?.meta?.usage?.cost, 0.003);
});

test("assistant without usage/duration leaves the meta fields absent", () => {
	const messages = createProjector().convert("agent", [
		{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1_000 },
		{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1_500, stopReason: "stop" },
	]);
	const assistant = messages.find((message) => message.role === "assistant");
	assert.equal(assistant?.meta?.usage, undefined);
	assert.equal(assistant?.meta?.durationMs, undefined);
	assert.equal(assistant?.meta?.startedAt, undefined);
});
