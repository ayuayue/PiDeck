/**
 * 记忆条目浏览器（设置页「记忆」tab）的读/删行为守卫。
 *
 * 这里守两件事，都是「删一条记忆」最容易出错的地方：
 *   1. 列出来的 key 必须能删掉它自己那一行 —— 列表和删除用同一套规范化，
 *      否则用户点了删除却没反应（历史上最容易被当成「UI 卡住」）。
 *   2. 删除只动一行：同文件其它条目原样保留，并且留下墓碑，
 *      否则从旧导出包导入会把刚删掉的记忆复活。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addMemory } from "../resources/agent-memory/tools.mjs";
import { projectKeyFromPath } from "../resources/agent-memory/paths.mjs";
import { searchEntries } from "../resources/agent-memory/db.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const entries = loadTsCommonJs("src/main/agentMemory/agentMemoryEntries.ts");

function makeRoot() {
	return mkdtempSync(join(tmpdir(), "pideck-memory-entries-"));
}

/** 造一份「全局 + 项目」都有条目的记忆目录，返回根目录与项目路径。 */
function seed() {
	const root = makeRoot();
	const projectPath = join(tmpdir(), "pideck-project-alpha");
	addMemory(root, { target: "memory", content: "构建用 npm run build 会触发全量编译，禁止" });
	addMemory(root, { target: "memory", content: "提交前必须跑针对性测试" });
	addMemory(root, { target: "user", content: "用户偏好中文回复" });
	addMemory(root, { target: "project", content: "项目里 pnpm 不能混用", projectId: projectKeyFromPath(projectPath) });
	return { root, projectPath };
}

test("列表：按作用域分组、带规范化 key 与字数，项目键能翻成项目名", () => {
	const { root, projectPath } = seed();
	const list = entries.readAgentMemoryEntries({ root, projects: () => [{ name: "Alpha", path: projectPath }] });

	assert.equal(list.total, 4);
	const globalMemory = list.groups.find((group) => group.scope === "global" && group.target === "memory");
	assert.ok(globalMemory, "缺全局记忆分组");
	assert.equal(globalMemory.file, "MEMORY.md");
	assert.equal(globalMemory.budget.maxChars > 0, true, "全局文件应带注入预算");
	assert.equal(globalMemory.entries[0].chars, globalMemory.entries[0].content.length);
	assert.ok(globalMemory.entries[0].key.length > 0, "条目必须带能定位自己的 key");

	const project = list.groups.find((group) => group.scope === "project");
	assert.ok(project);
	assert.equal(project.projectName, "Alpha", "项目键应翻成用户认得的项目名");
	assert.equal(project.budget, null, "项目作用域不参与每轮注入，因此没有预算");
});

test("列表：删除用的 key 与列表给的 key 一致，删掉一条只影响它自己", () => {
	const { root } = seed();
	const before = entries.readAgentMemoryEntries({ root });
	const target = before.groups.find((group) => group.scope === "global" && group.target === "memory");
	assert.equal(target.entries.length, 2);

	const removed = entries.deleteAgentMemoryEntry(root, { target: "memory", key: target.entries[0].key });
	assert.equal(removed.removed, 1);

	const after = entries.readAgentMemoryEntries({ root });
	const keptTarget = after.groups.find((group) => group.scope === "global" && group.target === "memory");
	assert.equal(keptTarget.entries.length, 1, "同文件其它条目必须保留");
	assert.equal(keptTarget.entries[0].content, target.entries[1].content);
	assert.ok(!readFileSync(join(root, "MEMORY.md"), "utf8").includes(target.entries[0].content), "文件里不应再出现被删条目");
});

test("删除留下墓碑：旧导出包不能把删掉的记忆导回来", () => {
	const { root } = seed();
	const before = entries.readAgentMemoryEntries({ root });
	const target = before.groups.find((group) => group.scope === "global" && group.target === "user");
	entries.deleteAgentMemoryEntry(root, { target: "user", key: target.entries[0].key });

	const tombstones = JSON.parse(readFileSync(join(root, "tombstones.json"), "utf8"));
	assert.equal(tombstones.length, 1);
	assert.equal(tombstones[0].target, "user");
	assert.equal(tombstones[0].scope, "global");
});

test("删不存在的 key 是空操作，不会把文件写坏", () => {
	const { root } = seed();
	const path = join(root, "MEMORY.md");
	const raw = readFileSync(path, "utf8");
	const result = entries.deleteAgentMemoryEntry(root, { target: "memory", key: "not-a-real-key" });
	assert.equal(result.removed, 0);
	assert.equal(readFileSync(path, "utf8"), raw, "没命中就不该重写文件");
	assert.ok(!existsSync(join(root, "tombstones.json")), "没删成功也没必要写墓碑");
});

test("缺 key 或 target 非法时明确报错（IPC 层据此回安全错误码）", () => {
	const { root } = seed();
	assert.throws(() => entries.deleteAgentMemoryEntry(root, { target: "memory", key: "  " }), /entry-key-required/);
	assert.throws(() => entries.deleteAgentMemoryEntry(root, { target: "nope", key: "x" }), /target-invalid/);
});

test("STANDING：读缺失文件为空串，保存整文件替换并同步索引", () => {
	const root = makeRoot();
	assert.equal(entries.readStandingEntry(root), "", "没有 STANDING.md 时读出来是空串");

	entries.writeStandingEntry(root, "回答保持简洁\r\n发布前先列步骤");
	assert.equal(entries.readStandingEntry(root), "回答保持简洁\n发布前先列步骤", "CRLF 归一成 LF，尾部补换行");

	// 写路径强制穿透了 mtime 短路：检索索引里要能立刻搜到新内容（走 db 的 LIKE 通道）。
	const hits = searchEntries(root, "发布前先列步骤", { limit: 5 });
	assert.ok(
		hits.hits.some((hit) => hit.target === "standing"),
		"保存后索引应包含新常驻指令",
	);
});

test("STANDING：超预算拒绝保存，空串清空文件", () => {
	const root = makeRoot();
	entries.writeStandingEntry(root, "先写一条");
	assert.throws(() => entries.writeStandingEntry(root, "长".repeat(4001)), /standing-too-long/);
	assert.equal(entries.readStandingEntry(root), "先写一条", "被拒的保存不能动原文件");

	entries.writeStandingEntry(root, "");
	assert.equal(entries.readStandingEntry(root), "");
});

test("设备档案：改名只动 name，id 保持稳定", () => {
	const { renameDevice, readDeviceProfile } = loadTsCommonJs("resources/agent-memory/sync.mjs");
	const root = makeRoot();

	const before = readDeviceProfile(root);
	const renamed = renameDevice(root, "工作笔记本");
	assert.equal(renamed.id, before.id, "改名不能换 id，否则设备记忆全部失联");
	assert.equal(renamed.name, "工作笔记本");
	assert.equal(readDeviceProfile(root).name, "工作笔记本");

	// 空名拒绝（UI 侧已禁用保存，这里守数据层最后一线）；再次读档不丢配置。
	assert.throws(() => renameDevice(root, "   "), /device-name-required/);
	assert.equal(readDeviceProfile(root).name, "工作笔记本");
});
