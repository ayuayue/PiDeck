import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { after, before, describe, test } from "node:test";

const require = createRequire(import.meta.url);
const buildDir = mkdtempSync(join(tmpdir(), "pideck-git-repo-scope-build-"));
const fixtureRoot = mkdtempSync(join(tmpdir(), "pideck-git-repo-scope-"));
let listGitRepos;
let resolveGitCwd;
let isPathInsideProject;

function git(cwd, ...args) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

before(() => {
	execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "src/main/git/gitRepoScope.ts", "src/shared/types.ts", "--module", "commonjs", "--target", "es2022", "--moduleResolution", "node", "--esModuleInterop", "--skipLibCheck", "--outDir", buildDir], { cwd: resolve("."), stdio: "pipe" });
	({ listGitRepos, resolveGitCwd, isPathInsideProject } = require(join(buildDir, "main/git/gitRepoScope.js")));
});

after(() => {
	rmSync(buildDir, { recursive: true, force: true });
	rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("resolveGitCwd", () => {
	test("defaults to the project root when repoPath is omitted", () => {
		const project = resolve(fixtureRoot, "proj");
		assert.equal(resolveGitCwd(project), resolve(project));
		assert.equal(resolveGitCwd(project, ""), resolve(project));
	});

	test("rejects a repository path outside the project", () => {
		const project = resolve(fixtureRoot, "inside");
		mkdirSync(project, { recursive: true });
		assert.throws(() => resolveGitCwd(project, resolve(fixtureRoot, "outside")), /outside the project/);
	});

	test("accepts a nested path inside the project", () => {
		const project = resolve(fixtureRoot, "nested-ok");
		const child = join(project, "packages", "api");
		mkdirSync(child, { recursive: true });
		assert.equal(resolveGitCwd(project, child), resolve(child));
	});

	test("treats Windows paths as inside when only case differs", () => {
		const project = `C:${sep}Work${sep}App`;
		const nested = `c:${sep}work${sep}app${sep}packages${sep}web`;
		if (process.platform === "win32") {
			assert.equal(isPathInsideProject(project, nested), true);
		} else {
			assert.equal(isPathInsideProject(project, nested), false);
		}
	});
});

describe("listGitRepos", () => {
	test("returns the root repo first and nested independent repos after", async () => {
		const project = join(fixtureRoot, "multi");
		const packages = join(project, "packages");
		const web = join(packages, "web");
		const api = join(packages, "api");
		const skipped = join(project, "node_modules", "dep");
		mkdirSync(web, { recursive: true });
		mkdirSync(api, { recursive: true });
		mkdirSync(skipped, { recursive: true });

		for (const dir of [project, web, api, skipped]) {
			git(dir, "init");
			git(dir, "config", "user.name", "PiDeck Test");
			git(dir, "config", "user.email", "test@example.com");
		}

		const repos = await listGitRepos(project);
		assert.equal(repos[0]?.relativePath, "");
		assert.deepEqual(
			repos.map((repo) => repo.relativePath),
			["", "packages/api", "packages/web"],
		);
		assert.ok(!repos.some((repo) => repo.relativePath.includes("node_modules")));
	});

	test("returns empty when the project has no git metadata", async () => {
		const project = join(fixtureRoot, "plain");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "README.md"), "hi");
		assert.deepEqual(await listGitRepos(project), []);
	});
});
