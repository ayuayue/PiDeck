import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";
/**
 * 引用写入的 interlock（K1 §6.2 `remoteHostReferenceInterlock` / 设计 §3.1 方案 A）。
 *
 * 判据一律是「**磁盘逐字节不变** + 稳定码」。这里用真实 store + 真实引用写入门，只把「有事务在跑」
 * 这件事做成文件（journal / tx 锁）——那正是门在真实世界里看到的形状。
 *
 * 覆盖：无事务时不是一刀切拒绝；journal 在 → 登记项目/登记会话/删除项目全部退让；活 owner 持有的
 * tx 锁同样退让；可证陈旧的锁会被回收而不是把写入永久锁死；hostId 解析不到 profile 与主机目录读不出来
 * 各有自己的码（可行动性不同：重新添加主机 vs 修复磁盘）。
 */

const { createRemoteHostReferenceRegistry } = loadTsCommonJs("src/main/remote/RemoteHostReferenceSources.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { createRemoteReferenceWriteGuard, REMOTE_HOST_REFERENCE_REBIND_ACTIVE, REMOTE_HOST_REFERENCE_HOST_UNRESOLVED, REMOTE_HOST_REFERENCE_STORE_UNVERIFIED } = loadTsCommonJs("src/main/remote/RemoteReferenceWriteGuard.ts");

const UNKNOWN_HOST = "9c2f0f6a-7f2e-4a19-9d1b-0d5f9f2dd0aa";
const JOURNAL_FILE = "remote-host-rebind.json";
const LOCK_FILE = "remote-host-rebind.lock";

function loadProjectStore(userData) {
	return loadTsCommonJs("src/main/projects/ProjectStore.ts", { stubs: { electron: { app: { getPath: () => userData }, dialog: {} } } });
}

function loadSessionCatalog() {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
}

async function hashFile(filePath) {
	return createHash("sha256")
		.update(await readFile(filePath))
		.digest("hex");
}

function registration(hostId, remoteSessionId) {
	return { projectId: "p-1", hostId, remoteSessionId, remotePath: remoteSessionId, title: remoteSessionId, updatedAt: 1000 };
}

/** 真实主机 store（含一个已验证 profile）+ 两个带门的引用 store。 */
async function makeHarness(t) {
	const userData = await mkdtemp(join(tmpdir(), "pideck-interlock-"));
	t.after(() => rm(userData, { recursive: true, force: true }));
	const projectsPath = join(userData, "projects.json");
	const catalogPath = join(userData, "session-catalog.json");
	const registry = createRemoteHostReferenceRegistry(catalogPath, projectsPath);
	const hosts = await RemoteHostStore.open(userData, { referenceRegistry: registry });
	const draft = await hosts.createDraft({ label: "host", sshHost: "10.81.2.15", connectTimeoutMs: 10000 }, hosts.getSnapshot().revision);
	const guard = createRemoteReferenceWriteGuard({ userDataDir: userData });

	const { ProjectStore } = loadProjectStore(userData);
	const projects = new ProjectStore(undefined, { referenceGuard: guard });
	await projects.load();
	const { SessionCatalog } = loadSessionCatalog();
	const catalog = new SessionCatalog(catalogPath, {}, undefined, undefined, { referenceGuard: guard });
	await catalog.load();
	return { userData, draft, projects, catalog, projectsPath, catalogPath };
}

async function seedReferences(harness) {
	await harness.projects.addRemote({ hostId: harness.draft.id, canonicalRemotePath: "/srv/app" });
	await harness.catalog.ensureRemoteSession(registration(harness.draft.id, "ws/a.jsonl"));
}

test("没有 rebind 事务时登记照常成功（门不是一刀切拒绝）", async (t) => {
	const harness = await makeHarness(t);
	await seedReferences(harness);
	const disk = JSON.parse(await readFile(harness.projectsPath, "utf8"));
	assert.equal(disk.projects.filter((project) => project.locator?.kind === "ssh").length, 1);
	assert.equal(JSON.parse(await readFile(harness.catalogPath, "utf8")).sessions.length, 1);
});

test("journal 存在时：登记项目 / 登记会话 / 删除项目一律退让，磁盘逐字节不变", async (t) => {
	const harness = await makeHarness(t);
	await seedReferences(harness);
	const journalPath = join(harness.userData, JOURNAL_FILE);
	await writeFile(journalPath, JSON.stringify({ txId: "tx-1", records: [] }), "utf8");
	const projectsBefore = await hashFile(harness.projectsPath);
	const catalogBefore = await hashFile(harness.catalogPath);
	const projectId = harness.projects.list()[0].id;

	await assert.rejects(() => harness.projects.addRemote({ hostId: harness.draft.id, canonicalRemotePath: "/srv/two" }), new RegExp(REMOTE_HOST_REFERENCE_REBIND_ACTIVE));
	await assert.rejects(() => harness.projects.remove(projectId), new RegExp(REMOTE_HOST_REFERENCE_REBIND_ACTIVE));
	await assert.rejects(() => harness.catalog.ensureRemoteSession(registration(harness.draft.id, "ws/b.jsonl")), new RegExp(REMOTE_HOST_REFERENCE_REBIND_ACTIVE));
	await assert.rejects(() => harness.catalog.removeByProjectId("p-1"), new RegExp(REMOTE_HOST_REFERENCE_REBIND_ACTIVE));

	assert.equal(await hashFile(harness.projectsPath), projectsBefore, "被拒的写入不得改 projects.json（逐字节）");
	assert.equal(await hashFile(harness.catalogPath), catalogBefore, "被拒的写入不得改 session-catalog.json（逐字节）");

	// 事务结束后写入恢复（退让是"等它收敛"，不是永久拒绝）。
	await rm(journalPath);
	await harness.projects.addRemote({ hostId: harness.draft.id, canonicalRemotePath: "/srv/two" });
	assert.equal(JSON.parse(await readFile(harness.projectsPath, "utf8")).projects.filter((project) => project.locator?.kind === "ssh").length, 2);
});

test("rebind tx 锁被活 owner 持有 ⇒ 同样退让；可证陈旧的锁会被回收而不是把写入锁死", async (t) => {
	const harness = await makeHarness(t);
	await seedReferences(harness);
	const lockPath = join(harness.userData, LOCK_FILE);
	const projectsBefore = await hashFile(harness.projectsPath);

	// 活 owner：pid 就是本进程（判定恒为 live），bootId 无关。
	await writeFile(lockPath, JSON.stringify({ pid: process.pid, bootId: "any-boot", startedAt: new Date().toISOString() }), "utf8");
	await assert.rejects(() => harness.projects.addRemote({ hostId: harness.draft.id, canonicalRemotePath: "/srv/blocked" }), new RegExp(REMOTE_HOST_REFERENCE_REBIND_ACTIVE));
	assert.equal(await hashFile(harness.projectsPath), projectsBefore, "被拒的写入不得改 projects.json（逐字节）");

	// 上一次开机留下的锁（不同 bootId ⇒ 可证陈旧）：回收后继续写，不把功能永久锁死。
	await writeFile(lockPath, JSON.stringify({ pid: 999999, bootId: "previous-boot", startedAt: new Date(0).toISOString() }), "utf8");
	await harness.projects.addRemote({ hostId: harness.draft.id, canonicalRemotePath: "/srv/allowed" });
	assert.equal(existsSync(lockPath), false, "陈旧锁必须被回收，不能留在盘上挡住后续写入");
});

test("hostId 解析不到 profile（已退役 / 未知）⇒ 拒绝且磁盘不变", async (t) => {
	const harness = await makeHarness(t);
	await seedReferences(harness);
	const projectsBefore = await hashFile(harness.projectsPath);
	await assert.rejects(() => harness.projects.addRemote({ hostId: UNKNOWN_HOST, canonicalRemotePath: "/srv/app" }), new RegExp(REMOTE_HOST_REFERENCE_HOST_UNRESOLVED));
	await assert.rejects(() => harness.catalog.ensureRemoteSession(registration(UNKNOWN_HOST, "ws/unknown.jsonl")), new RegExp(REMOTE_HOST_REFERENCE_HOST_UNRESOLVED));
	assert.equal(await hashFile(harness.projectsPath), projectsBefore, "被拒的写入不得改 projects.json（逐字节）");
});

test("主机目录读不出来 ⇒ 拒绝并给出与「主机不存在」不同的码（无法证明 ≠ 主机不在）", async (t) => {
	const harness = await makeHarness(t);
	await seedReferences(harness);
	const projectsBefore = await hashFile(harness.projectsPath);
	await writeFile(join(harness.userData, "remote-hosts.json"), "{ not json", "utf8");
	await writeFile(join(harness.userData, "remote-hosts.json.bak"), "{ not json", "utf8");
	await assert.rejects(() => harness.projects.addRemote({ hostId: harness.draft.id, canonicalRemotePath: "/srv/app" }), new RegExp(REMOTE_HOST_REFERENCE_STORE_UNVERIFIED));
	assert.equal(await hashFile(harness.projectsPath), projectsBefore, "被拒的写入不得改 projects.json（逐字节）");
});

test("生产装配把门注入两个引用 store（源码级守卫，防漏接）", () => {
	// 门不注入 = 静默失去 INV-1 保护；而单靠单测看不出来（测试自己会构造带门的 store）。
	// 正则刻意空白容忍（仓库规则：源码级契约测试不得依赖格式化结果）。
	const entry = mainIpcSource;
	assert.match(entry, /createRemoteReferenceWriteGuard\s*\(/, "main/index.ts 必须构造引用写入门");
	assert.match(entry, /new ProjectStore\([\s\S]{0,400}?referenceGuard/, "ProjectStore 必须收到 referenceGuard");
	assert.match(entry, /new SessionCatalog\([\s\S]{0,2000}?referenceGuard/, "SessionCatalog 必须收到 referenceGuard");
});
