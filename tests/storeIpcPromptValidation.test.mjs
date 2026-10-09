import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function register(promptManager, projectResourceManager = {}, options = {}) {
	const handlers = new Map();
	const electron = {
		ipcMain: {
			handle(channel, handler) {
				handlers.set(channel, handler);
			},
		},
	};
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const { registerStoreIpc } = loadTsCommonJs("src/main/ipc/storeIpc.ts", {
		stubs: { electron },
	});
	registerStoreIpc({
		promptManager,
		skillManager: {},
		xuePromptManager: {},
		projectResourceManager,
		configManager: options.configManager,
		projectTrustPath: options.projectTrustPath,
		extensionManager: options.extensionManager ?? {},
		appLogger: {
			info: async () => {},
			warn: async () => {},
		},
		mainCopy: (key) => key,
	});
	return { handlers, ipcChannels };
}

test("prompt IPC rejects malformed global and project payloads before manager calls", async () => {
	let managerCalls = 0;
	const failIfCalled = () => {
		managerCalls += 1;
		throw new Error("manager should not be called");
	};
	const { handlers, ipcChannels } = register(
		{
			create: failIfCalled,
			delete: failIfCalled,
			writeContent: failIfCalled,
			readContent: failIfCalled,
			rename: failIfCalled,
			toggle: failIfCalled,
			createInProject: failIfCalled,
		},
		{ getProjectRoot: failIfCalled },
	);

	await assert.rejects(handlers.get(ipcChannels.promptsCreate)({}, 42), /Invalid prompt input/);
	await assert.rejects(handlers.get(ipcChannels.promptsCreate)({}, { name: "valid", description: 42 }), /Invalid prompt description/);
	await assert.rejects(handlers.get(ipcChannels.promptsDelete)({}, 42), /Invalid prompt path/);
	await assert.rejects(handlers.get(ipcChannels.promptsEdit)({}, "C:/prompt.md", { invalid: true }), /Invalid prompt content/);
	await assert.rejects(handlers.get(ipcChannels.promptsRename)({}, "old", 42), /Invalid new prompt name/);
	await assert.rejects(handlers.get(ipcChannels.promptsToggle)({}, "C:/prompt.md", "yes"), /Invalid prompt toggle input/);
	await assert.rejects(handlers.get(ipcChannels.promptsCreateInProject)({}, "p".repeat(257), { name: "valid", description: "description" }), /Invalid project id/);
	assert.equal(managerCalls, 0);
});

test("project store imports require trust before writing project-local resources", async () => {
	let promptCalls = 0;
	const { handlers, ipcChannels } = register(
		{
			createInProject: async (_root, input) => {
				promptCalls += 1;
				return { name: input.name, description: input.description, path: "C:/project/.pi/prompts/demo.md", content: "", userCreated: true, scope: "project" };
			},
			writeContentInProject: async () => {
				promptCalls += 1;
			},
		},
		{ resolveProjectRoot: async () => "C:/project" },
		{ configManager: { getProjectTrustDecision: async () => false } },
	);

	await assert.rejects(
		handlers.get(ipcChannels.promptStoreImport)(
			{},
			{
				title: "Demo",
				description: "A demo prompt",
				content: "body",
				projectId: "p1",
			},
		),
		/mainProjectResource\.projectNotTrusted/,
	);
	assert.equal(promptCalls, 0);
});

