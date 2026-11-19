import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const oid = (char) => char.repeat(40);
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * T7（v5 §10.4）：公共 Git 面按**能力组**迁移。
 *
 * 这一组钉住三个新入口的语义分界：
 * - 仓库列表保留 `truncated` 与 revision/generation，不退回裸数组；
 * - 历史页显式分页：远端 HEAD-only 时没有 `totalCount`，本地保留 ref/path/allBranches 与总数；
 * - 比较必须显式 `mode`：本地是三点（merge-base，带 ahead/behind），远端是两树（trees，缺席 ahead/behind）。
 */
function harness() {
	const handlers = new Map();
	const calls = [];
	const tmp = mkdtempSync(join(tmpdir(), "pideck-git-page-"));
	const localProject = { id: "p-local", path: tmp, name: "local" };
	const remoteProject = { id: "p-remote", name: "remote", locator: { kind: "ssh", hostId: "11111111-1111-4111-8111-111111111111", remotePath: "/srv/app" } };
	const projects = new Map([
		[localProject.id, localProject],
		[remoteProject.id, remoteProject],
	]);
	const commitEntry = (index) => ({
		hash: oid(String(index)),
		shortHash: String(index).repeat(7),
		message: `subject ${index}`,
		authorName: "Fixture",
		authorEmail: "fixture@example.invalid",
		authorDate: 1_700_000_000_000 + index,
		parents: [],
		refNames: ["HEAD -> main"],
		graph: ["*"],
	});
	const gitService = {
		async getCommitLog(_cwd, options) {
			calls.push({ kind: "commitLog", options });
			return [commitEntry(1), commitEntry(2)];
		},
		async getCommitCount(_cwd, options) {
			calls.push({ kind: "commitCount", options });
			return 5;
		},
		async resolveRefOid(_cwd, ref) {
			return ref === "main" ? oid("a") : ref === "feature" ? oid("b") : null;
		},
		async compareBranches(_cwd, base, head) {
			calls.push({ kind: "compare", base, head });
			return { files: [{ path: "a.txt", status: "modified", originalPath: "old.txt" }], ahead: 2, behind: 1 };
		},
	};
	const remoteGitReads = {
		async repositoryListing(_event, projectId) {
			calls.push({ kind: "remoteRepositoryListing", projectId });
			return { ok: true, value: { repos: [{ target: { projectId, relativePath: "packages/a" }, relativePath: "packages/a", displayPath: "a", name: "a" }], truncated: true, revision: 7, generation: "conn-1" } };
		},
		async historyPage(_event, projectId, options) {
			calls.push({ kind: "remoteHistory", projectId, options });
			return { ok: true, value: { commits: [{ oid: oid("c"), parents: [], subject: "one", authorName: "F", authorEmail: "f@e.invalid", authorTimeMs: 1 }], hasMore: true } };
		},
		async compareRefs(_event, projectId, base, head) {
			calls.push({ kind: "remoteCompare", projectId, base, head });
			return { ok: true, value: { mode: "trees", base: { ref: base, oid: oid("a") }, head: { ref: head, oid: oid("b") }, files: [{ status: "M", path: "a.txt" }] } };
		},
	};
	const { registerGitIpc } = loadTsCommonJs("src/main/ipc/gitIpc.ts", {
		stubs: {
			electron: {
				ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: () => undefined, removeHandler: () => undefined },
				dialog: { showMessageBox: async () => ({ response: 0 }) },
			},
		},
	});
	registerGitIpc({
		appLogger: { warn: () => {}, info: () => {}, error: () => {} },
		mainCopy: (key) => key,
		gitService,
		gitRefsWatcher: { on: () => () => undefined, dispose: () => undefined },
		getMainWindow: () => null,
		piLocator: {},
		projectStore: { get: (id) => projects.get(id), list: () => [...projects.values()] },
		settingsStore: { get: () => ({}) },
		worktreeService: {},
		remoteGitReads,
	});
	const event = { sender: new EventEmitter() };
	return { handlers, calls, event, localProject, remoteProject, tmp };
}

const call = (h, channel, ...args) => h.handlers.get(channel)(h.event, ...args);

