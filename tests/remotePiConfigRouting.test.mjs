import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

import { systemIpcSource } from "./helpers/systemIpcSources.mjs";
import { preloadSource } from "./helpers/preloadSources.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";
/**
 * PiConfigRouter + IPC wiring (Batch A): local stays local, ssh goes only to the remote backend, provider
 * test/fetch/usage refuse an ssh target before any I/O, and the existing channels/preload contract do not move.
 */

const routerModule = loadTsCommonJs("src/main/config/PiConfigRouter.ts");
const shared = loadTsCommonJs("src/shared/piConfig.ts");
const HOST = "11111111-1111-4111-8111-111111111111";
const VERSION = "c".repeat(64);

function harness(remote = true) {
	const localCalls = [];
	const remoteCalls = [];
	const local = {
		getModelsConfig: async () => {
			localCalls.push("read-models");
			return { raw: "{}", parsed: { providers: {} } };
		},
		getSettingsConfig: async () => {
			localCalls.push("read-settings");
			return { raw: "{}", parsed: {} };
		},
		saveModelsConfig: async (data) => {
			localCalls.push("save-models");
			return { valid: true, modelCount: Object.keys(data.providers ?? {}).length };
		},
		saveSettingsConfig: async () => {
			localCalls.push("save-settings");
			return { valid: true };
		},
	};
	const backend = {
		read: async (input) => {
			remoteCalls.push(["read", input]);
			return { kind: "remote", hostId: input.hostId, file: input.file, version: VERSION, sha256: VERSION, data: { providers: {}, ...(input.file === "settings" ? {} : {}) }, secrets: [] };
		},
		patch: async (input) => {
			remoteCalls.push(["patch", input]);
			return { kind: "remote", hostId: input.hostId, file: input.file, version: VERSION, sha256: VERSION };
		},
	};
	const router = routerModule.createPiConfigRouter({ local, remote: remote ? backend : undefined });
	return { router, localCalls, remoteCalls };
}

async function rejectionCode(run) {
	try {
		await run();
	} catch (error) {
		return typeof error?.message === "string" ? error.message : String(error);
	}
	throw new Error("EXPECTED_REJECTION");
}

test("absent/local target keeps the exact ConfigManager path and never touches the remote backend", async () => {
	const h = harness();
	const models = await h.router.readModels();
	assert.equal(models.kind, "local");
	assert.deepEqual(models.value.parsed, { providers: {} });
	const settings = await h.router.readSettings({ target: { kind: "local" } });
	assert.equal(settings.kind, "local");
	assert.deepEqual(h.localCalls, ["read-models", "read-settings"]);
	assert.deepEqual(h.remoteCalls, []);

	const saved = await h.router.saveModels({ providers: { a: { models: [] } } });
	assert.equal(saved.kind, "local");
	assert.deepEqual(saved.value, { valid: true, modelCount: 1 });
	assert.deepEqual(h.remoteCalls, []);
});

test("ssh target goes only to the injected backend, bound to the target host", async () => {
	const h = harness();
	const models = await h.router.readModels({ target: { kind: "ssh", hostId: HOST } });
	assert.equal(models.kind, "remote");
	assert.deepEqual(JSON.parse(JSON.stringify(h.remoteCalls[0])), ["read", { hostId: HOST, file: "models" }]);
	await h.router.readSettings({ target: { kind: "ssh", hostId: HOST } });
	assert.deepEqual(JSON.parse(JSON.stringify(h.remoteCalls[1])), ["read", { hostId: HOST, file: "settings" }]);
	const receipt = await h.router.saveSettings({ theme: "dark" }, { target: { kind: "ssh", hostId: HOST }, expectedVersion: VERSION, patch: { theme: "dark" } });
	assert.equal(receipt.kind, "remote");
	assert.deepEqual(JSON.parse(JSON.stringify(h.remoteCalls[2])), ["patch", { hostId: HOST, file: "settings", expectedVersion: VERSION, patch: { theme: "dark" } }]);
	assert.deepEqual(h.localCalls, [], "a remote target must never read/write local config");
});

test("invalid/unsupported targets fail closed before any port is called", async () => {
	const h = harness();
	for (const options of [{ target: { kind: "ssh", hostId: "not-a-host" } }, { target: { kind: "bogus" } }, { target: { kind: "local", hostId: HOST } }, { unexpected: true }, "local"]) {
		assert.equal(await rejectionCode(() => h.router.readModels(options)), shared.REMOTE_CONFIG_CODES.targetInvalid, JSON.stringify(options));
	}
	// ssh write requires the version guard and a merge patch; local write refuses remote-only fields.
	assert.equal(await rejectionCode(() => h.router.saveModels({ providers: {} }, { target: { kind: "ssh", hostId: HOST } })), shared.REMOTE_CONFIG_CODES.versionConflict);
	assert.equal(await rejectionCode(() => h.router.saveModels({ providers: {} }, { target: { kind: "ssh", hostId: HOST }, expectedVersion: VERSION })), shared.REMOTE_CONFIG_CODES.fileInvalid);
	assert.equal(await rejectionCode(() => h.router.saveModels({ providers: {} }, { target: { kind: "local" }, expectedVersion: VERSION })), shared.REMOTE_CONFIG_CODES.targetInvalid);
	assert.deepEqual(h.localCalls, []);
	assert.deepEqual(h.remoteCalls, []);

	const unavailable = harness(false);
	assert.equal(await rejectionCode(() => unavailable.router.readModels({ target: { kind: "ssh", hostId: HOST } })), shared.REMOTE_CONFIG_CODES.unavailable);
	assert.deepEqual(unavailable.localCalls, []);
});

