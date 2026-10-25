import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { planResourceMigration, applyResourceMigration, buildLegacyStateCleanup } = loadTsCommonJs("src/main/config/piResourceMigration.ts");
const { PiResourceStateStore } = loadTsCommonJs("src/main/config/PiResourceStateStore.ts");

const emptyLegacy = () => ({
	global: { disabledExtensions: [], disabledSkills: [], disabledPrompts: [], disableExtensionWhitelist: false },
	project: { disabledExtensions: [], disabledSkills: [], disabledPrompts: [], inheritedExtensions: [], inheritedSkills: [], inheritedPrompts: [] },
});

const resources = [
	{ kind: "extensions", name: "pi-mcp-adapter", value: "/home/me/.pi/agent/extensions/pi-mcp-adapter.ts", scope: "user" },
	{ kind: "extensions", name: "npm:demo", value: "/home/me/.pi/agent/extensions/demo.ts", scope: "user", packageSource: "npm:demo" },
	{ kind: "skills", name: "tidy", value: "/home/me/.pi/agent/skills/tidy/SKILL.md", scope: "user" },
	{ kind: "skills", name: "shared", value: "/home/me/.pi/agent/skills/shared/SKILL.md", scope: "user" },
	{ kind: "prompts", name: "review", value: "/home/me/.pi/agent/prompts/review.md", scope: "user" },
	{ kind: "skills", name: "shared", value: "/repo/.pi/skills/shared/SKILL.md", scope: "project" },
];

test("global skill/prompt disables migrate to exact native rules", () => {
	const legacy = emptyLegacy();
	legacy.global.disabledSkills = ["tidy", "missing-skill"];
	legacy.global.disabledPrompts = ["review"];
	const plan = planResourceMigration({ legacy, resources });
	assert.deepEqual([...plan.actions.map((action) => `${action.scope.scope}|${action.kind}|${action.value}`)], ["global|skills|/home/me/.pi/agent/skills/tidy/SKILL.md", "global|prompts|/home/me/.pi/agent/prompts/review.md"]);
	assert.equal(plan.unresolved.length, 1);
	assert.equal(plan.unresolved[0].name, "missing-skill");
});

test("extension disable by path migrates; package installs disable the whole package", () => {
	const legacy = emptyLegacy();
	legacy.global.disabledExtensions = [
		{ scope: "user", source: "/home/me/.pi/agent/extensions/pi-mcp-adapter.ts" },
		{ scope: "user", source: "npm:demo" },
	];
	const plan = planResourceMigration({ legacy, resources });
	assert.deepEqual([...plan.actions.map((action) => `${action.kind}|${action.value}`)], ["extensions|/home/me/.pi/agent/extensions/pi-mcp-adapter.ts", "extensions|npm:demo"]);
	// 包内扩展不再单独生成规则（整包停用已覆盖）
	assert.equal(plan.actions.filter((action) => action.value === "/home/me/.pi/agent/extensions/demo.ts").length, 0);
});

test("whitelist-disabled extension list is archived, never turned into new disables", () => {
	const legacy = emptyLegacy();
	legacy.global.disableExtensionWhitelist = true;
	legacy.global.disabledExtensions = [{ scope: "user", source: "/home/me/.pi/agent/extensions/pi-mcp-adapter.ts" }];
	const plan = planResourceMigration({ legacy, resources });
	assert.equal(plan.actions.length, 0);
	assert.equal(plan.archived.length, 1);
	// 清理补丁保留禁用记录与总开关（等待用户明确处理）
	const cleanup = buildLegacyStateCleanup({ legacy, report: { ok: true, applied: 0, failed: [], unresolved: [], archived: plan.archived, revisions: {} } });
	assert.equal("disabledExtensions" in cleanup, false);
});

test("unknown-scope extension entries stay unresolved instead of spreading to all projects", () => {
	const legacy = emptyLegacy();
	legacy.global.disabledExtensions = [{ scope: "unknown", source: "npm:somewhere" }];
	const plan = planResourceMigration({ legacy, resources });
	assert.equal(plan.actions.length, 0);
	assert.equal(plan.unresolved[0].reason.includes("作用域"), true);
});

