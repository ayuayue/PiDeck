import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

/**
 * Rebind IPC（设计附 A 第 3 步）：四条通道的边界。
 *
 * 这里不重复 coordinator 的算法（`hostRebindCoordinator.test.mjs` 覆盖），只钉 IPC 必须守住的：
 * - 一次性确认：没有 requestId 不执行；deny 零执行；
 * - 摘要按**当前** plan 重算：两次 plan 不一致 → CONFIRMATION_CHANGED，且不执行；
 * - 只有稳定码与计数跨 IPC：txId / recordId 不出现；
 * - 执行前断开来源；失败码原样返回。
 */
const sourceHostId = "11111111-1111-4111-8111-111111111111";
const targetHostId = "22222222-2222-4222-8222-222222222222";

const planA = { source: { hostId: sourceHostId }, target: { hostId: targetHostId }, expectedHostRevision: 3, records: [{ store: "projects", recordId: "p1", beforeLocator: '{"hostId":"s"}', afterLocator: '{"hostId":"t"}' }] };
const planB = { ...planA, expectedHostRevision: 4 };

function fixture(overrides = {}) {
	const handlers = new Map();
	const calls = { plan: 0, rebind: [], disconnect: [], resume: 0 };
	const plans = overrides.plans ?? [planA];
	const coordinator = {
		async plan(source, target) {
			calls.plan += 1;
			if (overrides.planFails === true) throw new Error("REMOTE_HOST_REBIND_TARGET_UNVERIFIED");
			const journal = plans[Math.min(calls.plan - 1, plans.length - 1)];
			return {
				summary: {
					source: { hostId: journal.source.hostId, disabled: false, verified: true },
					target: { hostId: journal.target.hostId, disabled: false, verified: true },
					records: { projects: journal.records.length, sessions: 0 },
					referenceScan: { complete: true, count: 1 },
					warnings: [],
					tx: "idle",
				},
				journal,
			};
		},
		async rebind(source, target) {
			calls.rebind.push([source, target]);
			return overrides.outcome ?? { code: "REMOTE_HOST_REBIND_COMMITTED", stage: "committed", migratedProjects: 1, migratedSessions: 0, sourceRetired: true, warnings: [] };
		},
		async resumePendingRebind() {
			calls.resume += 1;
			if (overrides.resumeFails === true) throw new Error("REMOTE_HOST_REBIND_TARGET_MISSING");
			return overrides.resumeOutcome;
		},
		async describePending() {
			return overrides.describe ?? { present: false, tx: "idle" };
		},
	};
	const { registerRemoteHostRebindIpc } = loadTsCommonJs("src/main/ipc/remoteHostRebindIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/HostRebindJournal": {
				HostRebindJournal: class {
					lockFilePath() {
						return "/tmp/rebind.lock";
					}
					async read() {
						return undefined;
					}
					async write() {}
					async remove() {}
					async resume() {
						return overrides.resumeOutcome;
					}
				},
			},
			"../remote/HostRebindCoordinator": { createHostRebindCoordinator: () => coordinator },
			"../remote/RemoteHostRebindPorts": { createRemoteHostRebindPorts: () => ({ host: {}, listHostRecords: async () => ({ complete: true, records: [] }) }) },
			"../remote/RemoteHostReferenceSources": { createRemoteHostReferenceRegistry: () => ({}) },
			"../remote/HostRebindTxLock": {
				acquireRebindTxLock: async () => ({ release: async () => {} }),
				classifyRebindTxLockOwner: () => "live",
				currentBootId: () => "boot-1",
				defaultIsProcessAlive: () => true,
			},
			"../persistence/StoreFileLock": { readStoreFileLockState: async () => ({ kind: "missing" }) },
		},
	});
	const ipc = registerRemoteHostRebindIpc({
		enabled: overrides.enabled ?? true,
		userDataDir: "/tmp/ud",
		openStores: async () => ({ store: {}, pinStore: {} }),
		projectStore: () => ({}),
		sessionCatalog: () => ({}),
		...(overrides.noDisconnect === true ? {} : { disconnect: async (hostId) => calls.disconnect.push(hostId) }),
	});
	const sender = { id: 7, isDestroyed: () => false };
	return { handlers, calls, sender, resumeAtStartup: () => ipc.resumePendingAtStartup() };
}

const call = (f, channel, ...args) => f.handlers.get(channel)({ sender: f.sender }, ...args);

async function rejectsWith(run, pattern) {
	try {
		await run();
	} catch (error) {
		assert.match(String(error?.message ?? error), pattern);
		return;
	}
	assert.fail("expected rejection: " + pattern);
}

test("plan：只读、返回计数与一次性 requestId；非法输入与关闭功能都被拒", async () => {
	const f = fixture();
	const plan = await call(f, ipcChannels.remoteHostRebindPlan, sourceHostId, targetHostId);
	assert.equal(plan.ok, true);
	assert.deepEqual(JSON.parse(JSON.stringify(plan.summary.records)), { projects: 1, sessions: 0 });
	assert.equal(typeof plan.requestId, "string");

	const disabled = fixture({ enabled: false });
	assert.deepEqual(JSON.parse(JSON.stringify(await call(disabled, ipcChannels.remoteHostRebindPlan, sourceHostId, targetHostId))), { ok: false, code: "REMOTE_FEATURE_DISABLED" });
	assert.equal((await call(f, ipcChannels.remoteHostRebindPlan, "not-a-host", targetHostId)).code, "REMOTE_HOST_REBIND_INPUT_INVALID");
});

