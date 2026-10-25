import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildDraftResourceCommands, draftResourceCommandsForProject, selectComposerSuggestionCommands, standbyPreviewCommandsForProject } = loadTsCommonJs("src/renderer/src/utils/draftResourceCommands.ts");

test("draft resource commands include enabled user-only skills and discovered prompts", () => {
	const commands = buildDraftResourceCommands(
		[
			{ name: "review", description: "Review changes", enabled: true, userOnly: true },
			{ name: "disabled", description: "Disabled skill", enabled: false },
		],
		[
			{ name: "translate", description: "Translate text" },
			{ name: "hidden", description: "Disabled prompt", enabled: false },
		],
		{ projectResourcesAllowed: true },
	);

	assert.equal(
		JSON.stringify(commands),
		JSON.stringify([
			{ name: "skill:review", description: "Review changes", source: "skill" },
			{ name: "translate", description: "Translate text", source: "prompt" },
		]),
	);
});

test("draft command names deduplicate exact collisions while preserving Pi case distinctions", () => {
	const commands = buildDraftResourceCommands(
		[{ name: "review", description: "Skill command", enabled: true }],
		[
			{ name: "skill:review", description: "Exact collision" },
			{ name: "SKILL:REVIEW", description: "Case-sensitive command" },
		],
		{ projectResourcesAllowed: true },
	);

	assert.deepEqual(
		Array.from(commands, (command) => [command.name, command.source]),
		[
			["skill:review", "skill"],
			["SKILL:REVIEW", "prompt"],
		],
	);
});

test("draft command collisions follow Pi source precedence for skills and prompts", () => {
	const commands = buildDraftResourceCommands(
		[
			{ name: "same", description: "Package", enabled: true, sourceId: "package-project" },
			{ name: "same", description: "Global automatic", enabled: true, sourceId: "pi-global" },
			{ name: "same", description: "User settings", enabled: true, sourceId: "settings-user" },
			{ name: "same", description: "Project automatic", enabled: true, sourceId: "project-pi" },
			{ name: "same", description: "Project settings", enabled: true, sourceId: "settings-project" },
			{ name: "project-wins", description: "Global automatic", enabled: true, sourceId: "pi-global" },
			{ name: "project-wins", description: "Project automatic", enabled: true, sourceId: "project-agents" },
			{ name: "user-wins", description: "Global automatic", enabled: true, sourceId: "agents-global" },
			{ name: "user-wins", description: "User settings", enabled: true, sourceId: "settings-user" },
			{ name: "global-wins", description: "Package", enabled: true, sourceId: "package-user" },
			{ name: "global-wins", description: "Global automatic", enabled: true, sourceId: "pi-global" },
		],
		[
			{ name: "prompt-same", description: "Package", sourceId: "package-project" },
			{ name: "prompt-same", description: "Global automatic", scope: "global" },
			{ name: "prompt-same", description: "User settings", sourceId: "settings-user" },
			{ name: "prompt-same", description: "Project automatic", scope: "project" },
			{ name: "prompt-same", description: "Project settings", sourceId: "settings-project" },
			{ name: "project-prompt-wins", description: "Global automatic", scope: "global" },
			{ name: "project-prompt-wins", description: "Project automatic", scope: "project" },
			{ name: "user-prompt-wins", description: "Global automatic", scope: "global" },
			{ name: "user-prompt-wins", description: "User settings", sourceId: "settings-user" },
			{ name: "global-prompt-wins", description: "Package", sourceId: "package-user" },
			{ name: "global-prompt-wins", description: "Global automatic", scope: "global" },
		],
		{ projectResourcesAllowed: true },
	);
	const descriptions = new Map(commands.map((command) => [command.name, command.description]));

	assert.equal(descriptions.get("skill:same"), "Project settings");
	assert.equal(descriptions.get("skill:project-wins"), "Project automatic");
	assert.equal(descriptions.get("skill:user-wins"), "User settings");
	assert.equal(descriptions.get("skill:global-wins"), "Global automatic");
	assert.equal(descriptions.get("prompt-same"), "Project settings");
	assert.equal(descriptions.get("project-prompt-wins"), "Project automatic");
	assert.equal(descriptions.get("user-prompt-wins"), "User settings");
	assert.equal(descriptions.get("global-prompt-wins"), "Global automatic");
});

