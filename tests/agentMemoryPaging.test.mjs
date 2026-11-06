import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/**
 * 记忆条目分页（设置页「记忆」tab）。
 *
 * 列表是单一时间线：不再插分组行（同一组被别组隔开时会反复冒出同样的表头），
 * 每行带着自己的 group，作用域由行首徽标区分。这里守的是：
 *   1. 排序先于分页，换页不改变条目顺序，每行都能取到所属作用域；
 *   2. 越界页码夹到首/尾页——删掉最后一页的最后一条后不能停在空白页。
 */

const { MEMORY_PAGE_SIZE, buildMemoryPageEntries, flattenMemoryRows, memoryEntryId, memoryTotalPages } = loadTsCommonJs("src/renderer/src/components/app/settings/agentMemoryPaging.ts");

function entry(target, index) {
	return { index, target, scope: "global", projectId: "", projectName: "", key: `k${target}${index}`, exportId: `e${target}${index}`, content: `条目 ${index}`, chars: 4, category: "" };
}

function group(target, count, extra = {}) {
	const entries = Array.from({ length: count }, (_, i) => entry(target, i + 1));
	return {
		target,
		scope: "global",
		projectId: "",
		projectName: "",
		file: target === "failure" ? "failures.md" : "MEMORY.md",
		bytes: 100,
		budget: { maxChars: 32000, maxEntries: 400 },
		chars: 100,
		overBudget: false,
		entries,
		...extra,
	};
}

const shape = (rows) => Array.from(rows, (row) => row.entry.content);
const rowShape = (rows) => Array.from(rows, (row) => (row.kind === "group" ? `group:${row.group.target}` : `entry:${row.entry.content}`));

test("单组跨页：无时间时按文件序号倒序，每页只装条目", () => {
	const groups = [group("memory", 30)];
	const first = buildMemoryPageEntries(groups, 1);
	assert.equal(first.length, MEMORY_PAGE_SIZE);
	assert.equal(first[0].entry.content, "条目 30");
	assert.equal(first[0].group.target, "memory");
	assert.equal(first.at(-1).entry.content, "条目 11");

	const second = buildMemoryPageEntries(groups, 2);
	assert.deepEqual(shape(second).slice(0, 1), ["条目 10"]);
	assert.equal(second.length, 10);
	assert.equal(second.at(-1).entry.index, 1);
});

test("跨组换页：条目顺序稳定，且每行带自己的作用域", () => {
	// 无时间的组仍保持作用域顺序，各组内倒序；第二页开头是 failure 组。
	const groups = [group("memory", 5), group("failure", 20)];
	const first = buildMemoryPageEntries(groups, 1);
	assert.deepEqual(shape(first).slice(0, 2), ["条目 5", "条目 4"]);
	assert.equal(first.length, MEMORY_PAGE_SIZE);
	assert.equal(first[5].group.target, "failure", "memory 组的 5 条之后接 failure 组");

	const second = buildMemoryPageEntries(groups, 2);
	assert.deepEqual(shape(second), ["条目 5", "条目 4", "条目 3", "条目 2", "条目 1"]);
	assert.ok(second.every((row) => row.group.target === "failure"));
});

test("越界页码夹到首尾页，空列表返回空行", () => {
	const groups = [group("memory", 25)];
	assert.deepEqual(shape(buildMemoryPageEntries(groups, 99)).slice(0, 2), ["条目 5", "条目 4"]);
	assert.deepEqual(shape(buildMemoryPageEntries(groups, 0)).slice(0, 2), ["条目 25", "条目 24"]);
	assert.deepEqual(Array.from(buildMemoryPageEntries([], 1)), []);
	assert.equal(memoryTotalPages(0), 1);
	assert.equal(memoryTotalPages(25), 2);
	assert.equal(memoryTotalPages(40), 2);
	assert.equal(memoryTotalPages(41), 3);
});

test("跨作用域按记录时间整体倒序，分页前完成排序，key 唯一且每行带 group", () => {
	const global = group("memory", 3);
	global.entries = global.entries.map((item, index) => ({ ...item, updatedAt: `2026-0${index * 2 + 1}-01T00:00:00.000Z` }));
	const project = group("memory", 2, { scope: "project", projectId: "alpha" });
	project.entries = project.entries.map((item, index) => ({ ...item, scope: "project", projectId: "alpha", updatedAt: `2026-0${index * 2 + 2}-01T00:00:00.000Z` }));
	const groups = [global, project];
	const before = JSON.stringify(groups);
	const ids = (rows) => Array.from(rows, (row) => `${row.entry.scope}:${row.entry.index}`);
	const all = buildMemoryPageEntries(groups, 1, 5);
	assert.deepEqual(ids(all), ["global:3", "project:2", "global:2", "project:1", "global:1"]);
	assert.equal(new Set(all.map((row) => row.key)).size, all.length, "跨作用域混排时条目 key 不能冲突");
	assert.equal(all[0].group.scope, "global");
	assert.equal(all[1].group.projectId, "alpha", "项目条目要能取到自己的作用域信息");
	assert.deepEqual(ids(buildMemoryPageEntries(groups, 1, 2)), ["global:3", "project:2"]);
	assert.deepEqual(ids(buildMemoryPageEntries(groups, 2, 2)), ["global:2", "project:1"]);
	assert.deepEqual(ids(buildMemoryPageEntries(groups, 3, 2)), ["global:1"]);
	assert.equal(JSON.stringify(groups), before, "显示排序不能改变条目序号或原始数据");
});

