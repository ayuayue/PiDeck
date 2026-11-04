import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CloudSyncManager } from "../src/main/cloudSync/CloudSyncManager.ts";
import { CloudSyncScanner } from "../src/main/cloudSync/CloudSyncScanner.ts";
import { createDefaultExternalEditorSettings } from "../src/shared/types/project.ts";

const PASSWORD = "correct horse battery staple";

function minimalSettings() {
	return {
		theme: "dark",
		accent: "green",
		favoriteModels: [],
		externalEditors: createDefaultExternalEditorSettings(),
	};
}

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

async function withTemp(run) {
	const base = await mkdtemp(join(tmpdir(), "pideck-custompath-"));
	try {
		return await run(base);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

/** 内存对象存储（模拟 S3 条件写语义）。 */
function createMemoryStorage() {
	const storage = {
		objects: new Map(),
		async connect() { return { account: { id: "mem", name: "memory" } }; },
		async disconnect() {},
		async getAccount() { return { id: "mem", name: "memory" }; },
		async getCapabilities() { return { revisions: true, conditionalWrites: true, atomicReplacement: true }; },
		async readObject(key) {
			const entry = this.objects.get(key);
			if (!entry) return { found: false, key, bytes: null };
			return { found: true, key, bytes: entry.bytes, revision: entry.revision };
		},
		async writeObject(key, bytes, options) {
			const existing = this.objects.get(key);
			if (options?.expectedRevision === null && existing) {
				const err = new Error("conditional"); err.code = "conditional_write_conflict"; throw err;
			}
			const revision = `rev-${this.objects.size + 1}`;
			this.objects.set(key, { bytes, revision });
			return { created: !existing, revision };
		},
		async deleteObject(key) { return { deleted: this.objects.delete(key) }; },
	};
	return storage;
}

function makeManager({ userDataDir, homeDir, storage, listProjects = () => [], listSessionRecords = () => [] }) {
	return new CloudSyncManager({
		userDataDir,
		homeDir,
		deviceName: "test",
		appVersion: "0.0.0-test",
		listProjects,
		listSessionRecords,
		getDesktopSettings: minimalSettings,
		updateDesktopSettings: async () => undefined,
		createAdapter: () => storage,
	});
}

// ── Manager：自选路径必须进扫描树（scanOptions 已接线） ──────────────────────────

test("custom path added via manager appears in the selection tree (home-relative gets ~/ prefix)", async () => {
	await withTemp(async (base) => {
		const home = join(base, "home");
		const customFile = join(home, "my-tool", "web.json");
		await mkdir(join(home, "my-tool"), { recursive: true });
		await writeFile(customFile, '{"search":"web"}', "utf8");

		const manager = makeManager({ userDataDir: join(base, "userData"), homeDir: home, storage: createMemoryStorage() });
		await manager.initialize();
		await manager.setupMasterKey(PASSWORD);
		await manager.addCustomPath({
			filePath: customFile,
			relativeTo: "home",
			relativePath: "my-tool/web.json",
			label: "my-tool web.json",
		});

		const tree = await manager.scanSelection();
		const global = tree.projects.find((node) => node.projectId === "__global__");
		assert.ok(global, "global node must exist");
		const custom = global.resources.find((resource) => resource.relativePath === "~/my-tool/web.json");
		assert.ok(custom, "added custom path must appear in the selection tree");
		assert.equal(custom.category, "config");
		assert.ok(custom.customPathId && custom.customPathId.startsWith("cp-"), "customPathId must be carried for UI removal");
		await manager.dispose();
	});
});

test("project-relative custom path appears under the project node", async () => {
	await withTemp(async (base) => {
		const projectPath = join(base, "repo");
		const customFile = join(projectPath, "notes", "idea.md");
		await mkdir(join(projectPath, "notes"), { recursive: true });
		await writeFile(customFile, "# idea", "utf8");

		const scanner = new CloudSyncScanner({
			homeDir: join(base, "home"),
			listProjects: () => [{ id: "p1", name: "repo", path: projectPath, lastOpenedAt: 1, environment: "windows" }],
			listSessionRecords: () => [],
		});
		const snapshot = await scanner.scan(DEFAULT_PREFERENCES, {
			customPaths: [{
				id: "cp-2",
				filePath: customFile,
				relativeTo: "project",
				relativePath: "notes/idea.md",
				projectId: "p1",
				label: "repo/notes/idea.md",
			}],
		});
		const projectNode = snapshot.tree.projects.find((node) => node.projectId === "p1");
		assert.ok(projectNode);
		const custom = projectNode.resources.find((resource) => resource.relativePath === "notes/idea.md");
		assert.ok(custom, "project-relative custom path must live under the project node");
		assert.equal(custom.category, "config");
		assert.equal(custom.customPathId, "cp-2");
	});
});

test("machine-only absolute custom path shows under global with label", async () => {
	await withTemp(async (base) => {
		const realFile = join(base, "outside-home.txt");
		await writeFile(realFile, "data", "utf8");
		const scanner = new CloudSyncScanner({
			homeDir: join(base, "home"),
			listProjects: () => [],
			listSessionRecords: () => [],
		});
		const snapshot = await scanner.scan(DEFAULT_PREFERENCES, {
			customPaths: [{
				id: "cp-3",
				filePath: realFile,
				relativeTo: "absolute",
				// 无法相对化：relativePath 存原始绝对路径（模拟 D:\ 等盘符场景）
				relativePath: "D:/elsewhere/outside-home.txt",
				label: "D:/elsewhere/outside-home.txt",
			}],
		});
		const global = snapshot.tree.projects.find((node) => node.projectId === "__global__");
		assert.ok(global);
		const custom = global.resources.find((resource) => resource.category === "config" && resource.customPathId === "cp-3");
		assert.ok(custom, "machine-only custom path must be visible, not silently dropped");
		assert.ok(custom.relativePath.startsWith("machine-only/"), `expected machine-only key, got ${custom.relativePath}`);
		assert.equal(custom.label, "D:/elsewhere/outside-home.txt");
	});
});

// ── 排除黑名单必须生效（scanOptions.exclusions 已接线） ─────────────────────────

test("exclusion patterns from manager state are applied to scanning", async () => {
	await withTemp(async (base) => {
		const home = join(base, "home");
		await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
		await writeFile(join(home, ".pi", "agent", "prompts", "keep.md"), "keep", "utf8");
		await writeFile(join(home, ".pi", "agent", "prompts", "skip.log"), "skip", "utf8");

		const manager = makeManager({ userDataDir: join(base, "userData"), homeDir: home, storage: createMemoryStorage() });
		await manager.initialize();
		await manager.setupMasterKey(PASSWORD);
		await manager.setExclusions(["*.log"]);

		const tree = await manager.scanSelection();
		const global = tree.projects.find((node) => node.projectId === "__global__");
		assert.ok(global);
		const prompts = global.resources.filter((resource) => resource.category === "prompts").map((resource) => resource.relativePath);
		assert.ok(prompts.includes("prompts/keep.md"));
		assert.ok(!prompts.some((path) => path.endsWith(".log")), "*.log must be excluded from the scan");
		await manager.dispose();
	});
});

// ── home 相对自选路径：同步往返必须写回用户 home（而不是 ~/.pi/agent） ────────────

test("home-relative custom path syncs and restores into the user home", async () => {
	await withTemp(async (base) => {
		const storage = createMemoryStorage();

		// Machine A：home 下有一个自选文件。
		const homeA = join(base, "homeA");
		const customFile = join(homeA, "my-tool", "web.json");
		await mkdir(join(homeA, "my-tool"), { recursive: true });
		await writeFile(customFile, '{"search":"web"}', "utf8");
		const managerA = makeManager({ userDataDir: join(base, "userDataA"), homeDir: homeA, storage });
		await managerA.initialize();
		await managerA.setupMasterKey(PASSWORD);
		await managerA.configureProvider({ provider: "s3", config: { endpoint: "https://example.invalid", region: "us-east-1", bucket: "pideck-bucket", accessKeyId: "a", secretAccessKey: "s" } });
		await managerA.connectProvider("s3");
		await managerA.addCustomPath({
			filePath: customFile,
			relativeTo: "home",
			relativePath: "my-tool/web.json",
			label: "my-tool web.json",
		});

		const tree = await managerA.scanSelection();
		const global = tree.projects.find((node) => node.projectId === "__global__");
		const custom = global.resources.find((resource) => resource.relativePath === "~/my-tool/web.json");
		assert.ok(custom);
		await managerA.updateSelection({ selectedSessionIds: [], selectedResourceIds: [custom.selectionId] });
		const pushed = await managerA.syncNow();
		assert.equal(pushed.pushed, true);
		await managerA.dispose();

		// Machine B：全新 home，拉取恢复 → 应落 homeB/my-tool/web.json，而不是 homeB/.pi/agent/...。
		const homeB = join(base, "homeB");
		await mkdir(homeB, { recursive: true });
		const managerB = makeManager({ userDataDir: join(base, "userDataB"), homeDir: homeB, storage });
		await managerB.initialize();
		await managerB.setupMasterKey(PASSWORD);
		await managerB.configureProvider({ provider: "s3", config: { endpoint: "https://example.invalid", region: "us-east-1", bucket: "pideck-bucket", accessKeyId: "a", secretAccessKey: "s" } });
		await managerB.connectProvider("s3");

		const pulled = await managerB.syncNow();
		assert.equal(pulled.pulled, true);

		const restoredPath = join(homeB, "my-tool", "web.json");
		assert.equal(await readFile(restoredPath, "utf8"), '{"search":"web"}');
		const agentRootCopy = join(homeB, ".pi", "agent", "my-tool", "web.json");
		await assert.rejects(readFile(agentRootCopy), "home-relative custom path must NOT restore under the agent root");

		await managerB.dispose();
	});
});
