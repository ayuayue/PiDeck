import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);
const fsPromises = nodeRequire("node:fs/promises");
const { buildSessionOriginKey, toAbsoluteSessionPath } = loadTsCommonJs("src/shared/sessionIdentity.ts");
const { buildSessionIdAliasMap, migrateSessionIdList, remapSessionIdActivities, remapSessionIds } = loadTsCommonJs("src/shared/sessionIdAliases.ts");
const { getProjectAgentSessionDisplay } = loadTsCommonJs("src/renderer/src/agentListDisplay.ts");
// Tab 列表/置顶的生产迁移入口（hook 模块的纯函数）：react/jotai/atoms 无关的桩足够求出函数值。
const { migrateAndPruneSessionTabIds } = loadTsCommonJs("src/renderer/src/hooks/useSessionWorkspaceChrome.ts", {
	stubs: {
		react: { useCallback: (callback) => callback, useEffect: () => undefined, useRef: (value) => ({ current: value }), useState: (value) => [typeof value === "function" ? value() : value, () => undefined] },
		jotai: { useAtomValue: () => undefined, useSetAtom: () => () => undefined, useStore: () => ({}) },
		"../atoms": {},
		"../desktopApi": { desktopApi: {} },
	},
});
const SESSION_PATH = "/Users/Fixture/Project/.pi/sessions/2026-10-07T12-34-56-000Z_abcdef01.jsonl";

/** 权威会话名桩（等价于 SessionScanner 读到 session_info 名的结果，但不碰磁盘）。 */
function authoritativeTitle(name) {
	return () => Promise.resolve({ name, nameFromSessionInfo: true });
}

/** 读不出权威名（WSL 停机/文件被占）：冲突组必须原样保留、下次启动重试。 */
function failingTitleRead() {
	return () => Promise.reject(new Error("session title read failed"));
}

/** 完整旧目录记录：使用真实身份构造器，仅旧键模拟升级前的 POSIX 小写规则。 */
function entry(overrides = {}) {
	const record = {
		id: "original-session",
		projectId: "project-1",
		title: "A",
		titleLocked: true,
		titleOrigin: "manual",
		source: "pi",
		environment: "native",
		filePath: SESSION_PATH,
		status: "active",
		createdAt: 10,
		updatedAt: 100,
		...overrides,
	};
	return { originKey: buildSessionOriginKey(record), ...record };
}

/** 所有写入均限制在本测试的临时目录；POSIX 路径夹具只参与身份比较，不接触真实用户文件。 */
async function withCatalog(entries, run, options = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-identity-repair-"));
	const catalogPath = join(dir, "session-catalog.json");
	try {
		await writeFile(catalogPath, JSON.stringify({ version: 1, sessions: entries }), "utf8");
		const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
			stubs: {
				"node:fs/promises": options.fsPromises ?? fsPromises,
				"node:fs": { existsSync: () => true },
				"../logging/sharedLogger": { getAppLogger: () => null },
			},
		});
		const resolveFilePath = options.withoutResolver ? undefined : (options.resolveFilePath ?? ((_projectId, path, environment) => toAbsoluteSessionPath(path, "/Users/Fixture/Project", environment)));
		const createCatalog = () => new SessionCatalog(catalogPath, {}, resolveFilePath, options.fetchTitle);
		/** 重启 catalog：可注入与首次加载不同的标题读取结果（复现「首次读失败、下次拿到权威名」）。 */
		const createRestarted = () => new SessionCatalog(catalogPath, {}, resolveFilePath, options.restartFetchTitle ?? options.fetchTitle);
		await run({ catalog: createCatalog(), createCatalog, createRestarted, catalogPath });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** 生产 listPathSummary 的轻量形态：扫描只带文件时间，不提供覆盖人工标题的名称。 */
function summary(updatedAt = 100) {
	return { id: SESSION_PATH, filePath: SESSION_PATH, source: "pi", preview: "", messageCount: 0, updatedAt };
}

/** 侧栏和搜索共用目录记录；侧栏额外按路径归并，必须与按 ID 取标题的 Tab 一致。 */
function sidebarTitle(records) {
	const display = getProjectAgentSessionDisplay({
		agents: [],
		sessions: records.map((record) => ({ id: record.id, filePath: record.filePath, source: record.source, name: record.title, preview: record.preview, messageCount: record.messageCount, updatedAt: record.updatedAt })),
	});
	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "session");
	return display.children[0].session.name;
}