test("draft resource commands respect project trust and inherited global overrides", () => {
	const denied = buildDraftResourceCommands(
		[
			{ name: "project-skill", description: "Project skill", enabled: true, sourceId: "project-pi" },
			{ name: "global-skill", description: "Global skill", enabled: true, sourceId: "pi-global" },
		],
		[
			{ name: "project-prompt", description: "Project prompt", scope: "project", enabled: true },
			{ name: "global-prompt", description: "Global prompt", scope: "global", enabled: true },
		],
		{ projectResourcesAllowed: false },
	);
	assert.deepEqual(
		Array.from(denied, (command) => command.name),
		["skill:global-skill", "global-prompt"],
	);

	const inherited = buildDraftResourceCommands(
		[
			{ name: "same", description: "Project copy", enabled: true, sourceId: "project-pi" },
			{ name: "same", description: "Global copy", enabled: true, sourceId: "pi-global" },
			{ name: "packaged", description: "Global package", enabled: true, sourceId: "package-user" },
		],
		[
			{ name: "same-prompt", description: "Global prompt", scope: "global", enabled: true },
			{ name: "same-prompt", description: "Project prompt", scope: "project", enabled: true },
		],
		{
			projectResourcesAllowed: true,
			disabledGlobalSkillKeys: ["pi-global:same", "pi-global:packaged"],
			disabledGlobalPromptNames: ["same-prompt"],
		},
	);
	assert.deepEqual(
		Array.from(inherited, (command) => command.name),
		["skill:same", "skill:packaged", "same-prompt"],
	);
	assert.equal(inherited[0].description, "Project copy");
	assert.equal(inherited[1].description, "Global package");
	assert.equal(inherited[2].description, "Project prompt");
});

test("inherited skill overrides apply only to their exact discovery root", () => {
	const commands = buildDraftResourceCommands(
		[
			{ name: "pi-skill", description: "Pi root", enabled: true, sourceId: "pi-global" },
			{ name: "agents-skill", description: "Agents root", enabled: true, sourceId: "agents-global" },
			{ name: "package-skill", description: "User package", enabled: true, sourceId: "package-user" },
			{ name: "settings-skill", description: "Settings path", enabled: true, sourceId: "settings-user" },
		],
		[],
		{
			projectResourcesAllowed: true,
			disabledGlobalSkillKeys: ["pi-global:pi-skill", "agents-global:agents-skill", "pi-global:package-skill", "pi-global:settings-skill"],
		},
	);
	assert.deepEqual(
		Array.from(commands, (command) => command.name),
		["skill:package-skill", "skill:settings-skill"],
	);
});

test("draft commands hide the previous project while next discovery is pending", async () => {
	let snapshot = {
		projectId: "project-a",
		commands: [{ name: "skill:from-a", description: "Previous project", source: "skill" }],
	};
	let finishDiscovery = (_commands) => {};
	const nextDiscovery = new Promise((resolve) => {
		finishDiscovery = resolve;
	}).then((commands) => {
		snapshot = { projectId: "project-b", commands };
	});

	assert.equal(draftResourceCommandsForProject(snapshot, "project-b").length, 0);

	finishDiscovery([{ name: "skill:from-b", description: "New project", source: "skill" }]);
	await nextDiscovery;
	assert.equal(draftResourceCommandsForProject(snapshot, "project-b")[0]?.name, "skill:from-b");
});

test("live Pi command discovery replaces draft suggestions once the runtime starts", () => {
	const live = [{ name: "skill:live", description: "Pi runtime command", source: "skill" }];
	const draft = [{ name: "skill:draft", description: "Pre-agent command", source: "skill" }];

	assert.strictEqual(selectComposerSuggestionCommands(false, true, live, draft), live);
	assert.strictEqual(selectComposerSuggestionCommands(false, false, live, draft), draft);
	assert.strictEqual(selectComposerSuggestionCommands(true, false, live, draft), live);
});

// ── standby 进程命令预览（Issue #316）──────────────────────────

test("standby preview commands are dropped when the project switches", () => {
	const snapshot = { projectId: "project-a", commands: [{ name: "grill-me", description: "A", source: "skill" }] };

	assert.equal(standbyPreviewCommandsForProject(snapshot, "project-b").length, 0);
	assert.strictEqual(standbyPreviewCommandsForProject(snapshot, "project-a")[0]?.name, "grill-me");
	assert.equal(standbyPreviewCommandsForProject(snapshot, undefined).length, 0);
});

test("standby preview wins over local discovery for drafts but never over a live runtime", () => {
	const live = [{ name: "skill:live", description: "Pi runtime command", source: "skill" }];
	const draft = [{ name: "skill:draft", description: "Local discovery", source: "skill" }];
	const preview = [{ name: "grill-me", description: "Extension command via standby", source: "skill" }];

	// 草稿 + 有预览：预览优先（含扩展命令，本地发现覆盖不到）
	assert.strictEqual(selectComposerSuggestionCommands(false, false, live, draft, preview), preview);
	// 预览为空（池关/无进程/查询失败）：回退本地发现
	assert.strictEqual(selectComposerSuggestionCommands(false, false, live, draft, []), draft);
	assert.strictEqual(selectComposerSuggestionCommands(false, false, live, draft, undefined), draft);
	// runtime 已起/DSH：本会话 RPC 表永远唯一权威，预览不掺和
	assert.strictEqual(selectComposerSuggestionCommands(false, true, live, draft, preview), live);
	assert.strictEqual(selectComposerSuggestionCommands(true, false, live, draft, preview), live);
});