test("相同记录时间按文件序号倒序，缺失或无效时间在后且不伪造时间", () => {
	const data = group("memory", 5);
	data.entries[0].updatedAt = "2026-03-01T00:00:00.000Z";
	data.entries[1].updatedAt = "2026-03-01T00:00:00.000Z";
	data.entries[2].updatedAt = "invalid";
	data.entries[4].updatedAt = "2026-01-01T00:00:00.000Z";
	const rows = buildMemoryPageEntries([data], 1);
	assert.deepEqual(
		Array.from(rows, (row) => row.entry.index),
		[2, 1, 5, 4, 3],
	);
	assert.equal(data.entries[3].updatedAt, undefined);
});

test("条目 id 带作用域：同内容在全局与项目里是两条", () => {
	const base = entry("memory", 1);
	const project = { ...base, scope: "project", projectId: "proj-a" };
	assert.notEqual(memoryEntryId(base), memoryEntryId(project));
	assert.ok(memoryEntryId(base).includes("global"));
});

test("展平：分组行 + 条目行按序输出，行 key 唯一，且不切片（虚拟滚动自己收敛 DOM）", () => {
	const groups = [group("memory", 3), group("failure", 2)];
	const rows = flattenMemoryRows(groups);
	assert.deepEqual(rowShape(rows), ["group:memory", "entry:条目 1", "entry:条目 2", "entry:条目 3", "group:failure", "entry:条目 1", "entry:条目 2"]);
	assert.equal(new Set(rows.map((row) => row.key)).size, rows.length, "行 key 必须唯一：虚拟器按 key 缓存测量与 ref 回调");

	const many = flattenMemoryRows([group("memory", 200)]);
	assert.equal(many.length, 201, "导出/导入弹窗要能一路滚到底：这里不做分页切片");
	assert.equal(many[0].kind, "group");
});

test("展平：空组不出表头（与分页口径一致）", () => {
	assert.deepEqual(Array.from(flattenMemoryRows([group("memory", 0)])), []);
});

const textOf = (node) => (Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? ""));

function walk(node, predicate) {
	if (Array.isArray(node)) return node.flatMap((child) => walk(child, predicate));
	if (!node || typeof node !== "object") return [];
	return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)];
}

test("列表默认新条目在前，换页与搜索仍保持倒序", async (t) => {
	const data = group("memory", 25);
	data.entries = data.entries.map((item) => ({ ...item, content: `${item.index % 2 ? "匹配" : "其他"} ${item.index}`, updatedAt: `2026-01-${String(item.index).padStart(2, "0")}T00:00:00.000Z` }));
	const host = quickMessageHookHost();
	const { AgentMemoryEntryList } = loadTsCommonJs("src/renderer/src/components/app/settings/AgentMemoryEntryList.tsx", {
		stubs: {
			react: host.react,
			"../../../desktopApi": { desktopApi: { agentMemory: { list: async () => ({ ok: true, value: { root: "/memory", total: 25, groups: [data] } }) } } },
			"../../ui-shadcn/badge": { Badge: "badge" },
			"../../ui-shadcn/button": { Button: "button" },
			"../../ui-shadcn/input": { Input: "input" },
			"../../ui-shadcn/table": { Table: "table", TableBody: "tbody", TableCell: "td", TableHead: "th", TableHeader: "thead", TableRow: "tr" },
			"../../ui-shadcn/pagination": { Pagination: "pagination" },
			"../../ui-shadcn/tabs": { Tabs: "tabs", TabsContent: "tabs-content", TabsList: "tabs-list", TabsTrigger: "tabs-trigger" },
			"../../ui-shadcn/ConfirmDialog": { ConfirmDialog: "confirm-dialog" },
		},
	});
	t.after(() => host.unmount());
	const render = () => host.render(() => AgentMemoryEntryList({}));
	const contents = (tree) => walk(tree, (node) => node.type === "button" && node.props["aria-expanded"] !== undefined).map((node) => node.props.children.at(-1).props.children);
	render();
	await new Promise(setImmediate);
	let tree = render();
	assert.deepEqual(
		contents(tree),
		data.entries
			.slice()
			.reverse()
			.slice(0, MEMORY_PAGE_SIZE)
			.map((item) => item.content),
	);
	// 列表不再插分组行：作用域靠每行徽标区分，而不是整页里重复的表头。
	assert.equal(walk(tree, (node) => node.props?.colSpan !== undefined).length, 0, "no group rows in a flat timeline");
	assert.deepEqual(
		walk(tree, (node) => node.type === "badge").map(textOf),
		Array.from({ length: MEMORY_PAGE_SIZE }, () => "全局"),
	);
	walk(tree, (node) => node.type === "pagination")[0].props.onPageChange(2);
	tree = render();
	assert.deepEqual(contents(tree), ["匹配 5", "其他 4", "匹配 3", "其他 2", "匹配 1"]);
	walk(tree, (node) => node.type === "input")[0].props.onChange({ target: { value: "匹配" } });
	tree = render();
	assert.deepEqual(
		contents(tree),
		data.entries
			.filter((item) => item.index % 2)
			.reverse()
			.map((item) => item.content),
		"过滤后仍要先排序再分页",
	);
});

