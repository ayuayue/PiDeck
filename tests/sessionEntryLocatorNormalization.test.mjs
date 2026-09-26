import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * ssh 条目的本地镜像字段同步（`SessionCatalog.normalizeEntryLocator`，`src/main/sessions/SessionCatalog.ts:298-314`）
 * 究竟由哪一层保证 —— 这份文件锁的是**读入路径**，因为写路径那一层今天不可观测。
 *
 * 事实（读代码 + 突变自检得到，2026-09-27，工作树 `feat/remote-development`，基线 `295877d8e`）：
 * 1. 能进入内存的 ssh 条目**只有一个来源**：`readCatalogFile`，而它对每个条目无条件跑
 *    `normalizeEntryLocator`（`:1710-1721`，`entries.map(normalizeEntryLocator)` 在 `:1718`）。
 * 2. 所有会给条目挂本地字段的入口都对 ssh 硬拒绝或过滤：`setLocalSessionFilePath`（`:316-317` 抛
 *    `UNSUPPORTED_PROJECT_LOCATION`）、`attachRuntime`（`:1124`）、`mergeScanned`（`:1320` 的 origin 索引
 *    排除 ssh + `:1433` 的 `setLocalSessionFilePath`）、`repairRelativeFilePaths`（`:1636` 直接跳过）。
 *    没有公开入口能把 `filePath`/`originKey`/… 挂回一个 ssh 条目。
 * 3. ⇒ 写路径 `applyHostRebind` 里的 `normalizeEntryLocator`（`:775`）是**防御性冗余**：它的输入前提
 *    （"这条 ssh 条目的镜像字段已经是空的"）由读入路径保证。
 *
 * 突变自检（两条都实际跑过，用来证明上面的结论不是纸面推断）：
 * - M1 去掉读入路径的规范化（`:1718` 的 `entries.map(normalizeEntryLocator)` 改成 `entries`）：
 *   本文件 2/2 转红 —— 用例 1 停在 `读入路径必须清空 filePath`，用例 2 停在 `没有第二次写 ⇒ 备份不轮换`；
 *   同一突变下 `tests/hostRebindStorePorts.test.mjs` 的 15 个用例**仍然全绿**（那条链路被写路径的冗余
 *   规范化救了回来，所以它锁不住读入路径）。
 * - M2 去掉写路径的规范化（`:775` 改成 `entries[item.index].locator = item.locator`）：本文件 + 15 个
 *   端口用例 **17/17 全绿，零个用例转红** —— 这正是"写路径那一层没有任何测试锁住它"的证据，不要把它
 *   写成已被锁定。
 *
 * 所以这层防护的真实位置是**读入路径**；写路径那一层只在将来出现"绕开 `setLocalSessionFilePath` 直接
 * 改 `locator` 的新写入口"时才会生效（`:732-736` 的注释即这条规则）。
 */
const nodeRequire = createRequire(import.meta.url);

const HOST = "11111111-1111-4111-8111-111111111111";
const DIRTY_FILE_PATH = "/srv/app/.pi/subagent-artifacts/stale.jsonl";
const LOCAL_FILE_PATH = "/srv/app/local.jsonl";

/** 端口契约里的规范 JSON（收敛侧逐字节比对）；这里只用来断言读出的 locator 是规范形态。 */
const { canonicalHostLocatorJson } = loadTsCommonJs("src/main/remote/HostRebindJournal.ts");