test("#354 repairs an unchanged absolute POSIX path's old key before scanning without replacing its stable ID", async () => {
	const old = entry({ originKey: `pi:native:${SESSION_PATH.toLowerCase()}` });
	await withCatalog([old], async ({ catalog, createCatalog, catalogPath }) => {
		await catalog.load();
		assert.equal(catalog.get(old.id).originKey, buildSessionOriginKey(old));
		const records = await catalog.mergeScanned("project-1", [summary()]);
		assert.equal(records.length, 1);
		assert.equal(records[0].id, old.id);
		assert.equal(records[0].title, old.title);
		assert.equal(JSON.parse(await readFile(catalogPath, "utf8")).sessions[0].originKey, buildSessionOriginKey(old));
		assert.equal(JSON.parse(await readFile(`${catalogPath}.bak`, "utf8")).sessions[0].originKey, old.originKey, "atomic catalog backup retains the pre-repair index");
		const repairedSnapshot = await readFile(catalogPath, "utf8");
		await createCatalog().load();
		assert.equal(await readFile(catalogPath, "utf8"), repairedSnapshot, "the repair must be idempotent across restart");
	});
});

test("#354 repairs a missing absolute-path identity key even without a project path resolver", async () => {
	const old = entry({ originKey: undefined });
	await withCatalog(
		[old],
		async ({ catalog }) => {
			await catalog.load();
			assert.equal(catalog.get(old.id).originKey, buildSessionOriginKey(old));
			assert.equal((await catalog.mergeScanned("project-1", [summary()])).length, 1);
		},
		{ withoutResolver: true },
	);
});

test("#354 folds already persisted duplicates into the original ID while preserving the latest manual title and metadata", async () => {
	const original = entry({ originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, manualProjectAssignment: true, model: { provider: "provider", modelId: "model" } });
	const duplicate = entry({ id: "scanned-duplicate", title: "A2", createdAt: 20, updatedAt: 200, thinkingLevel: "high", piSessionId: "pi-session", forked: true });
	const predecessor = entry({ id: "predecessor", filePath: "/Users/Fixture/Project/.pi/sessions/previous.jsonl", supersededBy: duplicate.id });
	// 同优先级（都是人工标题）冲突由磁盘权威名仲裁：磁盘上是 A2，因此 A2 是最后成功改的名。
	await withCatalog(
		[duplicate, original, predecessor],
		async ({ catalog, createCatalog, catalogPath }) => {
			await catalog.load();
			const repaired = catalog.get(original.id);
			assert.ok(repaired);
			// 被归并的历史 id 不再作为独立会话，但它的引用仍解析到同一个现存记录（#354 别名契约）。
			assert.equal(catalog.get(duplicate.id).id, original.id, "the scanner-generated extra identity resolves to the surviving session");
			assert.equal(catalog.listEntries().length, 2, "the merged duplicate leaves no extra entity behind");
			assert.deepEqual([...repaired.mergedSessionIds], [duplicate.id]);
			assert.equal(repaired.title, "A2");
			assert.equal(repaired.titleOrigin, "manual");
			assert.equal(repaired.createdAt, original.createdAt);
			assert.equal(repaired.updatedAt, duplicate.updatedAt);
			assert.equal(repaired.model.modelId, "model");
			assert.equal(repaired.thinkingLevel, "high");
			assert.equal(repaired.piSessionId, "pi-session");
			assert.equal(repaired.forked, true);
			assert.equal(repaired.manualProjectAssignment, true);
			assert.equal(catalog.get(predecessor.id).supersededBy, original.id, "catalog replacement references must follow the retained stable ID");
			const snapshot = await readFile(catalogPath, "utf8");
			const restarted = createCatalog();
			await restarted.load();
			assert.equal(restarted.get(original.id).title, "A2");
			assert.equal(await readFile(catalogPath, "utf8"), snapshot);
		},
		{ fetchTitle: authoritativeTitle("A2") },
	);
});

test("#354 the old-key session keeps its ID even when a scanner duplicate carries an earlier file timestamp", async () => {
	const original = entry({ originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, createdAt: 30 });
	const duplicate = entry({ id: "scanned-duplicate", createdAt: 20, updatedAt: 200, title: "A2" });
	await withCatalog(
		[duplicate, original],
		async ({ catalog }) => {
			await catalog.load();
			assert.equal(catalog.listEntries().length, 1);
			assert.equal(catalog.listEntries()[0].id, original.id, "file timestamps are not evidence that a scanner-created ID predates the legacy identity");
			assert.equal(catalog.get(original.id).title, "A2");
		},
		{ fetchTitle: authoritativeTitle("A2") },
	);
});

