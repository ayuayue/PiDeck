import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { after, describe, test } from "node:test";
import { listGitRepos, resolveGitCwd, isPathInsideProject } from "../src/main/git/gitRepoScope.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "pideck-git-repo-scope-"));

function git(cwd, ...args) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

after(() => {
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

	test("prunes ignored repository trees and keeps explicitly included siblings", async () => {
		const project = join(fixtureRoot, "ignored");
		for (const name of ["", "third party/lib", "packages/keep", "packages/drop"]) {
			const dir = join(project, name);
			mkdirSync(dir, { recursive: true });
			git(dir, "init", "-q");
		}
		writeFileSync(join(project, ".gitignore"), "/third party/\n");
		writeFileSync(join(project, "packages", ".gitignore"), "*/\n!keep/\n");

		const repos = await listGitRepos(project);
		assert.deepEqual(
			repos.map((repo) => repo.relativePath),
			["", "packages/keep"],
		);
	});

	test("uses each nested worktree's rules and keeps tracked submodules", async () => {
		const project = join(fixtureRoot, "plain-container");
		const outer = join(project, "outer");
		for (const dir of [outer, join(outer, "module"), join(outer, "module", "generated"), join(outer, "module", "app")]) {
			mkdirSync(dir, { recursive: true });
			git(dir, "init", "-q");
		}
		// A tracked gitlink stays visible even if a later ignore rule matches its name.
		git(join(outer, "module"), "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init");
		git(outer, "add", "--", "module");
		writeFileSync(join(outer, ".gitignore"), "module/\n");
		writeFileSync(join(outer, "module", ".gitignore"), "generated/\n");

		const repos = await listGitRepos(project);
		assert.deepEqual(
			repos.map((repo) => repo.relativePath),
			["outer", "outer/module", "outer/module/app"],
		);
	});

	test("returns empty when the project has no git metadata", async () => {
		const project = join(fixtureRoot, "plain");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "README.md"), "hi");
		assert.deepEqual(await listGitRepos(project), []);
	});
});
