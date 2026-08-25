import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CloudSyncScanner } from "../src/main/cloudSync/CloudSyncScanner.ts";

const DEFAULT_PREFERENCES = {
	selectedSessionIds: [],
	selectedResourceIds: [],
	content: {
		desktopSettings: true,
		piModels: true,
		piCredentials: true,
		dshSettings: true,
		dshCredentials: true,
		projects: true,
		catalog: true,
		prompts: true,
		skills: true,
		extensions: true,
		security: true,
		imageGen: true,
	},
};

async function makeHome(base, entries) {
	for (const [relative, content] of Object.entries(entries)) {
		const target = join(base, relative);
		await mkdir(target.split(/[\\/]/).slice(0, -1).join("/"), { recursive: true });
		if (content !== null) await writeFile(target, content, "utf8");
	}
}

test("scanner builds a global + project selection tree with per-root status", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-cloud-scan-"));
	const home = join(base, "home");
	const projectPath = join(base, "proj");
	try {
		await makeHome(home, {
			".pi/agent/sessions/2026/a.jsonl": "{}",
			".pi/agent/sessions/b.jsonl": "{}",
			".pi/agent/skills/demo/SKILL.md": "# demo",
			".pi/agent/prompts/review.md": "review",
		});
		await makeHome(projectPath, {
			".pi/sessions/x.jsonl": "{}",
			".pi/prompts/pp.md": "pp",
		});
		const scanner = new CloudSyncScanner({
			homeDir: home,
			listProjects: () => [{
				id: "proj-1",
				name: "proj",
				path: projectPath,
				lastOpenedAt: 1,
				environment: "windows",
			}],
			listSessionRecords: () => [],
		});
		const snapshot = await scanner.scan(DEFAULT_PREFERENCES);
		assert.equal(snapshot.tree.projects.length, 2);
		// 内容分类偏好透传到选择树（UI 绑定用）
		assert.equal(snapshot.tree.content.desktopSettings, true);
		assert.equal(snapshot.tree.content.imageGen, true);
		const global = snapshot.tree.projects.find((node) => node.projectId === "__global__");
		const project = snapshot.tree.projects.find((node) => node.projectId === "proj-1");
		assert.ok(global);
		assert.ok(project);
		assert.equal(global.sessions.length, 2);
		assert.equal(project.sessions.length, 1);
		assert.equal(global.resources.length, 2); // prompts + skills (settings.json 缺省不存在)
		assert.equal(project.resources.length, 1); // .pi/prompts
		const globalSessionsRoot = snapshot.tree.roots.find((root) => root.kind === "global-sessions");
		assert.ok(globalSessionsRoot.ok);
		assert.equal(globalSessionsRoot.count, 2);
		const projectSessionsRoot = snapshot.tree.roots.find((root) => root.kind === "project-sessions" && root.projectId === "proj-1");
		assert.ok(projectSessionsRoot.ok);
		// 会话候选不暴露绝对路径
		for (const session of [...global.sessions, ...project.sessions]) {
			assert.ok(!session.relativePath.includes("\\"));
			assert.ok(!session.relativePath.startsWith("/"));
		}
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("scanner skips symlinks and applies the per-file size limit", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-cloud-scan-"));
	const home = join(base, "home");
	const outside = join(base, "outside.jsonl");
	try {
		await makeHome(home, { ".pi/agent/sessions/real.jsonl": "{}" });
		await writeFile(outside, "{}", "utf8");
		const sessionsDir = join(home, ".pi", "agent", "sessions");
		// 目录内放一个指向外部的符号链接：扫描必须跳过，防止后续恢复把外部文件当会话。
		try {
			await symlink(outside, join(sessionsDir, "escaped.jsonl"));
		} catch {
			// 平台不支持 symlink（如无权限环境）时跳过该断言
		}
		// 超过资源 10MB 上限的文件 → unavailable
		const big = "x".repeat(11 * 1024 * 1024);
		await makeHome(home, { ".pi/agent/skills/big/SKILL.md": big });
		const scanner = new CloudSyncScanner({
			homeDir: home,
			listProjects: () => [],
			listSessionRecords: () => [],
		});
		const snapshot = await scanner.scan(DEFAULT_PREFERENCES);
		const global = snapshot.tree.projects.find((node) => node.projectId === "__global__");
		const sessionPaths = global.sessions.map((session) => session.relativePath);
		assert.ok(!sessionPaths.includes("escaped.jsonl"), "symlinked session must be skipped");
		const bigResource = global.resources.find((resource) => resource.relativePath === "skills/big/SKILL.md");
		assert.ok(bigResource);
		assert.equal(bigResource.status, "unavailable");
		assert.match(bigResource.reason, /limit/);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("scanner honors existing selection and groups sessions by catalog project id", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-cloud-scan-"));
	const home = join(base, "home");
	try {
		await makeHome(home, {
			".pi/agent/sessions/2026/a.jsonl": "{}",
			".pi/agent/sessions/2026/b.jsonl": "{}",
		});
		const filePath = join(home, ".pi", "agent", "sessions", "2026", "a.jsonl");
		const scanner = new CloudSyncScanner({
			homeDir: home,
			listProjects: () => [],
			listSessionRecords: () => [{
				id: "session-a",
				projectId: "proj-1",
				title: "Review",
				source: "pi",
				environment: "native",
				filePath,
				preview: "",
				messageCount: 1,
				status: "active",
				createdAt: 1,
				updatedAt: 1,
			}],
		});
		// 第一次扫描拿到 selectionId，再带选中偏好扫描
		const first = await scanner.scan(DEFAULT_PREFERENCES);
		const sessionA = first.sessions.get(first.tree.projects[0].sessions[0].selectionId);
		const selectionId = sessionA.candidate.selectionId;
		const second = await scanner.scan({
			...DEFAULT_PREFERENCES,
			selectedSessionIds: [selectionId],
		});
		// catalog 记录归属 proj-1：a.jsonl 应挂到项目节点而不是全局
		const projectNode = second.tree.projects.find((node) => node.projectId === "proj-1");
		assert.ok(projectNode, "project node should exist for catalog-attached session");
		const selected = [...second.sessions.values()].filter((item) => item.candidate.selected);
		assert.equal(selected.length, 1);
		assert.equal(selected[0].candidate.selectionId, selectionId);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("scanner scans global config whitelist (config category) and excludes trust/bak", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-cloud-scan-"));
	const home = join(base, "home");
	try {
		await makeHome(home, {
			".pi/agent/auth.json": "{}",
			".pi/agent/models.json": "{}",
			".pi/agent/models-store.json": "{}",
			".pi/agent/trust.json": "{}",
			".pi/agent/models.json.bak-20260803": "{}",
		});
		const scanner = new CloudSyncScanner({
			homeDir: home,
			listProjects: () => [],
			listSessionRecords: () => [],
		});
		const snapshot = await scanner.scan(DEFAULT_PREFERENCES);
		const global = snapshot.tree.projects.find((node) => node.projectId === "__global__");
		assert.ok(global);
		const configPaths = global.resources
			.filter((resource) => resource.category === "config")
			.map((resource) => resource.relativePath);
		assert.deepEqual(configPaths.sort(), ["auth.json", "models-store.json", "models.json"].sort());
		// trust.json 与 *.bak* 被排除：不进任何候选
		const allPaths = global.resources.map((resource) => resource.relativePath);
		assert.ok(!allPaths.includes("trust.json"), "trust.json must be excluded");
		assert.ok(!allPaths.some((path) => path.includes(".bak")), "*.bak* files must be excluded");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("scanner applies user exclusion blacklist (glob)", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-cloud-scan-"));
	const home = join(base, "home");
	try {
		await makeHome(home, {
			".pi/agent/prompts/keep.md": "keep",
			".pi/agent/prompts/secret.md": "secret",
			".pi/agent/prompts/secret/nested.md": "nested",
		});
		const scanner = new CloudSyncScanner({
			homeDir: home,
			listProjects: () => [],
			listSessionRecords: () => [],
		});
		const snapshot = await scanner.scan(DEFAULT_PREFERENCES, { exclusions: ["**/secret*"] });
		const global = snapshot.tree.projects.find((node) => node.projectId === "__global__");
		assert.ok(global);
		const promptPaths = global.resources
			.filter((resource) => resource.category === "prompts")
			.map((resource) => resource.relativePath);
		assert.ok(promptPaths.includes("prompts/keep.md"), "non-excluded file must survive");
		assert.ok(!promptPaths.includes("prompts/secret.md"), "**/secret* must filter the file");
		assert.ok(!promptPaths.includes("prompts/secret/nested.md"), "**/secret* must filter nested paths");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("scanner adds custom sync paths as config candidates", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-cloud-scan-"));
	const home = join(base, "home");
	const customFile = join(base, "my-tool", "web.json");
	try {
		await mkdir(join(base, "my-tool"), { recursive: true });
		await writeFile(customFile, "{}", "utf8");
		const scanner = new CloudSyncScanner({
			homeDir: home,
			listProjects: () => [],
			listSessionRecords: () => [],
		});
		const snapshot = await scanner.scan(DEFAULT_PREFERENCES, {
			customPaths: [{
				id: "cp-1",
				filePath: customFile,
				relativeTo: "home",
				relativePath: "my-tool/web.json",
				label: "my-tool web.json",
			}],
		});
		const global = snapshot.tree.projects.find((node) => node.projectId === "__global__");
		assert.ok(global);
		const custom = global.resources.find((resource) => resource.relativePath === "my-tool/web.json");
		assert.ok(custom, "custom path must appear as a resource candidate");
		assert.equal(custom.category, "config");
		assert.equal(custom.projectId, "__global__");
		// 不存在的自选路径静默跳过，不抛异常
		const snapshot2 = await scanner.scan(DEFAULT_PREFERENCES, {
			customPaths: [{
				id: "cp-missing",
				filePath: join(base, "nope", "missing.json"),
				relativeTo: "home",
				relativePath: "nope/missing.json",
				label: "missing",
			}],
		});
		const global2 = snapshot2.tree.projects.find((node) => node.projectId === "__global__");
		assert.equal(global2.resources.filter((resource) => resource.relativePath === "nope/missing.json").length, 0);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