test("#354 unresolved entries with colliding legacy keys are preserved rather than guessed to be duplicates", async () => {
	const upper = entry({ id: "upper", originKey: `pi:native:${SESSION_PATH.toLowerCase()}` });
	const lower = entry({ id: "lower", filePath: SESSION_PATH.toLowerCase() });
	await withCatalog(
		[upper, lower],
		async ({ catalog, catalogPath }) => {
			const before = await readFile(catalogPath, "utf8");
			await catalog.load();
			assert.equal(catalog.listEntries().length, 2);
			assert.equal(await readFile(catalogPath, "utf8"), before);
		},
		{ resolveFilePath: () => undefined },
	);
});

test("#354 a newer scanned or automatic name cannot displace a duplicate's manual title during repair", async () => {
	const original = entry({ title: "User title", originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, updatedAt: 100 });
	const automatic = entry({ id: "duplicate-auto", title: "Automatic title", titleOrigin: "auto", createdAt: 20, updatedAt: 300 });
	await withCatalog([original, automatic], async ({ catalog }) => {
		await catalog.load();
		assert.equal(catalog.listEntries().length, 1);
		assert.equal(catalog.get(original.id).title, "User title");
		assert.equal(catalog.get(original.id).titleOrigin, "manual");
	});
});

test("#354 repeated renames and unchanged confirmations keep Tab, sidebar and search on one repaired record", async () => {
	const original = entry({ originKey: `pi:native:${SESSION_PATH.toLowerCase()}` });
	const duplicate = entry({ id: "scanned-duplicate", createdAt: 20, updatedAt: 200 });
	await withCatalog([original, duplicate], async ({ catalog }) => {
		await catalog.load();
		for (const title of ["A1", "A2", "A2", "A2"]) {
			await catalog.claimTitleOwnership(original.id);
			const renamed = await catalog.update(original.id, { title });
			const records = await catalog.mergeScanned("project-1", [summary(renamed.updatedAt)]);
			assert.equal(records.length, 1, "search must not contain a second title for the same file");
			assert.equal(records[0].id, original.id);
			assert.equal(sidebarTitle(records), title);
			assert.equal(catalog.getRecord(original.id).title, title);
			await catalog.attachRuntime({ sessionId: original.id, filePath: SESSION_PATH, piSessionId: "pi-session" });
			assert.equal(catalog.listEntries().length, 1);
		}
	});
});

test("#354 repair does not collapse distinct POSIX case, imported source identities or WSL distributions", async () => {
	const upper = entry({ id: "upper", originKey: `pi:native:${SESSION_PATH.toLowerCase()}` });
	const lower = entry({ id: "lower", filePath: SESSION_PATH.toLowerCase() });
	const codexA = entry({ id: "codex-a", source: "codex", importedSourceId: "source-a" });
	const codexB = entry({ id: "codex-b", source: "codex", importedSourceId: "source-b" });
	const wslA = entry({ id: "wsl-a", environment: "wsl", wslDistro: "DistroA", wslUser: "user" });
	const wslB = entry({ id: "wsl-b", environment: "wsl", wslDistro: "DistroB", wslUser: "user" });
	const entries = [upper, lower, codexA, codexB, wslA, wslB];
	await withCatalog(entries, async ({ catalog }) => {
		await catalog.load();
		assert.equal(catalog.listEntries().length, entries.length);
		for (const expected of entries) {
			assert.equal(catalog.get(expected.id).originKey, buildSessionOriginKey(expected));
		}
	});
});

test("#354 an unwritable repair snapshot leaves original disk data intact and still repairs the in-memory catalog", async () => {
	const old = entry({ originKey: `pi:native:${SESSION_PATH.toLowerCase()}` });
	await withCatalog(
		[old],
		async ({ catalog, catalogPath }) => {
			const before = await readFile(catalogPath, "utf8");
			await catalog.load();
			assert.equal(catalog.get(old.id).originKey, buildSessionOriginKey(old));
			assert.equal(await readFile(catalogPath, "utf8"), before);
		},
		{
			fsPromises: {
				...fsPromises,
				open: async () => {
					throw Object.assign(new Error("read-only test filesystem"), { code: "EROFS" });
				},
			},
		},
	);
});

// ── 复审回归：三次审查探针转永久行为测试（#354 补丁复审）──

/** 生产 resolver 在项目解析不出来时的行为：按契约原样返回入参（相对路径仍是相对的）。 */
const unresolvedProjectResolver = (_projectId, path) => path;

