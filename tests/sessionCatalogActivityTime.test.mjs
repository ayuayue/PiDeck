import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost as createHookHost } from "./helpers/quickMessageHookHost.mjs";

const { buildSessionOriginKey } = loadTsCommonJs("src/shared/sessionIdentity.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const { sessionRecordToSummary } = loadTsCommonJs("src/renderer/src/atoms/session-selectors.ts", { stubs: { "./session-atoms": {} } });
const { getProjectAgentSessionDisplay } = loadTsCommonJs("src/renderer/src/agentListDisplay.ts");

/** 完整目录记录：活动时间与标题所有权独立，不靠锁定标题冻结排序。 */
function entry(filePath, overrides = {}) {
	const record = { id: "session-a", projectId: "project-1", title: "A", titleOrigin: "manual", titleLocked: true, source: "pi", environment: "native", filePath, status: "active", createdAt: 100, updatedAt: 1000, ...overrides };
	return { ...record, originKey: buildSessionOriginKey(record) };
}

/** 所有 JSONL、目录快照和 scanner 缓存均在可清理的临时目录内。 */
async function withFixture(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-activity-"));
	const home = join(dir, "Home");
	const projectPath = join(dir, "Project");
	const sessionDir = join(home, ".pi", "agent", "sessions", "AuditProject");
	const catalogPath = join(dir, "session-catalog.json");
	try {
		await mkdir(sessionDir, { recursive: true });
		const { SessionScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts", {
			stubs: { electron: { app: { getPath: (name) => (name === "home" ? home : join(dir, "userData")) }, shell: {} }, "../logging/sharedLogger": { getAppLogger: () => null } },
		});
		const scanner = new SessionScanner();
		const createCatalog = () =>
			new SessionCatalog(
				catalogPath,
				{},
				(_projectId, filePath) => filePath,
				(filePath, options) => scanner.inferSessionNameAndValidity(filePath, options),
			);
		const createSession = async (id, title, updatedAt) => {
			const filePath = join(sessionDir, `2026-10-12T05-22-29-530Z_${id}.jsonl`);
			const lines = [
				{ type: "session", version: 3, id, timestamp: "2026-10-12T05:22:29.530Z", cwd: projectPath },
				{ type: "message", id: `${id}-user`, parentId: null, message: { role: "user", content: "Disposable activity fixture" } },
				{ type: "session_info", id: `${id}-name`, parentId: `${id}-user`, name: title },
			];
			await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
			await utimes(filePath, new Date(updatedAt), new Date(updatedAt));
			return filePath;
		};
		const seed = async (entries) => {
			await writeFile(catalogPath, JSON.stringify({ version: 1, sessions: entries }), "utf8");
			const catalog = createCatalog();
			await catalog.load();
			return catalog;
		};
		await run({ scanner, createCatalog, createSession, seed, catalogPath, projectPath });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("#354 a pre-rename scan cannot rewind persisted activity, sorting or restart state", async () => {
	await withFixture(async ({ scanner, createCatalog, createSession, seed, catalogPath }) => {
		const aPath = await createSession("abcdef01", "A", 1000);
		const bPath = await createSession("abcdef11", "B", 5000);
		const catalog = await seed([entry(aPath), entry(bPath, { id: "session-b", title: "B", updatedAt: 5000 })]);
		const staleSummaries = await scanner.list();
		assert.equal(staleSummaries.length, 2);
		await catalog.claimTitleOwnership("session-a");
		await scanner.rename(aPath, "A1");
		const renamed = await catalog.update("session-a", { title: "A1" });
		const renamedJsonl = await readFile(aPath, "utf8");
		await catalog.mergeScanned("project-1", staleSummaries);
		assert.equal(catalog.get("session-a").updatedAt, renamed.updatedAt);
		assert.equal(catalog.get("session-a").title, "A1");
		const persisted = JSON.parse(await readFile(catalogPath, "utf8"));
		assert.equal(persisted.sessions.find((record) => record.id === "session-a").updatedAt, renamed.updatedAt);
		const restarted = createCatalog();
		await restarted.load();
		const sorted = restarted.listEntries().sort((left, right) => right.updatedAt - left.updatedAt);
		assert.equal(sorted[0].id, "session-a");
		assert.equal(sorted[0].updatedAt, renamed.updatedAt);
		assert.equal(sorted[0].title, "A1");
		assert.equal(await readFile(aPath, "utf8"), renamedJsonl, "merging stale activity must not rewrite the session file");
	});
});

test("#354 scan return values expose the same latest activity as cached catalog records", async () => {
	await withFixture(async ({ scanner, createSession, seed }) => {
		const filePath = await createSession("abcdef01", "A", 1000);
		const catalog = await seed([entry(filePath, { updatedAt: 10000 })]);
		const [returned] = await catalog.mergeScanned("project-1", await scanner.list());
		assert.equal(returned.updatedAt, 10000, "the record projection must not prefer an older summary timestamp");
		assert.equal(returned.updatedAt, catalog.getRecord("session-a").updatedAt);
	});
});

for (const titleOrigin of ["manual", "auto"]) {
	test(`#354 newer content activity still advances a ${titleOrigin} title without renaming it`, async () => {
		await withFixture(async ({ scanner, createSession, seed, catalogPath }) => {
			const filePath = await createSession("abcdef01", "A", 1000);
			const catalog = await seed([entry(filePath, { titleOrigin, updatedAt: 5000 })]);
			await appendFile(filePath, `${JSON.stringify({ type: "message", id: "later-user", parentId: null, message: { role: "user", content: "Later content activity" } })}\n`, "utf8");
			await utimes(filePath, new Date(20000), new Date(20000));
			const [returned] = await catalog.mergeScanned("project-1", await scanner.list());
			assert.equal(returned.updatedAt, 20000);
			assert.equal(catalog.get("session-a").updatedAt, 20000);
			assert.equal(catalog.get("session-a").titleOrigin, titleOrigin);
			assert.equal(returned.title, "A");
			assert.equal(JSON.parse(await readFile(catalogPath, "utf8")).sessions[0].updatedAt, 20000);
		});
	});
}

test("#354 out-of-order scans preserve newer file activity in storage and returned records", async () => {
	await withFixture(async ({ scanner, createSession, seed }) => {
		const filePath = await createSession("abcdef01", "A", 1000);
		const catalog = await seed([entry(filePath)]);
		const older = await scanner.list();
		await utimes(filePath, new Date(20000), new Date(20000));
		await catalog.mergeScanned("project-1", await scanner.list());
		const [returned] = await catalog.mergeScanned("project-1", older);
		assert.equal(catalog.get("session-a").updatedAt, 20000);
		assert.equal(returned.updatedAt, 20000);
	});
});

test("#354 repeated older scans do not rewrite an unchanged catalog or rotate its backup", async () => {
	await withFixture(async ({ scanner, createSession, seed, catalogPath }) => {
		const filePath = await createSession("abcdef01", "A", 1000);
		const catalog = await seed([entry(filePath)]);
		const summaries = await scanner.list();
		await catalog.update("session-a", { updatedAt: 10000 });
		const snapshot = await readFile(catalogPath, "utf8");
		const backup = await readFile(`${catalogPath}.bak`, "utf8");
		const version = await stat(catalogPath);
		for (let index = 0; index < 2; index += 1) await catalog.mergeScanned("project-1", summaries);
		assert.equal(await readFile(catalogPath, "utf8"), snapshot);
		assert.equal(await readFile(`${catalogPath}.bak`, "utf8"), backup);
		assert.equal((await stat(catalogPath)).mtimeMs, version.mtimeMs);
	});
});

/** 注册真实重命名/目录 IPC，暂停后台扫描，验证界面不依赖扫描完成或推送。 */
function createIpc(catalog, scanner, projectPath) {
	const handlers = new Map();
	const pausedScans = [];
	const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, dialog: {} },
			"../sessions/BackgroundScanCoordinator": {
				BackgroundScanCoordinator: class {
					schedule(projectId, task) {
						pausedScans.push({ projectId, task });
						return true;
					}
				},
			},
		},
	});
	registerSessionIpc({
		projectStore: { get: (id) => (id === "project-1" ? { id, path: projectPath } : undefined) },
		settingsStore: { get: () => ({}) },
		sessionCatalog: catalog,
		sessionScanner: scanner,
		sessionRuntimeCoordinator: { getTarget: () => undefined, hasLiveRuntime: () => false },
		agentManager: { list: () => [] },
		appLogger: { info: () => undefined, warn: () => undefined },
		mainCopy: (key) => key,
		getMainWindow: () => null,
	});
	return {
		pausedScans,
		listCatalog: (projectId, options) => handlers.get(ipcChannels.sessionsCatalogList)({}, projectId, options),
		renameSession: (id, title) => handlers.get(ipcChannels.sessionsCatalogUpdate)({}, id, { title }),
	};
}