test("plan 失败只回稳定码", async () => {
	const f = fixture({ planFails: true });
	assert.deepEqual(JSON.parse(JSON.stringify(await call(f, ipcChannels.remoteHostRebindPlan, sourceHostId, targetHostId))), { ok: false, code: "REMOTE_HOST_REBIND_TARGET_UNVERIFIED" });
});

test("answer：没有确认的 requestId 不执行；deny 零执行", async () => {
	const f = fixture();
	assert.equal((await call(f, ipcChannels.remoteHostRebindAnswer, "made-up", "approve")).code, "HOST_REBIND_CONFIRMATION_REQUIRED");
	const plan = await call(f, ipcChannels.remoteHostRebindPlan, sourceHostId, targetHostId);
	const denied = await call(f, ipcChannels.remoteHostRebindAnswer, plan.requestId, "deny");
	assert.deepEqual(JSON.parse(JSON.stringify(denied)), { ok: true, ran: false });
	assert.equal(f.calls.rebind.length, 0, "拒绝不执行任何写");
	assert.equal(f.calls.disconnect.length, 0);
});

test("answer：批准后先断开来源再执行，终态只回稳定字段", async () => {
	const f = fixture();
	const plan = await call(f, ipcChannels.remoteHostRebindPlan, sourceHostId, targetHostId);
	const answered = await call(f, ipcChannels.remoteHostRebindAnswer, plan.requestId, "approve");
	assert.equal(answered.ok, true);
	assert.equal(answered.ran, true);
	assert.deepEqual(f.calls.disconnect, [sourceHostId], "§5.5：执行前断开来源");
	assert.deepEqual(f.calls.rebind, [[sourceHostId, targetHostId]]);
	assert.deepEqual(JSON.parse(JSON.stringify(answered.outcome)), {
		code: "REMOTE_HOST_REBIND_COMMITTED",
		stage: "committed",
		migratedProjects: 1,
		migratedSessions: 0,
		sourceRetired: true,
		warnings: [],
	});
	const text = JSON.stringify(answered);
	assert.ok(!text.includes("txId"), "txId 不出 main");
});

test("answer：两次 plan 不一致（状态变了）→ CONFIRMATION_CHANGED 且不执行", async () => {
	const f = fixture({ plans: [planA, planB] });
	const plan = await call(f, ipcChannels.remoteHostRebindPlan, sourceHostId, targetHostId);
	const answered = await call(f, ipcChannels.remoteHostRebindAnswer, plan.requestId, "approve");
	assert.equal(answered.ok, false);
	assert.equal(answered.code, "CONFIRMATION_CHANGED");
	assert.equal(f.calls.rebind.length, 0, "摘要不一致绝不执行");
});

test("describe：present 投影只带阶段与计数（无 txId / recordId）", async () => {
	const f = fixture({
		describe: {
			present: true,
			txId: "secret-tx",
			stage: "projects-written",
			sourceHostId: "a",
			targetHostId: "b",
			records: { projects: 2, sessions: 1 },
			referenceScan: { complete: true, count: 3 },
		},
	});
	const described = await call(f, ipcChannels.remoteHostRebindDescribe);
	assert.equal(described.ok, true);
	assert.equal(described.pending.present, true);
	assert.equal(described.pending.stage, "projects-written");
	assert.deepEqual(JSON.parse(JSON.stringify(described.pending.records)), { projects: 2, sessions: 1 });
	const text = JSON.stringify(described);
	assert.ok(!text.includes("secret-tx"));
	assert.ok(!text.includes("recordId"));
});

test("resume：没有 journal 时 resumed=false；有则投影终态", async () => {
	const empty = fixture();
	assert.deepEqual(JSON.parse(JSON.stringify(await call(empty, ipcChannels.remoteHostRebindResume))), { ok: true, resumed: false });

	const resumed = fixture({ resumeOutcome: { code: "REMOTE_HOST_REBIND_COMMITTED_WITH_WARNINGS", stage: "committed", migratedProjects: 0, migratedSessions: 0, sourceRetired: true, warnings: ["JOURNAL_REMOVE_FAILED"] } });
	const result = await call(resumed, ipcChannels.remoteHostRebindResume);
	assert.equal(result.ok, true);
	assert.equal(result.resumed, true);
	assert.deepEqual(JSON.parse(JSON.stringify(result.outcome.warnings)), ["JOURNAL_REMOVE_FAILED"]);
});

test("未装配 disconnect 时批准仍可执行（显式可选，不是静默跳过）", async () => {
	const f = fixture({ noDisconnect: true });
	const plan = await call(f, ipcChannels.remoteHostRebindPlan, sourceHostId, targetHostId);
	const answered = await call(f, ipcChannels.remoteHostRebindAnswer, plan.requestId, "approve");
	assert.equal(answered.ran, true);
	assert.equal(f.calls.rebind.length, 1);
});

test("resumePendingAtStartup：启动时自动收敛一次，失败不抛（留给横幅）", async () => {
	const f = fixture();
	await f.resumeAtStartup();
	assert.equal(f.calls.resume, 1);

	const failing = fixture({ resumeFails: true });
	await failing.resumeAtStartup();
	assert.equal(failing.calls.resume, 1, "失败也要尝试过一次");
});
