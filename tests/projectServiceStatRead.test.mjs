import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createLocalProjectFileService, createRemoteProjectFileService } = loadTsCommonJs("src/renderer/src/services/projectFileService.ts");
const { PROJECT_SERVICE_CODES } = loadTsCommonJs("src/renderer/src/services/projectServiceContracts.ts");
const { createRemoteProjectEntryService } = loadTsCommonJs("src/main/remote/RemoteProjectEntryService.ts");

const projectId = "project";
const root = "/srv/project";
const revision = { mode: 0o644, size: 10, dev: "1", ino: "2", uid: "3", gid: "4", mtimeNs: "5", ctimeNs: "6" };
const plain = (value) => JSON.parse(JSON.stringify(value));

function testFence(generation = "generation-1") {
	return { generation, slot: { current: generation } };
}

function fixture() {
	const entries = createRemoteProjectEntryService({
		locator: (id) => (id === projectId ? { hostId: "host", remotePath: root } : undefined),
		withProject: async (_target, work) =>
			work({
				nodePath: "/usr/bin/node",
				hostRevision: 1,
				async runCommand(command) {
					const marker = /PIDECK_ENTRY_[a-f0-9]{32}/.exec(command)?.[0];
					assert.ok(marker);
					const payload = { ok: true, stat: { kind: "file", bytes: 10, mtimeMs: 1 }, revision, relativePath: "src/renamed.ts" };
					return { exitCode: 0, stdout: marker + JSON.stringify(payload) };
				},
			}),
	});
	const api = {
		files: {
			async stat(target) {
				assert.equal(target.projectId, projectId);
				return { exists: target.relativePath !== "missing", isDirectory: target.relativePath === "" };
			},
		},
		remoteHosts: {
			async statProjectEntry(id, relativePath) {
				return { ok: true, value: await entries.stat(1, id, relativePath) };
			},
			async renameProjectEntry(id, source, target, version) {
				return { ok: true, value: await entries.rename(1, id, source, target, version) };
			},
		},
	};
	return { api, entries };
}

test("remote provider stat preserves an outstanding rename grant across 128 reads", async () => {
	const { api, entries } = fixture();
	const files = createRemoteProjectFileService(projectId, api, testFence());
	const target = { projectId, relativePath: "src/a.ts" };
	const grant = await entries.stat(1, projectId, target.relativePath);
	for (let index = 0; index < 128; index++) {
		const state = await files.stat({ projectId, relativePath: `src/file-${index}.ts` });
		assert.equal(state.availability, "present");
	}
	assert.equal(entries.tokenCount(), 1);
	const renamed = await files.renameEntry(target, "renamed.ts", grant.version);
	assert.deepEqual(plain(renamed.target), { projectId, relativePath: "src/renamed.ts" });
	assert.equal(entries.tokenCount(), 0);
});

test("both providers keep project identity and report present, directory, and unavailable states", async () => {
	for (const createService of [createLocalProjectFileService, createRemoteProjectFileService]) {
		const { api, entries } = fixture();
		const files = createService(projectId, api, testFence());
		const present = await files.stat({ projectId, relativePath: "src/a.ts" });
		assert.deepEqual(plain(present.target), { projectId, relativePath: "src/a.ts" });
		assert.equal(present.availability, "present");
		assert.equal(present.isDirectory, false);
		const directory = await files.stat({ projectId, relativePath: "" });
		assert.equal(directory.availability, "present");
		assert.equal(directory.isDirectory, true);
		// 公共 files.stat 的负结果无法区分“缺失”和“读取失败”：只能记 unavailable，不能谎报不存在。
		const negative = await files.stat({ projectId, relativePath: "missing" });
		assert.equal(negative.availability, "unavailable");
		assert.equal(negative.code, PROJECT_SERVICE_CODES.statUnavailable);
		assert.equal("isDirectory" in negative, false, "读不到时不能猜是不是目录");
		assert.equal(entries.tokenCount(), 0);
	}
});

test("stat rejects a target from another project before touching any read channel", async () => {
	let calls = 0;
	const api = {
		files: {
			async stat() {
				calls += 1;
				return { exists: true, isDirectory: false };
			},
		},
		remoteHosts: {},
	};
	const files = createRemoteProjectFileService(projectId, api, testFence());
	await assert.rejects(
		() => files.stat({ projectId: "other-project", relativePath: "a.ts" }),
		(error) => error?.code === PROJECT_SERVICE_CODES.projectMismatch,
	);
	assert.equal(calls, 0);
});
