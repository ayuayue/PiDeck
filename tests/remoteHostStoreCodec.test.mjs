import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { decodeRemoteHostSnapshot, encodeRemoteHostSnapshot } = loadTsCommonJs("src/main/remote/RemoteHostStoreCodec.ts");
const id = "01234567-89ab-4def-8123-456789abcdef";
const stamp = "2026-08-01T00:00:00.000Z";
const draft = { id, label: "Build Pi", sshHost: "build-pi", user: "alice", port: 2222, connectTimeoutMs: 15000, createdAt: stamp, updatedAt: stamp };
const endpoint = { hostName: "pi.example.invalid", port: 2222, user: "alice", pinAlias: `pideck-${id}`, routeDigest: "a".repeat(64), knownHostsSha256: "b".repeat(64), hostKeyFingerprints: [`SHA256:${"A".repeat(43)}`] };

function envelope(profiles = [draft], retiredHostIds = [], revision = 1) {
	return { schemaVersion: 1, revision, profiles, retiredHostIds };
}

test("round-trips draft, verified tombstone and retired identities without legacy paths", () => {
	const verified = { ...draft, verifiedEndpoint: endpoint, verifiedAt: stamp, disabledAt: stamp };
	const snapshot = decodeRemoteHostSnapshot(envelope([verified], ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]));
	assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), { revision: 1, profiles: [verified], retiredHostIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] });
	assert.deepEqual(JSON.parse(JSON.stringify(encodeRemoteHostSnapshot(snapshot.profiles, snapshot.retiredHostIds, 2))), envelope([verified], ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"], 2));
});

test("rejects aliases, ports, shell commands, unverified roots and unknown authority fields", () => {
	for (const profile of [
		{ ...draft, sshHost: "-oProxyCommand=sh" },
		{ ...draft, sshHost: "host\nProxyCommand sh" },
		{ ...draft, port: 0 },
		{ ...draft, proxyJump: "jump; id" },
		{ ...draft, remoteNodeCommand: "node; id" },
		{ ...draft, browseRoots: ["/home/alice/../root"] },
		{ ...draft, verifiedAt: stamp },
		{ ...draft, path: "C:\\faked-authority" },
	])
		assert.throws(() => decodeRemoteHostSnapshot(envelope([profile])), /REMOTE_HOST_STORE_INVALID/);
});

test("rejects duplicate, reused, or inconsistent endpoint identities", () => {
	for (const invalid of [
		envelope([draft, draft]),
		envelope([draft], [id]),
		envelope([draft], [id, id]),
		envelope([{ ...draft, verifiedEndpoint: { ...endpoint, pinAlias: "pideck-other" }, verifiedAt: stamp }]),
		envelope([{ ...draft, verifiedEndpoint: endpoint }]),
		envelope([{ ...draft, disabledAt: "not-a-date" }]),
		envelope([{ ...draft, disabledAt: "2026-07-31T23:59:59.000Z" }]),
		envelope([{ ...draft, verifiedEndpoint: endpoint, verifiedAt: "2026-07-31T23:59:59.000Z" }]),
		{ ...envelope(), schemaVersion: 2 },
		{ ...envelope(), revision: -1 },
	])
		assert.throws(() => decodeRemoteHostSnapshot(invalid), /REMOTE_HOST_STORE_INVALID/);
});
