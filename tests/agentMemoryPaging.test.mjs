import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 记忆条目分页（设置页「记忆」tab）。
 *
 * 守的是换页时的两件事：
 *   1. 分组行必须跟着条目一起出现在每一页——页首从组中间开始时补一次，
 *      否则读者看到一屏记忆却不知道它们属于哪个文件；
 *   2. 越界页码要夹到首/尾页——删掉最后一页的最后一条后不能停在空白页。
 */

const { MEMORY_PAGE_SIZE, buildMemoryPageRows, memoryEntryId, memoryTotalPages } = loadTsCommonJs("src/renderer/src/components/app/settings/agentMemoryPaging.ts");

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

const shape = (rows) => Array.from(rows, (row) => (row.kind === "group" ? `group:${row.group.target}` : `entry:${row.entry.content}`));

test("单组跨页：每页都有分组行，条目按序切分", () => {
	const groups = [group("memory", 30)];
	const first = buildMemoryPageRows(groups, 1);
	assert.equal(first.length, 1 + MEMORY_PAGE_SIZE);
	assert.equal(first[0].kind, "group");
	assert.equal(first[1].entry.content, "条目 1");
	assert.equal(first.at(-1).entry.content, `条目 ${MEMORY_PAGE_SIZE}`);

	const second = buildMemoryPageRows(groups, 2);
	assert.deepEqual(shape(second).slice(0, 2), ["group:memory", "entry:条目 21"]);
	assert.equal(second.filter((row) => row.kind === "entry").length, 10);
});

test("跨组换页：页首补上本页第一条所属组的分组行", () => {
	// 第一页 = A(5) + B 的前 15 条；第二页从 B 的第 16 条开始，必须先出现 B 的分组行。
	const groups = [group("memory", 5), group("failure", 20)];
	const first = buildMemoryPageRows(groups, 1);
	assert.deepEqual(shape(first).slice(0, 2), ["group:memory", "entry:条目 1"]);
	assert.equal(first.filter((row) => row.kind === "group").length, 2);
	assert.equal(first.filter((row) => row.kind === "entry").length, MEMORY_PAGE_SIZE);

	const second = buildMemoryPageRows(groups, 2);
	assert.deepEqual(shape(second).slice(0, 2), ["group:failure", "entry:条目 16"]);
});

test("越界页码夹到首尾页，空列表返回空行", () => {
	const groups = [group("memory", 25)];
	assert.deepEqual(shape(buildMemoryPageRows(groups, 99)).slice(0, 2), ["group:memory", "entry:条目 21"]);
	assert.deepEqual(shape(buildMemoryPageRows(groups, 0)).slice(0, 2), ["group:memory", "entry:条目 1"]);
	assert.deepEqual(Array.from(buildMemoryPageRows([], 1)), []);
	assert.equal(memoryTotalPages(0), 1);
	assert.equal(memoryTotalPages(25), 2);
	assert.equal(memoryTotalPages(40), 2);
	assert.equal(memoryTotalPages(41), 3);
});

test("条目 id 带作用域：同内容在全局与项目里是两条", () => {
	const base = entry("memory", 1);
	const project = { ...base, scope: "project", projectId: "proj-a" };
	assert.notEqual(memoryEntryId(base), memoryEntryId(project));
	assert.ok(memoryEntryId(base).includes("global"));
});
