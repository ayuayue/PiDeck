import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { serialize } from "node:v8";
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

test("readBranchTree returns a flat node table with ordered parents and previews", async (t) => {
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
	// 扁平投递：按文件追加顺序，children 不进 wire（#553 的 IPC 序列化上限）。
	assert.deepEqual(
		Array.from(tree.nodes, (node) => node.id),
		["session", "u1", "a1", "u2b", "u2", "a2", "c1"],
	);
	for (const node of tree.nodes) assert.equal(Object.hasOwn(node, "children"), false, "wire 里不能有递归结构");
	const byId = new Map(Array.from(tree.nodes, (node) => [node.id, node]));
	assert.equal(byId.get("u2b").parentId, "a1");
	assert.equal(byId.get("u2").parentId, "a1");
	assert.equal(byId.get("u1").role, "user");
	assert.ok(byId.get("u1").preview.startsWith("问一个长问题"));
	assert.equal(byId.get("u1").preview.length, 120, "超长预览截断");
	assert.equal(byId.get("u2b").preview, "被放弃的另一种问法", "被放弃分支仍在表里（fork 后悔药的核心价值）");
	assert.equal(byId.get("c1").entryType, "compaction");
	assert.equal(byId.get("c1").label, "压缩摘要");
	assert.equal(byId.get("c1").preview, "压缩摘要", "压缩点无正文时用索引 summary 做预览");

	// 渲染层重组：兄弟顺序与父链都和原始追加顺序一致。
	const { hydrateBranchTree } = loadTsCommonJs("src/renderer/src/components/session/branch/branchTreeView.ts");
	const hydrated = hydrateBranchTree(tree);
	assert.deepEqual(
		Array.from(hydrated.roots, (node) => node.id),
		["session"],
	);
	const a1 = hydrated.roots[0].children[0].children[0];
	assert.deepEqual(
		Array.from(a1.children, (node) => node.id),
		["u2b", "u2"],
		"兄弟节点按文件追加顺序排列",
	);
	assert.equal(a1.children[1].children[0].id, "a2");
});

test("orphan entries stay in the flat table and become roots after hydration", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-branch-orphan-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sessionPath = join(directory, "session.jsonl");
	const rows = [messageRow("u1", "session", "user", "问题一"), messageRow("orphan", "missing-parent", "user", "孤儿条目")];
	await writeFile(sessionPath, rows.join("\n") + "\n", "utf8");
	const tree = await createReader().readBranchTree(sessionPath);
	assert.deepEqual(
		Array.from(tree.nodes, (node) => node.id),
		["u1", "orphan"],
	);
	// 父链断裂的条目按 get_tree 同语义提升为根（重组在渲染层做，主进程不再建树）。
	const { hydrateBranchTree } = loadTsCommonJs("src/renderer/src/components/session/branch/branchTreeView.ts");
	assert.deepEqual(Array.from(hydrateBranchTree(tree).roots, (node) => node.id).sort(), ["orphan", "u1"]);
});

test("a 2000+ deep degenerate chain still crosses the IPC boundary (#553)", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-branch-deep-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sessionPath = join(directory, "session.jsonl");
	const depth = 2100;
	const rows = [JSON.stringify({ id: "e0", type: "session" })];
	for (let i = 1; i < depth; i += 1) rows.push(messageRow(`e${i}`, `e${i - 1}`, i % 2 === 1 ? "user" : "assistant", `step ${i}`));
	await writeFile(sessionPath, rows.join("\n") + "\n", "utf8");

	const tree = await createReader().readBranchTree(sessionPath);
	assert.equal(tree.nodes.length, depth);
	// 判据就是这条：嵌套树在 2467 层时 v8.serialize 栈溢出，扁平表必须能过。
	assert.doesNotThrow(() => serialize(tree));
	// 渲染层重组用普通递归/循环，2100 层可承受。
	const { hydrateBranchTree, buildBranchRows } = loadTsCommonJs("src/renderer/src/components/session/branch/branchTreeView.ts");
	const hydrated = hydrateBranchTree(tree);
	assert.equal(hydrated.roots.length, 1);
	const rowsView = buildBranchRows(hydrated, { collapsedIds: new Set(), expandedRuns: new Set() });
	assert.ok(rowsView.length > 0, "深链也要折出可见行（缩进封顶，不会横向爆掉）");
	assert.ok(
		rowsView.every((row) => row.depth <= 6),
		"缩进按 MAX_INDENT_DEPTH 封顶",
	);
});
