import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const view = loadTsCommonJs("src/renderer/src/components/session/branch/branchTreeView.ts");

/** 造一个 `SessionBranchNode`：测试只关心 id/preview/role/children，其余字段给稳定默认值。 */
function node(id, options = {}) {
	return {
		id,
		parentId: options.parentId,
		entryType: options.entryType ?? "message",
		role: options.role ?? "assistant",
		preview: options.preview ?? `preview-${id}`,
		timestamp: "2026-10-08T00:00:00.000Z",
		children: options.children ?? [],
	};
}

/** 挂孩子并回填 parentId（真实 reader 会填，活动路径判定依赖它）。 */
function attach(parent, children) {
	parent.children = children;
	for (const child of children) child.parentId = parent.id;
}

function tree(roots, leafId) {
	return { roots, leafId };
}

/** 线性链：n0 → n1 → …，parentId 全部按链回填。 */
function chain(length, prefix = "n") {
	const nodes = Array.from({ length }, (_, index) => node(`${prefix}${index}`, { role: "assistant" }));
	for (let index = 0; index < length - 1; index += 1) attach(nodes[index], [nodes[index + 1]]);
	return nodes;
}

test("linear chain collapses into a single row whose label comes from the tail", () => {
	const nodes = chain(12);
	const rows = view.buildBranchRows(tree([nodes[0]], nodes[11].id), { collapsedIds: new Set(), expandedRuns: new Set() });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].depth, 0);
	assert.equal(rows[0].steps, 11);
	assert.equal(rows[0].tail.id, "n11");
	// 行文案取末节点（信息量最大），fork 落点仍是段首
	assert.equal(rows[0].node.id, "n0");
	assert.equal(rows[0].isLeaf, true);
	assert.equal(view.rowHasDisclosure(rows[0]), true);
});

test("indentation grows only at branch points so long chains never push content off-screen", () => {
	// root(分支点,3 孩子) → 每个孩子各自带一条长线性链
	const altA = chain(6, "a");
	const altB = chain(6, "b");
	const altC = chain(6, "c");
	const root = node("root", { role: "user" });
	attach(root, [altA[0], altB[0], altC[0]]);
	const rows = view.buildBranchRows(tree([root], altB[5].id), { collapsedIds: new Set(), expandedRuns: new Set() });
	const byId = new Map(rows.map((row) => [row.node.id, row]));
	// root 自身深度 0，三个备选都在深度 1（只有分支点的孩子加一级）
	assert.equal(byId.get("root").depth, 0);
	assert.equal(byId.get("a0").depth, 1);
	assert.equal(byId.get("b0").depth, 1);
	assert.equal(byId.get("c0").depth, 1);
	// 线性链的其余节点与段首同深度（不再逐级右移）
	assert.equal(byId.get("b0").steps, 5);
	assert.deepEqual(
		Array.from(rows, (row) => row.node.id),
		["root", "a0", "b0", "c0"],
	);
	assert.equal(view.indentUnits(99), view.MAX_INDENT_DEPTH);
});

test("anchor nodes stay visible as their own row even when they lead a chain", () => {
	const user = node("u1", { role: "user" });
	const assistant = node("a1", { role: "assistant" });
	attach(assistant, [user]);
	const compaction = node("c1", { entryType: "compaction" });
	attach(compaction, [assistant]);
	const rows = view.buildBranchRows(tree([compaction], user.id), { collapsedIds: new Set(), expandedRuns: new Set() });
	assert.deepEqual(
		Array.from(rows, (row) => [row.node.id, row.steps]),
		[
			["c1", 0],
			["a1", 0],
			["u1", 0],
		],
	);
});

test("expanding a run reveals the whole folded segment in one click", () => {
	const nodes = chain(4);
	const runIds = view.collectRunIds(nodes[0], new Set());
	assert.deepEqual(Array.from(runIds), ["n0", "n1", "n2", "n3"]);
	const expandedRows = view.buildBranchRows(tree([nodes[0]], nodes[3].id), { collapsedIds: new Set(), expandedRuns: new Set(runIds) });
	assert.deepEqual(
		Array.from(expandedRows, (row) => row.node.id),
		["n0", "n1", "n2", "n3"],
	);
	for (const row of expandedRows) assert.equal(row.steps, 0);
});

test("collapsed subtrees hide their descendants but keep the alternative row visible", () => {
	const aUser = node("au", { role: "user" });
	attach(aUser, [node("a2")]);
	const bUser = node("bu", { role: "user" });
	attach(bUser, [node("b2")]);
	const root = node("root", { role: "user" });
	attach(root, [aUser, bUser]);
	const branch = tree([root], "b2");
	const rows = view.buildBranchRows(branch, { collapsedIds: new Set(["au"]), expandedRuns: new Set() });
	// 收起的子树后代不出现，但备选行本身保留（否则用户不知道这里还有一条分支）
	assert.deepEqual(
		Array.from(rows, (row) => row.node.id),
		["root", "au", "bu", "b2"],
	);
	const aRow = rows.find((row) => row.node.id === "au");
	assert.equal(aRow.collapsed, true);
	assert.equal(view.rowHasDisclosure(aRow), true);
	// 展开后后代回来
	const expandedRows = view.buildBranchRows(branch, { collapsedIds: new Set(), expandedRuns: new Set() });
	assert.ok(expandedRows.some((row) => row.node.id === "a2"));
});

