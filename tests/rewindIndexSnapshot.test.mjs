/**
 * PR #386：index 复制失败必须可见；WSL 绝对路径先回译，不能静默记录成空树。
 * 路径与失败注入测试不依赖 WSL；真实发行版测试用 PIDECK_TEST_WSL_DISTRO 显式启用。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createCheckpoint } from "../src/main/rewind/checkpointCore.ts";
import { runGitCommand } from "../src/main/git/gitRun.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/** 真实仓库：HEAD、暂存区、工作区三态不同，避免空树或 HEAD 回退混过断言。 */
function makeRepo(t) {
	const dir = mkdtempSync(path.join(tmpdir(), "rewind-index-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim();
	git(["init", "-q"]);
	git(["config", "user.name", "test"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "core.autocrlf", "false"]);
	git(["config", "commit.gpgsign", "false"]);
	writeFileSync(path.join(dir, "a.txt"), "head\n");
	git(["add", "a.txt"]);
	git(["commit", "-qm", "init"]);
	writeFileSync(path.join(dir, "a.txt"), "staged\n");
	git(["add", "a.txt"]);
	const expected = git(["write-tree"]);
	writeFileSync(path.join(dir, "a.txt"), "worktree\n");
	return { dir, git, expected };
}

/** 每条测试独立 id，失败时检查对应 ref 未发布。 */
function options(root) {
	return { root, id: `turn-${UUID}-1-${Date.now()}`, sessionId: UUID, trigger: "turn", turnIndex: 1 };
}

for (const code of ["EACCES", "ENOENT"]) {
	test(`#386 copyFile 抛 ${code}：拒绝发布错误的空 index 快照`, async (t) => {
		const { dir, git } = makeRepo(t);
		const failure = Object.assign(new Error(`injected copy failure: ${code}`), { code });
		const core = loadTsCommonJs("src/main/rewind/checkpointCore.ts", {
			stubs: {
				"node:fs/promises": {
					...fs,
					copyFile: async () => {
						throw failure;
					},
				},
			},
		});
		const opts = options(dir);
		await assert.rejects(core.createCheckpoint(opts), (error) => error === failure);
		assert.equal(git(["for-each-ref", `refs/pi-checkpoints/${opts.id}`]), "");
	});
}

test("#386 已有 HEAD 却缺失 index：明确失败，不记录空树", async (t) => {
	const { dir, git } = makeRepo(t);
	rmSync(path.join(dir, ".git", "index"));
	const opts = options(dir);
	await assert.rejects(createCheckpoint(opts), { code: "ENOENT" });
	assert.equal(git(["for-each-ref", `refs/pi-checkpoints/${opts.id}`]), "");
});

for (const linuxIndex of ["/tmp/repo/.git/index", "/tmp/main/.git/worktrees/linked/index", "/mnt/c/repo/.git/index"]) {
	test(`#386 Windows/WSL 子目录：回译 ${linuxIndex} 后捕获真实暂存树`, async (t) => {
		const { dir, expected } = makeRepo(t);
		const root = "\\\\wsl.localhost\\Debian\\tmp\\repo\\src";
		const expectedSource = linuxIndex.startsWith("/mnt/c/") ? path.win32.normalize("C:\\repo\\.git\\index") : path.win32.normalize(`\\\\wsl.localhost\\Debian${linuxIndex.replaceAll("/", "\\")}`);
		let copiedSource;
		const core = loadTsCommonJs("src/main/rewind/checkpointCore.ts", {
			globals: { process: { ...process, platform: "win32" } },
			stubs: {
				"node:path": { ...path, resolve: path.win32.resolve },
				"../git/gitRun.ts": {
					runGitCommand: async (args, opts) => {
						// 旧实现在 --git-dir 上得到相同的 Linux 绝对路径，确保测试先红。
						if (args[0] === "rev-parse" && args[1] === "--git-dir") return { stdout: path.posix.dirname(linuxIndex), stderr: "" };
						if (args[0] === "rev-parse" && args[1] === "--git-path") return { stdout: linuxIndex, stderr: "" };
						return runGitCommand(args, { ...opts, cwd: dir });
					},
				},
				"node:fs/promises": {
					...fs,
					stat: async (source) => {
						assert.equal(source, expectedSource);
						return fs.stat(path.join(dir, ".git", "index"));
					},
					copyFile: async (source, target) => {
						copiedSource = source;
						assert.equal(source, expectedSource);
						return fs.copyFile(path.join(dir, ".git", "index"), target);
					},
				},
			},
		});
		const cp = await core.createCheckpoint(options(root));
		assert.equal(copiedSource, expectedSource);
		assert.equal(cp.indexTreeSha, expected);
		assert.notEqual(cp.indexTreeSha, EMPTY_TREE);
	});
}

test("#386 宿主 linked worktree 子目录：使用独立 index，保留暂存内容", async (t) => {
	const { dir, git } = makeRepo(t);
	const parent = mkdtempSync(path.join(tmpdir(), "rewind-linked-"));
	const linked = path.join(parent, "linked");
	// 两个目录均为本测试私有；主仓库先被清理时不再调用 worktree remove。
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	git(["worktree", "add", "-qb", "linked-test", linked, "HEAD"]);
	writeFileSync(path.join(linked, "a.txt"), "linked-staged\n");
	execFileSync("git", ["add", "a.txt"], { cwd: linked });
	const expected = execFileSync("git", ["write-tree"], { cwd: linked }).toString().trim();
	const subdir = path.join(linked, "src");
	mkdirSync(subdir);
	const cp = await createCheckpoint(options(subdir));
	assert.equal(cp.indexTreeSha, expected);
	assert.notEqual(cp.indexTreeSha, EMPTY_TREE);
});

const distro = process.env.PIDECK_TEST_WSL_DISTRO;
test("#386 真实 WSL：从仓库子目录及 linked worktree 捕获非空暂存树", { skip: process.platform !== "win32" || !distro ? "需 Windows + PIDECK_TEST_WSL_DISTRO 指定已有发行版" : false }, async (t) => {
	const wsl = (args, input) => execFileSync("wsl.exe", ["-d", distro, "-e", ...args], { input, encoding: "utf8", timeout: 60000 }).trim();
	const linuxDir = wsl(["mktemp", "-d", "/tmp/pideck-rewind-XXXXXX"]);
	const hostDir = `\\\\wsl.localhost\\${distro}${linuxDir.replaceAll("/", "\\")}`;
	t.after(() => rmSync(hostDir, { recursive: true, force: true }));
	wsl(
		["/bin/sh", "-s", "--", linuxDir],
		`set -eu
cd "$1"
git init -q repo
cd repo
git config user.name test
git config user.email test@example.com
git config core.autocrlf false
git config commit.gpgsign false
printf 'head\\n' > a.txt
git add a.txt
git commit -qm init
git worktree add -qb linked-test ../linked HEAD
for dir in . ../linked; do
  (cd "$dir"; mkdir src; printf 'staged\\n' > a.txt; git add a.txt; printf 'worktree\\n' > a.txt)
done
`,
	);
	for (const name of ["repo", "linked"]) {
		const linuxRoot = `${linuxDir}/${name}/src`;
		const hostRoot = path.join(hostDir, name, "src");
		const expected = wsl(["git", "-C", linuxRoot, "write-tree"]);
		const cp = await createCheckpoint(options(hostRoot));
		assert.equal(cp.indexTreeSha, expected);
		assert.notEqual(cp.indexTreeSha, EMPTY_TREE);
	}
});
