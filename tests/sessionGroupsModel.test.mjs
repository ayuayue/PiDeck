import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildSessionGroupNodes, collectGroupedSessionIds, isSessionGroupsPluginEnabled, projectDirectoryLabel, shouldHideGroupedSession } = loadTsCommonJs("src/renderer/src/components/sidebar/sessionGroupsModel.ts");

const RECORD = (id, projectId, updatedAt) => ({ id, projectId, title: id, updatedAt });
const PROJECT = (id, name, path) => ({ id, name, path });
const ids = (records) => [...Array.from(records).map((record) => record.id)];

test("分组引用解析成分组→会话两层列表；失效引用丢弃、重复 id 去重", () => {
	const nodes = buildSessionGroupNodes([{ id: "g1", name: "other", color: "blue", createdAt: 1, sessionIds: ["s1", "ghost", "s1", "s2"], dirs: [] }], { s1: RECORD("s1", "p1", 100), s2: RECORD("s2", "p2", 200) }, { p1: PROJECT("p1", "Alpha", "D:\\alpha"), p2: PROJECT("p2", "Beta", "D:\\beta") });
	assert.equal(nodes.length, 1);
	assert.equal(nodes[0].total, 2);
	// 不再有目录（项目）这一层：分组下直接是会话。
	assert.equal(nodes[0].dirs, undefined);
	assert.deepEqual(ids(nodes[0].sessions), ["s2", "s1"]);
	// 跨项目分组才需要行内标项目名。
	assert.equal(nodes[0].projectCount, 2);
});

test("组内会话按 updatedAt 降序（跨项目混排）；组顺序 = groups 原序（用户拖拽顺序）", () => {
	const nodes = buildSessionGroupNodes(
		[
			{ id: "b", name: "B", color: "red", createdAt: 1, sessionIds: ["s1", "s2", "s3"], dirs: [] },
			{ id: "a", name: "A", color: "blue", createdAt: 2, sessionIds: [], dirs: [] },
		],
		{ s1: RECORD("s1", "p1", 1), s2: RECORD("s2", "p1", 30), s3: RECORD("s3", "p2", 10) },
		{ p1: PROJECT("p1", "P", "D:\\p"), p2: PROJECT("p2", "Q", "D:\\q") },
	);
	assert.deepEqual(ids(nodes[0].sessions), ["s2", "s3", "s1"]);
	assert.deepEqual([...Array.from(nodes.map((node) => node.group.id))], ["b", "a"]);
	// 空分组仍需保留节点（侧栏显示「组内没有可用会话」而不是整组消失）。
	assert.equal(nodes[1].total, 0);
	assert.equal(nodes[1].projectCount, 0);
});

test("项目缺失（已移除）与 noSession 虚拟会话都不进树", () => {
	const nodes = buildSessionGroupNodes([{ id: "g", name: "G", color: "cyan", createdAt: 1, sessionIds: ["s1", "s2"], dirs: [] }], { s1: RECORD("s1", "gone", 1), s2: { ...RECORD("s2", "p1", 2), noSession: true } }, {});
	assert.equal(nodes[0].total, 0);
	assert.equal(nodes[0].sessions.length, 0);
	const label = projectDirectoryLabel(undefined, "gone");
	assert.equal(label.name, "gone");
	assert.equal(label.path, undefined);
});

