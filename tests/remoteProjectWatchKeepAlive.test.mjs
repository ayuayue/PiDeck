import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createProjectWatchKeepAlive } = loadTsCommonJs("src/main/ipc/remoteProjectWatchKeepAlive.ts");

const HOST = "b145de8c-6330-45be-8752-f20e8e270150";
const ROOT = "/srv/projects/a";

/** The narrow service face the keep-alive port uses; it records the pairs it is asked to hold. */
function fakeService(calls) {
	return {
		retainProjectSessionWatch(hostId, root) {
			calls.push(["retain", hostId, root]);
		},
		releaseProjectSessionWatch(hostId, root) {
			calls.push(["release", hostId, root]);
		},
	};
}

const subscribeWith = (watchId) => async () => watchId;

test("a session's first watcher retains its (host, root) once, and the last one releases it", async () => {
	const calls = [];
	const keepAlive = createProjectWatchKeepAlive();
	keepAlive.noteSession("conn-1", { service: fakeService(calls), hostId: HOST, root: ROOT });
	await keepAlive.registry.ensure(HOST, "conn-1", "p1", subscribeWith("w1"), { paths: [""] });
	assert.deepEqual(calls, [["retain", HOST, ROOT]], "the first watch keeps the session warm");
	// A second project (or another directory) on the same session must not retain twice.
	await keepAlive.registry.ensure(HOST, "conn-1", "p2", subscribeWith("w2"), { paths: [""] });
	assert.equal(calls.length, 1, "retain is per session, not per watch");
	keepAlive.forgetSession(HOST, "conn-1");
	assert.deepEqual(
		calls,
		[
			["retain", HOST, ROOT],
			["release", HOST, ROOT],
		],
		"retirement gives the keep-alive back exactly once",
	);
	assert.equal(keepAlive.registry.sizeOfSession(HOST, "conn-1"), 0);
	assert.equal(keepAlive.registry.scopesForEvent(HOST, "conn-1", "w1"), undefined, "a retired session's watch ids stay unknown");
});

test("the keep-alive port never throws when it cannot name an owner", async () => {
	const calls = [];
	const keepAlive = createProjectWatchKeepAlive();
	// No noteSession: this happens for a session established before any read registered its owner.
	await assert.doesNotReject(keepAlive.registry.ensure(HOST, "conn-unknown", "p1", subscribeWith("w9"), { paths: [""] }));
	assert.deepEqual(calls, [], "an unknown owner is skipped, not guessed");
	keepAlive.forgetSession(HOST, "conn-unknown");
});

test("a host disconnect drops every session of that host and keeps other hosts warm", async () => {
	const calls = [];
	const otherHost = "0e0f18ba-6f0e-4bd8-9f6c-1c8f6f2a7d31";
	const keepAlive = createProjectWatchKeepAlive();
	const service = fakeService(calls);
	keepAlive.noteSession("conn-a", { service, hostId: HOST, root: ROOT });
	keepAlive.noteSession("conn-b", { service, hostId: HOST, root: "/srv/projects/b" });
	keepAlive.noteSession("conn-c", { service, hostId: otherHost, root: ROOT });
	for (const [sessionKey, projectId] of [
		["conn-a", "p1"],
		["conn-b", "p2"],
		["conn-c", "p3"],
	])
		await keepAlive.registry.ensure(sessionKey === "conn-c" ? otherHost : HOST, sessionKey, projectId, subscribeWith("w-" + sessionKey), { paths: [""] });
	assert.equal(calls.filter((call) => call[0] === "retain").length, 3);
	keepAlive.forgetHost(HOST);
	assert.equal(keepAlive.registry.sizeOfSession(HOST, "conn-a"), 0);
	assert.equal(keepAlive.registry.sizeOfSession(HOST, "conn-b"), 0);
	assert.equal(keepAlive.registry.sizeOfSession(otherHost, "conn-c"), 1, "another host's session is unrelated to this disconnect");
	assert.equal(calls.filter((call) => call[0] === "release").length, 2, "only the disconnected host's sessions release");
	// A late event for the dead sessions must not resolve to a scope.
	assert.equal(keepAlive.registry.scopesForEvent(HOST, "conn-a", "w-conn-a"), undefined);
});

test("a retired root only loses its own session, not its neighbour's", async () => {
	const calls = [];
	const keepAlive = createProjectWatchKeepAlive();
	const service = fakeService(calls);
	keepAlive.noteSession("conn-a", { service, hostId: HOST, root: ROOT });
	keepAlive.noteSession("conn-b", { service, hostId: HOST, root: "/srv/projects/b" });
	await keepAlive.registry.ensure(HOST, "conn-a", "p1", subscribeWith("w-a"), { paths: [""] });
	await keepAlive.registry.ensure(HOST, "conn-b", "p2", subscribeWith("w-b"), { paths: [""] });
	keepAlive.forgetSession(HOST, "conn-a");
	assert.equal(keepAlive.registry.sizeOfSession(HOST, "conn-b"), 1, "retiring one root must not clear a sibling root's registration");
	assert.equal(keepAlive.registry.scopesForEvent(HOST, "conn-b", "w-b").length, 1);
	assert.deepEqual(calls.filter((call) => call[1] === HOST && call[2] === ROOT).length, 2, "one retain and one release for the retired root");
});
