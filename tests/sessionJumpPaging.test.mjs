import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

async function fixture(t, turns = 8, longTurn = 3, longEntries = 100) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-jump-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "session.jsonl");
	const rows = [{ type: "session", id: "s" }];
	let parentId = "s";
	const add = (id, role, parent = parentId) => {
		rows.push({ type: "message", id, parentId: parent, message: { role, content: id, timestamp: 1 } });
		parentId = id;
	};
	// 全文件前缀故意插入废弃分支，保证文件序号与活动分支下标不相等。
	for (let n = 0; n < 30; n++) add("detached-" + n, "user");
	parentId = "s";
	for (let n = 0; n < turns; n++) {
		add("u" + n, "user");
		if (n === longTurn) for (let k = 0; k < longEntries; k++) add("tool-" + k, "assistant");
		add("a" + n, "assistant");
	}
	await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	const reader = new SessionHistoryReader({ toHostPath: (p) => p, trimMessages: (x) => x, translate: () => "summary", convertMessages: (agentId, messages, ids = []) => messages.map((m, i) => ({ id: agentId + "-history-" + ids[i], agentId, role: m.role, text: m.content, timestamp: 1, meta: { entryId: ids[i] } })) });
	return { reader, path };
}

test("跳转按当前分支取完整长回合，废弃分支的文件序号不参与分页", async (t) => {
	const { reader, path } = await fixture(t);
	const page = await reader.readSessionDisplayJumpPage(path, "viewer", "u3", 3);
	const ids = page.messages.map((m) => m.meta.entryId);
	assert.ok(ids.includes("u3"));
	assert.ok(ids.includes("a3"), "100条工具之后的最终回答必须保留");
	assert.ok(ids.includes("a4"), "有后文时至少显示下一轮完整回答");
	assert.ok(!ids.some((id) => id.startsWith("detached-")));
});

test("顺序、逆序、交替与最后三条的所有消息ID均可取到完整所属回合", async (t) => {
	const { reader, path } = await fixture(t);
	const targets = ["u0", "u7", "a6", "u6", "a7", "u1", "u5", "tool-99", "a3", "u2"];
	for (const id of targets.concat(targets.slice().reverse())) {
		const page = await reader.readSessionDisplayJumpPage(path, "viewer", "old-agent-history-" + id, 1);
		assert.ok(
			page.messages.some((m) => m.meta.entryId === id),
			id,
		);
		const turn = id.startsWith("tool-") ? 3 : Number(id.slice(1));
		assert.ok(
			page.messages.some((m) => m.meta.entryId === "a" + turn),
			id + " 所属回合不得截断",
		);
	}
});

test("目标的后续回合超出条目预算时减少后文，不得把目标回合裁掉", async (t) => {
	const { reader, path } = await fixture(t, 8, 4, SessionHistoryReader.maxPageWindowEntries() + 1);
	const page = await reader.readSessionDisplayJumpPage(path, "viewer", "u3", 3);
	assert.ok(page.messages.some((m) => m.meta.entryId === "u3"));
	assert.ok(page.messages.some((m) => m.meta.entryId === "a3"));
});

test("不存在的ID返回空页，带投影前缀的单条补读仍命中原始条目", async (t) => {
	const { reader, path } = await fixture(t);
	const page = await reader.readSessionDisplayJumpPage(path, "viewer", "absent", 3);
	assert.equal(page.messages.length, 0);
	const single = await reader.readEntryDisplayMessage(path, "viewer", "old-agent-history-detached-1");
	assert.ok(single, "补读入口必须剥离投影前缀");
	assert.equal(single.text, "detached-1");
});
