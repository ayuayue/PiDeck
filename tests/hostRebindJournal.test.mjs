import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { HostRebindJournal } = loadTsCommonJs("src/main/remote/HostRebindJournal.ts");

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

function locatorOf(hostId) {
	return JSON.stringify({ kind: "ssh", hostId, remotePath: "/srv/app" });
}

const BEFORE = locatorOf(SOURCE);
const AFTER = locatorOf(TARGET);
const ELSEWHERE = locatorOf(OTHER);

function journalOf(overrides = {}) {
	const records = overrides.records ?? [
		{ store: "projects", recordId: "p-1", beforeLocator: BEFORE, afterLocator: AFTER },
		{ store: "sessions", recordId: "s-1", beforeLocator: BEFORE, afterLocator: AFTER },
	];
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

/**
 * Journal + fake ports over one mutable "disk". Failure injection is per port call, so a test can
 * model "the write threw" and "the write landed but the caller saw an error" separately.
 */
async function createModel(t, options = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-rebind-journal-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const journal = new HostRebindJournal({
		userDataDir: directory,
		isProcessAlive: options.isProcessAlive ?? (() => false),
		bootId: options.bootId ?? "boot-1",
		now: options.now ?? Date.now,
	});
	if (options.journal !== null) await journal.write(options.journal ?? journalOf());
	const model = {
		records: new Map(
			options.records ?? [
				["p-1", BEFORE],
				["s-1", BEFORE],
			],
		),
		profiles: options.profiles ?? [
			{ hostId: SOURCE, disabled: false, verified: true },
			{ hostId: TARGET, disabled: false, verified: true },
		],
		retiredHostIds: options.retiredHostIds ?? [],
		revision: options.revision ?? 1,
		scan: options.scan ?? { complete: true, ids: [] },
		hostFailures: options.hostFailures ?? {},
		storeFailures: options.storeFailures ?? {},
		calls: [],
	};
	const host = {
		async readHostState() {
			if (model.hostFailures.readState) throw model.hostFailures.readState;
			return { revision: model.revision, profiles: model.profiles, retiredHostIds: model.retiredHostIds };
		},
		async verifyTargetAnchor(hostId) {
			model.calls.push(`anchor:${hostId}`);
			if (model.hostFailures.anchor) throw model.hostFailures.anchor;
		},
		async disableSource(hostId, revision) {
			model.calls.push(`disable@${revision}`);
			const failure = model.hostFailures.disable;
			if (failure?.lands) model.profiles = model.profiles.map((profile) => (profile.hostId === hostId ? { ...profile, disabled: true } : profile));
			if (failure) throw failure.error;
			model.profiles = model.profiles.map((profile) => (profile.hostId === hostId ? { ...profile, disabled: true } : profile));
			model.revision += 1;
			return model.revision;
		},
		async retireSource(hostId, revision) {
			model.calls.push(`retire@${revision}`);
			const failure = model.hostFailures.retire;
			if (failure?.lands) {
				model.profiles = model.profiles.filter((profile) => profile.hostId !== hostId);
				model.retiredHostIds = [...model.retiredHostIds, hostId];
				model.revision += 1;
			}
			if (failure) throw failure.error;
			model.profiles = model.profiles.filter((profile) => profile.hostId !== hostId);
			model.retiredHostIds = [...model.retiredHostIds, hostId];
			model.revision += 1;
			return model.revision;
		},
		async scanReferences() {
			model.calls.push("scan");
			return { complete: model.scan.complete, referencedHostIds: new Set(model.scan.ids) };
		},
	};
	const storePort = (name) => ({
		async readHostRecordLocators(recordIds) {
			model.calls.push(`read:${name}`);
			if (model.storeFailures.read?.[name]) throw model.storeFailures.read[name];
			return Array.from(recordIds, (recordId) => (model.records.has(recordId) ? { recordId, locator: model.records.get(recordId) } : { recordId }));
		},
		async applyHostRebind(_txId, patches) {
			model.calls.push(`apply:${name}`);
			const failure = model.storeFailures.apply?.[name];
			if (failure?.lands) for (const patch of patches) model.records.set(patch.recordId, patch.afterLocator);
			if (failure) throw failure.error;
			const results = [];
			for (const patch of patches) {
				const current = model.records.get(patch.recordId);
				if (current === undefined) results.push({ recordId: patch.recordId, outcome: "missing" });
				else if (current === patch.afterLocator) results.push({ recordId: patch.recordId, outcome: "already-applied" });
				else if (current !== patch.beforeLocator) results.push({ recordId: patch.recordId, outcome: "changed" });
				else {
					model.records.set(patch.recordId, patch.afterLocator);
					results.push({ recordId: patch.recordId, outcome: "applied" });
				}
			}
			return model.storeFailures.partial ? results.slice(0, results.length - 1) : results;
		},
	});
	return { directory, journal, model, ports: { host, projects: storePort("projects"), sessions: storePort("sessions") } };
}

function terminalOf(model, directory) {
	return {
		projects: model.records.get("p-1"),
		sessions: model.records.get("s-1"),
		retired: model.retiredHostIds.includes(SOURCE),
		sourceDisabled: model.profiles.find((profile) => profile.hostId === SOURCE)?.disabled ?? false,
		sourcePresent: model.profiles.some((profile) => profile.hostId === SOURCE),
		journalPresent: existsSync(join(directory, "remote-host-rebind.json")),
		lockPresent: existsSync(join(directory, "remote-host-rebind.lock")),
	};
}

const CLEAN_TERMINAL = {
	projects: AFTER,
	sessions: AFTER,
	retired: true,
	sourceDisabled: false,
	sourcePresent: false,
	journalPresent: false,
	lockPresent: false,
};

async function captureRejection(operation) {
	try {
		await operation();
	} catch (error) {
		return error.message;
	}
	return undefined;
}

test("a missing journal is a no-op and never touches a port", async (t) => {
	const { journal, model, ports } = await createModel(t, { journal: null });
	assert.equal(await journal.resume(ports), undefined);
	assert.deepEqual(model.calls, []);
});

test("round-trips the journal atomically without a backup file", async (t) => {
	const { directory, journal } = await createModel(t, { journal: null });
	const written = journalOf({ stage: "projects-written" });
	await journal.write(written);
	const raw = await readFile(journal.path(), "utf8");
	assert.ok(raw.endsWith("\n"), "the file is written with a trailing newline");
	assert.equal(JSON.parse(raw).stage, "projects-written");
	assert.equal(existsSync(`${journal.path()}.bak`), false, "the journal deliberately has no backup (design Q8)");
	assert.deepEqual(JSON.parse(JSON.stringify(await journal.read())), JSON.parse(JSON.stringify(written)));
	await journal.remove();
	assert.equal(await journal.read(), undefined);
	await journal.remove();
});

test("a malformed journal fails closed and is never deleted or overwritten", async (t) => {
	for (const content of ["{broken", JSON.stringify({ ...journalOf(), stage: "half-done" }), JSON.stringify({ ...journalOf(), unexpected: 1 }), ""]) {
		const { directory, journal, ports } = await createModel(t, { journal: null });
		await writeFile(journal.path(), content);
		const readError = await captureRejection(() => journal.read());
		assert.equal(readError, "REMOTE_HOST_REBIND_JOURNAL_INVALID", content);
		assert.equal(await captureRejection(() => journal.resume(ports)), "REMOTE_HOST_REBIND_JOURNAL_INVALID");
		assert.equal(await readFile(join(directory, "remote-host-rebind.json"), "utf8"), content, "the unreadable file is left for a human");
	}
});

test("per-record locators outrank the recorded stage", async (t) => {
	// Stage claims the sessions were written, but disk says nothing moved: it must be migrated.
	const stale = await createModel(t, { journal: journalOf({ stage: "sessions-written" }) });
	await stale.journal.resume(stale.ports);
	assert.deepEqual(terminalOf(stale.model, stale.directory), CLEAN_TERMINAL);

	// Stage claims nothing happened, but disk says both records already point at the target: no rewrite.
	const progressed = await createModel(t, {
		journal: journalOf({ stage: "prepared" }),
		records: [
			["p-1", AFTER],
			["s-1", AFTER],
		],
	});
	const outcome = await progressed.journal.resume(progressed.ports);
	assert.equal(outcome.code, "REMOTE_HOST_REBIND_COMMITTED");
	assert.equal(outcome.migratedProjects, 0);
	assert.equal(outcome.migratedSessions, 0);
	assert.equal(
		progressed.model.calls.some((call) => call.startsWith("apply:")),
		false,
		"an already-applied record is not rewritten",
	);
	assert.equal(progressed.model.retiredHostIds.includes(SOURCE), true);
	assert.equal(existsSync(join(progressed.directory, "remote-host-rebind.json")), false);
});

test("every crash point converges to the same terminal state as an uninterrupted run", async (t) => {
	const crashes = [
		["the source could not be disabled", { hostFailures: { disable: { error: new Error("write failed") } } }],
		["the projects write threw before landing", { storeFailures: { apply: { projects: { error: new Error("disk full") } } } }],
		["the sessions write threw before landing", { storeFailures: { apply: { sessions: { error: new Error("disk full") } } } }],
		["the retire threw before landing", { hostFailures: { retire: { error: new Error("write failed") } } }],
	];
	for (const [label, options] of crashes) {
		const model = await createModel(t, options);
		const firstError = await captureRejection(() => model.journal.resume(model.ports));
		assert.notEqual(firstError, undefined, label);
		// Restart with the fault gone: convergence must be idempotent and reach the clean terminal state.
		model.model.hostFailures = {};
		model.model.storeFailures = {};
		const outcome = await model.journal.resume(model.ports);
		assert.equal(outcome.code, "REMOTE_HOST_REBIND_COMMITTED", label);
		assert.deepEqual(terminalOf(model.model, model.directory), CLEAN_TERMINAL, label);
		// A third run has no journal left and changes nothing.
		model.model.records.set("p-1", AFTER);
		const callsBefore = model.model.calls.length;
		assert.equal(await model.journal.resume(model.ports), undefined, label);
		assert.equal(model.model.calls.length, callsBefore, label);
	}
});

test("a second resume after convergence is a no-op", async (t) => {
	const model = await createModel(t);
	assert.equal((await model.journal.resume(model.ports)).code, "REMOTE_HOST_REBIND_COMMITTED");
	const before = terminalOf(model.model, model.directory);
	assert.equal(await model.journal.resume(model.ports), undefined);
	assert.deepEqual(terminalOf(model.model, model.directory), before);
});

test("a source that is already retired skips the retire step but still migrates its records", async (t) => {
	// Crash between "retire committed" and "committed stage": the id is gone, references are not.
	const model = await createModel(t, {
		profiles: [{ hostId: TARGET, disabled: false, verified: true }],
		retiredHostIds: [SOURCE],
	});
	const outcome = await model.journal.resume(model.ports);
	assert.equal(outcome.code, "REMOTE_HOST_REBIND_COMMITTED");
	assert.equal(outcome.sourceRetired, true);
	assert.deepEqual(
		model.model.calls.filter((call) => call.startsWith("retire")),
		[],
		"a retired id is never retired twice",
	);
	assert.equal(model.model.records.get("p-1"), AFTER);
	assert.equal(model.model.records.get("s-1"), AFTER);
	assert.equal(existsSync(join(model.directory, "remote-host-rebind.json")), false);
});

test("a disappeared record stops convergence without recreating it", async (t) => {
	const model = await createModel(t, { records: [["s-1", BEFORE]] });
	assert.equal(await captureRejection(() => model.journal.resume(model.ports)), "REMOTE_HOST_REBIND_RECORD_MISSING");
	assert.equal(model.model.records.has("p-1"), false, "the missing record is not resurrected");
	assert.equal(model.model.retiredHostIds.includes(SOURCE), false, "nothing may be retired while a record is unknown");
	assert.equal(
		model.model.calls.some((call) => call.startsWith("apply:")),
		false,
	);
	assert.equal(existsSync(join(model.directory, "remote-host-rebind.json")), true, "the journal stays for the human");
});

test("a record written by someone else stops the transaction", async (t) => {
	const model = await createModel(t, {
		records: [
			["p-1", ELSEWHERE],
			["s-1", BEFORE],
		],
	});
	assert.equal(await captureRejection(() => model.journal.resume(model.ports)), "REMOTE_HOST_REBIND_STALE_PLAN");
	assert.equal(model.model.records.get("p-1"), ELSEWHERE, "the foreign write is never overwritten");
	assert.equal(model.model.records.get("s-1"), BEFORE, "no partial migration");
	assert.equal(model.model.retiredHostIds.includes(SOURCE), false);
});

test("an unreadable target anchor stops convergence before any host write", async (t) => {
	const model = await createModel(t, { hostFailures: { anchor: new Error("SSH_HOST_PIN_INVALID") } });
	assert.equal(await captureRejection(() => model.journal.resume(model.ports)), "REMOTE_HOST_REBIND_TARGET_ANCHOR_UNREADABLE");
	assert.deepEqual(model.model.calls, [`anchor:${TARGET}`], "no disable, no migration, no retire");
	assert.equal(model.model.retiredHostIds.includes(SOURCE), false);
	assert.equal(
		model.model.profiles.some((profile) => profile.hostId === SOURCE && !profile.disabled),
		true,
		"the source is untouched",
	);
	assert.equal(existsSync(join(model.directory, "remote-host-rebind.json")), true);
});

test("retirement needs a complete and empty reference scan", async (t) => {
	// References still point at the source: stay on the disabled tombstone, keep the journal.
	const referenced = await createModel(t, { scan: { complete: true, ids: [SOURCE] } });
	assert.equal(await captureRejection(() => referenced.journal.resume(referenced.ports)), "REMOTE_HOST_REBIND_INCOMPLETE");
	assert.equal(referenced.model.retiredHostIds.includes(SOURCE), false);
	assert.equal(
		referenced.model.profiles.some((profile) => profile.hostId === SOURCE && profile.disabled),
		true,
		"the source stays a disabled tombstone",
	);
	assert.equal(
		referenced.model.calls.some((call) => call.startsWith("retire")),
		false,
	);

	// An incomplete scan cannot prove "no references" either.
	const incomplete = await createModel(t, { scan: { complete: false, ids: [] } });
	assert.equal(await captureRejection(() => incomplete.journal.resume(incomplete.ports)), "REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE");
	assert.equal(incomplete.model.retiredHostIds.includes(SOURCE), false);
	assert.equal(existsSync(join(incomplete.directory, "remote-host-rebind.json")), true);
});

test("a committed journal is only dropped, never replayed", async (t) => {
	const model = await createModel(t, {
		journal: journalOf({ stage: "committed" }),
		records: [
			["p-1", BEFORE],
			["s-1", BEFORE],
		],
	});
	const outcome = await model.journal.resume(model.ports);
	assert.equal(outcome.code, "REMOTE_HOST_REBIND_COMMITTED");
	assert.equal(outcome.stage, "committed");
	assert.deepEqual(model.model.calls, [], "a committed transaction does not touch either store");
	assert.equal(model.model.records.get("p-1"), BEFORE);
	assert.equal(existsSync(join(model.directory, "remote-host-rebind.json")), false);
});

test("a journal that cannot be deleted is reported as committed with warnings, then retried", async (t) => {
	const realFs = await import("node:fs/promises");
	const { HostRebindJournal: FailingJournal } = loadTsCommonJs("src/main/remote/HostRebindJournal.ts", {
		stubs: {
			"node:fs/promises": {
				...realFs,
				unlink: async () => {
					throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
				},
			},
		},
	});
	const directory = await mkdtemp(join(tmpdir(), "pideck-rebind-journal-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const journal = new FailingJournal({ userDataDir: directory, isProcessAlive: () => false, bootId: "boot-1" });
	await journal.write(journalOf({ stage: "committed" }));
	const outcome = await journal.resume({
		host: {
			async readHostState() {
				throw new Error("unused");
			},
		},
	});
	assert.equal(outcome.code, "REMOTE_HOST_REBIND_COMMITTED_WITH_WARNINGS");
	assert.deepEqual(Array.from(outcome.warnings), ["JOURNAL_REMOVE_FAILED"]);
	assert.equal(existsSync(journal.path()), true);
});

test("the transaction lock defers to a live owner and recovers a provably dead one", async (t) => {
	const ownerOf = (overrides = {}) => JSON.stringify({ pid: 424242, bootId: "boot-1", startedAt: "2026-09-01T00:00:00.000Z", ...overrides });

	// Another instance on this boot is alive: recovery gives up instead of fighting for the lock.
	const live = await createModel(t, { journal: null, isProcessAlive: () => true });
	await writeFile(live.journal.lockFilePath(), ownerOf());
	await live.journal.write(journalOf());
	assert.equal(await live.journal.resume(live.ports), undefined);
	assert.deepEqual(live.model.calls, []);
	assert.equal(existsSync(live.journal.path()), true, "the journal is left for the live owner");
	assert.equal(existsSync(live.journal.lockFilePath()), true);

	// Same owner, but the pid is gone: a crashed writer, so recovery may proceed.
	const dead = await createModel(t, { journal: null, isProcessAlive: () => false });
	await writeFile(dead.journal.lockFilePath(), ownerOf());
	await dead.journal.write(journalOf());
	assert.equal((await dead.journal.resume(dead.ports)).code, "REMOTE_HOST_REBIND_COMMITTED");
	assert.equal(existsSync(dead.journal.lockFilePath()), false, "the recovered lock is released");

	// Same pid but a different boot id proves pid reuse.
	const reused = await createModel(t, { journal: null, isProcessAlive: () => true, bootId: "boot-2" });
	await writeFile(reused.journal.lockFilePath(), ownerOf());
	await reused.journal.write(journalOf());
	assert.equal((await reused.journal.resume(reused.ports)).code, "REMOTE_HOST_REBIND_COMMITTED");

	// A lock without owner metadata cannot be judged: treated as held (no timeout preemption).
	const opaque = await createModel(t, { journal: null, isProcessAlive: () => false });
	await writeFile(opaque.journal.lockFilePath(), "held\n");
	await opaque.journal.write(journalOf());
	assert.equal(await opaque.journal.resume(opaque.ports), undefined);
	assert.deepEqual(opaque.model.calls, []);
});

test("a store write that landed but threw is rolled forward, a real rejection passes through", async (t) => {
	// §1.5: "threw" does not mean "did not commit" (the host store can throw after a successful commit).
	const landed = await createModel(t, { hostFailures: { retire: { error: new Error("REMOTE_HOST_STORE_NEEDS_REPAIR"), lands: true } } });
	const rolled = await landed.journal.resume(landed.ports);
	assert.equal(rolled.code, "REMOTE_HOST_REBIND_COMMITTED_WITH_WARNINGS");
	assert.deepEqual(Array.from(rolled.warnings), ["UNKNOWN_OUTCOME_ROLLED_FORWARD"]);
	assert.equal(landed.model.retiredHostIds.includes(SOURCE), true);

	// A store-level validation failure keeps its own meaning (design §4.2: store codes pass through).
	const rejected = await createModel(t, { hostFailures: { retire: { error: new Error("REMOTE_HOST_RETIRE_INVALID") } } });
	assert.equal(await captureRejection(() => rejected.journal.resume(rejected.ports)), "REMOTE_HOST_RETIRE_INVALID");
	assert.equal(rejected.model.retiredHostIds.includes(SOURCE), false);

	// Anything else is an unknown outcome, never the raw error text.
	const unknown = await createModel(t, { hostFailures: { retire: { error: new Error("EACCES: C:\\Users\\me\\remote-hosts.json") } } });
	assert.equal(await captureRejection(() => unknown.journal.resume(unknown.ports)), "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
});

test("port failures and malformed port results never leak text or look applied", async (t) => {
	const leaking = await createModel(t, { storeFailures: { apply: { projects: { error: new Error("boom at C:\\secret\\path") } } } });
	assert.equal(await captureRejection(() => leaking.journal.resume(leaking.ports)), "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");

	const partial = await createModel(t, { storeFailures: { partial: true } });
	assert.equal(await captureRejection(() => partial.journal.resume(partial.ports)), "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");

	// A store with records but no port cannot be converged silently.
	const portless = await createModel(t);
	assert.equal(await captureRejection(() => portless.journal.resume({ host: portless.ports.host })), "REMOTE_HOST_REBIND_STORE_PORT_MISSING");
});

test("a source profile that vanished without being retired stops the transaction", async (t) => {
	const model = await createModel(t, { profiles: [{ hostId: TARGET, disabled: false, verified: true }] });
	assert.equal(await captureRejection(() => model.journal.resume(model.ports)), "REMOTE_HOST_REBIND_SOURCE_MISSING");
	assert.equal(
		model.model.calls.some((call) => call.startsWith("retire")),
		false,
	);
	assert.equal(model.model.records.get("p-1"), BEFORE);
});

test("the retire revision is taken from disk, not from the journal", async (t) => {
	const model = await createModel(t, { revision: 7, journal: journalOf({ expectedHostRevision: 1 }) });
	assert.equal((await model.journal.resume(model.ports)).code, "REMOTE_HOST_REBIND_COMMITTED");
	assert.equal(model.model.calls.includes("retire@8"), true, `last call: ${model.model.calls.join(", ")}`);
});
