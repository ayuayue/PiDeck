import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createLocalProjectFileService, createRemoteProjectFileService } = loadTsCommonJs("src/renderer/src/services/projectFileService.ts");
const { createRemoteProjectEntryService } = loadTsCommonJs("src/main/remote/RemoteProjectEntryService.ts");

const projectId = "project";
const root = "/srv/project";
const revision = { mode: 0o644, size: 10, dev: "1", ino: "2", uid: "3", gid: "4", mtimeNs: "5", ctimeNs: "6" };

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
	const files = createRemoteProjectFileService(api);
	const target = { projectId, relativePath: "src/a.ts" };
	const grant = await entries.stat(1, projectId, target.relativePath);
	for (let index = 0; index < 128; index++) {
		const state = await files.stat({ projectId, relativePath: `src/file-${index}.ts` });
		assert.equal(state.exists, true);
	}
	assert.equal(entries.tokenCount(), 1);
	await files.renameEntry(target, "renamed.ts", grant.version);
	assert.equal(entries.tokenCount(), 0);
});

test("both providers preserve project identity and file, directory, and missing states", async () => {
	for (const createService of [createLocalProjectFileService, createRemoteProjectFileService]) {
		const { api, entries } = fixture();
		const files = createService(api);
		for (const relativePath of ["src/a.ts", "", "missing"]) {
			const target = { projectId, relativePath };
			const state = await files.stat(target);
			assert.equal(state.target, target);
			assert.equal(state.exists, relativePath !== "missing");
			assert.equal(state.isDirectory, relativePath === "");
		}
		assert.equal(entries.tokenCount(), 0);
	}
});
