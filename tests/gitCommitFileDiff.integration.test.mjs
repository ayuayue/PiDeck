import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";

const require = createRequire(import.meta.url);
const buildDir = mkdtempSync(join(tmpdir(), "pideck-git-service-build-"));
const repositoryDir = mkdtempSync(join(tmpdir(), "pideck-git-diff-"));
let GitService;

function git(...args) {
  return execFileSync("git", args, {
    cwd: repositoryDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(relativePath, content) {
  writeFileSync(join(repositoryDir, relativePath), content);
}

before(() => {
  // Compile only the service and its shared types so the integration test exercises
  // the real implementation without requiring a complete Electron build first.
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "src/main/git/GitService.ts",
      "src/shared/types.ts",
      "--module",
      "commonjs",
      "--target",
      "es2022",
      "--moduleResolution",
      "node",
      "--esModuleInterop",
      "--skipLibCheck",
      "--outDir",
      buildDir,
    ],
    { cwd: resolve("."), stdio: "pipe" },
  );
  ({ GitService } = require(join(buildDir, "main/git/GitService.js")));

  git("init");
  git("config", "user.name", "PiDeck Test");
  git("config", "user.email", "test@example.com");
});

after(() => {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(repositoryDir, { recursive: true, force: true });
});

describe("GitService committed-file diff integration", () => {
  test("reads root, modified, added, renamed, deleted, and merge first-parent snapshots", async () => {
    const service = new GitService();

    write("root.txt", "root v1\n");
    git("add", "--", "root.txt");
    git("commit", "-m", "root");
    const root = git("rev-parse", "HEAD");
    assert.deepEqual(await service.getCommitFileDiff(repositoryDir, root, "root.txt"), {
      path: "root.txt",
      originalContent: "",
      modifiedContent: "root v1\n",
    });

    write("root.txt", "root v2\n");
    write("new.txt", "added\n");
    git("add", "--", "root.txt", "new.txt");
    git("commit", "-m", "modify and add");
    const changed = git("rev-parse", "HEAD");
    assert.deepEqual(await service.getCommitFileDiff(repositoryDir, changed, "root.txt"), {
      path: "root.txt",
      originalContent: "root v1\n",
      modifiedContent: "root v2\n",
    });
    assert.deepEqual(await service.getCommitFileDiff(repositoryDir, changed, "new.txt"), {
      path: "new.txt",
      originalContent: "",
      modifiedContent: "added\n",
    });

    git("mv", "new.txt", "renamed.txt");
    git("commit", "-m", "rename");
    const renamed = git("rev-parse", "HEAD");
    assert.deepEqual(
      await service.getCommitFileDiff(repositoryDir, renamed, "renamed.txt", "new.txt"),
      {
        path: "renamed.txt",
        originalPath: "new.txt",
        originalContent: "added\n",
        modifiedContent: "added\n",
      },
    );
    assert.equal(await service.getCommitFileDiff(repositoryDir, renamed, "renamed.txt"), null);

    const mainBranch = git("branch", "--show-current");
    git("checkout", "-b", "feature");
    write("renamed.txt", "feature version\n");
    git("add", "--", "renamed.txt");
    git("commit", "-m", "feature change");
    git("checkout", mainBranch);
    write("main.txt", "main only\n");
    git("add", "--", "main.txt");
    git("commit", "-m", "main change");
    git("merge", "--no-ff", "feature", "-m", "merge feature");
    const merge = git("rev-parse", "HEAD");
    assert.deepEqual(await service.getCommitFileDiff(repositoryDir, merge, "renamed.txt"), {
      path: "renamed.txt",
      originalContent: "added\n",
      modifiedContent: "feature version\n",
    });

    git("rm", "--", "root.txt");
    git("commit", "-m", "delete");
    const deleted = git("rev-parse", "HEAD");
    assert.deepEqual(await service.getCommitFileDiff(repositoryDir, deleted, "root.txt"), {
      path: "root.txt",
      originalContent: "root v2\n",
      modifiedContent: "",
    });
  });

  test("reads workspace, index, untracked, deleted, and renamed snapshots lazily", async () => {
    const service = new GitService();

    write("layered.txt", "head\n");
    git("add", "--", "layered.txt");
    git("commit", "-m", "layered base");
    write("layered.txt", "staged\n");
    git("add", "--", "layered.txt");
    write("layered.txt", "working\n");

    const layeredPath = join(repositoryDir, "layered.txt");
    const layeredStatus = await service.getStatus(repositoryDir);
    assert.equal(layeredStatus.index.some((resource) => resource.path === layeredPath), true);
    assert.equal(layeredStatus.workingTree.some((resource) => resource.path === layeredPath), true);
    assert.deepEqual(await service.getWorkspaceFileDiff(repositoryDir, "index", layeredPath, 1024), {
      path: layeredPath,
      originalContent: "head\n",
      modifiedContent: "staged\n",
    });
    assert.deepEqual(await service.getWorkspaceFileDiff(repositoryDir, "workingTree", layeredPath, 1024), {
      path: layeredPath,
      originalContent: "staged\n",
      modifiedContent: "working\n",
    });
    git("reset", "--hard", "HEAD");

    write("untracked.txt", "new file\n");
    const untrackedPath = join(repositoryDir, "untracked.txt");
    assert.deepEqual(await service.getWorkspaceFileDiff(repositoryDir, "untracked", untrackedPath, 1024), {
      path: untrackedPath,
      originalContent: "",
      modifiedContent: "new file\n",
    });
    rmSync(untrackedPath);

    write("deleted.txt", "before delete\n");
    git("add", "--", "deleted.txt");
    git("commit", "-m", "deleted base");
    const deletedPath = join(repositoryDir, "deleted.txt");
    rmSync(deletedPath);
    assert.deepEqual(await service.getWorkspaceFileDiff(repositoryDir, "workingTree", deletedPath, 1024), {
      path: deletedPath,
      originalContent: "before delete\n",
      modifiedContent: "",
    });
    git("add", "--", "deleted.txt");
    assert.deepEqual(await service.getWorkspaceFileDiff(repositoryDir, "index", deletedPath, 1024), {
      path: deletedPath,
      originalContent: "before delete\n",
      modifiedContent: "",
    });
    git("reset", "--hard", "HEAD");

    write("rename-source.txt", "rename body\n");
    git("add", "--", "rename-source.txt");
    git("commit", "-m", "rename base");
    git("mv", "rename-source.txt", "rename-target.txt");
    write("rename-target.txt", "rename body plus working edit\n");
    const sourcePath = join(repositoryDir, "rename-source.txt");
    const targetPath = join(repositoryDir, "rename-target.txt");
    const renameStatus = await service.getStatus(repositoryDir);
    const renameResource = renameStatus.index.find((resource) => resource.path === targetPath);
    const renameWorkingResource = renameStatus.workingTree.find((resource) => resource.path === targetPath);
    assert.equal(renameResource?.oldPath, sourcePath);
    assert.equal(renameWorkingResource?.oldPath, undefined);
    assert.deepEqual(await service.getWorkspaceFileDiff(repositoryDir, "index", targetPath, 1024), {
      path: targetPath,
      originalContent: "rename body\n",
      modifiedContent: "rename body\n",
    });
    assert.deepEqual(await service.getWorkspaceFileDiff(repositoryDir, "workingTree", targetPath, 1024), {
      path: targetPath,
      originalContent: "rename body\n",
      modifiedContent: "rename body plus working edit\n",
    });
    await service.unstageFiles(repositoryDir, [targetPath]);
    assert.equal((await service.getStatus(repositoryDir)).index.length, 0);
    git("reset", "--hard", "HEAD");
    rmSync(targetPath, { force: true });
  });

  test("scopes nested projects and rejects oversized or binary workspace files", async () => {
    const service = new GitService();
    mkdirSync(join(repositoryDir, "nested"), { recursive: true });
    mkdirSync(join(repositoryDir, "sibling"), { recursive: true });
    write("nested/inside.txt", "inside\n");
    write("sibling/outside.txt", "outside\n");
    git("add", "--", "nested/inside.txt", "sibling/outside.txt");
    git("commit", "-m", "nested base");
    write("nested/inside.txt", "inside changed\n");
    write("sibling/outside.txt", "outside changed\n");

    const nestedRoot = join(repositoryDir, "nested");
    const insidePath = join(nestedRoot, "inside.txt");
    const outsidePath = join(repositoryDir, "sibling", "outside.txt");
    const scopedStatus = await service.getStatus(nestedRoot);
    assert.deepEqual(scopedStatus.workingTree.map((resource) => resource.path), [insidePath]);
    await assert.rejects(() => service.stageFiles(nestedRoot, [outsidePath]));
    assert.equal(await service.getWorkspaceFileDiff(nestedRoot, "workingTree", insidePath, 4), null);

    writeFileSync(join(nestedRoot, "binary"), Buffer.from([0, 1, 2, 3]));
    assert.equal(
      await service.getWorkspaceFileDiff(nestedRoot, "untracked", join(nestedRoot, "binary"), 1024),
      null,
    );
    git("reset", "--hard", "HEAD");
    rmSync(join(nestedRoot, "binary"), { force: true });
  });

  test("stages resolved merge conflicts and preserves the Git drawer diff baseline", async () => {
    const service = new GitService();
    write("conflict.txt", "base\n");
    git("add", "--", "conflict.txt");
    git("commit", "-m", "conflict base");
    const mainBranch = git("branch", "--show-current");
    git("checkout", "-b", "pideck-conflict-test");
    write("conflict.txt", "theirs\n");
    git("add", "--", "conflict.txt");
    git("commit", "-m", "theirs");
    git("checkout", mainBranch);
    write("conflict.txt", "ours\n");
    git("add", "--", "conflict.txt");
    git("commit", "-m", "ours");
    try {
      git("merge", "pideck-conflict-test");
      assert.fail("merge should conflict");
    } catch {
      // Expected content conflict.
    }

    const conflictPath = join(repositoryDir, "conflict.txt");
    const conflictStatus = await service.getStatus(repositoryDir);
    assert.equal(conflictStatus.merge.some((resource) => resource.path === conflictPath), true);
    const conflictDiff = await service.getWorkspaceFileDiff(repositoryDir, "merge", conflictPath, 4096);
    assert.equal(conflictDiff?.originalContent, "ours\n");
    assert.match(conflictDiff?.modifiedContent ?? "", /<<<<<<< HEAD/);
    await service.stageFiles(repositoryDir, [conflictPath]);
    assert.equal((await service.getStatus(repositoryDir)).merge.length, 0);
    git("merge", "--abort");
    git("branch", "-D", "pideck-conflict-test");
  });

  test("does not follow workspace symlinks outside the project", async (context) => {
    const service = new GitService();
    const externalDir = mkdtempSync(join(tmpdir(), "pideck-external-"));
    const externalPath = join(externalDir, "secret.txt");
    const linkPath = join(repositoryDir, "external-link");
    writeFileSync(externalPath, "must not be read\n");
    try {
      try {
        symlinkSync(externalPath, linkPath, "file");
      } catch {
        context.skip("File symlinks are unavailable on this Windows environment");
        return;
      }
      const diff = await service.getWorkspaceFileDiff(repositoryDir, "untracked", linkPath, 4096);
      assert.equal(diff?.originalContent, "");
      assert.equal(diff?.modifiedContent, externalPath);
      assert.notEqual(diff?.modifiedContent, "must not be read\n");
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  test("unstages files in an unborn repository without deleting the worktree file", async () => {
    const service = new GitService();
    const unbornDir = mkdtempSync(join(tmpdir(), "pideck-unborn-"));
    const unbornGit = (...args) => execFileSync("git", args, {
      cwd: unbornDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    try {
      unbornGit("init");
      const filePath = join(unbornDir, "first.txt");
      writeFileSync(filePath, "first\n");
      await service.stageFiles(unbornDir, [filePath]);
      assert.equal((await service.getStatus(unbornDir)).index.length, 1);
      await service.unstageFiles(unbornDir, [filePath]);
      const status = await service.getStatus(unbornDir);
      assert.equal(status.index.length, 0);
      assert.equal(status.untracked.some((resource) => resource.path === filePath), true);
      assert.equal(existsSync(filePath), true);
    } finally {
      rmSync(unbornDir, { recursive: true, force: true });
    }
  });

  test("discards only the requested unstaged layer and deletes exact untracked files", async () => {
    const service = new GitService();

    write("discard-layered.txt", "head\n");
    write("discard-deleted.txt", "restore me\n");
    git("add", "--", "discard-layered.txt", "discard-deleted.txt");
    git("commit", "-m", "discard base");

    write("discard-layered.txt", "staged\n");
    git("add", "--", "discard-layered.txt");
    write("discard-layered.txt", "working\n");
    const layeredPath = join(repositoryDir, "discard-layered.txt");
    await service.discardFile(repositoryDir, "workingTree", layeredPath);
    assert.equal(execFileSync("git", ["show", ":discard-layered.txt"], { cwd: repositoryDir, encoding: "utf8" }), "staged\n");
    assert.equal(readFileSync(layeredPath, "utf8"), "staged\n");
    assert.equal((await service.getStatus(repositoryDir)).index.some((resource) => resource.path === layeredPath), true);

    const deletedPath = join(repositoryDir, "discard-deleted.txt");
    rmSync(deletedPath);
    await service.discardFile(repositoryDir, "workingTree", deletedPath);
    assert.equal(existsSync(deletedPath), true);

    write("discard-untracked.txt", "temporary\n");
    const untrackedPath = join(repositoryDir, "discard-untracked.txt");
    await service.discardFile(repositoryDir, "untracked", untrackedPath);
    assert.equal(existsSync(untrackedPath), false);
    await assert.rejects(() => service.discardFile(repositoryDir, "untracked", untrackedPath));

    git("reset", "--hard", "HEAD");
  });

  test("keeps discard scoped to the active nested project", async () => {
    const service = new GitService();
    mkdirSync(join(repositoryDir, "discard-nested"), { recursive: true });
    mkdirSync(join(repositoryDir, "discard-sibling"), { recursive: true });
    write("discard-nested/inside.txt", "inside\n");
    write("discard-sibling/outside.txt", "outside\n");
    git("add", "--", "discard-nested/inside.txt", "discard-sibling/outside.txt");
    git("commit", "-m", "discard scope base");
    write("discard-nested/inside.txt", "inside changed\n");
    write("discard-sibling/outside.txt", "outside changed\n");

    const nestedRoot = join(repositoryDir, "discard-nested");
    const insidePath = join(nestedRoot, "inside.txt");
    const outsidePath = join(repositoryDir, "discard-sibling", "outside.txt");
    await assert.rejects(() => service.discardFile(nestedRoot, "workingTree", outsidePath));
    await service.discardFile(nestedRoot, "workingTree", insidePath);
    assert.equal(readFileSync(insidePath, "utf8"), "inside\n");
    assert.equal(readFileSync(outsidePath, "utf8"), "outside changed\n");
    git("reset", "--hard", "HEAD");
  });

  test("handles a staged rename with an unstaged edit using only the current worktree path", async () => {
    const service = new GitService();
    write("rename-discard-source.txt", "rename head\n");
    git("add", "--", "rename-discard-source.txt");
    git("commit", "-m", "rename discard base");
    git("mv", "rename-discard-source.txt", "rename-discard-target.txt");
    write("rename-discard-target.txt", "rename working\n");

    const targetPath = join(repositoryDir, "rename-discard-target.txt");
    await service.discardFile(repositoryDir, "workingTree", targetPath);
    assert.equal(readFileSync(targetPath, "utf8"), "rename head\n");
    write("rename-discard-target.txt", "rename staged update\n");
    await service.stageFiles(repositoryDir, [targetPath]);
    assert.equal(execFileSync("git", ["show", ":rename-discard-target.txt"], { cwd: repositoryDir, encoding: "utf8" }), "rename staged update\n");
    git("reset", "--hard", "HEAD");
    rmSync(targetPath, { force: true });
  });

  test("treats stage and unstage paths literally", async () => {
    const service = new GitService();
    write("literal[ab].txt", "literal head\n");
    write("literala.txt", "a head\n");
    write("literalb.txt", "b head\n");
    git("add", "--", "literal[ab].txt", "literala.txt", "literalb.txt");
    git("commit", "-m", "literal base");
    write("literal[ab].txt", "literal changed\n");
    write("literala.txt", "a changed\n");
    write("literalb.txt", "b changed\n");

    const literalPath = join(repositoryDir, "literal[ab].txt");
    await service.stageFiles(repositoryDir, [literalPath]);
    assert.deepEqual(git("diff", "--cached", "--name-only").split(/\r?\n/).filter(Boolean), ["literal[ab].txt"]);
    await service.unstageFiles(repositoryDir, [literalPath]);
    assert.equal(git("diff", "--cached", "--name-only"), "");
    git("reset", "--hard", "HEAD");
  });

  test("resolves refs before git show and rejects option-like input", async () => {
    const service = new GitService();
    const injectedOutput = join(repositoryDir, "should-not-exist.patch");
    assert.equal(await service.getCommitDetail(repositoryDir, `--output=${injectedOutput}`), null);
    assert.deepEqual(
      await service.getCommitLog(repositoryDir, { ref: `--output=${injectedOutput}` }),
      [],
    );
    assert.deepEqual(
      await service.compareBranches(repositoryDir, `--output=${injectedOutput}`, "HEAD"),
      { files: [], ahead: 0, behind: 0 },
    );
    assert.equal(
      await service.diffFileBetweenRefs(repositoryDir, `--output=${injectedOutput}`, "HEAD", "root.txt"),
      "",
    );
    const currentBranch = git("branch", "--show-current");
    await assert.rejects(() => service.checkout(repositoryDir, "--detach"));
    await assert.rejects(() => service.checkout(repositoryDir, `${currentBranch}~1`));
    await assert.rejects(() => service.checkout(repositoryDir, `${currentBranch}^{commit}`));
    await assert.rejects(() => service.createBranch(repositoryDir, "--bad"));
    assert.equal(git("branch", "--show-current"), currentBranch);
    assert.equal(existsSync(injectedOutput), false);
  });
});
