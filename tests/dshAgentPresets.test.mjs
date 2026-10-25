import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
const { agentPresetsRow, shippedPresetPatchPaths, dshWebAgentPlaneDisableRows, dshSubagentModelSelectionSettingsRow } = loadTsCommonJs("src/main/dsh/dshPresetComposition.ts");
const { parseProfilePatches } = loadTsCommonJs("src/main/dsh/dshProfileSettings.ts");
const manifestPath = require.resolve("@deepseek-ai/dsh-web-app/package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const presetPaths = shippedPresetPatchPaths(dirname(manifestPath), manifest.dsh.bundle.patch);
const officialHost = parseProfilePatches(readFileSync(require.resolve("@deepseek-ai/dsh-web-app/cordis.patch.yml"), "utf8"));

test("registry uses 0.2 plugin declaration and standard deployment default", () => {
	const row = agentPresetsRow();
	assert.equal(row.id, "agent-preset-registry");
	assert.equal(row.name, "@deepseek-ai/dsh-agent-preset-registry");
	assert.equal(row.config.default, "standard");
});

test("official bundle presets include standard/ptc/minimal/cordis without web server patches", () => {
	assert.equal(presetPaths.length, 4);
	const ids = presetPaths
		.flatMap((path) => {
			assert.ok(existsSync(path));
			const rows = parseProfilePatches(readFileSync(path, "utf8")).flatMap((row) => row.insert ?? []);
			assert.ok(rows.every((row) => row.name === "@deepseek-ai/dsh-agent-preset"));
			return rows.map((row) => row.config.id);
		})
		.sort();
	assert.deepEqual(ids, ["cordis", "minimal", "ptc", "standard"]);
	assert.throws(() => shippedPresetPatchPaths("/unused", ["./cordis.patch.yml"]), /no preset/);
});

test("host disables exactly the agent-plane entries disabled by the official web composition", () => {
	const official = officialHost
		.filter((row) => row.disabled === true)
		.map((row) => row.id)
		.sort();
	const ours = dshWebAgentPlaneDisableRows();
	assert.deepEqual(Array.from(ours, (row) => row.id).sort(), Array.from(official));
	assert.ok(ours.every((row) => row.disabled === true));
});

test("subagent model selection remains a host-scoped dependency of official presets", () => {
	const official = officialHost.flatMap((row) => row.insert ?? []).find((row) => row.id === "subagent-model-selection-settings");
	const ours = dshSubagentModelSelectionSettingsRow();
	assert.equal(ours.id, official.id);
	assert.equal(ours.name, official.name);
	assert.ok(presetPaths.some((path) => /modelSelectionSettings:\s*true/.test(readFileSync(path, "utf8"))));
});