test("trusted project store imports route prompts, skills, and extensions to the project target", async () => {
	const calls = [];
	const { handlers, ipcChannels } = register(
		{
			createInProject: async (root, input) => {
				calls.push(["prompt-create", root, input]);
				return { name: input.name, description: input.description, path: "C:/project/.pi/prompts/demo.md", content: "", userCreated: true, scope: "project" };
			},
			writeContentInProject: async (root, path, content) => calls.push(["prompt-write", root, path, content]),
		},
		{
			resolveProjectRoot: async () => "C:/project",
			importSkillFromStore: async (projectId, input) => {
				calls.push(["skill", projectId, input]);
				return { name: input.name, path: "C:/project/.pi/skills/demo/SKILL.md" };
			},
		},
		{
			configManager: { getProjectTrustDecision: async () => true },
			extensionManager: {
				install: async (source, options) => {
					calls.push(["extension", source, options]);
					return "installed";
				},
			},
		},
	);

	await handlers.get(ipcChannels.promptStoreImport)(
		{},
		{
			title: "Demo",
			description: "A demo prompt",
			content: "body",
			projectId: "p1",
		},
	);
	await handlers.get(ipcChannels.skillStoreImport)(
		{},
		{
			id: "skill-1",
			title: "Demo Skill",
			description: "A demo skill",
			content: "body",
			type: "skill",
			author: "",
			category: "",
			tags: [],
			votes: 0,
			createdAt: "",
		},
		"pi-global",
		"p1",
	);
	await handlers.get(ipcChannels.extensionsInstall)({}, "npm:demo", "p1");

	assert.equal(calls.filter(([kind]) => kind === "prompt-create").length, 1);
	assert.equal(calls.filter(([kind]) => kind === "prompt-write").length, 1);
	const skillCall = calls.find(([kind]) => kind === "skill");
	assert.ok(skillCall);
	assert.equal(skillCall[0], "skill");
	assert.equal(skillCall[1], "p1");
	assert.equal(skillCall[2].name, "demo-skill");
	assert.equal(skillCall[2].description, "A demo skill");
	assert.equal(skillCall[2].content, "# Demo Skill\n\nbody");
	const extensionCall = calls.find(([kind]) => kind === "extension");
	assert.ok(extensionCall);
	assert.equal(extensionCall[0], "extension");
	assert.equal(extensionCall[1], "npm:demo");
	assert.equal(extensionCall[2].projectRoot, "C:/project");
});

test("prompt IPC accepts an empty description string and leaves required-field policy to the manager", async () => {
	let captured;
	const { handlers, ipcChannels } = register({
		create: async (input) => {
			captured = input;
			return { name: input.name, description: input.description, path: "C:/prompt.md", content: "", userCreated: true };
		},
	});

	await handlers.get(ipcChannels.promptsCreate)({}, { name: "valid", description: "" });
	assert.equal(captured.name, "valid");
	assert.equal(captured.description, "");
});

test("store imports reject null payloads, non-string fields, and oversized content before any manager call", async () => {
	let managerCalls = 0;
	const failIfCalled = () => {
		managerCalls += 1;
		throw new Error("manager should not be called");
	};
	const { handlers, ipcChannels } = register(
		{
			create: failIfCalled,
			writeContent: failIfCalled,
			createInProject: failIfCalled,
			writeContentInProject: failIfCalled,
		},
		{ importSkillFromStore: failIfCalled },
	);

	// null / 非对象：解构前拒绝，而非 TypeError。
	await assert.rejects(handlers.get(ipcChannels.promptStoreImport)({}, null), /Invalid store item/);
	await assert.rejects(handlers.get(ipcChannels.promptStoreImport)({}, "str"), /Invalid store item/);
	await assert.rejects(handlers.get(ipcChannels.skillStoreImport)({}, null, "pi-global"), /Invalid store item/);
	// 字段类型：title/description/content 必须是字符串。
	await assert.rejects(handlers.get(ipcChannels.promptStoreImport)({}, { title: 42, description: "d", content: "body" }), /Invalid store item title/);
	await assert.rejects(handlers.get(ipcChannels.promptStoreImport)({}, { title: "t", description: 42, content: "body" }), /Invalid store item description/);
	await assert.rejects(handlers.get(ipcChannels.promptStoreImport)({}, { title: "t", description: "d", content: 42 }), /Invalid store item content/);
	// 资源边界：content 与 promptsEdit 同限 4MB，拒绝超长载荷。
	await assert.rejects(handlers.get(ipcChannels.promptStoreImport)({}, { title: "t", description: "d", content: "x".repeat(4 * 1024 * 1024 + 1) }), /Invalid store item content/);
	await assert.rejects(handlers.get(ipcChannels.skillStoreImport)({}, { title: "t", description: "d", content: "x".repeat(4 * 1024 * 1024 + 1) }, "pi-global"), /Invalid store item content/);
	assert.equal(managerCalls, 0);
});