/** 侧栏/Tab 展示用的最小 summary 形态（catalog 记录 → summary）。 */
function asSummary(record) {
	return { id: record.id, name: record.title, filePath: record.filePath, updatedAt: record.updatedAt, preview: "", messageCount: 1, source: record.source };
}

test("#354 an unresolved relative path is not evidence that two projects share one physical session", async () => {
	const relative = ".pi/sessions/same.jsonl";
	const first = entry({ id: "id-a", projectId: "project-a", filePath: relative });
	const second = entry({ id: "id-b", projectId: "project-b", filePath: relative });
	assert.equal(first.originKey, second.originKey, "the fixture reproduces the colliding relative-path identity key");
	await withCatalog(
		[first, second],
		async ({ catalog, catalogPath }) => {
			const before = await readFile(catalogPath, "utf8");
			await catalog.load();
			assert.deepEqual([...catalog.listEntries().map(({ id }) => id)], ["id-a", "id-b"]);
			assert.equal(await readFile(catalogPath, "utf8"), before, "an unconfirmed path must not rewrite identity keys or drop records");
		},
		{ resolveFilePath: unresolvedProjectResolver },
	);
});

test("#354 a title conflict without authoritative evidence keeps both records for a later retry", async () => {
	const legacy = entry({ id: "legacy-id", originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, title: "A1" });
	const duplicate = entry({ id: "scanned-id", title: "A2", createdAt: 20, updatedAt: 200 });
	await withCatalog([legacy, duplicate], async ({ catalog, createCatalog, catalogPath }) => {
		await catalog.load();
		assert.equal(catalog.listEntries().length, 2, "guessing a title and deleting the other record would lose the newest user title");
		assert.equal(catalog.get("scanned-id").id, "scanned-id");
		assert.equal(catalog.get("legacy-id").mergedSessionIds, undefined);
		const snapshot = await readFile(catalogPath, "utf8");
		const restarted = createCatalog();
		await restarted.load();
		assert.equal(await readFile(catalogPath, "utf8"), snapshot, "an unresolved conflict must stay retryable without churn");
	});
});

test("#354 an unreadable session title leaves the conflict for the next start instead of guessing", async () => {
	const legacy = entry({ id: "legacy-id", originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, title: "A1" });
	const duplicate = entry({ id: "scanned-id", title: "A2", createdAt: 20, updatedAt: 200 });
	await withCatalog(
		[legacy, duplicate],
		async ({ catalog }) => {
			await catalog.load();
			assert.equal(catalog.listEntries().length, 2);
			assert.equal(catalog.get("scanned-id").id, "scanned-id");
		},
		{ fetchTitle: failingTitleRead() },
	);
});

