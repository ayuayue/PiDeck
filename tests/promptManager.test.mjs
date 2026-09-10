import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Load PromptManager with Electron and platform integrations replaced by deterministic stubs. */
function loadPromptManagerModule() {
	return loadTsCommonJs("src/main/prompts/PromptManager.ts", {
		stubs: {
			electron: { shell: { openPath: async () => "" } },
			"../fs/trash": { trashPath: async () => {} },
			"../wsl/WslPaths": {
				parseWslUncPath: () => null,
				toWindowsHostPath: (path) => path,
			},
		},
	});
}

async function withTemporaryHome(run) {
	const home = await mkdtemp(join(tmpdir(), "pideck-prompt-manager-"));
	try {
		await run(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test("toggle 同步持久化 PiDeck settings 禁用列表（模板白名单模式依据）", async () => {
	await withTemporaryHome(async (home) => {
		const { PromptManager } = loadPromptManagerModule();
		const manager = new PromptManager(home);
		const target = join(home, ".pi", "agent", "prompts", "review.md");
		await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
		await writeFile(target, "---\ndescription: review prompt\n---\n\nReview the code.\n", "utf8");

		// 内存 settings 替身：模拟 SettingsStore 的 get/update 语义
		const settings = { disabledPrompts: [] };
		manager.configureSettings(
			() => settings,
			(patch) => {
				Object.assign(settings, patch);
				return Promise.resolve(settings);
			},
		);

		// 禁用：settings 列表写入
		const disabled = await manager.toggle(target, false);
		assert.equal(disabled.enabled, false);
		assert.deepEqual(settings.disabledPrompts, ["review"]);
		const afterDisable = await manager.list();
		assert.equal(afterDisable.templates.find((template) => template.name === "review").enabled, false);

		// 启用：从 settings 列表移除（名称大小写不敏感去重）
		const enabled = await manager.toggle(target, true);
		assert.equal(enabled.enabled, true);
		assert.deepEqual(settings.disabledPrompts, []);
		const afterEnable = await manager.list();
		assert.equal(afterEnable.templates.find((template) => template.name === "review").enabled, true);
	});
});

test("内置推荐模板（builtin://）已移除：list 只返回真实落盘模板", async () => {
	await withTemporaryHome(async (home) => {
		const { PromptManager } = loadPromptManagerModule();
		const manager = new PromptManager(home);
		const { templates } = await manager.list();
		// 内置推荐模板不再注入列表：不应出现 builtin:// 虚拟条目
		assert.equal(templates.some((t) => t.path.startsWith("builtin://")), false);
	});
});

test("全局 prompt 文件 symlink 不能越过 prompts 目录边界", async (t) => {
	await withTemporaryHome(async (home) => {
		const { PromptManager } = loadPromptManagerModule();
		const manager = new PromptManager(home);
		const promptsDir = join(home, ".pi", "agent", "prompts");
		const outside = join(home, "outside.md");
		const linked = join(promptsDir, "linked.md");
		await mkdir(promptsDir, { recursive: true });
		await writeFile(outside, "---\ndescription: secret\n---\n", "utf8");
		try {
			symlinkSync(outside, linked, "file");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EPERM") {
				t.skip("The current filesystem does not permit file symlink creation");
				return;
			}
			throw error;
		}
		// Windows 上 symlinkSync 可能"报告成功"却不落盘（lstat 直接 ENOENT，常见于
		// Temp 目录的 reparse point 受限或被安全软件拦截）。此时 linked 是一个普通的不存在
		// 路径，边界用例失去意义：readContent 报 ENOENT（而非越界），writeContent 按"新建文件"
		// 正常落盘。必须显式跳过，否则会得到与边界检查无关的假失败。
		if (!existsSync(linked)) {
			t.skip("symlinkSync did not materialize the link on this filesystem");
			return;
		}
		const listed = await manager.list();
		assert.equal(listed.templates.some((template) => template.name === "linked"), false);
		await assert.rejects(manager.readContent(linked));
		await assert.rejects(manager.writeContent(linked, "changed"));
		assert.equal(readFileSync(outside, "utf8").includes("secret"), true);
	});
});

test("项目 prompt toggle 只写项目 settings，且同名全局禁用不串扰", async () => {
	await withTemporaryHome(async (home) => {
		const { PromptManager } = loadPromptManagerModule();
		const manager = new PromptManager(home);
		const project = join(home, "project");
		const projectPromptDir = join(project, ".pi", "prompts");
		const projectPrompt = join(projectPromptDir, "shared.md");
		await mkdir(projectPromptDir, { recursive: true });
		await writeFile(projectPrompt, "---\ndescription: project shared\n---\n\nProject.\n", "utf8");
		await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
		const globalSettings = { disabledPrompts: ["shared"] };
		manager.configureSettings(
			() => globalSettings,
			(patch) => {
				Object.assign(globalSettings, patch);
				return Promise.resolve(globalSettings);
			},
		);

		const before = await manager.listByProject(project);
		assert.equal(before.templates[0].enabled, true);
		const disabled = await manager.toggleInProject(project, "shared", false);
		assert.equal(disabled.enabled, false);
		assert.deepEqual(globalSettings.disabledPrompts, ["shared"]);
		const projectSettings = JSON.parse(readFileSync(join(project, ".pi", "settings.json"), "utf8"));
		assert.equal(projectSettings.theme, "dark");
		assert.deepEqual(projectSettings.disabledPrompts, ["shared"]);
		const after = await manager.listByProject(project);
		assert.equal(after.templates[0].enabled, false);
	});
});

test("项目 prompt toggle 遇到损坏 settings 时不覆盖原文件", async () => {
	await withTemporaryHome(async (home) => {
		const { PromptManager } = loadPromptManagerModule();
		const manager = new PromptManager(home);
		const project = join(home, "project");
		const projectPromptDir = join(project, ".pi", "prompts");
		const projectPrompt = join(projectPromptDir, "shared.md");
		await mkdir(projectPromptDir, { recursive: true });
		await writeFile(projectPrompt, "---\ndescription: shared\n---\n", "utf8");
		const settingsPath = join(project, ".pi", "settings.json");
		await writeFile(settingsPath, "{broken", "utf8");

		await assert.rejects(manager.toggleInProject(project, "shared", false));
		assert.equal(readFileSync(settingsPath, "utf8"), "{broken");
	});
});

test("项目 prompt toggle 拒绝项目 prompts 目录外的路径", async () => {
	await withTemporaryHome(async (home) => {
		const { PromptManager } = loadPromptManagerModule();
		const manager = new PromptManager(home);
		const project = join(home, "project");
		const outside = join(project, "outside.md");
		await mkdir(project, { recursive: true });
		await writeFile(outside, "---\ndescription: outside\n---\n", "utf8");
		await assert.rejects(manager.toggleInProject(project, outside, false));
	});
});

test("项目 prompt 目录 junction 指向项目外时不读取或写入", async (t) => {
	await withTemporaryHome(async (home) => {
		const { PromptManager } = loadPromptManagerModule();
		const manager = new PromptManager(home);
		const project = join(home, "project");
		const outsideDir = join(home, "outside-prompts");
		await mkdir(join(project, ".pi"), { recursive: true });
		await mkdir(outsideDir, { recursive: true });
		await writeFile(join(outsideDir, "secret.md"), "---\ndescription: secret\n---\n", "utf8");
		try {
			symlinkSync(
				outsideDir,
				join(project, ".pi", "prompts"),
				process.platform === "win32" ? "junction" : "dir",
			);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EPERM") {
				t.skip("The current filesystem does not permit junction creation");
				return;
			}
			throw error;
		}
		const listed = await manager.listByProject(project);
		assert.equal(listed.templates.length, 0);
		await assert.rejects(
			manager.createInProject(project, { name: "new", description: "new prompt" }),
		);
		assert.equal(readFileSync(join(outsideDir, "secret.md"), "utf8").includes("secret"), true);
	});
});
