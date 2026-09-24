import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ProjectResourceManager } = loadTsCommonJs("src/main/projects/ProjectResourceManager.ts");
const projectFileAccess = loadTsCommonJs("src/main/files/projectFileAccess.ts");
const { mainProcessT } = loadTsCommonJs("src/shared/i18n/mainProcessCopy.ts");

const en = (key, params) => mainProcessT("en-US", key, params);

function managerFor(project, discoveryDependencies = {}) {
	return new ProjectResourceManager((projectId) => (project && project.id === projectId ? project : undefined), en, undefined, discoveryDependencies);
}

const chatProject = {
	id: "builtin-chat",
	name: "Chat",
	path: join(tmpdir(), "pideck-chat-test-" + Date.now()),
	kind: "chat",
	pinned: true,
	sortOrder: -1,
};

test("list on a chat project returns empty resources instead of throwing", async () => {
	// 内置聊天项目没有 .pi/.agents 资源目录：list 是纯只读浏览，返回空列表。
	// 之前抛 chatUnsupported 会让前端技能面板（含全局技能）整体加载失败。
	const manager = managerFor(chatProject);
	const result = await manager.list("builtin-chat");
	assert.equal(result.skills.length, 0);
	assert.equal(result.extensions.length, 0);
	assert.deepEqual(JSON.parse(JSON.stringify(result.overrides)), {
		disabledGlobalExtensions: [],
		disabledGlobalSkills: [],
		disabledGlobalPrompts: [],
	});
});

test("discovery supports draft loading without a project and chat sessions", async () => {
	const manager = managerFor(chatProject);
	for (const result of [await manager.discovery(), await manager.discovery("builtin-chat")]) {
		assert.ok(Array.isArray(result.skills));
		assert.ok(Array.isArray(result.prompts));
		assert.ok(Array.isArray(result.extensions));
	}
});

