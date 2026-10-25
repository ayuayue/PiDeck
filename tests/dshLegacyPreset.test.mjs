import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { normalizeLegacyPresetRows } = loadTsCommonJs("src/main/dsh/dshLegacyPreset.ts");
const adapter = "file:///app/pideckLegacyPreset.js";

test("legacy preset translates retired workflow rows recursively without changing identity or input", () => {
	const input = [{ id: "delegation", name: "cordis:group", group: true, isolate: { workflowEngine: true }, config: [{ id: "custom-workflow", name: "@deepseek-ai/dsh-workflow-worker-thread", config: { provider: "spawn" } }] }];
	const before = JSON.stringify(input);
	const rows = normalizeLegacyPresetRows(input, adapter);
	assert.equal(rows[0].config[0].name, "@deepseek-ai/dsh-workflow-ptc");
	assert.equal(rows[0].config[0].id, "custom-workflow");
	assert.equal(rows[0].config[0].config.provider, "spawn");
	assert.equal(rows[0].isolate.workflowEngine, true);
	assert.equal(JSON.stringify(input), before);
});

test("legacy nested includes remain read-only and keep expressions until activation", () => {
	const rows = normalizeLegacyPresetRows(
		[
			{ id: "nested", name: "cordis:include", config: { path: "./nested.yml" } },
			{ id: "conditional", name: "./plugin.mjs", disabled: { __jsExpr: "process.platform === 'win32'" }, config: { path: "./resource.txt" } },
		],
		adapter,
	);
	assert.equal(rows[0].name, adapter);
	assert.equal(rows[0].config.path, "./nested.yml");
	assert.equal(rows[1].disabled.__jsExpr, "process.platform === 'win32'");
	assert.equal(rows[1].config.path, "./resource.txt");
});

test("invalid legacy rows report an error instead of silently dropping the composition", () => {
	assert.throws(() => normalizeLegacyPresetRows({}, adapter), /list/);
	assert.throws(() => normalizeLegacyPresetRows([{ id: "missing-module" }], adapter), /name/);
});