test("分组按栏目拆：聊天只列 Chat 会话、项目只列工作区会话，裁剪后空组不出现", () => {
	const groups = [
		{ id: "mixed", name: "混合", color: "blue", createdAt: 1, sessionIds: ["sChat", "sProj"], dirs: [] },
		{ id: "chatOnly", name: "只有聊天", color: "green", createdAt: 2, sessionIds: ["sChat"], dirs: [] },
	];
	const records = { sChat: RECORD("sChat", "pc", 10), sProj: RECORD("sProj", "p1", 20) };
	const projects = { pc: { ...PROJECT("pc", "Chat", "chat://"), kind: "chat" }, p1: PROJECT("p1", "P", "D:\\p") };

	const chat = buildSessionGroupNodes(groups, records, projects, "chat");
	// 组顺序仍按用户拖拽顺序，只换会话集合。
	assert.deepEqual(
		chat.map((node) => node.group.id),
		["mixed", "chatOnly"],
	);
	assert.deepEqual(ids(chat[0].sessions), ["sChat"]);
	assert.equal(chat[0].total, 1);
	// 聊天栏目恒为单项目：行内不再重复标「Chat」项目名。
	assert.equal(chat[0].projectCount, 1);

	const proj = buildSessionGroupNodes(groups, records, projects, "project");
	// chatOnly 在项目栏目一个会话都不剩 → 整组不出现（不留「组内没有可用会话」）。
	assert.deepEqual(
		proj.map((node) => node.group.id),
		["mixed"],
	);
	assert.deepEqual(ids(proj[0].sessions), ["sProj"]);
	assert.equal(proj[0].projectCount, 1);

	// 不传 scope 维持全量（简洁壳侧栏 / 旧调用）：两组都在，会话与跨项目计数不变。
	const all = buildSessionGroupNodes(groups, records, projects);
	assert.deepEqual(
		all.map((node) => node.group.id),
		["mixed", "chatOnly"],
	);
	assert.deepEqual(ids(all[0].sessions), ["sProj", "sChat"]);
	assert.equal(all[0].projectCount, 2);
});

test("collectGroupedSessionIds：只收解析后仍存活的会话（未加载项目的会话不得隐藏）", () => {
	const nodes = buildSessionGroupNodes(
		[{ id: "g", name: "G", color: "blue", createdAt: 1, sessionIds: ["s1", "unloaded"], dirs: [] }],
		// unloaded 的 catalog 还没加载：没有记录 → 不出现在分组树里，也就不能从项目列表隐藏。
		{ s1: RECORD("s1", "p1", 1) },
		{ p1: PROJECT("p1", "P", "D:\\p") },
	);
	const grouped = collectGroupedSessionIds(nodes);
	assert.equal(grouped.has("s1"), true);
	assert.equal(grouped.has("unloaded"), false);
	assert.equal(grouped.size, 1);
});

test("shouldHideGroupedSession：未入组不隐藏；搜索词非空时两边都给", () => {
	const grouped = new Set(["s1"]);
	assert.equal(shouldHideGroupedSession("s1", grouped, ""), true);
	assert.equal(shouldHideGroupedSession("s1", grouped, "   "), true);
	// 搜索是找回入口：命中时项目列表也保留，否则越搜越找不到。
	assert.equal(shouldHideGroupedSession("s1", grouped, "重"), false);
	assert.equal(shouldHideGroupedSession("s2", grouped, ""), false);
	// 插件未启用 / 没有分组时 groupedSessionIds 为 undefined：什么都不隐藏。
	assert.equal(shouldHideGroupedSession("s1", undefined, ""), false);
});

test("分组插件未启用时侧栏不展示分组的会话", () => {
	const catalog = (plugins) => ({ directory: "", plugins, issues: [] });
	const plugin = (id, enabled) => ({ manifest: { id }, enabled });
	assert.equal(isSessionGroupsPluginEnabled(catalog([plugin("session-groups", true)])), true);
	// 停用 / 代码已变更待重授权（enabled=false）都不算开启。
	assert.equal(isSessionGroupsPluginEnabled(catalog([plugin("session-groups", false)])), false);
	assert.equal(isSessionGroupsPluginEnabled(catalog([plugin("billion-context", true)])), false);
	// catalog 尚未加载（undefined）按关闭处理：fail-closed，避免插件关掉后旧分组先闪一下。
	assert.equal(isSessionGroupsPluginEnabled(undefined), false);
});

test("projectDirectoryLabel：远端项目给远端路径", () => {
	const remote = { id: "r", name: "Remote", locator: { kind: "ssh", remotePath: "/srv/repo" }, path: undefined };
	const label = projectDirectoryLabel(remote, "r");
	assert.equal(label.name, "Remote");
	assert.equal(label.path, "/srv/repo");
});