/** 跨 VM realm 的对象比较前先归一化：deepStrictEqual 会比较原型，两个 realm 的字面量原型不同。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** 生产 SessionCatalog；fsPromises 与 logger 走真实/空实现（与 hostRebindStorePorts.test.mjs 同口径）。 */
function loadSessionCatalog() {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: {
			"node:fs/promises": nodeRequire("node:fs/promises"),
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
}

async function makeTempDir(t, prefix) {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

function sshLocator(hostId) {
	return { kind: "ssh", hostId, remotePath: "/srv/app/.pi/sessions/remote.jsonl", remoteSessionId: "remote-1" };
}

function catalogEntry(overrides = {}) {
	return { id: "s-1", projectId: "project-1", title: "Entry", titleLocked: true, titleOrigin: "manual", source: "pi", environment: "native", status: "active", createdAt: 1, updatedAt: 1, ...overrides };
}

/**
 * 磁盘上的脏 catalog：历史版本在 ssh 记录上留下的本地镜像字段（`filePath` / `originKey` /
 * `piSessionId` / `wslDistro` / `wslUser` / `parentSessionPath`）。这是**真实可达**的输入形态：
 * 老版本 PiDeck 就是这么落盘的，`locatorNormalizationNeeded` 的判定条件（`:1710-1715`）逐字列出这六个字段。
 */
const STALE_FIELDS = { filePath: DIRTY_FILE_PATH, originKey: "stale-origin", piSessionId: "stale-pi", wslDistro: "Debian", wslUser: "root", parentSessionPath: "/srv/app/parent.jsonl" };

async function writeDirtyCatalogFixture(catalogPath) {
	await mkdir(dirname(catalogPath), { recursive: true });
	await writeFile(
		catalogPath,
		JSON.stringify({
			version: 1,
			sessions: [catalogEntry({ id: "s-ssh", title: "Remote session", locator: sshLocator(HOST), ...STALE_FIELDS }), catalogEntry({ id: "s-local", title: "Local session", locator: { kind: "local", environment: "native", filePath: LOCAL_FILE_PATH }, filePath: LOCAL_FILE_PATH })],
		}),
		"utf8",
	);
}

test("a dirty ssh catalog entry is normalized on the read path and keeps locator, file lookup and origin chain consistent", async (t) => {
	const directory = await makeTempDir(t, "pideck-catalog-locator-normalization-");
	const catalogPath = join(directory, "session-catalog.json");
	await writeDirtyCatalogFixture(catalogPath);
	const { SessionCatalog } = loadSessionCatalog();
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load(); // 唯一的输入入口：读入路径必须已经把镜像字段清掉

	// ① locator 链：ssh locator 原样保留（hostId / remotePath / remoteSessionId 不被清洗波及）
	const entry = catalog.get("s-ssh");
	assert.equal(entry.locator.kind, "ssh");
	assert.equal(entry.locator.hostId, HOST);
	assert.equal(entry.locator.remotePath, sshLocator(HOST).remotePath);
	assert.equal(entry.locator.remoteSessionId, "remote-1");
	assert.deepEqual(plain(catalog.getLocator("s-ssh")), { kind: "ssh", hostId: HOST, remotePath: sshLocator(HOST).remotePath, remoteSessionId: "remote-1" });

	// ② 镜像字段链：六个本地字段必须被清空（不做这一步，ssh 记录会带着本地 filePath 参与所有本地路径逻辑）
	for (const key of Object.keys(STALE_FIELDS)) assert.equal(catalog.get("s-ssh")[key], undefined, `读入路径必须清空 ${key}`);
	assert.equal(catalog.listEntries().find((candidate) => candidate.id === "s-ssh").originKey, undefined, "originKey 属于镜像字段：ssh 条目不得带着本地 origin 身份");
	assert.equal(catalog.getRecord("s-ssh").filePath, undefined, "ssh 记录不得暴露本地 filePath");
	assert.equal(catalog.getRecord("s-ssh").projectPath, undefined);
	assert.equal(catalog.getRecord("s-ssh").parentSessionPath, undefined);
	assert.equal(catalog.getRecord("s-ssh").wslDistro, undefined);
	assert.equal(catalog.getRecord("s-ssh").wslUser, undefined);

	// ③ 文件路径链：脏 filePath 不得让 ssh 记录被 findByFilePath 认领，也不得进本地读取路径
	assert.equal(catalog.findByFilePath(DIRTY_FILE_PATH, "native"), undefined, "ssh 记录不参与按文件路径查找（脏 filePath 是它唯一的本地身份，必须已被清掉）");
	assert.equal(catalog.findByFilePath(LOCAL_FILE_PATH, "native").id, "s-local", "正向对照：同文件里的本地记录仍可查");
	assert.throws(() => catalog.getLocalFilePath("s-ssh"), /UNSUPPORTED_PROJECT_LOCATION/, "ssh locator 不得进入本地文件读取路径");

	// ④ 端口读链：收敛侧看到的当前 locator 是规范 JSON，且等于磁盘上那条 ssh locator 的规范形态
	const snapshot = plain(await catalog.readHostRecordLocators(["s-ssh"]))[0];
	assert.equal(snapshot.recordId, "s-ssh");
	assert.equal(snapshot.locator, canonicalHostLocatorJson(sshLocator(HOST)));

	// ⑤ 落盘链：`locatorNormalizationNeeded` 命中 ⇒ load() 用规范化后的内存快照重写主文件（`.bak` = 脏原文件）
	const persisted = JSON.parse(await readFile(catalogPath, "utf8")).sessions.find((item) => item.id === "s-ssh");
	for (const key of Object.keys(STALE_FIELDS)) assert.equal(key in persisted, false, `落盘的 ssh 记录不得再有 ${key}`);
	assert.deepEqual(persisted.locator, sshLocator(HOST), "规范化只清镜像字段，locator 逐字段保持");
	const backup = JSON.parse(await readFile(`${catalogPath}.bak`, "utf8")).sessions.find((item) => item.id === "s-ssh");
	assert.equal(backup.filePath, DIRTY_FILE_PATH, "`.bak` 是写前内容（脏 fixture 本身），证明这次改写确实由 load() 触发");
});

test("a normalized ssh entry is not rewritten by the next load", async (t) => {
	const directory = await makeTempDir(t, "pideck-catalog-locator-normalization-reload-");
	const catalogPath = join(directory, "session-catalog.json");
	await writeDirtyCatalogFixture(catalogPath);
	const { SessionCatalog } = loadSessionCatalog();
	const first = new SessionCatalog(catalogPath);
	await first.load();
	const written = await readFile(catalogPath, "utf8");
	const backupAfterFirstLoad = await readFile(`${catalogPath}.bak`, "utf8");

	// 已经是规范形态：第二次 load() 不再命中 `locatorNormalizationNeeded`，不许产生第二次写（`.bak` 也不许轮换）
	const reloaded = new SessionCatalog(catalogPath);
	await reloaded.load();
	assert.equal(await readFile(catalogPath, "utf8"), written, "规范形态的 catalog 重新加载不得改写");
	assert.equal(await readFile(`${catalogPath}.bak`, "utf8"), backupAfterFirstLoad, "没有第二次写 ⇒ 备份不轮换");
	assert.equal(reloaded.get("s-ssh").locator.hostId, HOST);
	assert.equal(reloaded.get("s-ssh").filePath, undefined);
});
