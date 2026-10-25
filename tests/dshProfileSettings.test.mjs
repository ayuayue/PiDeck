import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import * as appBoot from "@deepseek-ai/dsh-app-boot";

const { composeEntries } = appBoot;

const api = loadTsCommonJs("src/main/dsh/dshProfileSettings.ts");
function fixture(t) {
	const home = mkdtempSync(join(tmpdir(), "dsh-profile-test-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return home;
}

test("legacy settings migrate once into profile without renaming or overwriting shared settings", (t) => {
	const home = fixture(t);
	const original = "agent-presets:\n  default: ptc\nllm-pi-ai:\n  providers:\n    custom:\n      baseURL: https://example.invalid/v1\n";
	writeFileSync(join(home, "settings.yaml"), original);
	api.initializeDshProfileSettings(home, [
		{ id: "agent-preset-registry", config: { default: "standard" } },
		{ id: "untouched", config: { version: 1 } },
	]);
	const snapshot = api.readDshSettingsSnapshot(home);
	assert.equal(snapshot["agent-preset-registry"].selectedDefault, "ptc");
	assert.equal(snapshot["agent-preset-registry"].default, "standard");
	assert.equal(snapshot.untouched, undefined);
	assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), original);
	api.writeDshProfileSettings(home, "agent-preset-registry", { selectedDefault: "minimal" });
	api.initializeDshProfileSettings(home, []);
	assert.equal(api.readDshSettingsSnapshot(home)["agent-preset-registry"].selectedDefault, "minimal");
});

test("offline provider import before first boot preserves the registry required deployment default", (t) => {
	const home = fixture(t);
	writeFileSync(join(home, "settings.yaml"), "agent-presets:\n  default: minimal\n");
	api.writeDshProfileSettings(home, "llm-pi-ai", { providers: {} });
	const patches = api.parseProfilePatches(readFileSync(api.dshProfilePatchPath(home), "utf8"));
	const rows = composeEntries([[{ insert: [{ id: "agent-preset-registry", name: "@deepseek-ai/dsh-agent-preset-registry", config: { default: "standard" } }] }], JSON.parse(JSON.stringify(patches))]);
	assert.equal(rows[0].config.default, "standard");
	assert.equal(rows[0].config.selectedDefault, "minimal");
});

test("profile writes preserve !!js expressions and unrelated rows without executing them", (t) => {
	const home = fixture(t);
	const path = api.dshProfilePatchPath(home);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, '- id: custom\n  config:\n    enabled: !!js process.platform === "win32"\n- id: llm-pi-ai\n  config:\n    providers: {}\n');
	api.writeDshProfileSettings(home, "llm-pi-ai", { providers: { custom: { baseURL: "https://example.invalid" } } });
	const rows = api.parseProfilePatches(readFileSync(path, "utf8"));
	assert.equal(rows[0].config.enabled.__jsExpr, 'process.platform === "win32"');
	assert.equal(rows[1].config.providers.custom.baseURL, "https://example.invalid");
});

test("invalid legacy or profile data fails without publishing or overwriting configuration", (t) => {
	const home = fixture(t);
	writeFileSync(join(home, "settings.yaml"), "not-a-mapping");
	assert.throws(() => api.initializeDshProfileSettings(home, []), /must be an object/);
	assert.equal(existsSync(api.dshProfilePatchPath(home)), false);
	mkdirSync(dirname(api.dshProfilePatchPath(home)), { recursive: true });
	writeFileSync(api.dshProfilePatchPath(home), "not-a-list");
	assert.throws(() => api.writeDshProfileSettings(home, "llm-pi-ai", {}), /must be a list/);
	assert.equal(readFileSync(api.dshProfilePatchPath(home), "utf8"), "not-a-list");
});

test("profile reload reads current shared HOME patches and keeps privacy overrides last", async (t) => {
	const home = fixture(t);
	const sharedPatch = join(home, appBoot.PROFILE_PATCH_FILENAME);
	const writeShared = (marker) =>
		writeFileSync(
			sharedPatch,
			api.dumpProfilePatches([
				{ id: "probe", config: { marker } },
				{ id: "session-telemetry-otel", disabled: false },
			]),
		);
	writeShared("first");
	const { prepareDshHostProfile } = loadTsCommonJs("src/main/dsh/dshHostProfile.ts");
	const deployment = [
		{
			insert: [
				{ id: "probe", name: "probe", config: {} },
				{ id: "session-telemetry-otel", name: "telemetry", disabled: false },
			],
		},
	];
	// 只验证上游组合重读，不安装插件、不启动 host、不访问真实 HOME。
	const prepared = await prepareDshHostProfile(home, createRequire(import.meta.url), { ...appBoot, createRuntimeResolution: async () => ({}) }, deployment);
	const read = () => composeEntries([appBoot.readProfilePatches("pideck-test", prepared.profileContext)]);
	assert.equal(read().find((row) => row.id === "probe").config.marker, "first");
	writeShared("second");
	const reloaded = read();
	assert.equal(reloaded.find((row) => row.id === "probe").config.marker, "second");
	assert.equal(reloaded.find((row) => row.id === "session-telemetry-otel").disabled, true);
	assert.equal(api.parseProfilePatches(readFileSync(sharedPatch, "utf8"))[0].config.marker, "second");
});

test("before first boot snapshots preserve legacy model/provider settings", (t) => {
	const home = fixture(t);
	writeFileSync(join(home, "settings.yaml"), "agent-default-model:\n  provider: custom\n  model: sample\n");
	assert.equal(api.readDshSettingsSnapshot(home)["agent-default-model"].model, "sample");
	api.writeDshProfileSettings(home, "llm-pi-ai", { providers: {} });
	assert.equal(api.readDshSettingsSnapshot(home)["agent-default-model"].model, "sample");
});