test("公共仓库列表：本地不截断、远端保留 truncated；两者都带 revision/generation", async () => {
	const h = harness();
	try {
		const local = await call(h, "git:repository-list", h.localProject.id);
		assert.equal(local.ok, true);
		assert.equal(local.value.truncated, false);
		assert.equal(local.value.generation, "local");
		assert.ok(local.value.revision > 0);
		assert.ok(Array.isArray(local.value.repos));

		const remote = await call(h, "git:repository-list", h.remoteProject.id);
		assert.equal(remote.ok, true);
		assert.equal(remote.value.truncated, true, "helper 的 truncated 不在归一化时丢失");
		assert.equal(remote.value.generation, "conn-1");
		assert.deepEqual(plain(remote.value.repos[0].target), { projectId: h.remoteProject.id, relativePath: "packages/a" });
	} finally {
		rmSync(h.tmp, { recursive: true, force: true });
	}
});

test("公共历史页：本地分页 + totalCount；远端 ref/全部分支/总数按 helper 参数透传，path 显式拒绝", async () => {
	const h = harness();
	try {
		const local = await call(h, "git:history-page", h.localProject.id, { maxCount: 2, skip: 1 });
		assert.equal(local.ok, true);
		assert.equal(local.value.commits.length, 2);
		assert.equal(local.value.totalCount, 5);
		assert.equal(local.value.hasMore, true, "5 > skip 1 + 2");
		assert.equal(local.value.commits[0].oid, oid("1"));
		assert.equal(local.value.commits[0].graph[0], "*", "本地图谱字段保留");
		assert.equal(h.calls.find((entry) => entry.kind === "commitLog").options.skip, 1);

		const remote = await call(h, "git:history-page", h.remoteProject.id, { maxCount: 10 });
		assert.equal(remote.ok, true);
		assert.equal(remote.value.hasMore, true);
		assert.equal("totalCount" in remote.value, false, "远端没有总数，不能填 0");
		assert.deepEqual(plain(remote.value.commits[0]), { oid: oid("c"), parents: [], subject: "one", authorName: "F", authorEmail: "f@e.invalid", authorTimeMs: 1 });

		// ref/全部分支/总数都有对应 helper 参数：原样透传，不静默吞掉。
		const filtered = await call(h, "git:history-page", h.remoteProject.id, { ref: "refs/heads/main", allBranches: false, withTotal: true });
		assert.equal(filtered.ok, true);
		const remoteOptions = h.calls.filter((entry) => entry.kind === "remoteHistory").at(-1).options;
		assert.equal(remoteOptions.ref, "refs/heads/main");
		assert.equal(remoteOptions.all, false);
		assert.equal(remoteOptions.withCount, true);
		// path 没有 helper 参数：拒绝而不是静默丢掉。
		const withPath = await call(h, "git:history-page", h.remoteProject.id, { path: { projectId: h.remoteProject.id, relativePath: "a.ts" } });
		assert.equal(withPath.ok, false);
		assert.equal(withPath.code, "UNSUPPORTED_CAPABILITY", "远端不支持 path 过滤时必须拒绝，不能静默丢掉参数");
	} finally {
		rmSync(h.tmp, { recursive: true, force: true });
	}
});

test("公共比较：本地 merge-base 带 ahead/behind；远端 trees 不带（不填 0）", async () => {
	const h = harness();
	try {
		const local = await call(h, "git:compare-refs", h.localProject.id, "main", "feature");
		assert.equal(local.ok, true);
		assert.equal(local.value.mode, "merge-base");
		assert.deepEqual({ base: local.value.base.oid, head: local.value.head.oid }, { base: oid("a"), head: oid("b") });
		assert.equal(local.value.ahead, 2);
		assert.equal(local.value.behind, 1);
		assert.deepEqual(plain(local.value.files), [{ status: "modified", path: "a.txt", oldPath: "old.txt" }]);

		const remote = await call(h, "git:compare-refs", h.remoteProject.id, "refs/heads/main", "refs/heads/feature");
		assert.equal(remote.ok, true);
		assert.equal(remote.value.mode, "trees");
		assert.equal("ahead" in remote.value, false, "远端没有 ahead/behind，不能填 0");
		assert.equal("behind" in remote.value, false);
		assert.deepEqual(plain(remote.value.base), { ref: "refs/heads/main", oid: oid("a") });

		const missing = await call(h, "git:compare-refs", h.localProject.id, "main", "gone");
		assert.equal(missing.ok, false);
		assert.equal(missing.code, "GIT_REF_NOT_FOUND");
	} finally {
		rmSync(h.tmp, { recursive: true, force: true });
	}
});
