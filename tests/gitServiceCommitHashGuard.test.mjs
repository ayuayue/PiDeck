import assert from "node:assert/strict";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const spawned = [];
const load = createTsSandbox({
  stubs: {
    "./gitProcess": {
      // 桩：记录参数并返回 dropCommit 需要的 stdout 形状；守卫失败时绝不会被调到
      runGit: async (args) => {
        spawned.push([...args]);
        return { stdout: "0".repeat(40) + "\n" };
      },
    },
    "./gitExecutable": { currentGitExecutable: () => "git" },
    "../fs/trash": { trashPath: async () => {} },
    "../rewind/checkpointConstants": { REF_BASE: "refs/pi-checkpoints" },
  },
});
const { GitService } = load("src/main/git/GitService.ts");

const BAD_HASHES = ["--exec=evil", "-x", "HEAD", "abc", "", "main", "HEAD~1", "refs/heads/main"];

test("cherryPick/revertCommit/dropCommit 拒绝非 40 位 SHA（不触达 git 层）", async () => {
  const service = new GitService();
  for (const hash of BAD_HASHES) {
    for (const method of ["cherryPick", "revertCommit", "dropCommit"]) {
      const before = spawned.length;
      await assert.rejects(
        service[method]("C:/tmp/any", hash),
        (error) => {
          assert.match(String(error?.message ?? ""), /invalid commit hash/);
          return true;
        },
        `${method} should reject ${JSON.stringify(hash)}`,
      );
      assert.equal(spawned.length, before, `${method}(${hash}) 不应触达 git 子进程`);
    }
  }
});

test("resetToCommit 拒绝非法 hash 与非法 mode", async () => {
  const service = new GitService();
  await assert.rejects(service.resetToCommit("C:/tmp/any", "--exec=evil", "soft"), (error) => {
    assert.match(String(error?.message ?? ""), /invalid commit hash/);
    return true;
  });
  await assert.rejects(service.resetToCommit("C:/tmp/any", "a".repeat(40), "--hard-evil"), (error) => {
    assert.match(String(error?.message ?? ""), /invalid reset mode/);
    return true;
  });
});

test("合法 40 位 SHA 通过守卫并抵达 git 层", async () => {
  const service = new GitService();
  await service.cherryPick("C:/tmp/any", "a".repeat(40));
  assert.deepEqual(spawned.at(-1), ["cherry-pick", "a".repeat(40)]);
  await service.resetToCommit("C:/tmp/any", "b".repeat(40), "hard");
  assert.deepEqual(spawned.at(-1), ["reset", "--hard", "b".repeat(40)]);
});
