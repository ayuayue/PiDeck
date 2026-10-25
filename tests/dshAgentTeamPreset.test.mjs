import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import * as appBoot from "@deepseek-ai/dsh-app-boot";

const require = createRequire(import.meta.url);
const { agentTeamPresetPatchPath } = loadTsCommonJs("src/main/dsh/dshPresetComposition.ts");
const { parseProfilePatches } = loadTsCommonJs("src/main/dsh/dshProfileSettings.ts");
const { prepareDshHostProfile } = loadTsCommonJs("src/main/dsh/dshHostProfile.ts");
const { composeEntries } = appBoot;

/** 部署模拟：含一个再启用 tool-subagent 的行（复刻官方 preset 对 subagent 工具的再启用，
 *  agent-team 的禁用行必须压得住它——这是「排在组合最后」注释的行为依据）。 */
function deploymentWithSubagentEnabled() {
	return [
		{
			insert: [
				{ id: "tool-subagent", name: "@deepseek-ai/dsh-tool-subagent", config: {} },
				{ id: "tool-subagent-fork", name: "@deepseek-ai/dsh-tool-subagent-fork", config: {} },
			],
		},
	];
}

function fixture(t) {
	const home = mkdtempSync(join(tmpdir(), "dsh-agent-team-test-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return home;
}

test("agent-team preset patch path resolves into the installed profile package", () => {
	const path = agentTeamPresetPatchPath((specifier) => require.resolve(specifier));
	assert.ok(path && existsSync(path));
	assert.ok(path.includes(join("@deepseek-ai", "dsh-experimental-agent-team-profile")));
	const rows = parseProfilePatches(readFileSync(path, "utf8"));
	// 官方 patch：禁用 subagent 域四件套 + 插入 team 三件（agent-team 服务 / 工具 / UI）。
	assert.deepEqual(
		rows
			.filter((row) => row.disabled === true)
			.map((row) => row.id)
			.sort(),
		["tool-subagent", "tool-subagent-control", "tool-subagent-fork", "tool-subagent-list-agents"],
	);
	const inserted = rows.flatMap((row) => row.insert ?? []);
	assert.deepEqual(inserted.map((row) => row.id).sort(), ["agent-team", "tool-agent-team", "ui-agent-team"]);
});

test("missing profile package resolves to undefined (fail-safe skip, not a boot failure)", () => {
	assert.equal(
		agentTeamPresetPatchPath(() => {
			throw new Error("not found");
		}),
		undefined,
	);
});

test("prepareDshHostProfile without the toggle keeps the composition byte-identical to the status quo", async (t) => {
	const home = fixture(t);
	// 只验证组合层，不安装插件、不启动 host（与 dshProfileSettings.test.mjs 同一策略）。
	const stubbedBoot = { ...appBoot, createRuntimeResolution: async () => ({}) };
	const off = await prepareDshHostProfile(home, createRequire(import.meta.url), stubbedBoot, deploymentWithSubagentEnabled(), false);
	const offRows = composeEntries([appBoot.readProfilePatches("pideck-test", off.profileContext)]);
	assert.equal(
		offRows.some((row) => row.name === "@deepseek-ai/dsh-experimental-agent-team"),
		false,
		"开关关：不注入 agent-team 行",
	);
	assert.equal(offRows.find((row) => row.id === "tool-subagent").disabled, undefined, "开关关：subagent 保持现状（未被禁用）");
});

test("prepareDshHostProfile with the toggle appends the team layer last and re-disables subagent tools", async (t) => {
	const home = fixture(t);
	const stubbedBoot = { ...appBoot, createRuntimeResolution: async () => ({}) };
	const on = await prepareDshHostProfile(home, createRequire(import.meta.url), stubbedBoot, deploymentWithSubagentEnabled(), true);
	const onRows = composeEntries([appBoot.readProfilePatches("pideck-test", on.profileContext)]);
	const team = onRows.find((row) => row.id === "agent-team");
	assert.equal(team.name, "@deepseek-ai/dsh-experimental-agent-team");
	assert.equal(team.config.maxMembers, 8);
	// cordis 后行覆盖先行：官方 patch 排在 preset/legacy 之后，压住部署行对 subagent 的再启用。
	assert.equal(onRows.find((row) => row.id === "tool-subagent").disabled, true);
	assert.equal(onRows.find((row) => row.id === "tool-subagent-fork").disabled, true);
	assert.equal(onRows.find((row) => row.id === "tool-agent-team").name, "@deepseek-ai/dsh-experimental-tool-agent-team");
});

test("runtime without the profile package skips the team layer instead of failing boot", async (t) => {
	const home = fixture(t);
	const stubbedBoot = { ...appBoot, createRuntimeResolution: async () => ({}) };
	const realRequire = createRequire(import.meta.url);
	// 模拟旧 runtime tgz（未含新依赖）：web-app 等常规包可解析，agent-team 包解析失败。
	const runtimeWithoutPackage = Object.assign((specifier) => realRequire(specifier), {
		resolve: (specifier) => {
			if (specifier.startsWith("@deepseek-ai/dsh-experimental-agent-team-profile")) throw new Error(`Cannot find '${specifier}'`);
			return realRequire.resolve(specifier);
		},
	});
	const prepared = await prepareDshHostProfile(home, runtimeWithoutPackage, stubbedBoot, deploymentWithSubagentEnabled(), true);
	const rows = composeEntries([appBoot.readProfilePatches("pideck-test", prepared.profileContext)]);
	assert.equal(
		rows.some((row) => row.name === "@deepseek-ai/dsh-experimental-agent-team"),
		false,
		"包缺失：fail-safe 跳过注入",
	);
	assert.equal(rows.find((row) => row.id === "tool-subagent").disabled, undefined, "包缺失：不产生孤儿禁用行");
});