test("#354 a duplicate whose updatedAt was refreshed by a runtime reattach must not outrank the disk's authoritative name", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-identity-repair-rename-"));
	try {
		const filePath = join(dir, "2026-10-07T12-34-56-000Z_abcdef01.jsonl");
		const catalogPath = join(dir, "session-catalog.json");
		await writeFile(filePath, `${JSON.stringify({ type: "session", version: 3, id: "pi-fixture", cwd: dir, timestamp: "2026-10-07T12:34:56.000Z" })}\n`, "utf8");
		const { SessionScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts", { stubs: { electron: { app: { getPath: () => dir }, shell: {} }, "../logging/sharedLogger": { getAppLogger: () => null } } });
		const scanner = new SessionScanner();
		const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
			stubs: { "node:fs/promises": fsPromises, "node:fs": { existsSync: () => true }, "../logging/sharedLogger": { getAppLogger: () => null } },
		});
		// 真实两次改名：旧 ID 记录停在 A1，重复记录持有最后一次成功改名的 A2（磁盘权威名）。
		await scanner.rename(filePath, "A1");
		await scanner.rename(filePath, "A2");
		assert.equal((await scanner.inferSessionNameAndValidity(filePath)).name, "A2");

		/**
		 * 升级前现场：只有 runtime attach（不改标题、不写 JSONL）刷新过旧 ID 记录的 updatedAt，
		 * 于是「谁更新时间新」与「谁持有最后一次改名」完全相反；两侧都是人工标题，优先级也相同。
		 * legacyUpdatedAt 是唯一变量，用来证明仲裁不读这个值。
		 */
		const load = async (legacyUpdatedAt) => {
			const legacy = entry({ id: "legacy-id", filePath, originKey: `pi:native:${filePath.toLowerCase()}`, title: "A1", updatedAt: legacyUpdatedAt });
			const duplicate = entry({ id: "scanned-id", filePath, title: "A2", createdAt: 20, updatedAt: 200 });
			await writeFile(catalogPath, JSON.stringify({ version: 1, sessions: [legacy, duplicate] }), "utf8");
			const catalog = new SessionCatalog(catalogPath, {}, undefined, (path, options) => scanner.inferSessionNameAndValidity(path, options));
			await catalog.load();
			return catalog;
		};

		const staleNewest = await load(900);
		assert.equal(staleNewest.listEntries().length, 1, "the reopened duplicate must fold instead of staying duplicated");
		assert.equal(staleNewest.get("legacy-id").title, "A2", "runtime updatedAt is not the time of the last title change");
		assert.equal(staleNewest.get("scanned-id").id, "legacy-id", "the old duplicate id still resolves to the surviving session");

		const staleOldest = await load(100);
		assert.equal(staleOldest.get("legacy-id").title, "A2", "the arbitration result must not depend on updatedAt at all");
		assert.equal(staleOldest.listEntries().length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("#354 merging a duplicate keeps the persisted pin, tab pin and recent-activity references on the surviving session", async () => {
	const legacy = entry({ id: "legacy-id", originKey: `pi:native:${SESSION_PATH.toLowerCase()}` });
	const duplicate = entry({ id: "scanned-id", title: "A2", createdAt: 20, updatedAt: 200 });
	await withCatalog(
		[legacy, duplicate],
		async ({ catalog, createCatalog, catalogPath }) => {
			await catalog.load();
			const records = catalog.listEntries();
			assert.equal(records.length, 1);
			assert.equal(records[0].id, legacy.id);
			const aliases = buildSessionIdAliasMap(records);
			// 三条生产迁移入口：主进程 settings 置顶（migrateSessionIdList）、Tab 列表/置顶
			// （migrateAndPruneSessionTabIds）、最近活动（remapSessionIdActivities）。
			assert.deepEqual([...migrateSessionIdList([duplicate.id], records)], [legacy.id]);
			assert.deepEqual([...remapSessionIds([duplicate.id], aliases)], [legacy.id]);
			assert.deepEqual(
				[...remapSessionIdActivities([{ sessionId: duplicate.id, projectId: "project-1", at: 1 }], aliases)].map((entry) => ({ ...entry })),
				[{ sessionId: legacy.id, projectId: "project-1", at: 1 }],
			);
			const recordsById = Object.fromEntries(records.map((record) => [record.id, record]));
			const seenSessionIds = new Set([duplicate.id, "deleted-session", legacy.id]);
			const migratedTabPin = migrateAndPruneSessionTabIds([duplicate.id, "deleted-session"], aliases, recordsById, seenSessionIds);
			assert.deepEqual([...migratedTabPin], [legacy.id], "the migrated tab pin survives while the really deleted tab is pruned");
			// 启动首帧的空记录表、尚未加载的项目都不能当「已删除」：迁移照做、置顶必须留下。
			assert.deepEqual([...migrateAndPruneSessionTabIds([duplicate.id], aliases, {}, new Set())], [legacy.id]);
			assert.deepEqual([...migrateAndPruneSessionTabIds(["not-loaded-yet"], aliases, {}, new Set())], ["not-loaded-yet"]);
			// 侧栏置顶：迁移后的 pin 命中存活行（原探针的本地 Set 不会被 catalog 改写，这里走生产迁移结果）。
			const pinned = new Set(migrateSessionIdList([duplicate.id], records));
			const display = getProjectAgentSessionDisplay({ agents: [], sessions: records.map(asSummary), pinnedSessionIds: pinned });
			assert.equal(display.children.length, 1);
			assert.equal(pinned.has(display.children[0].session.id), true, "discarding a duplicate ID must migrate persisted references to the surviving ID");
			// 未迁移完的迟到引用：仍解析到同一会话，而不是「会话不存在」。
			assert.equal(catalog.resolveSessionId(duplicate.id), legacy.id);
			assert.equal(catalog.getRecord(duplicate.id).id, legacy.id);
			assert.equal((await catalog.update(duplicate.id, { title: "renamed" })).id, legacy.id);
			assert.equal(catalog.get(legacy.id).title, "renamed");
			// 重启幂等：别名随原子快照落盘，重放结果一致。
			const snapshot = await readFile(catalogPath, "utf8");
			const restarted = createCatalog();
			await restarted.load();
			assert.equal(restarted.get(duplicate.id).id, legacy.id);
			assert.equal(restarted.resolveSessionId(duplicate.id), legacy.id);
			assert.equal(await readFile(catalogPath, "utf8"), snapshot);
		},
		{ fetchTitle: authoritativeTitle("A2") },
	);
});

test("#354 a later repair round keeps the aliases recorded by earlier rounds resolvable", async () => {
	const legacy = entry({ id: "legacy-id", originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, mergedSessionIds: ["earlier-id"] });
	const duplicate = entry({ id: "scanned-id", title: "A2", createdAt: 20, updatedAt: 200 });
	await withCatalog(
		[legacy, duplicate],
		async ({ catalog }) => {
			await catalog.load();
			assert.deepEqual([...catalog.get("legacy-id").mergedSessionIds], ["earlier-id", "scanned-id"]);
			assert.equal(catalog.get("earlier-id").id, "legacy-id", "aliases from previous rounds must stay resolvable");
			assert.equal(catalog.get("scanned-id").id, "legacy-id");
		},
		{ fetchTitle: authoritativeTitle("A2") },
	);
});

test("#354 an alias that collides with a real session id is dropped instead of shadowing it", async () => {
	const legacy = entry({ id: "legacy-id", originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, mergedSessionIds: ["other-session", "legacy-id"] });
	const other = entry({ id: "other-session", filePath: "/Users/Fixture/Project/.pi/sessions/other.jsonl" });
	await withCatalog([legacy, other], async ({ catalog, catalogPath }) => {
		await catalog.load();
		assert.equal(catalog.get("other-session").id, "other-session", "a real session must never be shadowed by an alias");
		assert.equal(catalog.get("legacy-id").mergedSessionIds, undefined);
		assert.equal(
			JSON.parse(await readFile(catalogPath, "utf8")).sessions.every((record) => !record.mergedSessionIds),
			true,
		);
	});
});

test("#354 Windows drive case variants merge while UNC and POSIX paths keep separate identities", async () => {
	const winLegacy = entry({ id: "win-upper", filePath: "C:\\Project\\.pi\\sessions\\a.jsonl", originKey: `pi:native:${"c:/project/.pi/sessions/a.jsonl"}` });
	const winScanned = entry({ id: "win-lower", filePath: "c:/Project/.pi/sessions/a.jsonl" });
	const unc = entry({ id: "unc", filePath: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\proj\\.pi\\sessions\\a.jsonl" });
	const posix = entry({ id: "posix", filePath: "/home/dev/proj/.pi/sessions/a.jsonl" });
	await withCatalog([winLegacy, winScanned, unc, posix], async ({ catalog }) => {
		await catalog.load();
		assert.equal(catalog.listEntries().length, 3, "UNC and POSIX absolute paths are different sessions");
		assert.equal(catalog.get("win-upper").id, "win-upper", "the legacy lower-case key record keeps its stable ID");
		assert.equal(catalog.get("win-lower").id, "win-upper");
		assert.equal(catalog.get("win-upper").mergedSessionIds[0], "win-lower");
		assert.notEqual(catalog.get("unc").originKey, catalog.get("posix").originKey);
	});
});

// ── 复审回归（#354 续修）：运行时归并必须过同一道标题仲裁，延期归并组必须保住原始证据 ──

/** 第一次读盘失败、之后成功：复现「启动时延期归并，运行时/下次启动才拿到权威名」的真实顺序。 */
function deferredAuthoritativeTitle(name) {
	let failedOnce = false;
	return () => {
		if (!failedOnce) {
			failedOnce = true;
			return Promise.reject(new Error("temporary failure"));
		}
		return Promise.resolve({ name, nameFromSessionInfo: true });
	};
}

test("#354 a conservative title conflict survives a runtime attach without dropping either identity", async () => {
	const legacy = entry({ id: "legacy-id", originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, title: "A1" });
	const duplicate = entry({ id: "scanned-id", title: "A2", createdAt: 20, updatedAt: 200 });
	await withCatalog(
		[legacy, duplicate],
		async ({ catalog, catalogPath, createRestarted }) => {
			await catalog.load();
			assert.equal(catalog.listEntries().length, 2);
			await catalog.attachRuntime({ sessionId: legacy.id, filePath: SESSION_PATH, piSessionId: "pi-test" });
			assert.equal(catalog.listEntries().length, 2, "the startup decision to keep an unresolved conflict must survive the destructive runtime attach");
			assert.equal(catalog.get(duplicate.id).title, "A2");
			assert.equal(catalog.get(legacy.id).mergedSessionIds, undefined, "an unresolved conflict must not record a merge alias");
			// 不改写旧身份键：它是「这条记录是升级前旧键」的唯一证据，改写后下次启动会按 createdAt 错选存活 ID。
			assert.equal(catalog.get(legacy.id).originKey, `pi:native:${SESSION_PATH.toLowerCase()}`);
			assert.equal(JSON.parse(await readFile(catalogPath, "utf8")).sessions.find((record) => record.id === legacy.id).originKey, `pi:native:${SESSION_PATH.toLowerCase()}`);
			// 下次启动拿到权威名后仍能归并到原来的稳定 ID。
			const retried = createRestarted();
			await retried.load();
			assert.equal(retried.listEntries().length, 1);
			assert.equal(retried.listEntries()[0].id, legacy.id);
			assert.equal(retried.get(legacy.id).title, "A2");
			assert.deepEqual([...retried.get(legacy.id).mergedSessionIds], [duplicate.id]);
		},
		{ restartFetchTitle: authoritativeTitle("A2") },
	);
});

test("#354 a runtime attach absorbs every same-source duplicate once the bounded disk name resolves the conflict", async () => {
	const legacy = entry({ id: "legacy-id", originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, title: "A1", model: { provider: "provider", modelId: "model" } });
	const scanned = entry({ id: "scanned-id", title: "A2", createdAt: 20, thinkingLevel: "high", updatedAt: 200 });
	// 保留旧身份键的同源兄弟（延期未决的组会留下这类记录）：同源判定必须看现场重算键。
	const third = entry({ id: "third-id", originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, title: "A3", createdAt: 30, updatedAt: 250 });
	await withCatalog(
		[legacy, scanned, third],
		async ({ catalog }) => {
			await catalog.load();
			assert.equal(catalog.listEntries().length, 3, "the first read failed, so the group stays retryable until the runtime attach reads the disk name");
			const attached = await catalog.attachRuntime({ sessionId: legacy.id, filePath: SESSION_PATH, piSessionId: "pi-live" });
			assert.equal(catalog.listEntries().length, 1, "every same-origin duplicate must be absorbed, not only the first one found");
			assert.equal(attached.id, legacy.id);
			assert.equal(catalog.get(legacy.id).title, "A2", "the disk-selected title must win the same conflict at the runtime merge point");
			assert.equal(catalog.get(legacy.id).model.modelId, "model", "the attached entry keeps its own preferences");
			assert.equal(catalog.get(legacy.id).thinkingLevel, "high", "metadata missing on the survivor is taken from the absorbed duplicate");
			assert.ok(catalog.get(legacy.id).updatedAt > 250, "the runtime attach still refreshes updatedAt");
			assert.deepEqual([...catalog.get(legacy.id).mergedSessionIds].sort(), ["scanned-id", "third-id"]);
			assert.equal(catalog.get(scanned.id).id, legacy.id);
			assert.equal(catalog.get(third.id).id, legacy.id);
		},
		{ fetchTitle: deferredAuthoritativeTitle("A2") },
	);
});

test("#354 a three-way arbitration keeps its disk-selected title after a later original-ID win", async () => {
	const evidence = entry({ id: "evidence-id", title: "A2", createdAt: 20 });
	const third = entry({ id: "third-id", title: "A3", createdAt: 30 });
	const legacy = entry({ id: "legacy-id", originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, title: "A1", createdAt: 40 });
	await withCatalog(
		[evidence, third, legacy],
		async ({ catalog }) => {
			await catalog.load();
			assert.equal(catalog.listEntries().length, 1);
			assert.equal(catalog.listEntries()[0].id, legacy.id, "the legacy-key record keeps the stable ID");
			assert.equal(catalog.get(legacy.id).title, "A2", "the evidence title must survive the later pairwise merge that rebuilds the entry");
			assert.equal(catalog.get(legacy.id).titleOrigin, "manual");
			assert.deepEqual([...catalog.get(legacy.id).mergedSessionIds].sort(), ["evidence-id", "third-id"]);
		},
		{ fetchTitle: authoritativeTitle("A2") },
	);
});

test("#354 a deferred arbitration keeps the evidence identifying the original stable ID for its next retry", async () => {
	const legacy = entry({ id: "legacy-id", originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, title: "A1", createdAt: 40 });
	const duplicate = entry({ id: "scanned-id", title: "A2", createdAt: 20, updatedAt: 200 });
	await withCatalog(
		[legacy, duplicate],
		async ({ catalog, createRestarted }) => {
			await catalog.load();
			assert.equal(catalog.listEntries().length, 2);
			const retried = createRestarted();
			await retried.load();
			assert.equal(retried.listEntries().length, 1);
			assert.equal(retried.listEntries()[0].id, legacy.id, "an unresolved group must keep its old identity key on disk; normalizing it erases the evidence that this ID is the upgrade-era record");
			assert.equal(retried.get(legacy.id).title, "A2");
		},
		{ fetchTitle: failingTitleRead(), restartFetchTitle: authoritativeTitle("A2") },
	);
});

test("#354 alias metadata of the wrong JSON type must not abort catalog startup or explode into per-character aliases", async () => {
	const numeric = entry({ id: "legacy-numeric", mergedSessionIds: 42 });
	const textual = entry({ id: "legacy-text", filePath: "/Users/Fixture/Project/.pi/sessions/other.jsonl", mergedSessionIds: "abc" });
	await withCatalog([numeric, textual], async ({ catalog }) => {
		await catalog.load();
		assert.equal(catalog.get(numeric.id).id, numeric.id);
		assert.equal(catalog.get(numeric.id).mergedSessionIds, undefined);
		assert.equal(catalog.get(textual.id).mergedSessionIds, undefined);
		assert.equal(catalog.get("a"), undefined, "a string alias table must never be split into per-character aliases");
	});
});

// ── 边界收口回归（#354 最终复审）：破坏性操作的物理确认、整组标题归属、queued mutation 执行时身份 ──

test("#354 a runtime attach does not fold records whose relative paths only collide as strings", async () => {
	const relative = ".pi/sessions/same.jsonl";
	const first = entry({ id: "id-a", projectId: "project-a", filePath: relative });
	const second = entry({ id: "id-b", projectId: "project-b", filePath: relative });
	assert.equal(first.originKey, second.originKey, "the fixture reproduces the colliding relative-path identity key");
	await withCatalog(
		[first, second],
		async ({ catalog, catalogPath }) => {
			await catalog.load();
			await catalog.attachRuntime({ sessionId: "id-a", filePath: relative, piSessionId: "pi-a" });
			assert.deepEqual([...catalog.listEntries().map(({ id }) => id)], ["id-a", "id-b"], "the absolute-path confirmation must gate the destructive runtime attach too, not only startup");
			assert.equal(catalog.get("id-b").projectId, "project-b");
			assert.equal(JSON.parse(await readFile(catalogPath, "utf8")).sessions.length, 2, "an unconfirmed path must not drop the other project's record");
		},
		{ resolveFilePath: unresolvedProjectResolver },
	);
});

test("#354 a runtime attach gives the merged group the highest title tier instead of the surviving draft label", async () => {
	const scanned = entry({ id: "scanned-id", title: "Manual title" });
	await withCatalog([scanned], async ({ catalog }) => {
		await catalog.load();
		const draft = await catalog.createDraft({ projectId: "project-1", title: "Provisional title", environment: "native" });
		await catalog.attachRuntime({ sessionId: draft.id, filePath: SESSION_PATH, piSessionId: "pi-a" });
		assert.equal(catalog.listEntries().length, 1);
		assert.equal(catalog.get(draft.id).title, "Manual title", "a provisional draft must not swallow the scanner-owned manual title");
		assert.equal(catalog.get(draft.id).titleOrigin, "manual");
		assert.equal(catalog.get(draft.id).titleLocked, true);
		assert.equal(catalog.get("scanned-id").id, draft.id);
	});
});

test("#354 a mutation queued under an absorbed ID resolves when its transaction executes", async () => {
	const scanned = entry({ id: "scanned-id", title: "A" });
	await withCatalog([scanned], async ({ catalog, catalogPath }) => {
		await catalog.load();
		const draft = await catalog.createDraft({ projectId: "project-1", title: "A", environment: "native" });
		// 真实顺序：attach 先入队，改名在 attach 提交前入队（此时 scanned-id 还存在）。
		const attach = catalog.attachRuntime({ sessionId: draft.id, filePath: SESSION_PATH, piSessionId: "pi-a" });
		const rename = catalog.update("scanned-id", { title: "Newest manual title" });
		const results = await Promise.allSettled([attach, rename]);
		assert.equal(results[0].status, "fulfilled");
		assert.equal(results[1].status, "fulfilled", "alias resolution must run inside the mutation queue after earlier merges, not only when enqueueing");
		assert.equal(catalog.get(draft.id).title, "Newest manual title");
		assert.equal(catalog.get("scanned-id").id, draft.id, "the absorbed ID keeps resolving to the surviving record");
		assert.equal(JSON.parse(await readFile(catalogPath, "utf8")).sessions[0].title, "Newest manual title");
	});
});
