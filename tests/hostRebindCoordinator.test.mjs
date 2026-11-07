import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createHostRebindCoordinator } = loadTsCommonJs("src/main/remote/HostRebindCoordinator.ts");

/**
 * Rebind 前置（设计附 A 第 1 步）：coordinator 只决定"这笔交易是什么"，
 * 执行交给已实现的 `convergeRebindJournal`。
 *
 * 这组用例钉住四件事：
 * 1. plan 只读、只回计数与稳定码，不写 journal；
 * 2. 记录归属用 registry 的 hostId（不靠猜），after 只改 hostId；
 * 3. 不合法的记录（指向别的 host / 已被删）在写之前就拒绝；
 * 4. rebind 先在锁内重建 plan，再写 WAL，最后交给 convergence。
 */
function harness(overrides = {}) {
	let disabled = false;
	let retired = false;
	const journalWrites = [];
	const writes = [];
	const state = {
		revision: 7,
		profiles: [
			{ hostId: "src-host", disabled: false, verified: true },
			{ hostId: "dst-host", disabled: false, verified: true },
		],
		retiredHostIds: [],
	};
	const host = {
		async readHostState() {
			return {
				revision: state.revision,
				profiles: state.profiles.map((profile) => ({ ...profile, disabled: profile.hostId === "src-host" ? disabled : profile.disabled })),
				retiredHostIds: retired ? [...state.retiredHostIds, "src-host"] : [...state.retiredHostIds],
			};
		},
		async verifyTargetAnchor() {
			if (overrides.anchorFails === true) throw new Error("SSH_HOST_PIN_INVALID");
		},
		async disableSource() {
			writes.push("disableSource");
			disabled = true;
			return state.revision + 1;
		},
		async retireSource() {
			writes.push("retireSource");
			retired = true;
			return state.revision + 2;
		},
		async scanReferences() {
			return { complete: overrides.scanIncomplete !== true, referencedHostIds: new Set(overrides.referenced ?? []) };
		},
	};
	const projects = {
		async readHostRecordLocators(recordIds) {
			return recordIds.map((recordId) => ({ recordId, locator: overrides.projectLocator === undefined ? JSON.stringify({ kind: "ssh", hostId: "src-host", remotePath: "/srv/app" }) : overrides.projectLocator(recordId) }));
		},
		async applyHostRebind(_txId, patches) {
			return patches.map((patch) => ({ recordId: patch.recordId, outcome: "applied" }));
		},
	};
	const sessions = {
		async readHostRecordLocators(recordIds) {
			return recordIds.map((recordId) => ({ recordId, locator: JSON.stringify({ kind: "ssh", hostId: "src-host", remotePath: "/srv/session" }) }));
		},
		async applyHostRebind(_txId, patches) {
			return patches.map((patch) => ({ recordId: patch.recordId, outcome: "applied" }));
		},
	};
	const deps = {
		host,
		projects: overrides.noStore === true ? undefined : projects,
		sessions,
		listHostRecords: async () => overrides.records ?? { complete: true, records: [{ store: "projects", recordId: "p1" }] },
		acquireLock: async () => (overrides.lockTaken === true ? undefined : { release: async () => {} }),
		lockState: async () => overrides.lockState ?? "missing",
		readJournal: async () => overrides.journal,
		writeJournal: async (journal) => {
			journalWrites.push(journal.stage);
			overrides.onWrite?.(journal);
		},
		removeJournal: async () => {},
		resumePending: async () => overrides.resumeOutcome,
		now: () => 1_700_000_000_000,
		newTxId: () => "tx-1",
	};
	return { deps, journalWrites, writes, state };
}

async function rejectsWith(run, pattern) {
	try {
		await run();
	} catch (error) {
		assert.match(String(error?.message ?? error), pattern);
		return;
	}
	assert.fail("expected rejection: " + pattern);
}

test("plan：只读、按 registry 的 hostId 归因记录，after 只改 hostId", async () => {
	const h = harness();
	const { summary, journal } = await createHostRebindCoordinator(h.deps).plan("src-host", "dst-host");
	assert.equal(h.journalWrites.length, 0, "预检不写 journal");
	assert.deepEqual(JSON.parse(JSON.stringify(summary.records)), { projects: 1, sessions: 0 });
	assert.equal(summary.referenceScan.complete, true);
	assert.equal(summary.tx, "idle");
	assert.equal(journal.txId, "tx-1");
	assert.equal(journal.expectedHostRevision, 7);
	assert.equal(journal.records.length, 1);
	assert.deepEqual(JSON.parse(journal.records[0].beforeLocator), { kind: "ssh", hostId: "src-host", remotePath: "/srv/app" });
	assert.deepEqual(JSON.parse(journal.records[0].afterLocator), { kind: "ssh", hostId: "dst-host", remotePath: "/srv/app" });
});

