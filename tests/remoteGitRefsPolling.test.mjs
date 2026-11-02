import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { REMOTE_GIT_REFS_POLL_INTERVAL_MS, startRemoteGitRefsPolling } = loadTsCommonJs("src/renderer/src/utils/remoteGitRefsPolling.ts");
const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const HOOK = "src/renderer/src/hooks/useRemoteGitRefsPolling.ts";
const PANEL = "src/renderer/src/components/workspace/RemoteGitPanel.tsx";
const projectId = "project";
const oid = (char) => char.repeat(40);

/** Deterministic scheduler: tests decide when a tick happens and can observe the cleared handle. */
function fakeTimer() {
	const timers = [];
	const cleared = [];
	return {
		timers,
		cleared,
		set(callback, intervalMs) {
			timers.push({ callback, intervalMs });
			return timers.length - 1;
		},
		clear(handle) {
			cleared.push(handle);
		},
		tick() {
			timers[timers.length - 1].callback();
		},
	};
}
const flush = () => new Promise((accept) => setImmediate(accept));
function poller(poll) {
	const timer = fakeTimer();
	let enabled = true;
	const calls = [];
	const stop = startRemoteGitRefsPolling({
		intervalMs: REMOTE_GIT_REFS_POLL_INTERVAL_MS,
		isEnabled: () => enabled,
		poll: () => {
			calls.push(calls.length + 1);
			return poll ? poll() : Promise.resolve();
		},
		timer,
	});
	return { timer, calls, stop, setEnabled: (value) => (enabled = value) };
}

test("refs polling runs at a fixed bounded cadence", () => {
	assert.equal(REMOTE_GIT_REFS_POLL_INTERVAL_MS, 15_000);
	const f = poller();
	assert.equal(f.timer.timers.length, 1);
	assert.equal(f.timer.timers[0].intervalMs, 15_000);
});

test("ticks poll only while the gate is enabled", async () => {
	const f = poller();
	f.timer.tick();
	await flush();
	assert.equal(f.calls.length, 1);
	f.setEnabled(false);
	f.timer.tick();
	await flush();
	assert.equal(f.calls.length, 1, "a closed gate must not start a read");
	f.setEnabled(true);
	f.timer.tick();
	await flush();
	assert.equal(f.calls.length, 2);
	f.stop();
});

test("a tick while the previous poll is unsettled does not start a second read", async () => {
	let resolve;
	const pending = new Promise((accept) => {
		resolve = accept;
	});
	const f = poller(() => pending);
	f.timer.tick();
	f.timer.tick();
	f.timer.tick();
	assert.equal(f.calls.length, 1, "single flight: overlapping ticks are skipped");
	resolve();
	await flush();
	f.timer.tick();
	assert.equal(f.calls.length, 2, "the next tick after settlement starts a new read");
	f.stop();
});

test("stopping clears the interval and no later tick can poll", async () => {
	const f = poller();
	f.timer.tick();
	await flush();
	f.stop();
	assert.deepEqual(f.timer.cleared, [0], "the interval handle is cleared");
	f.timer.tick();
	await flush();
	assert.equal(f.calls.length, 1, "a stopped poller never starts another read");
});

test("a rejected poll is swallowed and does not wedge the poller", async () => {
	let attempts = 0;
	const f = poller(() => {
		attempts += 1;
		return attempts === 1 ? Promise.reject(new Error("connection lost")) : Promise.resolve();
	});
	f.timer.tick();
	await flush();
	f.timer.tick();
	await flush();
	assert.equal(attempts, 2, "the timer survives a failed tick; the controller reports the code");
	f.stop();
});

test("the hook polls only when expanded, visible, host-ready and after the first refs load", () => {
	const hook = readFileSync(HOOK, "utf8");
	assert.match(hook, /useDocumentPageVisible/);
	assert.match(hook, /visibilitychange/);
	assert.match(hook, /!active \|\| !pageVisible \|\| !hostReady \|\| !refsLoaded/);
	assert.match(hook, /stopPolling\(\);\s*stopRef\.current\(\);/);
	assert.ok(!hook.includes("loadSync"), "polling must never touch sync facts");
	assert.ok(!hook.includes("loadRefs"), "polling is a quiet read, not the manual section load");
	const panel = readFileSync(PANEL, "utf8");
	// The gates are the refs area's own expansion, the refs-watch capability and the host's observed readiness,
	// never a snapshot-watching effect. G4b adds the capability to the expansion gate (the hook still requires
	// expanded + visible + host-ready + a first manual refs load).
	assert.match(panel, /useRemoteGitRefsPolling\(\{\s*active: refsOpen && capabilities\.refsWatch,\s*refsLoaded: state\.refs !== undefined,\s*hostReady,\s*poll: pollRefs,\s*stop: stopRefsPolling,?\s*\}\)/);
	assert.match(panel, /data-testid="remote-git-refs-auto"/);
	for (const effect of panel.split("useEffect(").slice(1)) {
		const body = effect.split("\n\t},")[0];
		assert.ok(!body.includes("pollRefs"), "only the polling hook owns the interval");
	}
});