test("#354 historical rename updates Tab, sidebar and search before any background scan completes", async () => {
	await withFixture(async ({ scanner, createSession, seed, projectPath }) => {
		const filePath = await createSession("abcdef01", "A", 1000);
		const catalog = await seed([entry(filePath)]);
		const ipc = createIpc(catalog, scanner, projectPath);
		const syncHost = createHookHost();
		const renameHost = createHookHost();
		const { useProjectSync } = loadTsCommonJs("src/renderer/src/hooks/useProjectSync.ts", { stubs: { react: syncHost.react, "../atoms/session-selectors": { sessionRecordToSummary } } });
		const { useRename } = loadTsCommonJs("src/renderer/src/hooks/useRename.ts", { stubs: { react: renameHost.react, "../i18n": { t: (key) => key } } });
		let records = [];
		const syncInput = {
			projects: [],
			activeProjectId: "project-1",
			setProjects: () => undefined,
			setActiveProjectId: () => undefined,
			replaceProjectSessions: (input) => {
				records = input.sessions;
			},
			api: { sessions: { listCatalog: ipc.listCatalog } },
			showToast: () => undefined,
			t: (key) => key,
		};
		const sync = syncHost.render(() => useProjectSync(syncInput));
		const renameApi = { renameSession: ipc.renameSession, refreshProjectSessions: sync.refreshProjectSessions, showToast: () => undefined };
		const renderRename = () => renameHost.render(() => useRename(renameApi));
		try {
			await sync.refreshProjectSessions("project-1");
			for (const title of ["A1", "A2"]) {
				renderRename().openSessionRename("project-1", sessionRecordToSummary(records[0]));
				renderRename().renameModalsProps.rename.onValueChange(title);
				await renderRename().submitSessionRename();
				const tabRecord = records.find((record) => record.id === "session-a");
				const display = getProjectAgentSessionDisplay({ agents: [], sessions: records.map(sessionRecordToSummary) });
				assert.equal(tabRecord.title, title);
				assert.equal(display.children.length, 1);
				assert.equal(display.children[0].session.name, title);
				assert.deepEqual(
					Array.from(records, (record) => record.title),
					[title],
					"search reads only the updated canonical record",
				);
				assert.equal((await scanner.inferSessionNameAndValidity(filePath)).name, title);
			}
			assert.equal(ipc.pausedScans.length, 3, "initial refresh and both rename refreshes return without executing a scan");
		} finally {
			renameHost.unmount();
			syncHost.unmount();
		}
	});
});
