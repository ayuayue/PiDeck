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
				if (target.relativePath === "missing") return { availability: "missing", exists: false, isDirectory: false, code: "ENOENT" };
				if (target.relativePath === "unavailable") return { availability: "unavailable", exists: false, isDirectory: false, code: "SSH_HOST_NOT_READY" };
				return { availability: "present", exists: true, isDirectory: target.relativePath === "" };
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

test("both providers keep project identity and report present, missing, and unavailable states", async () => {
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
		const missing = await files.stat({ projectId, relativePath: "missing" });
		assert.equal(missing.availability, "missing");
		assert.equal(missing.code, "ENOENT");
		assert.equal("isDirectory" in missing, false, "missing is not evidence of a file type");
		const unavailable = await files.stat({ projectId, relativePath: "unavailable" });
		assert.equal(unavailable.availability, "unavailable");
		assert.equal(unavailable.code, "SSH_HOST_NOT_READY");
		assert.equal("isDirectory" in unavailable, false, "an unavailable read cannot guess a file type");
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
