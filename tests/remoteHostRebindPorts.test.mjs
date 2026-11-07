import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteHostRebindPorts } = loadTsCommonJs("src/main/remote/RemoteHostRebindPorts.ts");

/**
 * Rebind 前置（设计附 A 第 1 步）：host 端口把真实 store 映射成 journal 的词汇。
 *
 * 只钉映射与幂等，不重复测 store 自己的 CAS（那在 RemoteHostStore 套件里）：
 * - `disabled` 来自 tombstone 标记、`verified` 来自已确认 endpoint；
 * - 已禁用的来源是 no-op（不调 store.disable），revision 一律 re-read；
 * - target anchor 必须真的能从磁盘读出 pin；
 * - `listHostRecords` 只保留 projects/sessions 两个可迁移源。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const endpoint = { pinAlias: "pideck-h1", knownHostsSha256: "a".repeat(64), routeDigest: "b".repeat(64), hostKeyFingerprints: ["SHA256:x"] };

function harness(overrides = {}) {
	const calls = [];
	const profiles = overrides.profiles ?? [
		{ id: "h1", disabledAt: undefined, verifiedEndpoint: endpoint },
		{ id: "h2", disabledAt: "2026-01-01T00:00:00.000Z", verifiedEndpoint: undefined },
	];
	let revision = overrides.revision ?? 4;
	const store = {
		getSnapshot: () => ({ revision, profiles, retiredHostIds: overrides.retiredHostIds ?? [] }),
		disable: async (hostId, expectedRevision) => {
			calls.push(["disable", hostId, expectedRevision]);
			revision += 1;
			return profiles.find((profile) => profile.id === hostId);
		},
		retire: async (hostId, expectedRevision) => {
			calls.push(["retire", hostId, expectedRevision]);
			revision += 1;
			return hostId;
		},
	};
	const pinStore = {
		readPin: async (hostId, readEndpoint) => {
			calls.push(["readPin", hostId, readEndpoint.pinAlias]);
			if (overrides.pinFails === true) throw new Error("SSH_HOST_PIN_INVALID");
			return { filePath: "/tmp/pin", endpoint: readEndpoint };
		},
	};
	const registry = {
		scan: async () => ({ complete: overrides.scanComplete ?? true, referencedHostIds: new Set(overrides.referenced ?? ["h1"]) }),
		recordsOf: async (hostId) => ({
			complete: true,
			records: [
				{ source: "projects", recordId: "p1", hostId },
				{ source: "sessions", recordId: "s1", hostId },
				{ source: "host-profiles", recordId: "h1", hostId },
			],
		}),
	};
	const ports = createRemoteHostRebindPorts({ store, pinStore, registry, ...(overrides.projects === undefined ? {} : { projects: overrides.projects }) });
	return {
		ports,
		calls,
		get revision() {
			return revision;
		},
	};
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

test("readHostState：disabled 来自 tombstone，verified 来自已确认 endpoint", async () => {
	const h = harness();
	const state = await h.ports.host.readHostState();
	assert.equal(state.revision, 4);
	assert.deepEqual(plain(state.profiles.map((profile) => ({ hostId: profile.hostId, disabled: profile.disabled, verified: profile.verified }))), [
		{ hostId: "h1", disabled: false, verified: true },
		{ hostId: "h2", disabled: true, verified: false },
	]);
	assert.deepEqual(plain(state.retiredHostIds), []);
});

test("verifyTargetAnchor：缺失 / 未验证 / pin 读不出分别是三个稳定码", async () => {
	await rejectsWith(() => harness().ports.host.verifyTargetAnchor("nope"), /REMOTE_HOST_REBIND_TARGET_MISSING/);
	await rejectsWith(() => harness().ports.host.verifyTargetAnchor("h2"), /REMOTE_HOST_REBIND_TARGET_UNVERIFIED/);
	// pin 失败透传 store 码，由 convergence 折成 TARGET_ANCHOR_UNREADABLE（单一折叠点）。
	await rejectsWith(() => harness({ pinFails: true }).ports.host.verifyTargetAnchor("h1"), /SSH_HOST_PIN_INVALID/);
});

test("disableSource：已禁用是幂等 no-op；否则调 store 并回 re-read revision", async () => {
	const already = harness();
	assert.equal(await already.ports.host.disableSource("h2", 4), 4);
	assert.deepEqual(already.calls, [], "已禁用不调用 store.disable");

	const fresh = harness();
	assert.equal(await fresh.ports.host.disableSource("h1", 4), 5, "返回 re-read revision，不是 request 的");
	assert.deepEqual(fresh.calls, [["disable", "h1", 4]]);
});

test("retireSource：调 store.retire 后返回 re-read revision", async () => {
	const h = harness();
	assert.equal(await h.ports.host.retireSource("h1", 4), 5);
	assert.deepEqual(h.calls, [["retire", "h1", 4]]);
});

test("scanReferences：complete 与 id 集合原样透传", async () => {
	const h = harness({ referenced: ["h1", "h9"], scanComplete: false });
	const scan = await h.ports.host.scanReferences();
	assert.equal(scan.complete, false);
	assert.deepEqual([...scan.referencedHostIds], ["h1", "h9"]);
});

test("listHostRecords：只保留 projects/sessions，host-profiles 不是可迁移记录", async () => {
	const listed = await harness().ports.listHostRecords("h1");
	assert.equal(listed.complete, true);
	assert.deepEqual(plain(listed.records), [
		{ store: "projects", recordId: "p1" },
		{ store: "sessions", recordId: "s1" },
	]);
});