test("plan：来源=目标 / 来源缺失 / 目标未验证 / pin 读不出 / 扫描不完整都拒绝", async () => {
	const coordinator = () => createHostRebindCoordinator(harness().deps);
	await rejectsWith(() => coordinator().plan("src-host", "src-host"), /REMOTE_HOST_REBIND_SAME_HOST/);

	const missingSource = harness();
	missingSource.deps.host.readHostState = async () => ({ revision: 7, profiles: [{ hostId: "dst-host", disabled: false, verified: true }], retiredHostIds: [] });
	await rejectsWith(() => createHostRebindCoordinator(missingSource.deps).plan("src-host", "dst-host"), /REMOTE_HOST_REBIND_SOURCE_MISSING/);

	const unverified = harness();
	unverified.deps.host.readHostState = async () => ({
		revision: 7,
		profiles: [
			{ hostId: "src-host", disabled: false, verified: true },
			{ hostId: "dst-host", disabled: false, verified: false },
		],
		retiredHostIds: [],
	});
	await rejectsWith(() => createHostRebindCoordinator(unverified.deps).plan("src-host", "dst-host"), /REMOTE_HOST_REBIND_TARGET_UNVERIFIED/);

	await rejectsWith(() => createHostRebindCoordinator(harness({ anchorFails: true }).deps).plan("src-host", "dst-host"), /REMOTE_HOST_REBIND_TARGET_ANCHOR_UNREADABLE/);
	await rejectsWith(() => createHostRebindCoordinator(harness({ scanIncomplete: true }).deps).plan("src-host", "dst-host"), /REMOTE_HOST_REBIND_REFERENCE_SCAN_INCOMPLETE/);
});

test("plan：记录指向别的 host 是 ORIGIN_CONFLICT，记录已不存在是 RECORD_MISSING", async () => {
	await rejectsWith(() => createHostRebindCoordinator(harness({ projectLocator: () => JSON.stringify({ kind: "ssh", hostId: "other-host", remotePath: "/srv/app" }) }).deps).plan("src-host", "dst-host"), /REMOTE_HOST_REBIND_ORIGIN_CONFLICT/);
	await rejectsWith(() => createHostRebindCoordinator(harness({ projectLocator: () => undefined }).deps).plan("src-host", "dst-host"), /REMOTE_HOST_REBIND_RECORD_MISSING/);
});

test("plan：tx 状态只回四种稳定值（busy / lock-unreadable / journal-present）", async () => {
	const busy = await createHostRebindCoordinator(harness({ lockState: "live" }).deps).plan("src-host", "dst-host");
	assert.equal(busy.summary.tx, "busy");
	const unreadable = await createHostRebindCoordinator(harness({ lockState: "unreadable" }).deps).plan("src-host", "dst-host");
	assert.equal(unreadable.summary.tx, "lock-unreadable");
	const journal = {
		schemaVersion: 1,
		txId: "tx-0",
		createdAt: new Date(0).toISOString(),
		stage: "prepared",
		source: { hostId: "a", endpointDigest: "", disabled: false },
		target: { hostId: "b", endpointDigest: "", knownHostsSha256: "" },
		expectedHostRevision: 1,
		records: [],
		referenceScan: { complete: true, count: 0 },
	};
	const pending = await createHostRebindCoordinator(harness({ journal }).deps).plan("src-host", "dst-host");
	assert.equal(pending.summary.tx, "journal-present");
});

test("rebind：锁被占时不写 journal；成功路径按 source-disabled→projects-written→source-retired→committed 写 WAL", async () => {
	const busy = harness({ lockTaken: true });
	await rejectsWith(() => createHostRebindCoordinator(busy.deps).rebind("src-host", "dst-host"), /REMOTE_HOST_REBIND_TX_BUSY/);
	assert.equal(busy.journalWrites.length, 0);

	const h = harness();
	const outcome = await createHostRebindCoordinator(h.deps).rebind("src-host", "dst-host");
	assert.equal(outcome.code, "REMOTE_HOST_REBIND_COMMITTED");
	assert.equal(outcome.migratedProjects, 1);
	assert.deepEqual(h.journalWrites, ["prepared", "source-disabled", "projects-written", "source-retired", "committed"]);
	assert.deepEqual(h.writes, ["disableSource", "retireSource"]);
});

test("rebind：store 端口缺席时在写之前就失败（STORE_PORT_MISSING）", async () => {
	const h = harness({ noStore: true });
	await rejectsWith(() => createHostRebindCoordinator(h.deps).rebind("src-host", "dst-host"), /REMOTE_HOST_REBIND_STORE_PORT_MISSING/);
	assert.equal(h.journalWrites.length, 0, "还没写 WAL");
});

test("describePending：只回阶段与计数，不暴露 recordId", async () => {
	const journal = {
		schemaVersion: 1,
		txId: "tx-9",
		createdAt: new Date(0).toISOString(),
		stage: "projects-written",
		source: { hostId: "a", endpointDigest: "", disabled: true },
		target: { hostId: "b", endpointDigest: "", knownHostsSha256: "" },
		expectedHostRevision: 3,
		records: [
			{ store: "projects", recordId: "secret-project-id", beforeLocator: '{"hostId":"a","kind":"ssh","remotePath":"/x"}', afterLocator: '{"hostId":"b","kind":"ssh","remotePath":"/x"}' },
			{ store: "sessions", recordId: "secret-session-id", beforeLocator: '{"hostId":"a","kind":"ssh","remotePath":"/y"}', afterLocator: '{"hostId":"b","kind":"ssh","remotePath":"/y"}' },
		],
		referenceScan: { complete: true, count: 2 },
	};
	const described = await createHostRebindCoordinator(harness({ journal }).deps).describePending();
	assert.equal(described.present, true);
	assert.equal(described.stage, "projects-written");
	assert.deepEqual(JSON.parse(JSON.stringify(described.records)), { projects: 1, sessions: 1 });
	const text = JSON.stringify(described);
	assert.ok(!text.includes("secret-project-id"), "recordId 不出 main");
	assert.ok(!text.includes("/x"), "路径不出 main");

	const empty = await createHostRebindCoordinator(harness().deps).describePending();
	assert.deepEqual(JSON.parse(JSON.stringify(empty)), { present: false, tx: "idle" });
});
