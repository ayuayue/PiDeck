import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	buildCatalogSyncEntry,
	buildCloudSyncProject,
	buildGlobalCloudSyncProject,
	buildPiDeckSyncIndex,
	createSessionRef,
	createTextFileBundle,
	filterSyncableDesktopSettings,
	pickSyncableDesktopSettings,
	resolveGlobalSessionPath,
	resolvePortablePath,
	sessionObjectKey,
	toPortableRelativePath,
} from "../src/main/cloudSync/payload.ts";

const project = {
	id: "project-a",
	name: "PiDeck",
	path: "/workspace/pideck",
	lastOpenedAt: 100,
	pinned: true,
	sortOrder: 2,
	environment: "windows",
};

test("desktop settings payload keeps portable preferences and excludes device paths", () => {
	const settings = {
		theme: "dark",
		accent: "green",
		favoriteModels: ["provider/model"],
		customPiPath: "C:/Users/me/bin/pi",
		piProxyUrl: "http://127.0.0.1:7890",
		backgroundImage: "wallpaper.png",
		dshHomeDir: "D:/dsh",
	};
	const picked = pickSyncableDesktopSettings(settings);
	assert.deepEqual(picked, {
		theme: "dark",
		accent: "green",
		favoriteModels: ["provider/model"],
	});
	assert.deepEqual(
		filterSyncableDesktopSettings({ ...settings, language: "zh-CN", customPiPath: "/unsafe" }),
		{ theme: "dark", accent: "green", favoriteModels: ["provider/model"], language: "zh-CN" },
	);
});

test("session and project paths round-trip as portable relative paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-cloud-payload-"));
	const filePath = join(root, "2026", "session.jsonl");
	assert.equal(toPortableRelativePath(root, filePath), "2026/session.jsonl");
	assert.equal(resolvePortablePath(root, "2026/session.jsonl"), filePath);
	assert.equal(resolveGlobalSessionPath(root, "2026/session.jsonl"), join(root, ".pi", "agent", "sessions", "2026", "session.jsonl"));
	assert.throws(() => resolvePortablePath(root, "../escape"), /unsafe path segment/);
	assert.throws(() => toPortableRelativePath(root, "/elsewhere/session.jsonl"), /outside the sync root/);
});

test("selected session refs contain identity/hash/object key but never absolute paths", () => {
	const ref = createSessionRef({
		sessionId: "session-1",
		scope: "project",
		projectId: "project-a",
		rootPath: "/workspace/pideck/.pi/sessions",
		filePath: "/workspace/pideck/.pi/sessions/2026/session.jsonl",
		size: 42,
		mtimeMs: 1234,
		contentHash: "sha256-hash",
	});
	assert.deepEqual(ref, {
		sessionId: "session-1",
		scope: "project",
		projectId: "project-a",
		relativePath: "2026/session.jsonl",
		size: 42,
		mtimeMs: 1234,
		contentHash: "sha256-hash",
		objectKey: "pideck-sessions/session-1.jsonl.enc",
	});
	assert.equal(sessionObjectKey("session-1"), ref.objectKey);
	assert.throws(
		() => createSessionRef({
			sessionId: "session-1",
			scope: "project",
			rootPath: "/workspace/pideck/.pi/sessions",
			filePath: "/workspace/pideck/.pi/sessions/a.jsonl",
			size: 1,
			mtimeMs: 1,
			contentHash: "hash",
		}),
		/project id/,
	);
});

test("project tree, catalog entry and file bundles use the sync manifest shape", () => {
	const small = createTextFileBundle(".pi/prompts/review.md", "review this");
	assert.equal(small.content, "review this");
	assert.equal(small.objectKey, undefined);
	const large = createTextFileBundle(".pi/extensions/large.ts", "x".repeat(20), 10);
	assert.equal(large.content, undefined);
	assert.match(large.objectKey, /^pideck-files\/[0-9a-f]{64}\.enc$/);

	const catalog = buildCatalogSyncEntry({
		id: "session-1",
		projectId: "project-a",
		title: "Review",
		source: "pi",
		environment: "native",
		filePath: "/workspace/pideck/.pi/sessions/session.jsonl",
		preview: "hello",
		messageCount: 2,
		status: "active",
		createdAt: 1,
		updatedAt: 2,
	}, "session.jsonl");
	assert.equal(catalog.filePath, undefined);
	assert.equal(catalog.parentSessionPath, undefined);
	assert.equal(catalog.relativePath, "session.jsonl");

	const node = buildCloudSyncProject(project, {
		resources: { prompts: [small] },
		catalogEntries: [catalog],
	});
	assert.equal(node.projectId, "project-a");
	assert.equal(node.pathHint, project.path);
	assert.equal(node.resources?.prompts?.[0].relativePath, ".pi/prompts/review.md");
	assert.equal(buildGlobalCloudSyncProject().projectId, "__global__");
});

test("index builder writes schema metadata and applies the same settings filter", () => {
	const index = buildPiDeckSyncIndex({
		deviceId: "device-a",
		deviceName: "Workstation",
		appVersion: "0.7.2-beta",
		syncedAt: 123,
		settings: {
			theme: "dark",
			customPiPath: "/device-only",
		},
		projects: [buildCloudSyncProject(project)],
	});
	assert.equal(index.schemaVersion, 1);
	assert.equal(index.meta.deviceName, "Workstation");
	assert.deepEqual(index.settings, { theme: "dark" });
	assert.equal(index.projects?.[0].projectId, "project-a");
});
