import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * SessionCatalog.onRowsRemoved：会话行消失的集中通知点（关联会话据此清理 linked-sessions.json）。
 * 每条路径一个用例：removeWithDescendants（删除 / 归档）、removeByProjectId（删项目）、
 * mergeScanned 的外部删除清理——这三条在没有集中点时各自漏过清理（PR 审查 B4）。
 */

function loadCatalog() {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: {
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
}

const VALID_SESSION_JSONL = '{"type":"session","version":3,"id":"s1","timestamp":"2026-10-04T00:00:00.000Z","cwd":"C:\\\\x"}\n';

async function withCatalog(run) {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-removed-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const removed = [];
		catalog.onRowsRemoved((ids) => removed.push([...ids]));
		await run({ catalog, removed, dir });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const draft = (catalog, projectId, title) => catalog.createDraft({ projectId, title, environment: "native" });

test("removeWithDescendants（删除 / 归档的公共路径）通知被移除的会话 id", async () => {
	await withCatalog(async ({ catalog, removed }) => {
		const a = await draft(catalog, "p1", "A");
		const b = await draft(catalog, "p1", "B");
		await catalog.removeWithDescendants(a.id);
		assert.deepEqual(removed.flat(), [a.id]);
		assert.ok(catalog.get(b.id), "别的会话不受影响");
	});
});

test("removeByProjectId（删项目）通知该项目下的全部会话，其它项目不受影响", async () => {
	await withCatalog(async ({ catalog, removed }) => {
		const a = await draft(catalog, "p1", "A");
		const b = await draft(catalog, "p1", "B");
		const other = await draft(catalog, "p2", "C");
		await catalog.removeByProjectId("p1");
		assert.deepEqual(removed.flat().sort(), [a.id, b.id].sort());
		assert.ok(catalog.get(other.id));
	});
});

test("mergeScanned 清掉磁盘上已消失的会话时通知", async () => {
	await withCatalog(async ({ catalog, removed, dir }) => {
		const file = join(dir, "2026-10-04T00-00-00-000Z_s1.jsonl");
		await writeFile(file, VALID_SESSION_JSONL);
		const [record] = await catalog.mergeScanned("project-1", [{ id: file, filePath: file, name: "Some session", preview: "hello", updatedAt: 100, messageCount: 1, source: "pi" }]);
		assert.equal(removed.length, 0, "新增不触发");
		await unlink(file);
		await catalog.mergeScanned("project-1", []);
		assert.deepEqual(removed.flat(), [record.id]);
	});
});

test("remove / 重复移除：只对真的消失的行通知一次，订阅者抛错不影响 catalog，退订后不再通知", async () => {
	await withCatalog(async ({ catalog, removed }) => {
		catalog.onRowsRemoved(() => {
			throw new Error("listener failure");
		});
		const a = await draft(catalog, "p1", "A");
		assert.equal(await catalog.remove(a.id), true);
		assert.equal(await catalog.remove(a.id), false);
		assert.deepEqual(removed.flat(), [a.id]);
		const dispose = catalog.onRowsRemoved((ids) => removed.push(["late", ...ids]));
		dispose();
		const b = await draft(catalog, "p1", "B");
		await catalog.remove(b.id);
		assert.deepEqual(removed.flat(), [a.id, b.id]);
	});
});
