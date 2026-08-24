import assert from "node:assert/strict";
import test from "node:test";

import { mergeSyncIndexes, resolveMergeConflicts } from "../src/main/cloudSync/merge.ts";
import { buildPiDeckSyncIndex, buildCloudSyncProject, buildGlobalCloudSyncProject } from "../src/main/cloudSync/payload.ts";

const PASSWORD = "unused";

function makeIndex({ settings, sessions, resources, projectMetadata }) {
	const globalOptions = {};
	if (sessions) globalOptions.sessions = sessions;
	if (resources) globalOptions.resources = resources;
	const projects = [buildGlobalCloudSyncProject(globalOptions)];
	if (projectMetadata) {
		projects.push(buildCloudSyncProject({
			id: "proj-a",
			name: "Proj",
			path: "/workspace/proj",
			lastOpenedAt: 1,
			...projectMetadata,
		}));
	}
	return buildPiDeckSyncIndex({
		deviceId: "device-a",
		deviceName: "Workstation",
		appVersion: "0.0.0-test",
		syncedAt: 1,
		...(settings ? { settings } : {}),
		projects,
	});
}

function sessionRef(sessionId, hash, relativePath = `${sessionId}.jsonl`) {
	return {
		sessionId,
		scope: "global",
		relativePath,
		size: 10,
		mtimeMs: 1,
		contentHash: hash,
		objectKey: `pideck-sessions/${sessionId}.jsonl.enc`,
	};
}

test("settings fields merge independently; only both-changed fields conflict", () => {
	const base = makeIndex({ settings: { theme: "dark", accent: "green" } });
	const local = makeIndex({ settings: { theme: "dark", accent: "blue", language: "zh-CN" } });
	const remote = makeIndex({ settings: { theme: "light", accent: "green" } });
	const result = mergeSyncIndexes(base, local, remote, "smartMerge");
	// theme: 仅远端改 → 采纳远端；accent: 仅本地改 → 采纳本地；language: 仅本地新增 → 采纳
	assert.equal(result.merged.settings.theme, "light");
	assert.equal(result.merged.settings.accent, "blue");
	assert.equal(result.merged.settings.language, "zh-CN");
	assert.equal(result.conflicts.length, 0);
});

test("settings conflict resolved by explicit choice", () => {
	const base = makeIndex({ settings: { theme: "dark" } });
	const local = makeIndex({ settings: { theme: "dark-2" } });
	const remote = makeIndex({ settings: { theme: "light-2" } });
	const result = mergeSyncIndexes(base, local, remote, "smartMerge");
	assert.equal(result.conflicts.length, 1);
	assert.equal(result.conflicts[0].id, "settings:theme");
	const resolved = resolveMergeConflicts(base, local, remote, [{ id: "settings:theme", choice: "remote" }], "smartMerge");
	assert.equal(resolved.merged.settings.theme, "light-2");
	assert.equal(resolved.conflicts.length, 0);
	assert.equal(resolved.settingsAdoptedFromRemote, true);
});

