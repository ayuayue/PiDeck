import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const { parseGitHubRepositorySource, resolveGitHubLatestVersion } = loadTsCommonJs("src/main/extensions/githubVersion.ts");
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("GitHub package sources retain owner/repo and provide a short display name", () => {
	for (const source of ["git:github.com/QUNIXNG/cua-gate", "github:QUNIXNG/cua-gate", "git:https://github.com/QUNIXNG/cua-gate.git", "https://github.com/QUNIXNG/cua-gate/tree/main"]) {
		assert.deepEqual({ ...parseGitHubRepositorySource(source) }, { owner: "QUNIXNG", repo: "cua-gate", name: "cua-gate" });
	}
	for (const source of ["git:https://gitlab.com/owner/repo", "https://example.com/pkg.tgz", "npm:pkg", "C:\\pkg"]) {
		assert.equal(parseGitHubRepositorySource(source), null);
	}
});

test("latest GitHub release provides the latest version", async () => {
	const requests = [];
	const version = await resolveGitHubLatestVersion(
		{ owner: "owner", repo: "repo" },
		{
			fetchImpl: async (url) => {
				requests.push(url);
				return jsonResponse(200, { tag_name: "v1.2.0" });
			},
		},
	);
	assert.equal(version, "1.2.0");
	assert.deepEqual(requests, ["https://api.github.com/repos/owner/repo/releases/latest"]);
});

test("no GitHub release falls back to the highest semantic version tag", async () => {
	const requests = [];
	const version = await resolveGitHubLatestVersion(
		{ owner: "owner", repo: "repo" },
		{
			fetchImpl: async (url) => {
				requests.push(url);
				return url.endsWith("/releases/latest") ? jsonResponse(404, {}) : jsonResponse(200, [{ name: "v1.2.0" }, { name: "v1.10.0" }, { name: "nightly" }]);
			},
		},
	);
	assert.equal(version, "1.10.0");
	assert.equal(requests.length, 2);
});

test("GitHub package enrichment reads the installed package and isolates lookup failure", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pideck-github-version-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "package");
	await mkdir(path);
	await writeFile(join(path, "package.json"), JSON.stringify({ version: "1.1.0" }));
	const loadProductionTs = createTsSandbox({ stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
	const { PiExtensionCatalog } = loadProductionTs("src/main/extensions/piExtensionCatalog.ts");
	let fetchImpl = async () => jsonResponse(200, { tag_name: "v1.2.0" });
	const catalog = new PiExtensionCatalog({ homeDir: () => home, toHostPath: (value) => value, locator: {}, getSettings: () => ({}), getPiDeckSettings: () => ({}), translate: (key) => key, gitHubVersionOptions: { fetchImpl: (...args) => fetchImpl(...args) } });
	const row = { id: "user:github:owner/repo", source: "git:github.com/owner/repo", path, scope: "user" };

	const updated = await catalog.enrichExtensionVersion(row, async () => {
		throw new Error("npm must not be queried");
	});
	assert.equal(updated.currentVersion, "1.1.0");
	assert.equal(updated.latestVersion, "1.2.0");
	assert.equal(updated.hasUpdate, true);
	fetchImpl = async () => {
		throw new Error("offline");
	};
	const failed = await catalog.enrichExtensionVersion(row, async () => null);
	assert.equal(failed.currentVersion, "1.1.0");
	assert.equal(failed.latestVersion, undefined);
	assert.equal(failed.updateError, "mainExtension.versionCheckFailed");
});
