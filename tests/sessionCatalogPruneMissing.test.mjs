import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * mergeScanned 外部删除清理（pruneMissing）回归。
 *
 * 背景：catalog 历史上只增改不删，pi 会话文件被外部删除（用户手工 rm、脚本
 * 清理、pi 侧回收）后，侧栏条目永远残留（2026-10-04 实机：12 个 "view" 垃圾
 * 会话文件删了之后列表还在）。现在 mergeScanned 会剔除「磁盘已不存在」的
 * pi 原生/native 条目，WSL、dsh、其它项目、草稿一律不动。
 */

function loadCatalog() {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: {
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
}

const VALID_SESSION_JSONL = '{"type":"session","version":3,"id":"s1","timestamp":"2026-10-04T00:00:00.000Z","cwd":"C:\\\\x"}\n';

function summary(filePath, overrides = {}) {
	return {
		id: filePath,
		filePath,
		name: "Some session",
		preview: "hello",
		updatedAt: 100,
		messageCount: 1,
		source: "pi",
		...overrides,
	};
}

function seedEntry(overrides) {
	const now = Date.now();
	return {
		id: "seed",
		projectId: "project-1",
		title: "Entry",
		source: "pi",
		environment: "native",
		status: "active",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

test("prunes a pi/native entry whose session file was deleted externally, and persists the removal", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-prune-"));
	const catalogFile = join(dir, "sessions.json");
	const sessionFile = join(dir, "2026-10-04T00-00-00-000Z_s1.jsonl");
	try {
		await writeFile(sessionFile, VALID_SESSION_JSONL);
		const catalog = new SessionCatalog(catalogFile);
		await catalog.load();

		await catalog.mergeScanned("project-1", [summary(sessionFile)]);
		assert.equal(catalog.listEntries().length, 1, "entry registered from scan");

		await unlink(sessionFile);
		await catalog.mergeScanned("project-1", []);
		assert.equal(catalog.listEntries().length, 0, "entry pruned after external deletion");

		const reloaded = new SessionCatalog(catalogFile);
		await reloaded.load();
		assert.equal(reloaded.listEntries().length, 0, "prune persisted to disk");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("keeps the entry while the file still exists", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-prune-keep-"));
	const catalogFile = join(dir, "sessions.json");
	const sessionFile = join(dir, "alive.jsonl");
	try {
		await writeFile(sessionFile, VALID_SESSION_JSONL);
		const catalog = new SessionCatalog(catalogFile);
		await catalog.load();
		await catalog.mergeScanned("project-1", [summary(sessionFile)]);
		await catalog.mergeScanned("project-1", []);
		assert.equal(catalog.listEntries().length, 1, "existing file must survive the prune pass");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("never prunes wsl entries (UNC existsSync is unreliable when the distro is offline)", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-prune-wsl-"));
	const catalogFile = join(dir, "sessions.json");
	try {
		const seed = {
			version: 1,
			sessions: [
				seedEntry({
					id: "wsl-entry",
					environment: "wsl",
					wslDistro: "Ubuntu",
					wslUser: "user",
					filePath: "\\\\wsl.localhost\\Ubuntu\\home\\user\\proj\\.pi\\sessions\\gone.jsonl",
				}),
			],
		};
		await writeFile(catalogFile, JSON.stringify(seed), "utf8");
		const catalog = new SessionCatalog(catalogFile);
		await catalog.load();
		await catalog.mergeScanned("project-1", []);
		assert.equal(catalog.listEntries().length, 1, "wsl entry must survive even though the UNC path is unreachable");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("never prunes dsh backend entries (files live under $DSH_HOME)", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-prune-dsh-"));
	const catalogFile = join(dir, "sessions.json");
	try {
		const seed = {
			version: 1,
			sessions: [seedEntry({ id: "dsh-entry", backend: "dsh", dshSessionId: "host-1", filePath: join(dir, "missing-dsh.jsonl") })],
		};
		await writeFile(catalogFile, JSON.stringify(seed), "utf8");
		const catalog = new SessionCatalog(catalogFile);
		await catalog.load();
		await catalog.mergeScanned("project-1", []);
		assert.equal(catalog.listEntries().length, 1, "dsh entry must survive regardless of file presence");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("does not touch entries owned by other projects during this project's scan", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-prune-scope-"));
	const catalogFile = join(dir, "sessions.json");
	try {
		const seed = {
			version: 1,
			sessions: [seedEntry({ id: "other-project-entry", projectId: "project-2", filePath: join(dir, "gone.jsonl") })],
		};
		await writeFile(catalogFile, JSON.stringify(seed), "utf8");
		const catalog = new SessionCatalog(catalogFile);
		await catalog.load();
		await catalog.mergeScanned("project-1", []);
		assert.equal(catalog.listEntries().length, 1, "other project's entries are out of scope");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("skips pruning an entry whose session has a live runtime (prewarm attaches filePath before pi writes the file)", async () => {
	// 2026-10-05 实机事故：草稿预热激活 → attachRuntime 写入 filePath，但 pi 首条
	// 消息才创建 jsonl。同秒的扫描把记录当「外部删除」剔掉 → 整页闪回引导页、
	// 输入草稿丢失、发送又另起新进程。活跃绑定必须挡下外部删除判定。
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-prune-live-"));
	const catalogFile = join(dir, "sessions.json");
	const futureFile = join(dir, "not-yet-written.jsonl");
	try {
		const seed = {
			version: 1,
			sessions: [seedEntry({ id: "prewarmed", filePath: futureFile })],
		};
		await writeFile(catalogFile, JSON.stringify(seed), "utf8");
		const catalog = new SessionCatalog(catalogFile);
		await catalog.load();
		catalog.setSessionLivenessProbe((sessionId) => sessionId === "prewarmed");
		await catalog.mergeScanned("project-1", []);
		assert.equal(catalog.listEntries().length, 1, "live runtime must survive even though the file does not exist yet");

		// 运行终结（探针不再报告活跃）后，下一轮扫描按真实缺失正常清理。
		catalog.setSessionLivenessProbe(() => false);
		await catalog.mergeScanned("project-1", []);
		assert.equal(catalog.listEntries().length, 0, "once the runtime is gone, the missing file is pruned as before");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("skips pruning for other entries sharing the scan when only one session is live", async () => {
	// 探针按 sessionId 精确放行：同项目其它文件缺失的条目不受影响。
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-prune-live-scope-"));
	const catalogFile = join(dir, "sessions.json");
	try {
		const seed = {
			version: 1,
			sessions: [seedEntry({ id: "live", filePath: join(dir, "live-not-written.jsonl") }), seedEntry({ id: "dead", filePath: join(dir, "dead-gone.jsonl") })],
		};
		await writeFile(catalogFile, JSON.stringify(seed), "utf8");
		const catalog = new SessionCatalog(catalogFile);
		await catalog.load();
		catalog.setSessionLivenessProbe((sessionId) => sessionId === "live");
		await catalog.mergeScanned("project-1", []);
		const ids = catalog.listEntries().map((entry) => entry.id);
		// vm realm 数组与宿主数组原型不同，deepEqual 会误报——按文本比较。
		assert.deepEqual(JSON.parse(JSON.stringify(ids)), ["live"], "only the live entry survives");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("keeps non-pi sources and draft entries without filePath", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-prune-source-"));
	const catalogFile = join(dir, "sessions.json");
	try {
		const seed = {
			version: 1,
			// 注意：无 filePath 的 pi 草稿在 load() 的 staleDrafts 清理里就会被剔
			// （既有行为，与 prune 无关），这里只验证非 pi 来源不受 prune 影响。
			sessions: [seedEntry({ id: "codex-entry", source: "codex", filePath: join(dir, "gone-codex.jsonl") })],
		};
		await writeFile(catalogFile, JSON.stringify(seed), "utf8");
		const catalog = new SessionCatalog(catalogFile);
		await catalog.load();
		await catalog.mergeScanned("project-1", []);
		const ids = catalog.listEntries().map((entry) => entry.id);
		// vm realm 数组与宿主数组原型不同，deepEqual 会误报——按文本比较。
		assert.deepEqual(JSON.parse(JSON.stringify(ids)), ["codex-entry"], "non-pi sources stay");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("prunes nested subagent session entries whose whole parent session directory was deleted", async () => {
	// 2027-02 小窗 ENOENT 事故：嵌套子代理会话的 filePath 形如
	// <encoded>/<父会话目录>/<agentId>/run-N/session.jsonl。父会话目录被 pi 整体清理后，
	// 直接父目录（run-N）也不存在——旧的「dirname 在才清」闸把它当成「磁盘离线」
	// 永远跳过，陈旧记录残留并会顶到小窗项目切换的 sessions[0]。
	// 修复后锚点是「逐级向上第一个存在的祖先目录」（项目 encoded 目录在 = 确定删除）。
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-prune-subagent-"));
	const catalogFile = join(dir, "sessions.json");
	try {
		const nestedFile = join(dir, "2026-08-02T04-26-52-784Z_parent", "ef6005bb", "run-0", "session.jsonl");
		const seed = {
			version: 1,
			sessions: [seedEntry({ id: "stale-subagent", title: "subagent-researcher-ef6005bb-1", filePath: nestedFile })],
		};
		await writeFile(catalogFile, JSON.stringify(seed), "utf8");
		const catalog = new SessionCatalog(catalogFile);
		await catalog.load();
		await catalog.mergeScanned("project-1", []);
		assert.equal(catalog.listEntries().length, 0, "nested subagent entry pruned once the project dir anchor exists but the file is gone");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("keeps entries when no ancestor exists within the climb limit (disk/offline protection)", async () => {
	// 爬升上限 6 层：路径深于上限且所有祖先都不存在时视为「磁盘/路径整体不可达」，跳过清理。
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-prune-deep-"));
	const catalogFile = join(dir, "sessions.json");
	try {
		// dirname 起 7 层全不存在的路径（a/b/c/d/e/f/g/file.jsonl，爬升 6 次查不到存在的目录）。
		const deepFile = join(dir, "a", "b", "c", "d", "e", "f", "g", "file.jsonl");
		const seed = {
			version: 1,
			sessions: [seedEntry({ id: "deep-offline", filePath: deepFile })],
		};
		await writeFile(catalogFile, JSON.stringify(seed), "utf8");
		const catalog = new SessionCatalog(catalogFile);
		await catalog.load();
		await catalog.mergeScanned("project-1", []);
		assert.equal(catalog.listEntries().length, 1, "entry survives when no existing ancestor is found within the climb limit");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
