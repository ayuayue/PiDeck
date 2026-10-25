import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadTelemetryModule() {
	const source = readFileSync("src/main/telemetry/TelemetryService.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {}, URL };
	vm.runInNewContext(outputText, sandbox, {
		filename: "TelemetryService.ts",
	});
	return sandbox.exports;
}

function createSettingsStore(initial = {}) {
	let settings = {
		telemetryEnabled: true,
		...initial,
	};
	return {
		get: () => ({ ...settings }),
		update: async (patch) => {
			settings = { ...settings, ...patch };
			return { ...settings };
		},
		read: () => ({ ...settings }),
	};
}

test("does not send heartbeat without a PostHog project key", async () => {
	const { TelemetryService } = loadTelemetryModule();
	const store = createSettingsStore();
	const calls = [];
	const service = new TelemetryService({
		settingsStore: store,
		capture: async (request) => calls.push(request),
		config: { projectKey: "", host: "https://us.i.posthog.com" },
		metadata: {
			appVersion: "0.4.16",
			platform: "win32",
			arch: "x64",
			packaged: true,
		},
		now: () => new Date("2026-06-11T01:00:00Z"),
		createInstallId: () => "install-1",
	});

	await service.sendHeartbeat();

	assert.equal(calls.length, 0);
	assert.equal(store.read().telemetryInstallId, undefined);
});

test("sends one anonymous heartbeat per local date", async () => {
	const { TelemetryService } = loadTelemetryModule();
	const store = createSettingsStore();
	const calls = [];
	const service = new TelemetryService({
		settingsStore: store,
		capture: async (request) => calls.push(request),
		config: {
			projectKey: "phc_test",
			host: "https://us.i.posthog.com",
		},
		metadata: {
			appVersion: "0.4.16",
			platform: "win32",
			arch: "x64",
			packaged: true,
		},
		now: () => new Date("2026-06-11T01:00:00Z"),
		createInstallId: () => "install-1",
	});

	await service.sendHeartbeat();
	await service.sendHeartbeat();

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://us.i.posthog.com/capture/");
	assert.equal(calls[0].body.api_key, "phc_test");
	assert.equal(calls[0].body.event, "app_heartbeat");
	assert.equal(calls[0].body.distinct_id, "install-1");
	assert.equal(
		JSON.stringify(calls[0].body.properties),
		JSON.stringify({
			app_version: "0.4.16",
			platform: "win32",
			arch: "x64",
			packaged: true,
			install_id: "install-1",
			$set: {
				app_version: "0.4.16",
				platform: "win32",
				arch: "x64",
				packaged: true,
			},
		}),
	);
	assert.equal(store.read().telemetryInstallId, "install-1");
	assert.equal(store.read().telemetryLastHeartbeatDate, "2026-06-11");
});

test("skips heartbeat when telemetry is disabled", async () => {
	const { TelemetryService } = loadTelemetryModule();
	const store = createSettingsStore({ telemetryEnabled: false });
	const calls = [];
	const service = new TelemetryService({
		settingsStore: store,
		capture: async (request) => calls.push(request),
		config: {
			projectKey: "phc_test",
			host: "https://us.i.posthog.com",
		},
		metadata: {
			appVersion: "0.4.16",
			platform: "win32",
			arch: "x64",
			packaged: true,
		},
		now: () => new Date("2026-06-11T01:00:00Z"),
		createInstallId: () => "install-1",
	});

	await service.sendHeartbeat();

	assert.equal(calls.length, 0);
});

test("skips heartbeat outside packaged builds", async () => {
	const { TelemetryService } = loadTelemetryModule();
	const store = createSettingsStore();
	const calls = [];
	const service = new TelemetryService({
		settingsStore: store,
		capture: async (request) => calls.push(request),
		config: {
			projectKey: "phc_test",
			host: "https://us.i.posthog.com",
		},
		metadata: {
			appVersion: "0.4.16",
			platform: "win32",
			arch: "x64",
			packaged: false,
		},
		now: () => new Date("2026-06-11T01:00:00Z"),
		createInstallId: () => "install-1",
	});

	await service.sendHeartbeat();

	assert.equal(calls.length, 0);
});

test("merges snapshot into properties and $set with fixed fields winning collisions", async () => {
	const { TelemetryService } = loadTelemetryModule();
	const store = createSettingsStore();
	const calls = [];
	let snapshotCalls = 0;
	const service = new TelemetryService({
		settingsStore: store,
		capture: async (request) => calls.push(request),
		config: {
			projectKey: "phc_test",
			host: "https://us.i.posthog.com",
		},
		metadata: {
			appVersion: "0.4.16",
			platform: "win32",
			arch: "x64",
			packaged: true,
		},
		snapshot: () => {
			snapshotCalls += 1;
			return {
				feature_pet: true,
				sessions_total: 12,
				hidden_modules: ["pet"],
				// 快照相机字段不得覆盖固定字段
				app_version: "9.9.9-fake",
			};
		},
		now: () => new Date("2026-06-11T01:00:00Z"),
		createInstallId: () => "install-1",
	});

	await service.sendHeartbeat();

	assert.equal(snapshotCalls, 1);
	assert.equal(calls.length, 1);
	const properties = calls[0].body.properties;
	assert.equal(properties.feature_pet, true);
	assert.equal(properties.sessions_total, 12);
	assert.deepEqual(properties.hidden_modules, ["pet"]);
	assert.equal(properties.app_version, "0.4.16");
	assert.equal(properties.$set.feature_pet, true);
	assert.equal(properties.$set.sessions_total, 12);
	assert.equal(properties.$set.app_version, "0.4.16");
});

test("does not invoke snapshot when heartbeat gates fail", async () => {
	const { TelemetryService } = loadTelemetryModule();
	const store = createSettingsStore({ telemetryEnabled: false });
	const calls = [];
	let snapshotCalls = 0;
	const service = new TelemetryService({
		settingsStore: store,
		capture: async (request) => calls.push(request),
		config: {
			projectKey: "phc_test",
			host: "https://us.i.posthog.com",
		},
		metadata: {
			appVersion: "0.4.16",
			platform: "win32",
			arch: "x64",
			packaged: true,
		},
		snapshot: () => {
			snapshotCalls += 1;
			return { feature_pet: true };
		},
		now: () => new Date("2026-06-11T01:00:00Z"),
		createInstallId: () => "install-1",
	});

	await service.sendHeartbeat();

	assert.equal(calls.length, 0);
	assert.equal(snapshotCalls, 0);
});
