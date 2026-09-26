import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const JOURNAL_FILE = "remote-host-rebind.json";
const LOCK_FILE = "remote-host-rebind.lock";

/** 端口契约（HostRebindJournal §4.4）：before/after 与读回的 locator 都是这份规范 JSON。 */
const { HostRebindJournal, canonicalHostLocatorJson } = loadTsCommonJs("src/main/remote/HostRebindJournal.ts");

/** 跨 VM realm 的对象比较前先归一化：deepStrictEqual 会比较原型，两个 realm 的字面量原型不同。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function sshLocator(hostId, overrides = {}) {
	return { kind: "ssh", hostId, remotePath: "/srv/app/.pi/sessions/one.jsonl", remoteSessionId: "remote-1", ...overrides };
}

function canonicalSshLocator(hostId, overrides = {}) {
	return canonicalHostLocatorJson(sshLocator(hostId, overrides));
}

async function makeTempDir(t, prefix) {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

/** 生产 ProjectStore：electron 只用到 app.getPath("userData") 与 dialog。 */
function loadProjectStore(userData) {
	return loadTsCommonJs("src/main/projects/ProjectStore.ts", { stubs: { electron: { app: { getPath: () => userData }, dialog: {} } } });
}

/** 生产 SessionCatalog；fsPromises 可注入（崩溃注入用例要拦 rename），logger 走空实现。 */
function loadSessionCatalog(fsPromises = nodeRequire("node:fs/promises")) {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: {
			"node:fs/promises": fsPromises,
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
}

/**
 * rename 故障注入（模拟"中途崩溃"）：`before-landing` 让主文件替换前抛错（写没落地），
 * `after-landing` 让替换已落地后再抛错（调用方看到异常，但磁盘已经变了）。
 */
function loadCatalogWithRenameFault(catalogPath, faults) {
	const realFs = nodeRequire("node:fs/promises");
	const injected = () => Object.assign(new Error("EIO: injected rename failure"), { code: "EIO" });
	const stub = {
		...realFs,
		async rename(from, to) {
			const isPrimary = String(to) === catalogPath;
			if (isPrimary && faults.mode === "before-landing") throw injected();
			await realFs.rename(from, to);
			if (isPrimary && faults.mode === "after-landing") throw injected();
		},
	};
	return loadSessionCatalog(stub);
}

function projectFixture(id, name, path, extra = {}) {
	return { id, name, path, lastOpenedAt: 1, environment: "windows", ...extra };
}

function catalogEntry(overrides = {}) {
	return { id: "s-1", projectId: "project-1", title: "Entry", titleLocked: true, titleOrigin: "manual", source: "pi", environment: "native", status: "active", createdAt: 1, updatedAt: 1, ...overrides };
}

function scanSummary(filePath, overrides = {}) {
	return { id: filePath, filePath, name: "Scanned local", preview: "hello", updatedAt: 500, messageCount: 1, source: "pi", ...overrides };
}

async function writeProjectsFixture(userData, projects, revision) {
	const { encodeProjectStoreSnapshot } = loadTsCommonJs("src/main/projects/projectStoreCodec.ts");
	await mkdir(userData, { recursive: true });
	const filePath = join(userData, "projects.json");
	await writeFile(filePath, JSON.stringify(encodeProjectStoreSnapshot(projects, revision)), "utf8");
	return filePath;
}

async function loadProjectStoreFixture(userData, projects, revision) {
	const filePath = await writeProjectsFixture(userData, projects, revision);
	const { ProjectStore } = loadProjectStore(userData);
	const store = new ProjectStore();
	await store.load();
	return { store, filePath };
}

async function writeCatalogFixture(catalogPath, sessions) {
	await mkdir(dirname(catalogPath), { recursive: true });
	await writeFile(catalogPath, JSON.stringify({ version: 1, sessions }, null, 2), "utf8");
}

function journalOf(records, overrides = {}) {
	return {
		schemaVersion: 1,
		txId: "tx-1",
		createdAt: "2026-09-01T00:00:00.000Z",
		stage: "prepared",
		source: { hostId: SOURCE, endpointDigest: "a".repeat(64), disabled: false },
		target: { hostId: TARGET, endpointDigest: "b".repeat(64), knownHostsSha256: "c".repeat(64) },
		expectedHostRevision: 1,
		records,
		referenceScan: { complete: true, count: records.length },
		...overrides,
	};
}

function createHostModel() {
	const model = {
		revision: 1,
		profiles: [
			{ hostId: SOURCE, disabled: false, verified: true },
			{ hostId: TARGET, disabled: false, verified: true },
		],
		retiredHostIds: [],
		calls: [],
		scanIds: [],
		scanComplete: true,
	};
	const host = {
		async readHostState() {
			return { revision: model.revision, profiles: model.profiles, retiredHostIds: model.retiredHostIds };
		},
		async verifyTargetAnchor(hostId) {
			model.calls.push(`anchor:${hostId}`);
		},
		async disableSource(hostId) {
			model.calls.push("disable");
			model.profiles = model.profiles.map((profile) => (profile.hostId === hostId ? { ...profile, disabled: true } : profile));
			model.revision += 1;
			return model.revision;
		},
		async retireSource(hostId) {
			model.calls.push("retire");
			model.profiles = model.profiles.filter((profile) => profile.hostId !== hostId);
			model.retiredHostIds = [...model.retiredHostIds, hostId];
			model.revision += 1;
			return model.revision;
		},
		async scanReferences() {
			model.calls.push("scan");
			return { complete: model.scanComplete, referencedHostIds: new Set(model.scanIds) };
		},
	};
	return { model, host };
}

function sourceProfile(model) {
	return model.profiles.find((profile) => profile.hostId === SOURCE);
}

async function captureRejection(operation) {
	try {
		await operation();
	} catch (error) {
		return error.message;
	}
	return undefined;
}

async function tempFilesIn(directory) {
	return (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
}

// ---------------------------------------------------------------------------
// ProjectStore：canHoldHostReferences=false 的诚实形态
// ---------------------------------------------------------------------------

test("the project port declares it cannot hold host references and reads its real local locators", async (t) => {
	const userData = await makeTempDir(t, "pideck-rebind-port-projects-");
	const { store } = await loadProjectStoreFixture(userData, [projectFixture("p-1", "local", "/srv/app")], 3);

	assert.equal(store.canHoldHostReferences, false, "projects.json 读到 ssh 就被 codec 拒绝 ⇒ 结构上装不下 host 引用（设计 Q6）");

	const snapshots = plain(await store.readHostRecordLocators(["p-1", "p-missing"]));
	assert.equal(snapshots.length, 2, "每个被请求的 recordId 都必须回一条 snapshot");
	const locator = JSON.parse(snapshots[0].locator);
	assert.equal(snapshots[0].recordId, "p-1");
	assert.equal(locator.kind, "local", "只读端口如实返回记录真实持有的 local locator，不编造 ssh");
	assert.equal(locator.localPath, "/srv/app");
	assert.equal(locator.hostId, undefined);
	assert.equal(snapshots[0].locator, canonicalHostLocatorJson(locator), "读回的 locator 必须是规范 JSON");
	assert.deepEqual(snapshots[1], { recordId: "p-missing" }, "记录不存在 ⇒ 缺省 locator（收敛侧判 RECORD_MISSING，INV-6）");
});

test("the project port refuses every rebind patch and never writes", async (t) => {
	const userData = await makeTempDir(t, "pideck-rebind-port-projects-refuse-");
	const { store, filePath } = await loadProjectStoreFixture(userData, [projectFixture("p-1", "local", "/srv/app")], 3);
	const before = await readFile(filePath, "utf8");
	const backupBefore = await readFile(`${filePath}.bak`, "utf8");
	const revisionBefore = JSON.parse(before).revision;
	const localLocator = (await store.readHostRecordLocators(["p-1"]))[0].locator;

	// 用"与当前 locator 完全匹配"的 before：证明拒绝不是 CAS 不匹配，而是这个 store 根本不能迁移
	const error = await captureRejection(() => store.applyHostRebind("tx-projects", [{ recordId: "p-1", beforeLocator: localLocator, afterLocator: canonicalSshLocator(TARGET) }]));
	assert.equal(error, "PROJECT_STORE_REMOTE_UNSUPPORTED");
	assert.equal(await readFile(filePath, "utf8"), before, "projects.json 逐字节不变（没有走 save()）");
	assert.equal(await readFile(`${filePath}.bak`, "utf8"), backupBefore, ".bak 也没被轮换");
	assert.equal(JSON.parse(await readFile(filePath, "utf8")).revision, revisionBefore, "revision 不前进 = save() 没被调用");
	assert.deepEqual(await tempFilesIn(userData), [], "没有留下半截临时文件");

	// 空补丁是合法 no-op；形状非法的补丁也不能漏成非稳定错误
	assert.deepEqual(plain(await store.applyHostRebind("tx-projects", [])), []);
	assert.equal(await captureRejection(() => store.applyHostRebind("tx-projects", undefined)), "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
	assert.equal(await readFile(filePath, "utf8"), before);

	// 正向对照：store 自己的写入口照旧可用（revision 前进只可能来自 save()）
	await store.rename("p-1", "renamed");
	const after = JSON.parse(await readFile(filePath, "utf8"));
	assert.equal(after.revision, revisionBefore + 1);
	assert.equal(after.projects.find((project) => project.id === "p-1").name, "renamed");
});

test("the project port fails closed with PROJECT_STORE_NEEDS_REPAIR while the store needs repair", async (t) => {
	const userData = await makeTempDir(t, "pideck-rebind-port-projects-repair-");
	const filePath = join(userData, "projects.json");
	await writeFile(filePath, "{truncated-primary", "utf8");
	await writeFile(`${filePath}.bak`, "{truncated-backup", "utf8");
	const { ProjectStore } = loadProjectStore(userData);
	const store = new ProjectStore();
	await assert.rejects(store.load(), (error) => error.code === "PROJECT_STORE_NEEDS_REPAIR");

	assert.equal(await captureRejection(() => store.readHostRecordLocators(["p-1"])), "PROJECT_STORE_NEEDS_REPAIR");
	assert.equal(await captureRejection(() => store.applyHostRebind("tx", [{ recordId: "p-1", beforeLocator: "{}", afterLocator: "{}" }])), "PROJECT_STORE_NEEDS_REPAIR");
	assert.equal(await readFile(filePath, "utf8"), "{truncated-primary", "修复态下不得写盘");
	assert.equal(await readFile(`${filePath}.bak`, "utf8"), "{truncated-backup");
});

// ---------------------------------------------------------------------------
// SessionCatalog：读端口 / 逐记录 CAS / locator 漂移
// ---------------------------------------------------------------------------

test("the session port returns one canonical locator snapshot per requested record", async (t) => {
	const directory = await makeTempDir(t, "pideck-rebind-port-sessions-read-");
	const catalogPath = join(directory, "session-catalog.json");
	const localLocator = { kind: "local", environment: "native", filePath: "/srv/app/local.jsonl" };
	await writeCatalogFixture(catalogPath, [catalogEntry({ id: "s-ssh", title: "Remote session", locator: sshLocator(SOURCE) }), catalogEntry({ id: "s-local", title: "Local session", locator: localLocator, filePath: "/srv/app/local.jsonl" }), catalogEntry({ id: "s-draft", title: "No session", noSession: true })]);
	const { SessionCatalog } = loadSessionCatalog();
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();

	const snapshots = plain(await catalog.readHostRecordLocators(["s-ssh", "s-local", "s-draft", "s-ssh", "s-missing"]));
	assert.equal(snapshots.length, 5, "每个被请求的 recordId 都必须回一条 snapshot（重复 id 也各回一条）");
	assert.equal(snapshots[0].locator, canonicalSshLocator(SOURCE), "ssh locator 按规范 JSON 返回（收敛侧逐字节比对）");
	assert.equal(JSON.parse(snapshots[1].locator).filePath, "/srv/app/local.jsonl");
	assert.deepEqual(snapshots[2], { recordId: "s-draft" }, "没有位置的记录（无文件草稿）没有 locator，不编造");
	assert.deepEqual(snapshots[3], snapshots[0]);
	assert.deepEqual(snapshots[4], { recordId: "s-missing" });
});

test("a rebind moves the ssh hostId and writes through the catalog's own atomic write path", async (t) => {
	const directory = await makeTempDir(t, "pideck-rebind-port-sessions-write-");
	const catalogPath = join(directory, "session-catalog.json");
	await writeCatalogFixture(catalogPath, [catalogEntry({ id: "s-ssh", title: "Remote session", locator: sshLocator(SOURCE) }), catalogEntry({ id: "s-local", title: "Local session", locator: { kind: "local", environment: "native", filePath: "/srv/app/local.jsonl" }, filePath: "/srv/app/local.jsonl" })]);
	const { SessionCatalog } = loadSessionCatalog();
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	assert.equal(existsSync(`${catalogPath}.bak`), false, "fixture 已是规范形态：加载本身不写盘");

	const before = (await catalog.readHostRecordLocators(["s-ssh"]))[0].locator;
	const patch = { recordId: "s-ssh", beforeLocator: before, afterLocator: canonicalSshLocator(TARGET) };
	const results = plain(await catalog.applyHostRebind("tx-write", [patch]));
	assert.equal(results.length, 1, "结果条数必须等于补丁条数（少返结果 = 收敛侧 UNKNOWN_OUTCOME）");
	assert.deepEqual(results, [{ recordId: "s-ssh", outcome: "applied" }]);

	const persisted = JSON.parse(await readFile(catalogPath, "utf8"));
	const persistedSsh = persisted.sessions.find((entry) => entry.id === "s-ssh");
	assert.equal(persistedSsh.locator.hostId, TARGET);
	assert.equal(persistedSsh.locator.remotePath, sshLocator(SOURCE).remotePath, "remotePath 原样保留");
	assert.equal(persistedSsh.locator.remoteSessionId, "remote-1", "remoteSessionId 原样保留");

	// 写路径证据：只有 writeSnapshot 会做 .bak 轮换（自建 writeFile 不会产生它），且内存已被整体替换
	const backup = JSON.parse(await readFile(`${catalogPath}.bak`, "utf8"));
	assert.equal(backup.sessions.find((entry) => entry.id === "s-ssh").locator.hostId, SOURCE, ".bak = 写前内容（enqueueMutation → writeSnapshot）");
	assert.equal(catalog.get("s-ssh").locator.hostId, TARGET, "内存快照随写成功一起换代");
	assert.equal(catalog.getLocator("s-ssh").hostId, TARGET);
	assert.equal(catalog.findByFilePath("/srv/app/local.jsonl", "native").id, "s-local");
	assert.deepEqual(await tempFilesIn(directory), []);
});

test("a rebound ssh session keeps findByFilePath, originKey and the locator chain consistent", async (t) => {
	const directory = await makeTempDir(t, "pideck-rebind-port-sessions-drift-");
	const catalogPath = join(directory, "session-catalog.json");
	// 脏 fixture：模拟历史版本在 ssh 记录上留下的本地镜像字段（加载时会清，写回后不得再出现）
	const staleFields = { filePath: "/srv/app/.pi/subagent-artifacts/stale.jsonl", originKey: "stale-origin", piSessionId: "stale-pi", wslDistro: "Debian", wslUser: "root", parentSessionPath: "/srv/app/parent.jsonl" };
	await writeCatalogFixture(catalogPath, [catalogEntry({ id: "s-ssh", title: "Remote session", locator: sshLocator(SOURCE), ...staleFields }), catalogEntry({ id: "s-local", title: "Local session", locator: { kind: "local", environment: "native", filePath: "/srv/app/local.jsonl" }, filePath: "/srv/app/local.jsonl" })]);
	const { SessionCatalog } = loadSessionCatalog();
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();

	const before = (await catalog.readHostRecordLocators(["s-ssh"]))[0].locator;
	const results = plain(await catalog.applyHostRebind("tx-drift", [{ recordId: "s-ssh", beforeLocator: before, afterLocator: canonicalSshLocator(TARGET) }]));
	assert.deepEqual(results, [{ recordId: "s-ssh", outcome: "applied" }]);

	// 三条链路自洽：locator 链 / 文件路径链 / origin 链
	assert.equal(catalog.getLocator("s-ssh").hostId, TARGET);
	assert.equal(catalog.getRecord("s-ssh").filePath, undefined, "ssh 记录不得暴露本地 filePath");
	assert.equal(catalog.getRecord("s-ssh").projectPath, undefined);
	assert.throws(() => catalog.getLocalFilePath("s-ssh"), /UNSUPPORTED_PROJECT_LOCATION/, "ssh locator 不得进入本地文件读取路径");
	assert.equal(catalog.findByFilePath(staleFields.filePath, "native"), undefined, "ssh 记录不参与按文件路径查找");
	assert.equal(catalog.findByFilePath("/srv/app/local.jsonl", "native").id, "s-local", "同路径的本地记录仍然可查");
	for (const key of Object.keys(staleFields)) assert.equal(catalog.get("s-ssh")[key], undefined, `${key} 必须保持清空（ssh 分支的镜像同步）`);

	const persistedSsh = JSON.parse(await readFile(catalogPath, "utf8")).sessions.find((entry) => entry.id === "s-ssh");
	assert.equal(persistedSsh.locator.hostId, TARGET);
	for (const key of Object.keys(staleFields)) assert.equal(key in persistedSsh, false, `落盘的 ssh 记录不得再有 ${key}`);

	// origin 链：再次扫描不会认领这条 ssh 记录，也不会因为脏 filePath 把它清掉（mergeScanned 的存量清洗）
	const merged = plain(await catalog.mergeScanned("project-1", [scanSummary(staleFields.filePath), scanSummary("/srv/app/scanned.jsonl")]));
	const rebound = merged.find((record) => record.id === "s-ssh");
	assert.notEqual(rebound, undefined, "ssh 记录必须存活（脏 filePath 会让 mergeScanned 把它当子代理产物删掉）");
	assert.equal(rebound.locator.hostId, TARGET);
	assert.equal(rebound.filePath, undefined);
	const scanned = merged.find((record) => record.filePath === "/srv/app/scanned.jsonl");
	assert.notEqual(scanned, undefined);
	assert.notEqual(scanned.id, "s-ssh");

	// 写进去的就是规范形态：重新加载不需要任何归一化改写
	const written = await readFile(catalogPath, "utf8");
	const reloaded = new SessionCatalog(catalogPath);
	await reloaded.load();
	assert.equal(await readFile(catalogPath, "utf8"), written, "重新加载不得因为 locator 漂移而改写");
	assert.equal(reloaded.get("s-ssh").locator.hostId, TARGET);
});

test("replaying an applied rebind reports already-applied without a second write", async (t) => {
	const directory = await makeTempDir(t, "pideck-rebind-port-sessions-replay-");
	const catalogPath = join(directory, "session-catalog.json");
	await writeCatalogFixture(catalogPath, [catalogEntry({ id: "s-ssh", title: "Remote session", locator: sshLocator(SOURCE) })]);
	const { SessionCatalog } = loadSessionCatalog();
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	const patch = { recordId: "s-ssh", beforeLocator: (await catalog.readHostRecordLocators(["s-ssh"]))[0].locator, afterLocator: canonicalSshLocator(TARGET) };

	assert.deepEqual(plain(await catalog.applyHostRebind("tx-replay", [patch])), [{ recordId: "s-ssh", outcome: "applied" }]);
	const afterFirst = await readFile(catalogPath, "utf8");
	const backupAfterFirst = await readFile(`${catalogPath}.bak`, "utf8");
	assert.deepEqual(plain(await catalog.applyHostRebind("tx-replay", [patch])), [{ recordId: "s-ssh", outcome: "already-applied" }]);
	assert.equal(await readFile(catalogPath, "utf8"), afterFirst, "重放不产生第二次写");
	assert.equal(await readFile(`${catalogPath}.bak`, "utf8"), backupAfterFirst, "重放也不轮换备份");
});

test("a patch whose beforeLocator no longer matches reports changed and writes nothing", async (t) => {
	const directory = await makeTempDir(t, "pideck-rebind-port-sessions-stale-");
	const catalogPath = join(directory, "session-catalog.json");
	await writeCatalogFixture(catalogPath, [catalogEntry({ id: "s-ssh", title: "Remote session", locator: sshLocator(SOURCE) })]);
	const { SessionCatalog } = loadSessionCatalog();
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	const written = await readFile(catalogPath, "utf8");

	const results = plain(await catalog.applyHostRebind("tx-stale", [{ recordId: "s-ssh", beforeLocator: canonicalSshLocator(OTHER), afterLocator: canonicalSshLocator(TARGET) }]));
	assert.deepEqual(results, [{ recordId: "s-ssh", outcome: "changed" }], "既非 before 也非 after ⇒ changed（收敛侧 STALE_PLAN）");
	assert.equal(await readFile(catalogPath, "utf8"), written, "并发写过就不许覆盖");
	assert.equal(catalog.get("s-ssh").locator.hostId, SOURCE);
});

test("a batch with a missing record writes nothing and still reports one verdict per patch", async (t) => {
	const directory = await makeTempDir(t, "pideck-rebind-port-sessions-missing-");
	const catalogPath = join(directory, "session-catalog.json");
	await writeCatalogFixture(catalogPath, [catalogEntry({ id: "s-ssh", title: "Remote session", locator: sshLocator(SOURCE) })]);
	const { SessionCatalog } = loadSessionCatalog();
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	const written = await readFile(catalogPath, "utf8");
	const before = (await catalog.readHostRecordLocators(["s-ssh"]))[0].locator;

	const results = plain(
		await catalog.applyHostRebind("tx-missing", [
			{ recordId: "s-ssh", beforeLocator: before, afterLocator: canonicalSshLocator(TARGET) },
			{ recordId: "s-gone", beforeLocator: before, afterLocator: canonicalSshLocator(TARGET) },
		]),
	);
	assert.equal(results.length, 2, "结果条数恒等于补丁条数");
	assert.deepEqual(results, [
		{ recordId: "s-ssh", outcome: "changed" },
		{ recordId: "s-gone", outcome: "missing" },
	]);
	assert.equal(await readFile(catalogPath, "utf8"), written, "全有或全无：一条 missing 就整批不写（INV-9）");
	assert.equal(catalog.get("s-ssh").locator.hostId, SOURCE, "没有记录可以在未写盘时报 applied");
	assert.deepEqual(plain(await catalog.applyHostRebind("tx-missing", [{ recordId: "s-gone", beforeLocator: before, afterLocator: canonicalSshLocator(TARGET) }])), [{ recordId: "s-gone", outcome: "missing" }]);
});

test("a patch that changes more than the hostId is refused", async (t) => {
	const directory = await makeTempDir(t, "pideck-rebind-port-sessions-shape-");
	const catalogPath = join(directory, "session-catalog.json");
	await writeCatalogFixture(catalogPath, [catalogEntry({ id: "s-ssh", title: "Remote session", locator: sshLocator(SOURCE) }), catalogEntry({ id: "s-local", title: "Local session", locator: { kind: "local", environment: "native", filePath: "/srv/app/local.jsonl" }, filePath: "/srv/app/local.jsonl" })]);
	const { SessionCatalog } = loadSessionCatalog();
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	const written = await readFile(catalogPath, "utf8");
	const sshBefore = (await catalog.readHostRecordLocators(["s-ssh"]))[0].locator;
	const localBefore = (await catalog.readHostRecordLocators(["s-local"]))[0].locator;

	// after 顺手改了 remotePath：不是"只换 hostId"，整条判 changed
	const extraChange = canonicalSshLocator(TARGET, { remotePath: "/srv/other/.pi/sessions/two.jsonl" });
	assert.deepEqual(plain(await catalog.applyHostRebind("tx-shape", [{ recordId: "s-ssh", beforeLocator: sshBefore, afterLocator: extraChange }])), [{ recordId: "s-ssh", outcome: "changed" }]);

	// before 不是规范 JSON（键序不同、语义相同）也不行：字节契约就是端口契约
	const reordered = JSON.stringify({ remoteSessionId: "remote-1", remotePath: sshLocator(SOURCE).remotePath, hostId: SOURCE, kind: "ssh" });
	assert.deepEqual(plain(await catalog.applyHostRebind("tx-shape", [{ recordId: "s-ssh", beforeLocator: reordered, afterLocator: canonicalSshLocator(TARGET) }])), [{ recordId: "s-ssh", outcome: "changed" }]);

	// after 里塞了 ssh 分支不该有的字段（filePath）：合法键集合按 kind 校验，未知键同样拒绝
	const strayKey = JSON.stringify({ filePath: "/srv/app/x.jsonl", hostId: TARGET, kind: "ssh", remotePath: sshLocator(SOURCE).remotePath, remoteSessionId: "remote-1" });
	assert.deepEqual(plain(await catalog.applyHostRebind("tx-shape", [{ recordId: "s-ssh", beforeLocator: sshBefore, afterLocator: strayKey }])), [{ recordId: "s-ssh", outcome: "changed" }]);

	// 本地记录上的 ssh 补丁（before 与当前 locator 一模一样）同样拒绝：端口不是 local→ssh 迁移入口
	assert.deepEqual(plain(await catalog.applyHostRebind("tx-shape", [{ recordId: "s-local", beforeLocator: localBefore, afterLocator: canonicalSshLocator(TARGET) }])), [{ recordId: "s-local", outcome: "changed" }]);
	assert.equal(await readFile(catalogPath, "utf8"), written);
});

test("the session port fails closed with SESSION_CATALOG_NEEDS_REPAIR while the catalog needs repair", async (t) => {
	const directory = await makeTempDir(t, "pideck-rebind-port-sessions-repair-");
	const catalogPath = join(directory, "session-catalog.json");
	await writeFile(catalogPath, "{broken-primary", "utf8");
	await writeFile(`${catalogPath}.bak`, "{broken-backup", "utf8");
	const { SessionCatalog } = loadSessionCatalog();
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();

	assert.equal(await captureRejection(() => catalog.readHostRecordLocators(["s-ssh"])), "SESSION_CATALOG_NEEDS_REPAIR", "修复态不能答成'记录不存在'");
	assert.equal(await captureRejection(() => catalog.applyHostRebind("tx", [{ recordId: "s-ssh", beforeLocator: canonicalSshLocator(SOURCE), afterLocator: canonicalSshLocator(TARGET) }])), "SESSION_CATALOG_NEEDS_REPAIR");
	assert.equal(await readFile(catalogPath, "utf8"), "{broken-primary", "修复态下不得写盘");
	assert.equal(await readFile(`${catalogPath}.bak`, "utf8"), "{broken-backup");
});

test("port reads and writes reject malformed batches instead of answering them", async (t) => {
	const userData = await makeTempDir(t, "pideck-rebind-port-shape-");
	const { store } = await loadProjectStoreFixture(userData, [projectFixture("p-1", "local", "/srv/app")], 3);
	const catalogPath = join(userData, "session-catalog.json");
	await writeCatalogFixture(catalogPath, [catalogEntry({ id: "s-ssh", title: "Remote session", locator: sshLocator(SOURCE) })]);
	const { SessionCatalog } = loadSessionCatalog();
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();

	const malformed = [undefined, null, "s-1", 42, {}, [""], [123], [null], ["a".repeat(129)]];
	for (const recordIds of malformed) {
		const label = JSON.stringify(recordIds);
		assert.equal(await captureRejection(() => store.readHostRecordLocators(recordIds)), "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME", `project port: ${label}`);
		assert.equal(await captureRejection(() => catalog.readHostRecordLocators(recordIds)), "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME", `session port: ${label}`);
	}
	assert.deepEqual(plain(await store.readHostRecordLocators([])), [], "空批次是'没有记录要读'，不是错误");
	assert.deepEqual(plain(await catalog.readHostRecordLocators([])), []);

	for (const patches of [undefined, "patch", [null], [{ recordId: "", beforeLocator: "{}", afterLocator: "{}" }]]) {
		const label = JSON.stringify(patches);
		assert.equal(await captureRejection(() => catalog.applyHostRebind("tx", patches)), "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME", `session port: ${label}`);
	}
	assert.deepEqual(plain(await catalog.applyHostRebind("tx", [])), [], "空批次是合法 no-op");
});

// ---------------------------------------------------------------------------
// 端到端收敛：两个端口 + journal
// ---------------------------------------------------------------------------

test("convergence surfaces the project port's refusal as its own stable code", async (t) => {
	const directory = await makeTempDir(t, "pideck-rebind-port-e2e-projects-");
	const journalDir = join(directory, "journal");
	const catalogPath = join(directory, "session-catalog.json");
	await writeCatalogFixture(catalogPath, [catalogEntry({ id: "s-ssh", title: "Remote session", locator: sshLocator(SOURCE) })]);
	const { store: projectStore, filePath: projectFile } = await loadProjectStoreFixture(directory, [projectFixture("p-1", "local", "/srv/app")], 3);
	const localLocator = (await projectStore.readHostRecordLocators(["p-1"]))[0].locator;

	const journal = new HostRebindJournal({ userDataDir: journalDir, isProcessAlive: () => false, bootId: "boot-1" });
	await journal.write(journalOf([{ store: "projects", recordId: "p-1", beforeLocator: localLocator, afterLocator: canonicalSshLocator(TARGET) }]));
	const { SessionCatalog } = loadSessionCatalog();
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();

	const { model, host } = createHostModel();
	const projectsWritten = await readFile(projectFile, "utf8");
	const catalogWritten = await readFile(catalogPath, "utf8");
	const error = await captureRejection(() => journal.resume({ host, projects: projectStore, sessions: catalog }));

	assert.equal(error, "PROJECT_STORE_REMOTE_UNSUPPORTED", "store 端口码必须原样透出，不能被折成 UNKNOWN_OUTCOME（INV-10）");
	assert.equal(await readFile(projectFile, "utf8"), projectsWritten, "拒绝的补丁没有落盘");
	assert.equal(await readFile(catalogPath, "utf8"), catalogWritten);
	assert.equal(sourceProfile(model).disabled, true, "WAL：stage 写的是即将执行的那一步，source 已 disable");
	assert.equal(model.retiredHostIds.includes(SOURCE), false, "未收敛不许 retire");
	assert.equal(model.calls.includes("retire"), false);
	assert.equal(JSON.parse(await readFile(join(journalDir, JOURNAL_FILE), "utf8")).stage, "projects-written");
	assert.equal(existsSync(join(journalDir, JOURNAL_FILE)), true, "journal 留给人工/下次 resume");
	assert.equal(existsSync(join(journalDir, LOCK_FILE)), false, "tx 锁必须释放");
});

test("a store write that fails mid-transaction leaves no half-written store and converges on retry", async (t) => {
	const directory = await makeTempDir(t, "pideck-rebind-port-e2e-fail-");
	const journalDir = join(directory, "journal");
	const catalogPath = join(directory, "session-catalog.json");
	await writeCatalogFixture(catalogPath, [catalogEntry({ id: "s-ssh", title: "Remote session", locator: sshLocator(SOURCE) })]);
	const faults = { mode: "before-landing" };
	const { SessionCatalog } = loadCatalogWithRenameFault(catalogPath, faults);
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	const { store: projectStore } = await loadProjectStoreFixture(directory, [projectFixture("p-1", "local", "/srv/app")], 3);

	const journal = new HostRebindJournal({ userDataDir: journalDir, isProcessAlive: () => false, bootId: "boot-1" });
	await journal.write(journalOf([{ store: "sessions", recordId: "s-ssh", beforeLocator: canonicalSshLocator(SOURCE), afterLocator: canonicalSshLocator(TARGET) }]));
	const { model, host } = createHostModel();
	const catalogWritten = await readFile(catalogPath, "utf8");

	const error = await captureRejection(() => journal.resume({ host, projects: projectStore, sessions: catalog }));
	assert.equal(error, "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME", "写没落地也不能宣布成功：结果未知");
	assert.equal(await readFile(catalogPath, "utf8"), catalogWritten, "没有半写状态");
	assert.deepEqual(await tempFilesIn(directory), []);
	assert.equal(catalog.get("s-ssh").locator.hostId, SOURCE, "写失败不换代内存快照");
	assert.equal(sourceProfile(model).disabled, true, "半迁移的合法中间态：source 是 disabled tombstone");
	assert.equal(model.retiredHostIds.includes(SOURCE), false);
	assert.equal(JSON.parse(await readFile(join(journalDir, JOURNAL_FILE), "utf8")).stage, "sessions-written");
	assert.equal(existsSync(join(journalDir, LOCK_FILE)), false);

	// 故障消失：重跑只补没落地的那一步，然后 retire + 收口
	faults.mode = undefined;
	const outcome = await journal.resume({ host, projects: projectStore, sessions: catalog });
	assert.equal(outcome.code, "REMOTE_HOST_REBIND_COMMITTED");
	assert.equal(outcome.migratedSessions, 1);
	assert.equal(JSON.parse(await readFile(catalogPath, "utf8")).sessions[0].locator.hostId, TARGET);
	assert.equal(model.calls.filter((call) => call === "disable").length, 1, "已落地的阶段不重复执行");
	assert.equal(model.retiredHostIds.includes(SOURCE), true);
	assert.equal(existsSync(join(journalDir, JOURNAL_FILE)), false);
	assert.equal(existsSync(join(journalDir, LOCK_FILE)), false);
});

test("a store write that landed but threw is still converged by the next resume", async (t) => {
	const directory = await makeTempDir(t, "pideck-rebind-port-e2e-landed-");
	const journalDir = join(directory, "journal");
	const catalogPath = join(directory, "session-catalog.json");
	await writeCatalogFixture(catalogPath, [catalogEntry({ id: "s-ssh", title: "Remote session", locator: sshLocator(SOURCE) })]);
	const faults = { mode: "after-landing" };
	const { SessionCatalog } = loadCatalogWithRenameFault(catalogPath, faults);
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	const { store: projectStore } = await loadProjectStoreFixture(directory, [projectFixture("p-1", "local", "/srv/app")], 3);

	const journal = new HostRebindJournal({ userDataDir: journalDir, isProcessAlive: () => false, bootId: "boot-1" });
	await journal.write(journalOf([{ store: "sessions", recordId: "s-ssh", beforeLocator: canonicalSshLocator(SOURCE), afterLocator: canonicalSshLocator(TARGET) }]));
	const { model, host } = createHostModel();

	// §1.5：抛异常不等于没提交 —— 收敛结果只能是"未知"，不许当成功也不许当失败
	assert.equal(await captureRejection(() => journal.resume({ host, projects: projectStore, sessions: catalog })), "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
	assert.equal(JSON.parse(await readFile(catalogPath, "utf8")).sessions[0].locator.hostId, TARGET, "这次写其实落地了");
	assert.equal(catalog.get("s-ssh").locator.hostId, SOURCE, "内存快照没换代（store 的权威是内存，重跑会以它为准重写）");
	assert.equal(model.retiredHostIds.includes(SOURCE), false);

	faults.mode = undefined;
	const outcome = await journal.resume({ host, projects: projectStore, sessions: catalog });
	assert.equal(outcome.code, "REMOTE_HOST_REBIND_COMMITTED");
	assert.equal(outcome.migratedSessions, 1);
	assert.equal(JSON.parse(await readFile(catalogPath, "utf8")).sessions[0].locator.hostId, TARGET);
	assert.equal(catalog.get("s-ssh").locator.hostId, TARGET);
	assert.equal(model.retiredHostIds.includes(SOURCE), true);
	assert.equal(existsSync(join(journalDir, JOURNAL_FILE)), false);
});
