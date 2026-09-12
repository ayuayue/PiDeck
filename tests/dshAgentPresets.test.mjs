import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);
const { agentPresetsRow, shippedPresetRoot, dshWebAgentPlaneDisableRows, hostCompositionPath, dshSubagentModelSelectionSettingsRow } = loadTsCommonJs("src/main/dsh/dshPresetComposition.ts");

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

test("dshSubagentModelSelectionSettingsRow: 与 dsh-web-app host 行同源，且确为当前预设所需", () => {
	const row = dshSubagentModelSelectionSettingsRow();
	assert.equal(row.id, "subagent-model-selection-settings");
	assert.equal(row.name, "@deepseek-ai/dsh-tool-subagent/model-selection-settings");
	// 与官方 web 部署的 host 插入行逐字一致（防两端漂移：漏挂或改名都会先红在这里）。
	const patchPath = nodeRequire.resolve("@deepseek-ai/dsh-web-app/cordis.patch.yml");
	const patch = readFileSync(patchPath, "utf8");
	const officialRow = patch.match(
		/\n\s+- id: (subagent-model-selection-settings)\n\s+name: '([^']+)'/,
	);
	assert.ok(officialRow, `dsh-web-app/cordis.patch.yml 缺少 subagent-model-selection-settings 行`);
	assert.equal(row.id, officialRow[1]);
	assert.equal(row.name, officialRow[2]);
	// 行不是死配置：随包预设里确有 tool-subagent 行要求 modelSelectionSettings
	// （缺失时 preset 整棵挂载失败：agent-preset/invalid "requires … in the Host scope"）。
	const root = shippedPresetRoot(agentPresetsPackageDir);
	const usingRow = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.some((entry) => {
			const composition = join(root, entry.name, "agent.cordis.yml");
			return existsSync(composition) && /modelSelectionSettings:\s*true/.test(readFileSync(composition, "utf8"));
		});
	assert.ok(usingRow, "没有任何随包预设使用 modelSelectionSettings，Host 行已成死配置，应移除");
});

// 回归背景：组合文件曾写在 userData 的 configDir，dsh-agent-presets 以 ctx.baseUrl
// （= 组合文件目录，由 dsh-app-boot 的 Include 重置）为基准向上找 node_modules，
// configDir 走不到 runtime → 随包预设的 24 个插件行全被判 "cannot be resolved"。

test("hostCompositionPath：落在 appRoot 子目录，且与 node_modules 同级可达", () => {
	const appRoot = "D:\data\runtimes\dsh\0.1.5-rc.1";
	const path = hostCompositionPath(appRoot);
	// 必须位于 appRoot 下（其父目录的 node_modules 才是包名行解析基准）。
	assert.ok(path.startsWith(appRoot), `组合文件应在 appRoot 内: ${path}`);
	// 向上走一级即 appRoot，正是 packageInstalled 命中 <appRoot>/node_modules 的位置。
	assert.equal(join(dirname(dirname(path))), appRoot);
	// 文件名保持 cordis.yml（loader include 的扩展名判定）。
	assert.ok(path.endsWith(".yml"));
});

test("hostCompositionPath：绝不落在 configDir（回归断言）", () => {
	const appRoot = "/home/u/.config/pi-desktop/runtimes/dsh/0.1.5-rc.1";
	const configDir = "/home/u/.config/pi-desktop/dsh-config";
	const path = hostCompositionPath(appRoot);
	assert.equal(path.startsWith(configDir), false);
});