test("project disables migrate into the project scope, including inherited global resources", () => {
	const legacy = emptyLegacy();
	legacy.project.disabledSkills = ["shared"];
	legacy.project.inheritedPrompts = ["/home/me/.pi/agent/prompts/review.md"];
	const plan = planResourceMigration({ legacy, resources, projectId: "p1" });
	assert.deepEqual([...plan.actions.map((action) => `${action.scope.scope}:${action.scope.projectId}|${action.kind}|${action.value}`)], ["project:p1|skills|/repo/.pi/skills/shared/SKILL.md", "project:p1|prompts|/home/me/.pi/agent/prompts/review.md"]);
});

test("project actions without a projectId are unresolved, never written globally", () => {
	const legacy = emptyLegacy();
	legacy.project.disabledSkills = ["shared"];
	const plan = planResourceMigration({ legacy, resources });
	assert.equal(plan.actions.length, 0);
	assert.equal(plan.unresolved.length, 1);
});

test("cleanup only clears successfully migrated categories", () => {
	const legacy = emptyLegacy();
	legacy.global.disabledSkills = ["tidy"];
	legacy.global.disabledPrompts = ["review"];
	const report = {
		ok: false,
		applied: 1,
		failed: [{ action: { scope: { scope: "global" }, kind: "prompts", value: "/x/review.md", reason: "" }, error: "disk full" }],
		unresolved: [],
		archived: [],
		revisions: {},
	};
	const cleanup = buildLegacyStateCleanup({ legacy, report });
	assert.deepEqual([...cleanup.disabledSkills], []);
	assert.equal("disabledPrompts" in cleanup, false);
});

test("applyResourceMigration writes each action and records completion", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-mig-"));
	try {
		const written = [];
		const service = {
			setFileResourceEnabled: async (request) => {
				written.push(`${request.scope.scope}|${request.kind}|${request.resourceId}|${request.enabled}`);
				return { ok: true, revision: `rev-${written.length}` };
			},
		};
		const state = new PiResourceStateStore(join(dir, "state.json"));
		const legacy = emptyLegacy();
		legacy.global.disabledSkills = ["tidy"];
		const plan = planResourceMigration({ legacy, resources });
		const report = await applyResourceMigration({ plan, service, state, migrationKey: "global" });
		assert.equal(report.ok, true);
		assert.equal(report.applied, 1);
		assert.deepEqual([...written], ["global|skills|/home/me/.pi/agent/skills/tidy/SKILL.md|false"]);
		assert.ok(state.readMigration("global"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("回归：包安装的整包停用写成 packages 条目动作，不再写顶层 `-<包目录>` 规则", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-mig-pkg-"));
	try {
		const legacy = emptyLegacy();
		legacy.global.disabledExtensions = [{ scope: "user", source: "npm:demo" }];
		// 迁移真实拿到的资源：包安装的 value 是包目录（pi list 输出），不是包内文件
		const pkgDir = "/home/me/.pi/agent/npm/node_modules/demo";
		const plan = planResourceMigration({ legacy, resources: [{ kind: "extensions", name: "npm:demo", value: pkgDir, scope: "user", packageSource: "npm:demo" }] });
		assert.equal(plan.actions.length, 1);
		assert.equal(plan.actions[0].packageSource, "npm:demo");
		assert.notEqual(plan.actions[0].value, pkgDir, "包目录绝不能当顶层过滤值写入（对 pi 惰性、却让开关弹回）");
		const calls = [];
		const service = {
			setFileResourceEnabled: async (request) => {
				calls.push(`file|${request.resourceId}`);
				return { ok: true };
			},
			setPackageEnabled: async (request) => {
				calls.push(`package|${request.resourceId}|${request.enabled}`);
				return { ok: true, revision: "rev-pkg" };
			},
		};
		const state = new PiResourceStateStore(join(dir, "state.json"));
		const report = await applyResourceMigration({ plan, service, state, migrationKey: "global" });
		assert.equal(report.ok, true);
		assert.deepEqual(calls, ["package|npm:demo|false"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("applyResourceMigration reports failures and does not record completion", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-mig-fail-"));
	try {
		const service = { setFileResourceEnabled: async () => ({ ok: false, error: "locked" }) };
		const state = new PiResourceStateStore(join(dir, "state.json"));
		const legacy = emptyLegacy();
		legacy.global.disabledSkills = ["tidy"];
		const plan = planResourceMigration({ legacy, resources });
		const report = await applyResourceMigration({ plan, service, state, migrationKey: "global" });
		assert.equal(report.ok, false);
		assert.equal(report.failed.length, 1);
		assert.equal(state.readMigration("global"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
