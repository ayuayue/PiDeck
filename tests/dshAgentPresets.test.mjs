import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);
const { agentPresetsRow, shippedPresetRoot, dshWebAgentPlaneDisableRows } = loadTsCommonJs("src/main/dsh/dshPresetComposition.ts");

/** 真实安装的 dsh-agent-presets 包目录（0.1.5 起随包预设随该包分发）。 */
const agentPresetsPackageDir = dirname(nodeRequire.resolve("@deepseek-ai/dsh-agent-presets/package.json"));

test("agentPresetsRow: 默认 standard，roots 交给插件 includeShippedRoot（对齐 dsh-web 0.1.5 形态）", () => {
	const row = agentPresetsRow();
	assert.equal(row.id, "agent-presets");
	assert.equal(row.name, "@deepseek-ai/dsh-agent-presets");
	assert.equal(row.config.default, "standard");
	assert.equal(row.config.roots, undefined);
});

test("shippedPresetRoot: 指向 <dsh-agent-presets 包>/presets", () => {
	assert.equal(shippedPresetRoot(agentPresetsPackageDir), join(agentPresetsPackageDir, "presets"));
});

test("随包预设根真实存在且含官方模式", () => {
	const root = shippedPresetRoot(agentPresetsPackageDir);
	assert.ok(existsSync(root), `随包预设根缺失: ${root}`);
	const dirs = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	assert.ok(dirs.includes("standard"), `缺少 standard 预设: ${dirs.join(",")}`);
	assert.ok(dirs.includes("minimal"), `缺少 minimal 预设: ${dirs.join(",")}`);
	// 每个模式目录必须带组合文件与显示元数据（缺一就不是可用的预设槽位）
	for (const id of dirs) {
		const composition = join(root, id, "agent.cordis.yml");
		const metadata = join(root, id, "preset.yml");
		assert.ok(statSync(composition).isFile(), `${id} 缺 agent.cordis.yml`);
		assert.ok(statSync(metadata).isFile(), `${id} 缺 preset.yml`);
	}
});

test("dshWebAgentPlaneDisableRows: 对齐 dsh-web-app 的 agent-plan 禁用清单", () => {
	const rows = dshWebAgentPlaneDisableRows();
	// dsh-web-app/cordis.patch.yml 的「agent plane moves behind agent presets」段共 23 行。
	assert.equal(rows.length, 23);
	const ids = new Set(rows.map((row) => row.id));
	for (const id of [
		"tool-bash",
		"tool-pwsh",
		"tool-fs",
		"tool-fs-search",
		"tool-goal",
		"tool-todo",
		"tool-web",
		"tool-subagent",
		"tool-subagent-fork",
		"tool-workflow",
		"tool-ralph",
		"agent-instructions",
	]) {
		assert.ok(ids.has(id), `缺少基础层禁用行: ${id}`);
	}
	assert.ok(rows.every((row) => row.disabled === true));
});
