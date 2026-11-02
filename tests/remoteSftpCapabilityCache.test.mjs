import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteSftpCapabilityCache } = loadTsCommonJs("src/main/remote/RemoteSftpCapabilityCache.ts");

function key(overrides = {}) {
	return {
		hostId: "11111111-1111-4111-8111-111111111111",
		canonicalRoot: "/srv/project",
		connectionId: "host#manager#1",
		hostRevision: 3,
		binaryIdentity: "sftp-sha256-v1",
		...overrides,
	};
}

test("positive probes reuse only the exact connection/root/host-revision/binary key", () => {
	const cache = createRemoteSftpCapabilityCache({ now: () => 100 });
	cache.set(key(), { ok: true, value: "probe-v1" });
	assert.deepEqual({ ...cache.get(key()) }, { kind: "positive", value: "probe-v1" });
	for (const changed of [key({ connectionId: "host#manager#2" }), key({ hostRevision: 4 }), key({ binaryIdentity: "sftp-sha256-v2" }), key({ canonicalRoot: "/srv/other" })]) {
		assert.equal(cache.get(changed), undefined);
	}
});

test("negative probe expires after the short TTL and never outlives its generation", () => {
	let now = 50;
	const cache = createRemoteSftpCapabilityCache({ now: () => now, negativeTtlMs: 1000 });
	cache.set(key(), { ok: false, code: "SFTP_SUBSYSTEM_UNAVAILABLE" });
	assert.deepEqual({ ...cache.get(key()) }, { kind: "negative", code: "SFTP_SUBSYSTEM_UNAVAILABLE", retryAt: 1050 });
	now = 1049;
	assert.equal(cache.get(key()).kind, "negative");
	now = 1050;
	assert.equal(cache.get(key()), undefined);
});

test("a new generation for the same host/root replaces old positive and negative entries", () => {
	const cache = createRemoteSftpCapabilityCache({ now: () => 10 });
	const first = key({ connectionId: "host#manager#1", hostRevision: 1 });
	cache.set(first, { ok: true, value: "old" });
	const second = key({ connectionId: "host#manager#2", hostRevision: 2 });
	cache.set(second, { ok: false, code: "SFTP_SUBSYSTEM_UNAVAILABLE" });
	assert.equal(cache.get(first), undefined);
	assert.equal(cache.get(second).kind, "negative");
	assert.equal(cache.size(), 1);
});

test("host/root/connection invalidation removes only the selected scope", () => {
	const cache = createRemoteSftpCapabilityCache({ now: () => 1, maxEntries: 16 });
	const a = key();
	const b = key({ canonicalRoot: "/srv/b", connectionId: "host#manager#2" });
	const c = key({ hostId: "22222222-2222-4222-8222-222222222222", connectionId: "host#manager#3" });
	cache.set(a, { ok: true, value: "a" });
	cache.set(b, { ok: true, value: "b" });
	cache.set(c, { ok: true, value: "c" });
	assert.equal(cache.invalidateRoot(a.hostId, "/srv/project"), 1);
	assert.equal(cache.get(a), undefined);
	assert.equal(cache.get(b).kind, "positive");
	cache.set(a, { ok: true, value: "a2" });
	assert.equal(cache.invalidateConnection(a.connectionId), 1);
	assert.equal(cache.size(), 2);
	assert.equal(cache.get(b).kind, "positive");
	assert.equal(cache.get(c).kind, "positive");
	assert.equal(cache.invalidateHost(c.hostId), 1);
	assert.equal(cache.get(c), undefined);
	assert.equal(cache.size(), 1);
	assert.equal(cache.get(b).kind, "positive");
	assert.equal(cache.invalidateHost(b.hostId), 1);
	assert.equal(cache.size(), 0);
});

test("cache size is bounded by LRU eviction", () => {
	const cache = createRemoteSftpCapabilityCache({ now: () => 1, maxEntries: 2 });
	const a = key({ canonicalRoot: "/srv/a" });
	const b = key({ canonicalRoot: "/srv/b" });
	const c = key({ canonicalRoot: "/srv/c" });
	cache.set(a, { ok: true, value: "a" });
	cache.set(b, { ok: true, value: "b" });
	assert.equal(cache.get(a).kind, "positive");
	cache.set(c, { ok: true, value: "c" });
	assert.equal(cache.get(b), undefined);
	assert.equal(cache.get(a).kind, "positive");
	assert.equal(cache.get(c).kind, "positive");
});

test("invalid keys and options fail closed", () => {
	assert.throws(() => createRemoteSftpCapabilityCache({ negativeTtlMs: 0 }), /REMOTE_SFTP_CACHE_OPTIONS_INVALID/);
	assert.throws(() => createRemoteSftpCapabilityCache({ maxEntries: 0 }), /REMOTE_SFTP_CACHE_OPTIONS_INVALID/);
	const cache = createRemoteSftpCapabilityCache({ now: () => 1 });
	assert.throws(() => cache.get(key({ canonicalRoot: "" })), /REMOTE_SFTP_CACHE_KEY_INVALID/);
	assert.throws(() => cache.get(key({ canonicalRoot: "/srv/../etc" })), /REMOTE_SFTP_CACHE_KEY_INVALID/);
	assert.throws(() => cache.set(key({ hostRevision: -1 }), { ok: true, value: null }), /REMOTE_SFTP_CACHE_KEY_INVALID/);
});