test("discovery omits project resources after trust is denied and applies project disabled lists", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-discovery-trust-"));
	try {
		const skillName = `draft-skill-${Date.now()}`;
		const project = { id: "p1", name: "P1", path: root, lastOpenedAt: 1 };
		const piDir = join(root, ".pi");
		mkdirSync(join(piDir, "custom-skill"), { recursive: true });
		writeFileSync(join(piDir, "custom-skill", "SKILL.md"), `---\nname: ${skillName}\ndescription: local skill\n---\n\n# ${skillName}\n`);
		writeFileSync(join(piDir, "settings.json"), JSON.stringify({ skills: ["custom-skill"], disabledSkills: [skillName] }));

		const unresolved = await managerFor(project).discovery("p1");
		assert.equal(unresolved.projectResourcesAllowed, false);
		assert.equal(
			unresolved.skills.some((skill) => skill.name === skillName),
			false,
		);

		const denied = await managerFor(project, { getProjectTrustDecision: async () => false }).discovery("p1");
		assert.equal(denied.projectResourcesAllowed, false);
		assert.equal(
			denied.skills.some((skill) => skill.name === skillName),
			false,
		);

		const allowed = await managerFor(project, { getProjectTrustDecision: async () => true }).discovery("p1");
		assert.equal(allowed.projectResourcesAllowed, true);
		assert.equal(allowed.skills.find((skill) => skill.name === skillName)?.enabled, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("list on an unknown project still throws notFound", async () => {
	const manager = managerFor(chatProject);
	await assert.rejects(manager.list("missing"), /no longer exists/i);
});

test("write operations on a chat project keep throwing chatUnsupported", async () => {
	// 只读浏览放行，写入仍须拒绝：chat 项目不存在可创建/删除/改写的资源目录。
	const manager = managerFor(chatProject);
	const chatUnsupported = /do not support project-level resources/i;
	await assert.rejects(manager.ensureResourceDirectory("builtin-chat", "prompts"), chatUnsupported);
	await assert.rejects(manager.createSkill({ projectId: "builtin-chat", name: "hello", description: "desc", locationId: "project-pi" }), chatUnsupported);
	await assert.rejects(manager.deleteSkill("builtin-chat", "C:/x/SKILL.md"), chatUnsupported);
	await assert.rejects(manager.renameSkill("builtin-chat", "C:/x/SKILL.md", "hello"), chatUnsupported);
	await assert.rejects(manager.toggleSkill("builtin-chat", "C:/x/SKILL.md", false), chatUnsupported);
	await assert.rejects(manager.deleteExtension("builtin-chat", "C:/x/ext.ts"), chatUnsupported);
	await assert.rejects(manager.toggleExtension("builtin-chat", "C:/x/ext.ts", false), chatUnsupported);
});

test("store skill import writes a project-local .pi/skills resource", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-store-skill-"));
	try {
		const project = { id: "p1", name: "P1", path: root, lastOpenedAt: 1 };
		const manager = managerFor(project);
		const summary = await manager.importSkillFromStore("p1", {
			name: "PDF / Tools",
			description: "Useful PDF tools",
			content: "# PDF / Tools\n\nUse the tool.",
		});
		const skillPath = join(root, ".pi", "skills", "pdf-tools", "SKILL.md");
		assert.equal(summary.sourceId, "project-pi");
		assert.equal(summary.path.endsWith(join(".pi", "skills", "pdf-tools", "SKILL.md")), true);
		assert.match(readFileSync(skillPath, "utf8"), /name: pdf-tools/);
		assert.match(readFileSync(skillPath, "utf8"), /source: prompts\.chat/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("list on a regular project scans .pi/skills SKILL.md files", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-"));
	try {
		const skillDir = join(root, ".pi", "skills");
		mkdirSync(join(skillDir, "mykit"), { recursive: true });
		writeFileSync(join(skillDir, "mykit", "SKILL.md"), "---\nname: mykit\ndescription: Test kit\n---\n\n# mykit\n");
		const project = { id: "p1", name: "P1", path: root, lastOpenedAt: 1 };
		const manager = managerFor(project);
		const result = await manager.list("p1");
		assert.equal(result.skills.length, 1);
		assert.equal(result.skills[0].name, "mykit");
		assert.equal(result.skills[0].sourceId, "project-pi");
		assert.equal(result.extensions.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("createSkill writes to the selected project resource location", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-location-"));
	try {
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });
		const created = await manager.createSkill({
			projectId: "p1",
			name: "agents-skill",
			description: "created in the agents directory",
			locationId: "project-agents",
		});
		assert.equal(created.sourceId, "project-agents");
		assert.equal(created.path.toLowerCase().endsWith(join(".agents", "skills", "agents-skill", "SKILL.md").toLowerCase()), true);
		const listed = await manager.list("p1");
		assert.equal(
			listed.skills.some((skill) => skill.path === created.path),
			true,
		);
		assert.equal(listed.skillLocations.length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("toggleSkill 写入项目 .pi/settings.json 的 disabledSkills 并反映到列表", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-toggle-"));
	try {
		const skillDir = join(root, ".pi", "skills");
		mkdirSync(join(skillDir, "mykit"), { recursive: true });
		writeFileSync(join(skillDir, "mykit", "SKILL.md"), "---\nname: MyKit\ndescription: Test kit\n---\n\n# MyKit\n");
		const project = { id: "p1", name: "P1", path: root, lastOpenedAt: 1 };
		const manager = managerFor(project);
		const skillPath = join(skillDir, "mykit", "SKILL.md");

		// 禁用：项目 settings 写入（名称保留原始大小写，比较不敏感）
		const disabled = await manager.toggleSkill("p1", skillPath, false);
		assert.equal(disabled.enabled, false);
		const settings = JSON.parse(readFileSync(join(root, ".pi", "settings.json"), "utf8"));
		assert.deepEqual(settings.disabledSkills, ["MyKit"]);

		// 列表显示禁用
		const listed = await manager.list("p1");
		assert.equal(listed.skills[0].enabled, false);

		// 启用：从 settings 移除
		const enabled = await manager.toggleSkill("p1", skillPath, true);
		assert.equal(enabled.enabled, true);
		const after = JSON.parse(readFileSync(join(root, ".pi", "settings.json"), "utf8"));
		assert.deepEqual(after.disabledSkills, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目继承覆盖保留无关 settings，且启用时只移除对应稳定键", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-overrides-"));
	try {
		mkdirSync(join(root, ".pi"), { recursive: true });
		const settingsPath = join(root, ".pi", "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", disabledSkills: ["local"] }));
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });

		await manager.toggleInheritedResource({ projectId: "p1", kind: "extension", key: "shared.ts", enabled: false });
		await manager.toggleInheritedResource({ projectId: "p1", kind: "skill", key: "pi-global:shared", enabled: false });
		await manager.toggleInheritedResource({ projectId: "p1", kind: "prompt", key: "SHARED", enabled: false });
		let settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(settings.theme, "dark");
		assert.deepEqual(settings.disabledSkills, ["local"]);
		assert.deepEqual(settings.pideckDisabledGlobalExtensions, ["shared.ts"]);
		assert.deepEqual(settings.pideckDisabledGlobalSkills, ["pi-global:shared"]);
		assert.deepEqual(settings.pideckDisabledGlobalPrompts, ["shared"]);

		const overrides = await manager.toggleInheritedResource({ projectId: "p1", kind: "extension", key: "shared.ts", enabled: true });
		assert.deepEqual([...overrides.disabledGlobalExtensions], []);
		settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(settings.pideckDisabledGlobalSkills, ["pi-global:shared"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("损坏的项目 settings 会拒绝覆盖写入且不先修改 skill", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-invalid-"));
	try {
		const skillDir = join(root, ".pi", "skills", "mykit");
		mkdirSync(skillDir, { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		const originalSkill = "---\nname: MyKit\ndescription: Test kit\n---\n\n# MyKit\n";
		writeFileSync(skillPath, originalSkill);
		const settingsPath = join(root, ".pi", "settings.json");
		writeFileSync(settingsPath, "{broken");
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });

		await assert.rejects(manager.toggleInheritedResource({ projectId: "p1", kind: "prompt", key: "shared", enabled: false }), /JSON is invalid/i);
		await assert.rejects(manager.toggleSkill("p1", skillPath, false), /JSON is invalid/i);
		assert.equal(readFileSync(settingsPath, "utf8"), "{broken");
		assert.equal(readFileSync(skillPath, "utf8"), originalSkill);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目扩展开关用含后缀 source，并在 settings 损坏时拒绝写入", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-extension-"));
	try {
		const extensionDir = join(root, ".pi", "extensions");
		mkdirSync(extensionDir, { recursive: true });
		const extensionPath = join(extensionDir, "shared.ts");
		writeFileSync(extensionPath, "export default () => {};\n");
		const settingsPath = join(root, ".pi", "settings.json");
		writeFileSync(settingsPath, "{broken");
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });

		await assert.rejects(manager.toggleExtension("p1", extensionPath, false), /JSON is invalid/i);
		assert.equal(readFileSync(settingsPath, "utf8"), "{broken");
		writeFileSync(settingsPath, "{}");
		await manager.toggleExtension("p1", extensionPath, false);
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(settings.disabledExtensions, ["shared.ts"]);
		const listed = await manager.list("p1");
		assert.equal(listed.extensions[0].source, "shared.ts");
		assert.equal(listed.extensions[0].enabled, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目扩展列表对齐 pi 的 js、index.js 与 package manifest 发现规则", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-extension-discovery-"));
	try {
		const extensionDir = join(root, ".pi", "extensions");
		mkdirSync(join(extensionDir, "index-package"), { recursive: true });
		mkdirSync(join(extensionDir, "manifest-package", "dist"), { recursive: true });
		mkdirSync(join(extensionDir, "ignored-directory"), { recursive: true });
		writeFileSync(join(extensionDir, "plain.js"), "module.exports = {};\n");
		writeFileSync(join(extensionDir, "index-package", "index.js"), "module.exports = {};\n");
		writeFileSync(join(extensionDir, "manifest-package", "package.json"), JSON.stringify({ pi: { extensions: ["dist/first.js", "dist/second.ts"] } }));
		writeFileSync(join(extensionDir, "manifest-package", "dist", "first.js"), "module.exports = {};\n");
		writeFileSync(join(extensionDir, "manifest-package", "dist", "second.ts"), "export default {};\n");
		writeFileSync(join(extensionDir, "ignored-directory", "README.md"), "not an extension\n");

		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });
		const result = await manager.listProjectExtensions("p1");
		const bySource = new Map(result.map((extension) => [extension.source, extension]));

		assert.ok(bySource.get("plain.js")?.path?.endsWith(join(".pi", "extensions", "plain.js")));
		assert.ok(bySource.get("index-package")?.path?.endsWith(join(".pi", "extensions", "index-package")));
		assert.ok(bySource.get("manifest-package")?.path?.endsWith(join(".pi", "extensions", "manifest-package")));
		assert.equal(result.filter((extension) => extension.source === "manifest-package").length, 1);
		assert.equal(bySource.has("ignored-directory"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("嵌套 SKILL.md symlink 不能让项目列表读取外部文件", async (t) => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-prm-skill-link-"));
	const root = join(fixture, "project");
	const skillDir = join(root, ".pi", "skills", "linked");
	const outsideSkill = join(fixture, "outside-SKILL.md");
	try {
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(outsideSkill, "---\nname: outside\ndescription: secret\n---\n");
		try {
			symlinkSync(outsideSkill, join(skillDir, "SKILL.md"), "file");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EPERM") {
				t.skip("The current filesystem does not permit file symlink creation");
				return;
			}
			throw error;
		}
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });
		const listed = await manager.list("p1");
		assert.equal(listed.skills.length, 0);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("项目资源目录 junction 指向项目外时列表与写操作都拒绝越界", async (t) => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-prm-junction-"));
	const root = join(fixture, "project");
	const outsideSkills = join(fixture, "outside-skills");
	try {
		mkdirSync(join(root, ".pi"), { recursive: true });
		mkdirSync(join(outsideSkills, "secret"), { recursive: true });
		writeFileSync(join(outsideSkills, "secret", "SKILL.md"), "---\nname: secret\ndescription: outside\n---\n");
		try {
			symlinkSync(outsideSkills, join(root, ".pi", "skills"), process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EPERM") {
				t.skip("The current filesystem does not permit junction creation");
				return;
			}
			throw error;
		}
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });
		const listed = await manager.list("p1");
		assert.equal(listed.skills.length, 0);
		await assert.rejects(manager.createSkill({ projectId: "p1", name: "new", description: "new skill", locationId: "project-pi" }), /outside the project/i);
		assert.equal(readFileSync(join(outsideSkills, "secret", "SKILL.md"), "utf8").includes("outside"), true);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("外部技能完整目录可写入两个项目级目标", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-prm-import-skill-"));
	const root = join(fixture, "project");
	const source = join(fixture, "external-skill");
	try {
		mkdirSync(root, { recursive: true });
		mkdirSync(join(source, "templates"), { recursive: true });
		writeFileSync(join(source, "SKILL.md"), "---\nname: external\ndescription: External skill\n---\n\n# External\n");
		writeFileSync(join(source, "templates", "prompt.md"), "template attachment\n");
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });

		await manager.importSkillDirectory("p1", "project-pi", source, "external-pi");
		await manager.importSkillDirectory("p1", "project-agents", source, "external-agents");

		assert.equal(readFileSync(join(root, ".pi", "skills", "external-pi", "SKILL.md"), "utf8"), readFileSync(join(source, "SKILL.md"), "utf8"));
		assert.equal(readFileSync(join(root, ".agents", "skills", "external-agents", "templates", "prompt.md"), "utf8"), "template attachment\n");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("项目 MCP 导入层只读写 .pi/mcp.json，不会覆盖 Claude .mcp.json", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-mcp-layer-"));
	try {
		const claudeConfig = join(root, ".mcp.json");
		const originalClaudeConfig = JSON.stringify({ mcpServers: { claude: { command: "claude-server" } } });
		writeFileSync(claudeConfig, originalClaudeConfig, "utf8");
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });

		assert.deepEqual(JSON.parse(JSON.stringify(await manager.readProjectMcpConfig("p1"))), {});
		await manager.saveProjectMcpConfig("p1", { mcpServers: { imported: { command: "node", args: ["server.mjs"] } } });

		assert.equal(readFileSync(claudeConfig, "utf8"), originalClaudeConfig);
		const saved = JSON.parse(readFileSync(join(root, ".pi", "mcp.json"), "utf8"));
		assert.equal(saved.mcpServers.imported.command, "node");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目 MCP 写入在临时文件完成后重新校验最终目标边界", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-mcp-reresolve-"));
	try {
		let writePathResolutions = 0;
		const { ProjectResourceManager: BoundaryCheckingManager } = loadTsCommonJs("src/main/projects/ProjectResourceManager.ts", {
			stubs: {
				"../files/projectFileAccess": {
					...projectFileAccess,
					resolveProjectFileWritePath: async (...args) => {
						writePathResolutions += 1;
						const resolved = await projectFileAccess.resolveProjectFileWritePath(...args);
						// Model a junction/symlink swap after the staging path was accepted.
						// The third resolution must be the final target immediately before rename.
						return writePathResolutions === 3 ? join(root, "outside", "mcp.json") : resolved;
					},
				},
			},
		});
		const project = { id: "p1", name: "P1", path: root, lastOpenedAt: 1 };
		const manager = new BoundaryCheckingManager((projectId) => (projectId === project.id ? project : undefined), en);

		await assert.rejects(manager.saveProjectMcpConfig("p1", { mcpServers: { imported: { command: "node" } } }), /outside the project/i);
		assert.equal(writePathResolutions, 3);
		assert.equal(existsSync(join(root, ".pi", "mcp.json")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("缺失项目 MCP 文件仍会拒绝指向项目外的 .pi junction", async (t) => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-prm-mcp-junction-"));
	const root = join(fixture, "project");
	const outside = join(fixture, "outside");
	try {
		mkdirSync(root, { recursive: true });
		mkdirSync(outside, { recursive: true });
		try {
			symlinkSync(outside, join(root, ".pi"), process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EPERM") {
				t.skip("The current filesystem does not permit junction creation");
				return;
			}
			throw error;
		}
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });

		await assert.rejects(manager.readProjectMcpConfig("p1"), /outside the project/i);
		assert.equal(existsSync(join(outside, "mcp.json")), false);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

// ── 重命名回归：markdown 技能绝不能把 .pi/skills 根目录搬走（数据丢失事故） ──

test("项目级 markdown 技能重命名只改文件名，不搬走 .pi/skills 根目录", async () => {
	const rawRoot = mkdtempSync(join(tmpdir(), "pideck-prm-md-rename-"));
	const root = realpathSync.native ? realpathSync.native(rawRoot) : realpathSync(rawRoot);
	try {
		const skillDir = join(root, ".pi", "skills");
		mkdirSync(join(skillDir, "bar"), { recursive: true });
		writeFileSync(join(skillDir, "foo.md"), "---\nname: foo\ndescription: md skill\n---\n\nbody\n", "utf8");
		writeFileSync(join(skillDir, "bar", "SKILL.md"), "---\nname: bar\ndescription: dir skill\n---\n\nbody\n", "utf8");
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });

		const renamed = await manager.renameSkill("p1", join(skillDir, "foo.md"), "foo-renamed");

		// 根目录原地不动，其他技能不受影响
		assert.equal(existsSync(join(skillDir, "bar", "SKILL.md")), true);
		assert.equal(existsSync(join(skillDir, "foo.md")), false);
		assert.equal(existsSync(join(skillDir, "foo-renamed.md")), true);
		// 旧实现会把整个 .pi/skills 改名搬走，此处必须不存在
		assert.equal(existsSync(join(root, ".pi", "foo-renamed")), false);
		assert.equal(renamed.name, "foo-renamed");
		assert.equal(renamed.path, join(skillDir, "foo-renamed.md"));
		// 回归：旧实现按不存在的 SKILL.md 回读，正文/描述为空
		assert.match(readFileSync(renamed.path, "utf8"), /name: foo-renamed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目级禁用技能重命名后同步 .pi/settings.json 的 disabledSkills", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-rename-disabled-"));
	try {
		const skillDir = join(root, ".pi", "skills");
		mkdirSync(join(skillDir, "mykit"), { recursive: true });
		writeFileSync(join(skillDir, "mykit", "SKILL.md"), "---\nname: MyKit\ndescription: kit\n---\n\n# MyKit\n", "utf8");
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });
		const skillPath = join(skillDir, "mykit", "SKILL.md");

		await manager.toggleSkill("p1", skillPath, false);
		assert.deepEqual(JSON.parse(readFileSync(join(root, ".pi", "settings.json"), "utf8")).disabledSkills, ["MyKit"]);

		const renamed = await manager.renameSkill("p1", skillPath, "renamed-kit");
		// 旧名条目被新名替换，不残留孤儿数据；禁用状态保持
		assert.deepEqual(JSON.parse(readFileSync(join(root, ".pi", "settings.json"), "utf8")).disabledSkills, ["renamed-kit"]);
		assert.equal(renamed.enabled, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目级 markdown 技能无 name 时回退为文件名且重命名时自动补全 name", async () => {
	const rawRoot = mkdtempSync(join(tmpdir(), "pideck-prm-bare-md-"));
	const root = realpathSync.native ? realpathSync.native(rawRoot) : realpathSync(rawRoot);
	try {
		const skillDir = join(root, ".pi", "skills");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "tool.md"), "---\ndescription: bare tool\n---\n\nbody\n", "utf8");
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });

		const list = await manager.list("p1");
		const tool = list.skills.find((s) => s.path === join(skillDir, "tool.md"));
		assert.ok(tool);
		// 回退名取文件名而非「skills」
		assert.equal(tool.name, "tool");

		const renamed = await manager.renameSkill("p1", tool.path, "tool-v2");
		assert.equal(renamed.name, "tool-v2");
		assert.match(readFileSync(renamed.path, "utf8"), /name: tool-v2/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
