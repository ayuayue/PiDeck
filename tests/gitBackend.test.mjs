import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { GitBackendRouter, LocalGitBackend } = loadTsCommonJs("src/main/git/GitBackend.ts");

test("Git backend routing rejects SSH locators instead of selecting local Git", () => {
	const router = new GitBackendRouter({ locationKind: "local" }, { get: () => undefined });
	assert.throws(() => router.forLocator({ kind: "ssh", hostId: "host-1", remotePath: "/work/project" }), /UNSUPPORTED_PROJECT_LOCATION/);
});

test("local Git backend resolves repository and file targets beneath the stored project root", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pideck-git-backend-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "packages", "api"), { recursive: true });
	const project = { id: "project-1", path: root, environment: "windows" };
	const projectStore = { get: (projectId) => (projectId === project.id ? project : undefined) };
	const backend = new LocalGitBackend(projectStore, (record) => record.path);
	const router = new GitBackendRouter(backend, projectStore);

	assert.equal(router.forProject(project.id), backend);
	const repository = await backend.resolveRepository({ projectId: project.id, relativePath: "packages/api" });
	assert.equal(repository.repoRoot, realpathSync.native(join(root, "packages", "api")));
	assert.equal(repository.repoTarget.relativePath, "packages/api");
	assert.equal(await backend.resolveFilePath({ projectId: project.id, relativePath: "packages/api/index.ts" }), resolve(realpathSync.native(root), "packages/api/index.ts"));
	await assert.rejects(backend.resolveFilePath({ projectId: project.id, relativePath: "../outside" }), /INVALID_PROJECT_FILE_TARGET/);
});
