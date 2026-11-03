/**
 * 记忆条目时间（设置页「记忆」列表的「记录于」列）的行为守卫。
 *
 * 守两件事：
 *   1. 索引同步必须是 diff —— 只加一条记忆，不能把同文件其它条目的写入时间刷成现在，
 *      否则「这条记忆是什么时候记下的」永远等于「最近一次同步」。顺带也保住 fts rowid 不抖。
 *   2. 列表读出来的 `updatedAt` 必须与索引里的一致（读不到就留空，UI 显示破折号，不编造时间）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { entryTimes } from "../resources/agent-memory/db.mjs";
import { addMemory, removeMemory } from "../resources/agent-memory/tools.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const entries = loadTsCommonJs("src/main/agentMemory/agentMemoryEntries.ts");

function makeRoot() {
	return mkdtempSync(join(tmpdir(), "pideck-memory-times-"));
}

/** 让两次写入的 ISO 时间戳必然不同（updated_at 是毫秒精度的 ISO 串）。 */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

test("索引同步：新增一条不刷新其它条目的写入时间，删除会带走它自己的时间", async () => {
	const root = makeRoot();
	addMemory(root, { target: "memory", content: "构建用 npm run build 会触发全量编译，禁止" });
	addMemory(root, { target: "memory", content: "提交前必须跑针对性测试" });
	const before = entryTimes(root, "memory");
	assert.equal(before.size, 2);
	const keptContent = "提交前必须跑针对性测试";
	const keptTime = before.get(keptContent);
	assert.ok(keptTime, "刚写入的条目必须有时间");

	await tick();
	addMemory(root, { target: "memory", content: "改 i18n 词典后必须重跑 genZhTwCopy" });
	const after = entryTimes(root, "memory");
	assert.equal(after.size, 3);
	// 关键断言：老条目时间没变（全删重插会让它变成第二次同步的时间）。
	assert.equal(after.get(keptContent), keptTime);
	assert.ok(String(after.get("改 i18n 词典后必须重跑 genZhTwCopy")) > String(keptTime));

	await tick();
	removeMemory(root, { target: "memory", content: keptContent });
	const remaining = entryTimes(root, "memory");
	assert.equal(remaining.size, 2);
	assert.equal(remaining.get(keptContent), undefined, "删掉的条目不能留在索引里");
});

test("索引同步：内容没变的条目在重复同步后时间不变（幂等）", async () => {
	const root = makeRoot();
	addMemory(root, { target: "memory", content: "提交前必须跑针对性测试" });
	const first = entryTimes(root, "memory").get("提交前必须跑针对性测试");
	await tick();
	addMemory(root, { target: "memory", content: "提交前必须跑针对性测试" });
	// 同内容重复 add 会被去重挡掉（文件不变），时间自然也不该变。
	assert.equal(entryTimes(root, "memory").get("提交前必须跑针对性测试"), first);
});

test("列表：条目带上索引里的写入时间，且与 entryTimes 一致", () => {
	const root = makeRoot();
	addMemory(root, { target: "memory", content: "构建用 npm run build 会触发全量编译，禁止" });
	addMemory(root, { target: "user", content: "用户偏好中文回复" });
	const times = entryTimes(root, "memory");
	const userTimes = entryTimes(root, "user");
	const list = entries.readAgentMemoryEntries({ root, projects: () => [] });
	const items = list.groups.flatMap((group) => group.entries);
	const memoryEntry = items.find((entry) => entry.content === "构建用 npm run build 会触发全量编译，禁止");
	const userEntry = items.find((entry) => entry.content === "用户偏好中文回复");
	for (const entry of [memoryEntry, userEntry]) {
		assert.ok(entry, "条目应当被列出");
		const expected = (entry.target === "user" ? userTimes : times).get(entry.content);
		assert.equal(entry.updatedAt, expected, `${entry.target} 条目的时间必须来自索引`);
		assert.ok(!Number.isNaN(Date.parse(entry.updatedAt)), "时间必须是可解析的 ISO 串");
	}
});

test("渲染层：列表有手动刷新按钮与「记录于」列，空跨列跟着变成 4 列", () => {
	const source = readFileSync("src/renderer/src/components/app/settings/AgentMemoryEntryList.tsx", "utf8");
	assert.match(source, /aria-label=\{t\("settings\.agentMemoryRefresh"\)\}/, "工具栏要有手动刷新按钮");
	assert.match(source, /<EntryTimeCell value=\{row\.entry\.updatedAt\} \/>/, "行要渲染条目时间");
	assert.match(source, /title=\{t\("settings\.agentMemoryTableUpdatedHint"\)\}/, "列头要解释时间口径");
	assert.doesNotMatch(source, /colSpan=\{3\}/, "加了时间列后不能再有 3 列跨列");
	assert.equal(source.match(/colSpan=\{4\}/g)?.length, 2, "空态行与分组行都要铺满 4 列");
});
