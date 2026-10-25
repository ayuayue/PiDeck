import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 真实 SessionCatalog（磁盘 catalog JSON），只把日志模块换成空实现。
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
	stubs: { "../logging/sharedLogger": { getAppLogger: () => null } },
});

const SESSION_FILE = "C:/Users/me/.pi/agent/sessions/--d--work-old--/s.jsonl";

function summary(overrides = {}) {
	return {
		id: SESSION_FILE,
		filePath: SESSION_FILE,
		name: "移动前的会话",
		preview: "hello",
		updatedAt: 1_700_000_000_000,
		messageCount: 1,
		source: "pi",
		projectPath: "D:\\work\\old",
		...overrides,
	};
}

async function withCatalog(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-directory-import-"));
	try {
		const catalog = new SessionCatalog(join(dir, "session-catalog.json"));
		await catalog.load();
		await run(catalog);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("手动导入把会话归属钉在当前项目，旧目录项目的扫描改不回去", async () => {
	await withCatalog(async (catalog) => {
		await catalog.mergeScanned("project-new", [summary()], undefined, { manualAssignment: true });
		assert.equal(catalog.listEntries()[0].projectId, "project-new");
		assert.equal(catalog.listEntries()[0].manualProjectAssignment, true);

		// 旧项目（目录被移动/改名前的那个）刷新时的常规扫描：不得抢回归属。
		await catalog.mergeScanned("project-old", [summary()]);
		assert.equal(catalog.listEntries()[0].projectId, "project-new");
		// 旧项目也不该在列表里看到这条会话（它已不属于该项目）。
		const oldRecords = await catalog.mergeScanned("project-old", [summary()]);
		assert.deepEqual(JSON.parse(JSON.stringify(oldRecords)), []);
	});
});

test("没有手动导入置位时，扫描仍按项目改归属（默认行为不变）", async () => {
	await withCatalog(async (catalog) => {
		await catalog.mergeScanned("project-a", [summary()]);
		await catalog.mergeScanned("project-b", [summary()]);
		assert.equal(catalog.listEntries()[0].projectId, "project-b");
		assert.equal(catalog.listEntries()[0].manualProjectAssignment, undefined);
	});
});

test("重新手动导入到另一个项目时归属跟随用户操作", async () => {
	await withCatalog(async (catalog) => {
		await catalog.mergeScanned("project-new", [summary()], undefined, { manualAssignment: true });
		await catalog.mergeScanned("project-other", [summary()], undefined, { manualAssignment: true });
		assert.equal(catalog.listEntries()[0].projectId, "project-other");
	});
});

test("置位随 catalog 落盘并在重启后保持", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-directory-import-reload-"));
	try {
		const catalogPath = join(dir, "session-catalog.json");
		const first = new SessionCatalog(catalogPath);
		await first.load();
		await first.mergeScanned("project-new", [summary()], undefined, { manualAssignment: true });

		const reloaded = new SessionCatalog(catalogPath);
		await reloaded.load();
		assert.equal(reloaded.listEntries()[0].manualProjectAssignment, true);
		await reloaded.mergeScanned("project-old", [summary()]);
		assert.equal(reloaded.listEntries()[0].projectId, "project-new");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
