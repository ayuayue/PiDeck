/** 自动学习来源只跟踪本机新写入条目，测试使用假补全，不联网。 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as db from "../resources/agent-memory/db.mjs";
import { addMemory } from "../resources/agent-memory/tools.mjs";
import { exportEntryId } from "../resources/agent-memory/sync.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const stubs = { "../../../resources/agent-memory/db.mjs": db, "./db.mjs": db };
const { runLearnerPass } = loadTsCommonJs("src/main/agentMemory/agentMemoryLearner.ts", { stubs });
const { readLearnState, writeLearnState } = loadTsCommonJs("src/main/agentMemory/autoLearn.ts");
const { readAgentMemoryEntries } = loadTsCommonJs("src/main/agentMemory/agentMemoryEntries.ts", { stubs });

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pideck-learn-source-"));
	t.after(() => {
		db.closeDatabase(root);
		rmSync(root, { recursive: true, force: true });
	});
	return root;
}

function seedTurns(root, turns = 12) {
	const messages = Array.from({ length: turns * 2 }, (_, index) => ({ id: `m${index}`, role: index % 2 === 0 ? "user" : "assistant", content: `项目使用 npm，回合 ${index}`, timestamp: "" }));
	assert.equal(db.replaceSession(root, { id: "runtime", backend: "pi", project: "alpha", cwd: "/alpha", startedAt: "", endedAt: "", filePath: "" }, messages), true);
}

function learn(root, reply, projectId = "alpha") {
	return runLearnerPass({ root, sources: [], complete: async () => JSON.stringify(reply) }, { sessionId: "runtime", projectId });
}

const listItems = (root) => readAgentMemoryEntries({ root }).groups.flatMap((group) => group.entries);

test("新增学习条目持久标记来源，手工重复条目不补标，后续空批次不丢来源", async (t) => {
	const root = fixture(t);
	seedTurns(root);
	addMemory(root, { target: "memory", content: "人工已有条目" });
	const result = await learn(root, [
		{ target: "memory", content: "人工已有条目" },
		{ target: "memory", content: "学习得到的全局约定" },
		{ target: "project", content: "学习得到的项目约定" },
	]);
	assert.equal(result.added, 2);
	assert.equal(result.duplicate, 1);
	const entries = listItems(root);
	const manual = entries.find((entry) => entry.content === "人工已有条目");
	const learned = entries.filter((entry) => entry.content.startsWith("学习得到"));
	assert.equal(manual.source, undefined, "去重命中的手工条目不能冒充自动学习");
	assert.equal(learned.length, 2);
	for (const entry of learned) {
		assert.equal(entry.source, "auto-learn");
		assert.equal(readLearnState(root).entries?.[entry.exportId], "auto-learn", "列表与持久来源必须使用相同条目身份");
	}
	assert.doesNotMatch(readFileSync(join(root, "MEMORY.md"), "utf8"), /auto-learn|自动学习/, "来源不能混进 Markdown 真值");

	seedTurns(root, 24);
	assert.equal((await learn(root, [])).ran, true);
	const reloaded = loadTsCommonJs("src/main/agentMemory/agentMemoryEntries.ts", { stubs }).readAgentMemoryEntries({ root });
	assert.equal(reloaded.groups.flatMap((group) => group.entries).filter((entry) => entry.source === "auto-learn").length, 2, "重载模块和推进水位后来源仍保留");
});

test("用户偏好、项目教训与无项目退化的记忆按真实落盘作用域标记", async (t) => {
	const root = fixture(t);
	seedTurns(root);
	assert.equal(
		(
			await learn(root, [
				{ target: "user", content: "学习到的用户偏好" },
				{ target: "failure", category: "correction", content: "学习到的项目教训" },
			])
		).added,
		2,
	);
	const entries = listItems(root);
	const user = entries.find((entry) => entry.target === "user");
	const failure = entries.find((entry) => entry.target === "failure");
	assert.equal(user.scope, "global");
	assert.equal(user.projectId, "");
	assert.equal(user.source, "auto-learn", "传了项目上下文也不能把全局 user 来源记到项目目录");
	assert.equal(failure.projectId, "alpha");
	assert.equal(failure.source, "auto-learn", "教训条目身份要去除分类前缀");

	seedTurns(root, 24);
	assert.equal((await learn(root, [{ target: "project", content: "无项目时退化成全局记忆" }], "")).added, 1);
	const fallback = listItems(root).find((entry) => entry.content === "无项目时退化成全局记忆");
	assert.equal(fallback.scope, "global");
	assert.equal(fallback.source, "auto-learn");
});

test("旧水位没有来源记录时不推断、不补标，未知来源字段被忽略", (t) => {
	const root = fixture(t);
	addMemory(root, { target: "memory", content: "历史会话留下的记忆" });
	writeLearnState(root, { version: 1, sessions: { old: { learnedTurns: 12, learnedAt: "2026-01-01T00:00:00.000Z" } } });
	assert.equal(listItems(root)[0].source, undefined);
	const id = exportEntryId({ target: "memory", scope: "global", content: "历史会话留下的记忆" });
	writeLearnState(root, { version: 1, sessions: {}, entries: { [id]: "unknown-source", invalid: { source: "auto-learn" } } });
	assert.equal(listItems(root)[0].source, undefined);
	assert.equal(Object.keys(readLearnState(root).entries ?? {}).length, 0);
});

function walk(node, predicate) {
	if (Array.isArray(node)) return node.flatMap((child) => walk(child, predicate));
	if (!node || typeof node !== "object") return [];
	return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)];
}

test("列表仅对有来源的条目显示自动学习标签，搜索标签可筛出自动条目", async (t) => {
	const root = fixture(t);
	seedTurns(root);
	addMemory(root, { target: "memory", content: "历史无来源条目" });
	await learn(root, [{ target: "memory", content: "本次新学的条目" }]);
	const host = quickMessageHookHost();
	const { AgentMemoryEntryList } = loadTsCommonJs("src/renderer/src/components/app/settings/AgentMemoryEntryList.tsx", {
		stubs: {
			react: host.react,
			"../../../desktopApi": { desktopApi: { agentMemory: { list: async () => ({ ok: true, value: readAgentMemoryEntries({ root }) }) } } },
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
	render();
	// 桌面 API 的 Promise 跨 VM realm，等异步刷新 effect 完成后再检查列表。
	await new Promise(setImmediate);
	let tree = render();
	const badges = walk(tree, (node) => node.type === "badge");
	assert.equal(badges.length, 1, "历史未记录来源的条目不能补标签");
	assert.equal(badges[0].props.children, "自动学习");
	const search = walk(tree, (node) => node.type === "input")[0];
	search.props.onChange({ target: { value: "自动学习" } });
	tree = render();
	assert.equal(walk(tree, (node) => node.type === "badge").length, 1);
	const text = (node) => (Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : String(node ?? ""));
	assert.ok(text(tree).includes("本次新学的条目"));
	assert.ok(!text(tree).includes("历史无来源条目"), "按来源标签搜索时只保留自动条目");
});
