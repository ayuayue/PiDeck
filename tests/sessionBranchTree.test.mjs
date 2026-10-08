import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionHistoryReader, extractMessagePreviewFromLine } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

function createReader() {
	return new SessionHistoryReader({
		toHostPath: (sessionPath) => sessionPath,
		convertMessages: (_agentId, rawMessages, entryIds = []) =>
			rawMessages.map((message, index) => ({
				id: entryIds[index] ?? `message-${index}`,
				role: message.role,
				text: typeof message.content === "string" ? message.content : (message.content?.[0]?.text ?? ""),
			})),
		trimMessages: (messages) => messages,
		translate: () => "Summary unavailable.",
	});
}

function messageRow(id, parentId, role, text) {
	return JSON.stringify({ id, parentId, type: "message", message: { role, content: [{ type: "text", text }] } });
}

/** 分支树必须复用 JSONL 显示索引而不是 get_tree RPC：整树单行 JSON.parse 会冻窗（同 get_messages 禁用原因）。 */
test("readBranchTree never issues a get_tree RPC request", () => {
	const source = readFileSync("src/main/pi/SessionHistoryReader.ts", "utf8");
	assert.doesNotMatch(source, /client\.request\(\{\s*type:\s*"get_tree"/);
	const start = source.indexOf("async readBranchTree");
	const branchTree = source.slice(start, source.indexOf("\n\t}", start));
	assert.match(branchTree, /getSessionDisplayIndex/);
});

test("extractMessagePreviewFromLine handles content shapes and caps length", () => {
	assert.equal(extractMessagePreviewFromLine(JSON.stringify({ id: "a", type: "message", message: { role: "user", content: "hello world" } })), "hello world");
	assert.equal(
		extractMessagePreviewFromLine(
			JSON.stringify({
				id: "b",
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "  first\n\nblock  " },
						{ type: "text", text: "second" },
					],
				},
			}),
		),
		"first block",
	);
	// 非 message / 非法 JSON / 空行都返回空串，节点降级为类型名显示。
	assert.equal(extractMessagePreviewFromLine(JSON.stringify({ id: "c", type: "usage" })), "");
	assert.equal(extractMessagePreviewFromLine("{not json"), "");
	assert.equal(extractMessagePreviewFromLine(""), "");
	const long = "x".repeat(400);
	assert.equal(extractMessagePreviewFromLine(JSON.stringify({ message: { content: long } })).length, 120);
});

test("readBranchTree returns ordered children, active path leaf and previews", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-branch-tree-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sessionPath = join(directory, "session.jsonl");
	// 树形：u1 → a1 → { u2b（被放弃分支）, u2 → a2（活动）}；compaction 挂在 a2 后。
	// JSONL 最后一行是 pi 当前叶节点 → 活动 leaf = compaction 行（沿 parentId 回溯含 a2 分支）。
	const rows = [
		JSON.stringify({ id: "session", type: "session" }),
		messageRow("u1", "session", "user", "问一个长问题".repeat(30)),
		messageRow("a1", "u1", "assistant", "第一回答"),
		messageRow("u2b", "a1", "user", "被放弃的另一种问法"),
		messageRow("u2", "a1", "user", "第二种问法"),
		messageRow("a2", "u2", "assistant", "第二回答"),
		JSON.stringify({ id: "c1", parentId: "a2", type: "compaction", summary: "压缩摘要" }),
	];
	await writeFile(sessionPath, rows.join("\n") + "\n", "utf8");

	const tree = await createReader().readBranchTree(sessionPath);
	assert.equal(tree.leafId, "c1");
	// 主进程返回原始树：session 头是根，纯中转节点（无预览、单孩子）由渲染层 compactPassThrough 折叠。
	assert.equal(tree.roots.length, 1);
	assert.equal(tree.roots[0].id, "session");
	const u1 = tree.roots[0].children[0];
	assert.equal(u1.id, "u1");
	assert.equal(u1.role, "user");
	assert.ok(u1.preview.startsWith("问一个长问题"));
	assert.equal(u1.preview.length, 120, "超长预览截断");
	const a1 = u1.children[0];
	assert.equal(a1.role, "assistant");
	assert.deepEqual(
		[...a1.children].map((child) => child.id),
		["u2b", "u2"],
		"兄弟节点按文件追加顺序排列",
	);
	// 被放弃分支仍在树里（fork 后悔药的核心价值）。
	assert.equal(a1.children[0].preview, "被放弃的另一种问法");
	const a2 = a1.children[1].children[0];
	assert.equal(a2.id, "a2");
	const compaction = a2.children[0];
	assert.equal(compaction.entryType, "compaction");
	assert.equal(compaction.label, "压缩摘要");
	assert.equal(compaction.preview, "压缩摘要", "压缩点无正文时用索引 summary 做预览");
});

test("readBranchTree promotes orphan entries to roots (parent chain broken)", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-branch-orphan-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sessionPath = join(directory, "session.jsonl");
	const rows = [messageRow("u1", "session", "user", "问题一"), messageRow("orphan", "missing-parent", "user", "孤儿条目")];
	await writeFile(sessionPath, rows.join("\n") + "\n", "utf8");
	const tree = await createReader().readBranchTree(sessionPath);
	// 父链断裂的条目按 get_tree 同语义提升为根，不丢节点。
	assert.deepEqual([...tree.roots].map((root) => root.id).sort(), ["orphan", "u1"]);
});