test("session transfers: upload local-only, download remote-only, conflict on both-changed", () => {
	const base = makeIndex({ sessions: [sessionRef("s1", "a".repeat(64)), sessionRef("s2", "b".repeat(64))] });
	const local = makeIndex({ sessions: [sessionRef("s1", "a".repeat(64)), sessionRef("s2", "b".repeat(64)), sessionRef("s3", "c".repeat(64))] });
	const remote = makeIndex({ sessions: [sessionRef("s1", "a".repeat(64)), sessionRef("s2", "b".repeat(64)), sessionRef("s4", "d".repeat(64))] });
	const result = mergeSyncIndexes(base, local, remote, "smartMerge");
	// s3 仅本地 → 上传；s4 仅远端 → 下载；s1/s2 未变
	assert.deepEqual(result.transfers.sessionUpload.map((ref) => ref.sessionId), ["s3"]);
	assert.deepEqual(result.transfers.sessionDownload.map((ref) => ref.sessionId), ["s4"]);
	assert.equal(result.conflicts.length, 0);
	const mergedIds = result.merged.projects[0].sessions.map((ref) => ref.sessionId).sort();
	assert.deepEqual(mergedIds, ["s1", "s2", "s3", "s4"]);

	// 双方改同一会话 → 冲突
	const base2 = makeIndex({ sessions: [sessionRef("s1", "a".repeat(64))] });
	const local2 = makeIndex({ sessions: [sessionRef("s1", "e".repeat(64))] });
	const remote2 = makeIndex({ sessions: [sessionRef("s1", "f".repeat(64))] });
	const conflict = mergeSyncIndexes(base2, local2, remote2, "smartMerge");
	assert.equal(conflict.conflicts.length, 1);
	assert.equal(conflict.conflicts[0].id, "session:s1");
	assert.equal(conflict.conflicts[0].kind, "session");
	// 显式选远端 → 下载
	const resolved = resolveMergeConflicts(base2, local2, remote2, [{ id: "session:s1", choice: "remote" }], "smartMerge");
	assert.equal(resolved.conflicts.length, 0);
	assert.deepEqual(resolved.transfers.sessionDownload.map((ref) => ref.sessionId), ["s1"]);
	assert.equal(resolved.merged.projects[0].sessions[0].contentHash, "f".repeat(64));
});

test("resource transfer plan keeps project/category/relativePath provenance", () => {
	const base = makeIndex({
		resources: { skills: [{ relativePath: "demo/SKILL.md", contentHash: "a".repeat(64), content: "base" }] },
	});
	const local = makeIndex({
		resources: { skills: [{ relativePath: "demo/SKILL.md", contentHash: "b".repeat(64), content: "local" }] },
	});
	const remote = makeIndex({
		resources: { skills: [{ relativePath: "demo/SKILL.md", contentHash: "c".repeat(64), content: "remote" }] },
	});
	const result = mergeSyncIndexes(base, local, remote, "smartMerge");
	assert.equal(result.conflicts.length, 1);
	assert.equal(result.conflicts[0].id, "resource:__global__:skills:demo/SKILL.md");
	assert.equal(result.conflicts[0].kind, "resource");
	const resolved = resolveMergeConflicts(
		base,
		local,
		remote,
		[{ id: "resource:__global__:skills:demo/SKILL.md", choice: "remote" }],
		"smartMerge",
	);
	assert.deepEqual(resolved.transfers.resourceDownload.map((item) => item.bundle.relativePath), ["demo/SKILL.md"]);
	assert.equal(resolved.merged.projects[0].resources.skills[0].content, "remote");
});

test("project metadata conflict and one-sided adoption", () => {
	const base = makeIndex({ projectMetadata: { pinned: false } });
	const local = makeIndex({ projectMetadata: { pinned: true, sortOrder: 1 } });
	const remote = makeIndex({ projectMetadata: { pinned: false, sortOrder: 2 } });
	const result = mergeSyncIndexes(base, local, remote, "smartMerge");
	const proj = result.merged.projects.find((project) => project.projectId === "proj-a");
	// pinned: 仅本地改 → 采纳本地；sortOrder: 双方改 → 冲突（默认本地优先）
	assert.deepEqual(result.conflicts.map((conflict) => conflict.id), ["project:proj-a:sortOrder"]);
	assert.equal(proj.metadata.pinned, true);
	assert.equal(proj.metadata.sortOrder, 1);
	// 显式选远端
	const resolved = resolveMergeConflicts(base, local, remote, [{ id: "project:proj-a:sortOrder", choice: "remote" }], "smartMerge");
	assert.equal(resolved.conflicts.length, 0);
	assert.equal(resolved.merged.projects.find((project) => project.projectId === "proj-a").metadata.sortOrder, 2);
});
