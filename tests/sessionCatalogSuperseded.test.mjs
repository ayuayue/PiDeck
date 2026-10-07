import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);

/** 与 sessionCatalogForked.test.mjs 同一套沙箱：相对 import 由 helper 按源文件目录解析。 */
function loadCatalog(fsPromises = nodeRequire("node:fs/promises")) {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: {
			"node:fs/promises": fsPromises,
			// existsSync 恒真 = 文件都在磁盘上，外部删除清理不会把条目剔掉
			"node:fs": { existsSync: () => true },
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
}

function summary(overrides = {}) {
	return {
		id: "C:/sessions/old.jsonl",
		filePath: "C:/sessions/old.jsonl",
		name: "Resent session",
		preview: "hello",
		updatedAt: 100,
		messageCount: 1,
		source: "pi",
		...overrides,
	};
}

async function seedOrigin(catalog) {
	return catalog.ensureRuntimeTarget({
		projectId: "project-1",
		title: "Original session",
		source: "pi",
		environment: "native",
		filePath: "C:/sessions/old.jsonl",
	});
}

test("markSuperseded stamps the origin record and persists across reload", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-superseded-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const origin = await seedOrigin(catalog);
		const updated = await catalog.markSuperseded(origin.id, "child-session-1");
		assert.equal(updated?.supersededBy, "child-session-1");
		assert.equal(catalog.get(origin.id)?.supersededBy, "child-session-1");
		// 重发/编辑 fork 后旧文件留在磁盘：列表去重靠这个持久化标记，不是删文件——
		// 用户随时可以从旧 JSONL 恢复数据。
		const reloaded = new SessionCatalog(join(dir, "sessions.json"));
		await reloaded.load();
		assert.equal(reloaded.get(origin.id)?.supersededBy, "child-session-1");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("markSuperseded is idempotent and tolerates unknown ids", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-superseded-idem-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const origin = await seedOrigin(catalog);
		const first = await catalog.markSuperseded(origin.id, "child-1");
		const second = await catalog.markSuperseded(origin.id, "child-1");
		// 同一 fork 事件重放（IPC 重试）安全：重复标记值不变
		assert.equal(second?.supersededBy, first?.supersededBy);
		// 未知 id（fork 成功但 catalog 记录已被并发删除的竞态）：不抛错
		assert.equal(await catalog.markSuperseded("missing-id", "child-2"), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("mergeScanned never overwrites the supersededBy marker on later scans", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-superseded-scan-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const origin = await seedOrigin(catalog);
		await catalog.markSuperseded(origin.id, "child-1");
		// 同一文件再次扫描（updatedAt 变化触发 upsert）：标记是 fork 事件的既成事实，
		// 扫描合并只更新扫描可见字段，不允许冲掉它
		const [record] = await catalog.mergeScanned("project-1", [summary({ updatedAt: 200 })]);
		assert.equal(record?.id, origin.id);
		assert.equal(record?.supersededBy, "child-1");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
