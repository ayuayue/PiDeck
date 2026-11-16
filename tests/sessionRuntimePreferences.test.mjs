import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * SessionRuntimePreferences.applyPreferences 的两条降级契约：
 * - #545：本地 pi 会按模型 thinkingLevelMap 收敛档位，激活后必须把实际档位写回 catalog；
 * - #548：DSH 权限预设重放失败不能阻断用户消息投递（降级 + 提示），其它后端照旧抛错。
 */
const { SessionRuntimePreferences } = loadTsCommonJs("src/main/sessions/runtime/sessionRuntimePreferences.ts");

const PI_ENTRY = { id: "session-1", backend: "pi", model: { provider: "custom", modelId: "model-b", modelName: "Model B" }, thinkingLevel: "xhigh" };
const DSH_ENTRY = { id: "dsh-1", backend: "dsh", model: { provider: "deepseek", modelId: "v4", modelName: "V4" }, thinkingLevel: "high", permissionPreset: "danger-full-access" };

function createHarness({ entry = PI_ENTRY, runtimeLevel = "high", isRemote = false, permissionError } = {}) {
	const updates = [];
	const warnings = [];
	const notified = [];
	const calls = { setModel: 0, setThinking: 0, reads: 0, setPermission: 0 };
	const catalog = {
		get: () => entry,
		update: async (_id, patch) => {
			updates.push(patch);
			return { ...entry, ...patch };
		},
	};
	const agents = {
		setModel: async () => {
			calls.setModel += 1;
		},
		setThinking: async () => {
			calls.setThinking += 1;
		},
		getRuntimeModelThinkingState: async () => {
			calls.reads += 1;
			return { provider: entry.model.provider, modelId: entry.model.modelId, modelName: entry.model.modelName, thinkingLevel: runtimeLevel };
		},
		setPermission: async () => {
			calls.setPermission += 1;
			if (permissionError) throw permissionError;
		},
		notifyPermissionPreferenceIgnored: (agentId, preset) => notified.push({ agentId, preset }),
	};
	const logger = { info: () => undefined, warn: (scope, message) => warnings.push({ scope, message }), error: () => undefined };
	const preferences = new SessionRuntimePreferences(catalog, agents, logger, () => isRemote, new Map(), new Map());
	return { preferences, updates, warnings, notified, calls };
}

test("pi activation writes the runtime-clamped thinking level back to the catalog (#545)", async () => {
	const h = createHarness();
	await h.preferences.applyLatestPreferences(PI_ENTRY.id, "agent-1");
	assert.equal(h.calls.setThinking, 1, "pi still receives the persisted preference");
	assert.equal(h.updates.length, 1);
	assert.equal(h.updates[0].thinkingLevel, "high");
	assert.equal(typeof h.updates[0].updatedAt, "number");
});

test("no catalog write when the runtime kept the requested level", async () => {
	const h = createHarness({ runtimeLevel: "xhigh" });
	await h.preferences.applyLatestPreferences(PI_ENTRY.id, "agent-1");
	assert.deepEqual(h.updates, []);
});

test("remote sessions keep the no-extra-round-trip contract", async () => {
	const h = createHarness({ isRemote: true });
	await h.preferences.applyLatestPreferences(PI_ENTRY.id, "agent-1");
	assert.equal(h.calls.reads, 0, "remote activation must not add a readback RPC");
	assert.deepEqual(h.updates, []);
});

test("DSH permission replay failure degrades instead of blocking the send (#548)", async () => {
	const h = createHarness({ entry: DSH_ENTRY, permissionError: new Error("dsh /permission was accepted but preset did not become active: danger-full-access") });
	await h.preferences.applyLatestPreferences(DSH_ENTRY.id, "agent-1");
	assert.equal(h.calls.setPermission, 1);
	assert.deepEqual(h.notified, [{ agentId: "agent-1", preset: "danger-full-access" }], "用户必须看到「权限没生效」而不是静默的不一致");
	assert.ok(
		h.warnings.some((entry) => entry.message === "DSH permission preference ignored"),
		"降级要留痕，便于诊断",
	);
});

test("a successful DSH permission replay stays silent", async () => {
	const h = createHarness({ entry: DSH_ENTRY });
	await h.preferences.applyLatestPreferences(DSH_ENTRY.id, "agent-1");
	assert.equal(h.calls.setPermission, 1);
	assert.deepEqual(h.notified, []);
});

test("non-DSH backends still fail closed when their permission setter rejects", async () => {
	// 只有 DSH 的 /permission 是「尽力应用」；其它后端若实现了这个能力面，失败必须照旧抛出。
	const h = createHarness({ entry: { ...PI_ENTRY, permissionPreset: "unrestricted" }, permissionError: new Error("boom") });
	await assert.rejects(() => h.preferences.applyLatestPreferences(PI_ENTRY.id, "agent-1"), /boom/);
	assert.deepEqual(h.notified, []);
});