test("批量删除：勾选后只发一次 IPC，删除清单只带定位键，删完给撤销", async (t) => {
	const data = group("memory", 25);
	const calls = [];
	const host = quickMessageHookHost();
	const { AgentMemoryEntryList } = loadTsCommonJs("src/renderer/src/components/app/settings/AgentMemoryEntryList.tsx", {
		stubs: {
			react: host.react,
			"../../../desktopApi": {
				desktopApi: {
					agentMemory: {
						list: async () => ({ ok: true, value: { root: "/memory", total: 25, groups: [data] } }),
						deleteEntries: async (items) => {
							calls.push(items);
							return { ok: true, value: { removed: items.length, missing: 0 } };
						},
					},
				},
			},
			"../../ui-shadcn/badge": { Badge: "badge" },
			"../../ui-shadcn/button": { Button: "button" },
			"../../ui-shadcn/checkbox": { Checkbox: "checkbox" },
			"../../ui-shadcn/input": { Input: "input" },
			"../../ui-shadcn/table": { Table: "table", TableBody: "tbody", TableCell: "td", TableHead: "th", TableHeader: "thead", TableRow: "tr" },
			"../../ui-shadcn/pagination": { Pagination: "pagination" },
			"../../ui-shadcn/tabs": { Tabs: "tabs", TabsContent: "tabs-content", TabsList: "tabs-list", TabsTrigger: "tabs-trigger" },
			"../../ui-shadcn/ConfirmDialog": { ConfirmDialog: "confirm-dialog" },
		},
	});
	t.after(() => host.unmount());
	const render = () => host.render(() => AgentMemoryEntryList({}));
	render();
	await new Promise(setImmediate);
	let tree = render();

	// 进入批量模式：工具栏那个带 aria-pressed 的图标按钮（批量删除与刷新并排）。
	const toggle = walk(tree, (node) => node.type === "button" && node.props["aria-pressed"] !== undefined);
	assert.equal(toggle.length, 1, "工具栏只应有一个可切换选中态的按钮");
	toggle[0].props.onClick();
	tree = render();
	let boxes = walk(tree, (node) => node.type === "checkbox");
	assert.equal(boxes.length, MEMORY_PAGE_SIZE + 1, "批量模式：表头全选 + 每行一个勾选框");

	// 本页可见的是第 25..6 条（倒序），勾前两条。
	boxes[1].props.onCheckedChange();
	boxes[2].props.onCheckedChange();
	tree = render();
	assert.ok(textOf(tree).includes("已选 2 条"), "选择栏要给出跨页累计的选中数");

	// 删除要过一次确认弹框，确认后才发 IPC。
	assert.equal(walk(tree, (node) => node.props?.onConfirm !== undefined && node.type === "confirm-dialog").length, 0, "没点删除前不应弹确认框");
	walk(tree, (node) => node.type === "button" && node.props.variant === "destructive")[0].props.onClick();
	tree = render();
	const confirm = walk(tree, (node) => node.type === "confirm-dialog" && node.props?.onConfirm !== undefined);
	assert.equal(confirm.length, 1, "删除所选项要弹确认框");
	assert.ok(confirm[0].props.message.includes("要删除 2 条记忆"));
	confirm[0].props.onConfirm();
	await new Promise(setImmediate);
	await new Promise(setImmediate);
	tree = render();

	assert.equal(calls.length, 1, "一批勾选只发一次 IPC（主进程按文件分组落盘）");
	// 沙箱（vm）里创建的对象跨 realm，strict 的 deepEqual 会因原型不同而失败，这里只比结构。
	assert.deepEqual(
		JSON.parse(JSON.stringify(calls[0])),
		[
			{ target: "memory", projectId: "", key: "kmemory25" },
			{ target: "memory", projectId: "", key: "kmemory24" },
		],
		"删除清单只带定位键，任何文件路径都不从渲染层传下去",
	);
	boxes = walk(tree, (node) => node.type === "checkbox");
	assert.equal(boxes.length, 0, "删完退出批量模式");
	assert.ok(textOf(tree).includes("已删除 2 条记忆"), "批量删除同样给撤销条");
});