test("provider test / model fetch / usage stay local-only and refuse an ssh target without any request", () => {
	// Undefined and local are allowed; only ssh is refused, and it is refused before a network/key decision.
	assert.doesNotThrow(() => routerModule.rejectRemotePiConfigTarget(undefined));
	assert.doesNotThrow(() => routerModule.rejectRemotePiConfigTarget({ kind: "local" }));
	assert.equal(
		(() => {
			try {
				routerModule.rejectRemotePiConfigTarget({ kind: "ssh", hostId: HOST });
				return "ALLOWED";
			} catch (error) {
				return error.message;
			}
		})(),
		shared.REMOTE_CONFIG_CODES.providerOperationUnsupported,
	);
	assert.equal(
		(() => {
			try {
				routerModule.rejectRemotePiConfigTarget({ kind: "ssh", hostId: "bad" });
				return "ALLOWED";
			} catch (error) {
				return error.message;
			}
		})(),
		shared.REMOTE_CONFIG_CODES.targetInvalid,
	);
});

test("the existing config IPC/preload contract now routes an optional target without adding channels", () => {
	const systemIpc = systemIpcSource;
	const mainIndex = mainIpcSource;
	const preload = preloadSource;
	const channels = readFileSync("src/shared/ipc.ts", "utf8");
	// Channel names/values are untouched; the target is an extra OPTION on the same four handlers.
	assert.match(channels, /configGetModels: "config:get-models"/);
	assert.match(channels, /configGetSettings: "config:get-settings"/);
	assert.match(channels, /configSaveModels: "config:save-models"/);
	assert.match(channels, /configSaveSettings: "config:save-settings"/);
	assert.match(systemIpc, /ipcMain\.handle\(ipcChannels\.configGetModels, async \(_event, options\?: unknown\)/);
	assert.match(systemIpc, /ipcMain\.handle\(ipcChannels\.configGetSettings, async \(_event, options\?: unknown\)/);
	assert.match(systemIpc, /ipcMain\.handle\(ipcChannels\.configSaveModels, async \(_event, data, options\?: unknown\)/);
	assert.match(systemIpc, /ipcMain\.handle\(ipcChannels\.configSaveSettings, async \(_event, settings, options\?: unknown\)/);
	assert.match(systemIpc, /piConfigRouter\.readModels\(options\)/);
	assert.match(systemIpc, /piConfigRouter\.saveModels\(data, options\)/);
	assert.match(systemIpc, /createPiConfigRouter\(\{/);
	// The deferred provider operations are guarded in the same handlers.
	assert.match(systemIpc, /configTestProvider[\s\S]{0,400}?rejectRemotePiConfigTarget/);
	assert.match(systemIpc, /configFetchModels[\s\S]{0,600}?rejectRemotePiConfigTarget/);
	assert.match(systemIpc, /configFetchUsage[\s\S]{0,600}?rejectRemotePiConfigTarget/);
	// Assembly: the backend is built only behind the remote experiment switch and passed as a dependency.
	assert.match(mainIndex, /createRemotePiConfigBackend\(\{/);
	assert.match(mainIndex, /remotePiConfig,/);
	assert.match(mainIndex, /remoteFeatureEnabled[\s\S]{0,200}?createRemotePiConfigBackend/);
	// Batch B (after the A1/A2/A4 security fix) extends the four existing methods with optional options; no new channel.
	assert.match(preload, /getModels: \(options\?: [\s\S]{0,160}?\) =>\s*ipcRenderer\.invoke\(ipcChannels\.configGetModels, options\)/);
	assert.match(preload, /getSettings: \(options\?: [\s\S]{0,160}?\) =>\s*ipcRenderer\.invoke\(ipcChannels\.configGetSettings, options\)/);
	assert.match(preload, /saveModels: \(data: unknown, options\?: [\s\S]{0,160}?\) =>\s*ipcRenderer\.invoke\(ipcChannels\.configSaveModels, data, options\)/);
	assert.match(preload, /saveSettings: \(settings: Record<string, unknown>, options\?: [\s\S]{0,160}?\) =>\s*ipcRenderer\.invoke\(ipcChannels\.configSaveSettings, settings, options\)/);
	// Remote answers stay local-compatible DTOs with sanitized remote metadata; save returns the receipt.
	assert.match(systemIpc, /raw: JSON\.stringify\(routed\.data, null, 2\), parsed: routed\.data, remote: routed/);
	assert.match(systemIpc, /return \{ valid: true, remote: routed \};/);
});