test("default collapse set keeps the active path open and folds abandoned branch points", () => {
	const altA = chain(2, "a");
	const altB = chain(2, "b");
	const root = node("root", { role: "user" });
	attach(root, [altA[0], altB[0]]);
	const activeIds = view.collectActiveIds(tree([root], altB[1].id));
	assert.deepEqual(Array.from(activeIds).sort(), ["b0", "b1", "root"]);
	const collapsed = view.defaultCollapsedIds(tree([root], altB[1].id), activeIds);
	// 非活动分支点（a0 下还有 a1）默认收起；root 在活动路径上不收起
	assert.equal(collapsed.has("a0"), true);
	assert.equal(collapsed.has("root"), false);
});

test("pass-through nodes without preview and a single child are compacted away", () => {
	const real = node("real", { preview: "hello" });
	const wrapper = node("w1", { entryType: "custom", preview: "" });
	attach(wrapper, [real]);
	const prepared = view.prepareTree(tree([wrapper], "real"));
	assert.equal(prepared.tree.roots[0].id, "real");
	assert.equal(prepared.nodeCount, 1);
	assert.equal(prepared.tree.roots[0].parentId, undefined);
});

test("prepareTree counts nodes and resolves the active leaf through the orphan-safe walk", () => {
	const nodes = chain(3);
	const prepared = view.prepareTree(tree([nodes[0]], nodes[2].id));
	assert.equal(prepared.nodeCount, 3);
	assert.equal(prepared.activeIds.has("n2"), true);
	// leafId 指向不存在的节点：不抛错，活动集为空（只读面板不因脏数据炸掉）
	const orphan = view.prepareTree(tree([nodes[0]], "missing"));
	assert.equal(orphan.activeIds.size, 0);
});

test("expand-all marks every node id so no run stays folded", () => {
	const nodes = chain(5);
	const all = view.collectAllIds(tree([nodes[0]], nodes[4].id));
	assert.equal(all.length, 5);
	const rows = view.buildBranchRows(tree([nodes[0]], nodes[4].id), { collapsedIds: new Set(), expandedRuns: new Set(all) });
	assert.deepEqual(
		Array.from(rows, (row) => row.depth),
		[0, 0, 0, 0, 0],
	);
});

test("rows carry the visual parent so keyboard left-arrow can walk back up", () => {
	const altA = chain(3, "a");
	const altB = chain(3, "b");
	const root = node("root", { role: "user" });
	attach(root, [altA[0], altB[0]]);
	const rows = view.buildBranchRows(tree([root], altB[2].id), { collapsedIds: new Set(), expandedRuns: new Set() });
	const byId = new Map(rows.map((row) => [row.node.id, row]));
	assert.equal(byId.get("root").parentRowId, undefined);
	// 分支点的两个孩子挂到父行；线性链其余节点挂到同一行（段首）
	assert.equal(byId.get("a0").parentRowId, "root");
	assert.equal(byId.get("b0").parentRowId, "root");
});

test("keyboard focus movement walks the visible row sequence", () => {
	const nodes = chain(4);
	const rows = view.buildBranchRows(tree([nodes[0]], nodes[3].id), { collapsedIds: new Set(), expandedRuns: new Set() });
	const only = rows[0].node.id;
	// 折叠成一行时上下移动原地不动（只有一行）
	assert.equal(view.moveRowFocus(rows, only, "ArrowDown"), only);
	assert.equal(view.moveRowFocus(rows, only, "ArrowUp"), only);
	const expanded = view.collectRunIds(nodes[0], new Set());
	const allRows = view.buildBranchRows(tree([nodes[0]], nodes[3].id), { collapsedIds: new Set(), expandedRuns: new Set(expanded) });
	assert.equal(view.moveRowFocus(allRows, "n0", "ArrowDown"), "n1");
	assert.equal(view.moveRowFocus(allRows, "n1", "ArrowUp"), "n0");
	// 边界不越位
	assert.equal(view.moveRowFocus(allRows, "n0", "ArrowUp"), "n0");
	assert.equal(view.moveRowFocus(allRows, "n3", "ArrowDown"), "n3");
	assert.equal(view.moveRowFocus(allRows, "n2", "Home"), "n0");
	assert.equal(view.moveRowFocus(allRows, "n1", "End"), "n3");
	// 焦点行已消失（收起后）→ 落到首行，不抛错
	assert.equal(view.moveRowFocus(allRows, "gone", "ArrowDown"), "n0");
});

test("right-arrow descends into the first child row only, not into siblings", () => {
	const altA = chain(2, "a");
	const altB = chain(2, "b");
	const root = node("root", { role: "user" });
	attach(root, [altA[0], altB[0]]);
	const rows = view.buildBranchRows(tree([root], altB[1].id), { collapsedIds: new Set(), expandedRuns: new Set() });
	assert.equal(view.childRowId(rows, "root"), "a0");
	// a0 行下面紧跟的是兄弟 b0（parentRowId 不是 a0）→ 不是子行
	assert.equal(view.childRowId(rows, "a0"), undefined);
	assert.equal(view.childRowId(rows, "missing"), undefined);
});