/** The controller's quiet poll and generation fencing: the timer only decides when, never what may publish. */
function refsList(branch, head = oid("a")) {
	return { head, branch, refs: [{ fullName: "refs/heads/main", name: "main", oid: head, kind: "branch" }] };
}
function controllerFixture(api = {}) {
	const states = [];
	const reads = createRemoteGitViewController(
		projectId,
		"identity",
		{
			cancelRemoteReads: async () => {},
			status: async () => ({ ok: true, snapshot: { head: oid("a"), branch: "main", groups: { merge: [], index: [], workingTree: [], untracked: [] } } }),
			branches: async () => ({ ok: true, info: { current: "main", branches: ["main"] } }),
			refs: async () => ({ ok: true, refs: refsList("main") }),
			...api,
		},
		(state) => states.push(state),
	);
	return { reads, current: () => states.at(-1) };
}

test("a quiet poll keeps the rows on screen and reports failures without clearing them", async () => {
	let result = { ok: true, refs: refsList("main") };
	const f = controllerFixture({ refs: async () => result });
	await f.reads.refresh();
	await f.reads.loadRefs();
	assert.equal(f.current().refs.branch, "main");
	result = { ok: false, code: "GIT_COMMAND_FAILED" };
	await f.reads.pollRefs();
	assert.equal(f.current().refs.branch, "main", "a failed tick must not blank the list");
	assert.equal(f.current().refsErrorCode, "GIT_COMMAND_FAILED");
	result = { ok: true, refs: refsList("next") };
	await f.reads.pollRefs();
	assert.equal(f.current().refs.branch, "next");
	assert.equal(f.current().refsErrorCode, undefined, "a successful tick clears the stale error");
});

test("polling never runs before refs facts exist and never overlaps itself", async () => {
	let calls = 0;
	let resolve;
	const pending = new Promise((accept) => {
		resolve = accept;
	});
	const f = controllerFixture({
		refs: () => {
			calls += 1;
			return calls === 1 ? Promise.resolve({ ok: true, refs: refsList("main") }) : pending;
		},
	});
	await f.reads.refresh();
	await f.reads.pollRefs();
	assert.equal(calls, 0, "the first refs load stays a manual action");
	await f.reads.loadRefs();
	assert.equal(calls, 1);
	const first = f.reads.pollRefs();
	await f.reads.pollRefs();
	assert.equal(calls, 2, "one poll in flight at a time");
	resolve({ ok: true, refs: refsList("main") });
	await first;
});

test("a manual refs load and stopRefsPolling both retire an in-flight poll", async () => {
	let resolvePoll;
	let pollPending;
	let mode = "poll";
	const f = controllerFixture({
		refs: () => {
			if (mode !== "poll") return Promise.resolve({ ok: true, refs: refsList("manual", oid("b")) });
			pollPending = new Promise((accept) => {
				resolvePoll = accept;
			});
			return pollPending;
		},
	});
	await f.reads.refresh();
	mode = "manual";
	await f.reads.loadRefs();
	mode = "poll";
	const polling = f.reads.pollRefs();
	mode = "manual";
	await f.reads.loadRefs();
	resolvePoll({ ok: true, refs: refsList("stale", oid("c")) });
	await polling;
	assert.equal(f.current().refs.branch, "manual", "a manual load supersedes the in-flight poll answer");
	// stopRefsPolling (collapse/hide/unmount) retires the next poll just the same.
	mode = "poll";
	const stale = f.reads.pollRefs();
	f.reads.stopRefsPolling();
	resolvePoll({ ok: true, refs: refsList("stale-again", oid("d")) });
	await stale;
	assert.equal(f.current().refs.branch, "manual", "a stopped poll cannot publish later");
});
