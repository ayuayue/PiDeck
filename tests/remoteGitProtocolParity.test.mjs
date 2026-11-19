/**
 * 远端 Git 读协议的形状一致性（git.log 的 ref/all/withCount、commitDetail 的行数、compare 的三点模式、
 * stagedDiff）。这里分三层证明同一件事，任何一层单独都不够：
 *
 * 1. 冻结 worker 的 `prepare`：参数校验与归一化结果。它会在任何 Git 子进程之前跑，所以平台无关；
 * 2. main 侧的结果解析：helper 多给的字段只有在被请求时存在，缺席不等于 0，形状不符即拒；
 * 3. 冻结源码与契约的字面量：capability / repo scope 列表、argv、上限标记，两处必须逐字一致。
 *
 * 真实仓库上的端到端行为由 tests/remoteGitHistory.test.mjs、tests/remoteGitCompare.test.mjs 承担（Linux）；
 * 这里补一条 Linux-only 的 stagedDiff/计数/行数用例，避免新增命令只在自己写的解析里转圈。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { fixture, options, successful } from "./helpers/remoteGitFixture.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { materializeRemoteHelperArtifacts } from "./helpers/remoteHelperArtifacts.mjs";

const CONTRACT = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { REMOTE_HELPER_CAPABILITIES } = loadTsCommonJs("src/main/remote/RemoteHelperCapabilities.ts");
const { REMOTE_HELPER_INLINE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const { REMOTE_GIT_READ_SOURCE } = loadTsCommonJs("src/main/remote/RemoteGitReadSource.ts");
const { readRemoteGitCommitDetail, readRemoteGitCompare, readRemoteGitLog, validateRemoteGitRefFullName } = loadTsCommonJs("src/main/git/RemoteGitService.ts");

const ROOT = "/srv/pideck-parity-root";
const OID = (letter) => letter.repeat(40);
/** 结果来自测试 VM 里的模块，跨 realm 的对象只能按结构比较。 */
const plain = (value) => JSON.parse(JSON.stringify(value));
const oid = (letter) => OID(letter);

/** The frozen worker as the deploy bundle ships it: git-read.mjs plus the siblings it imports. */
function loadFrozenProgram(t) {
	const directory = mkdtempSync(path.join(tmpdir(), "pideck-git-read-parity-"));
	t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
	materializeRemoteHelperArtifacts(directory);
	return import(pathToFileURL(path.join(directory, "git-read.mjs")).href).then((module) => module.createGitReadProgram(ROOT, fs, path));
}

function codeOf(fn) {
	try {
		fn();
	} catch (error) {
		return error.message;
	}
	return null;
}

/** `prepare` is the acceptance face every Git request crosses before a child exists; it is pure on every platform. */
function prepare(program, method, params, repo) {
	return program.prepare(method, params, repo);
}

// ── The two capability/scope vocabularies cannot drift apart ─────────────────────────────────────

test("git.stagedDiff is advertised, dispatched and repo-scoped in exactly the contract's order", () => {
	assert.ok(REMOTE_HELPER_CAPABILITIES.includes("git.stagedDiff"), "the contract advertises the new read");
	// The frozen entry repeats the vocabulary literally; the hello response is that literal.
	const frozen = /const CAPABILITIES = \[([^\]]*)\]/.exec(REMOTE_HELPER_INLINE_SOURCE);
	assert.ok(frozen, "the frozen entry must keep its capability literal");
	assert.deepEqual(
		Array.from(frozen[1].matchAll(/"([^"]+)"/g), (match) => match[1]),
		[...REMOTE_HELPER_CAPABILITIES],
		"helper capability order must equal the contract's",
	);
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes('frame.method === "git.stagedDiff"'), "the entry dispatches it");
	// Read scope: contract list, entry REPO_METHODS (read half) and worker READ_REPO must be the same sequence.
	assert.ok(CONTRACT.REMOTE_GIT_REPO_READ_METHODS.includes("git.stagedDiff"));
	const repoMethods = /const REPO_METHODS = new Set\(\[([^\]]*)\]\);/.exec(REMOTE_HELPER_INLINE_SOURCE);
	assert.ok(repoMethods, "the entry must keep its scope list");
	assert.deepEqual(
		Array.from(repoMethods[1].matchAll(/"([^"]+)"/g), (match) => match[1]),
		[...CONTRACT.REMOTE_GIT_REPO_READ_METHODS, ...CONTRACT.REMOTE_GIT_REPO_WRITE_METHODS],
		"the entry's scope list must equal the contract's read + write lists",
	);
	const readRepo = /const READ_REPO = new Set\(\[([^\]]*)\]\)/.exec(REMOTE_GIT_READ_SOURCE);
	assert.ok(readRepo, "the frozen worker must keep its read scope list");
	assert.deepEqual(
		Array.from(readRepo[1].matchAll(/"([^"]+)"/g), (match) => match[1]),
		[...CONTRACT.REMOTE_GIT_REPO_READ_METHODS],
		"the worker's read scope list must equal the contract's",
	);
});

test("the four commit-graph write verbs are advertised, dispatched, scoped and run the local commands", () => {
	const { REMOTE_GIT_WRITE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteGitWriteSource.ts");
	const verbs = ["git.cherryPick", "git.revert", "git.reset", "git.drop"];
	for (const verb of verbs) {
		assert.ok(REMOTE_HELPER_CAPABILITIES.includes(verb), `${verb} must be advertised`);
		assert.ok(CONTRACT.REMOTE_GIT_REPO_WRITE_METHODS.includes(verb), `${verb} must be repo-scoped`);
		assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(`frame.method === "${verb}"`), `${verb} must be dispatched`);
	}
	// 能力表顺序是线上事实：四条必须连续且同序，否则旧 helper 的前缀比较会错位。
	// 跨 realm 的数组只能按序列化比较（prototype 不同）。
	const at = REMOTE_HELPER_CAPABILITIES.indexOf("git.cherryPick");
	assert.equal(JSON.stringify(REMOTE_HELPER_CAPABILITIES.slice(at, at + 4)), JSON.stringify(verbs));
	// 冻结写程序跑的就是本机 GitService 跑的那几条命令。
	for (const literal of ['["cherry-pick", hash]', '["revert", "--no-edit", hash]', '["reset", "--" + mode, hash]', '["rebase", "--onto", parent, hash]']) {
		assert.ok(REMOTE_GIT_WRITE_SOURCE.includes(literal), `the frozen writer must run ${literal}`);
	}
	// 冲突不留在远端：sequencer 状态在这里无法解决，会挡住之后所有受管写。
	assert.ok(REMOTE_GIT_WRITE_SOURCE.includes('[verb, "--abort"]'), "a conflicted pick or rewrite must be aborted");
	// 身份显式注入：私有元数据上下文隐藏全局配置，不注入就只会得到 Committer identity unknown。
	assert.ok(REMOTE_GIT_WRITE_SOURCE.includes('"user.name=" + who.name'), "the committer name must be injected");
	assert.ok(REMOTE_GIT_WRITE_SOURCE.includes('"user.email=" + who.email'), "the committer email must be injected");
	// 令牌种类与回执形状在 main 侧各有独立单元测试（tests/remoteGitHistoryVerbs.test.mjs）。
	assert.equal(JSON.stringify([...loadTsCommonJs("src/main/remote/RemoteGitHistoryContract.ts").REMOTE_GIT_HISTORY_METHODS]), JSON.stringify(verbs));
});

test("the frozen read commands are the ones the contract and the local panel use", () => {
	for (const literal of ['["rev-list", "--count"]', '"--numstat"', '"--staged", "--unified=3", "--no-color", "--no-ext-diff"', '"merge-base"', '"--diff-filter=ADMR"']) {
		assert.ok(REMOTE_GIT_READ_SOURCE.includes(literal), `the frozen worker must run ${literal}`);
	}
	assert.equal(CONTRACT.REMOTE_GIT_STAGED_DIFF_MAX_CHARS, 100 * 1024, "the local read and the helper keep one 100 KiB bound");
	assert.ok(REMOTE_GIT_READ_SOURCE.includes(`MAX_STAGED_DIFF = ${CONTRACT.REMOTE_GIT_STAGED_DIFF_MAX_CHARS}`), "the helper literal must equal the contract constant");
	assert.ok(REMOTE_GIT_READ_SOURCE.includes(`"${CONTRACT.REMOTE_GIT_STAGED_DIFF_TRUNCATION_MARKER.replace(/\n/g, "\\n")}"`), "the truncation marker must be the same text on both sides");
});

// ── git.log: one filter, an optional count ──────────────────────────────────────────────────────

test("git.log accepts a full local ref or --all, never both, and normalizes the defaults", async (t) => {
	const program = await loadFrozenProgram(t);
	assert.deepEqual(prepare(program, "git.log", {}), { method: "git.log", maxCount: 50, skip: 0, ref: null, all: false, withCount: false });
	assert.deepEqual(prepare(program, "git.log", { maxCount: 10, skip: 20, ref: "refs/heads/main" }), { method: "git.log", maxCount: 10, skip: 20, ref: "refs/heads/main", all: false, withCount: false });
	assert.deepEqual(prepare(program, "git.log", { all: true, withCount: true }), { method: "git.log", maxCount: 50, skip: 0, ref: null, all: true, withCount: true });
	for (const params of [
		{ ref: "HEAD" },
		{ ref: "refs/remotes/origin/main" },
		{ ref: "refs/heads/-x" },
		{ ref: "refs/heads/a b" },
		{ ref: 7 },
		{ all: "yes" },
		{ withCount: 1 },
		{ all: true, ref: "refs/tags/v1.0" },
		{ all: false, ref: "refs/tags/v1.0", mode: "trees" },
		{ skip: -1 },
		{ maxCount: 0 },
		{ maxCount: 101 },
	]) {
		assert.equal(
			codeOf(() => prepare(program, "git.log", params)),
			"GIT_RESULT_INVALID",
			JSON.stringify(params),
		);
	}
	// No parameter at all is still the old HEAD page, so an older caller keeps its exact request.
	assert.equal(prepare(program, "git.log", undefined).all, false);
});

test("the helper's ref rule and the main-process copy agree on every shape", async (t) => {
	const program = await loadFrozenProgram(t);
	const refs = [
		"refs/heads/main",
		"refs/heads/feature/x",
		"refs/heads/ünïcode",
		"refs/tags/v1.0",
		"refs/tags/release/2026-01",
		"HEAD",
		"refs/remotes/origin/main",
		"refs/heads/-x",
		"refs/heads/@",
		"refs/tags/v1.0{}",
		"refs/heads/a b",
		"refs/heads/x..y",
		"refs/heads/x@{1}",
		"refs/heads/x.lock",
		"refs/heads/.hidden",
		"refs/heads/master/",
		"refs/heads//master",
		"refs/heads/",
		"refs/heads/" + "x".repeat(1100),
		"refs/heads/a\u0000b",
		"-refs/heads/main",
	];
	for (const ref of refs) {
		const helper = codeOf(() => prepare(program, "git.log", { ref })) === null;
		const main = codeOf(() => validateRemoteGitRefFullName(ref)) === null;
		assert.equal(helper, main, `${JSON.stringify(ref.slice(0, 40))}: helper ${helper}, main ${main}`);
	}
});

// ── git.compare: explicit tree vs three-dot semantics ───────────────────────────────────────────

test("git.compare names its semantics and refuses an unknown or extra one", async (t) => {
	const program = await loadFrozenProgram(t);
	assert.deepEqual(prepare(program, "git.compare", { base: "refs/heads/main", head: "refs/tags/v1.0" }), { method: "git.compare", base: "refs/heads/main", head: "refs/tags/v1.0", mode: "trees" });
	assert.equal(prepare(program, "git.compare", { base: "refs/heads/main", head: "refs/tags/v1.0", mode: "threeDot" }).mode, "threeDot");
	for (const params of [{ base: "refs/heads/main" }, { base: "refs/heads/main", head: "refs/tags/v1.0", mode: "merge-base" }, { base: "refs/heads/main", head: "refs/tags/v1.0", path: "a.txt" }, { base: "HEAD", head: "refs/tags/v1.0" }]) {
		assert.equal(
			codeOf(() => prepare(program, "git.compare", params)),
			"GIT_RESULT_INVALID",
			JSON.stringify(params),
		);
	}
});

// ── git.stagedDiff: no parameter, repo scope only ──────────────────────────────────────────────

test("git.stagedDiff takes no parameter and accepts the repository scope", async (t) => {
	const program = await loadFrozenProgram(t);
	assert.deepEqual(prepare(program, "git.stagedDiff", {}), { method: "git.stagedDiff" });
	assert.deepEqual(prepare(program, "git.stagedDiff", undefined), { method: "git.stagedDiff" });
	assert.deepEqual(prepare(program, "git.stagedDiff", {}, "packages/a"), { method: "git.stagedDiff" });
	for (const params of [{ path: "a.txt" }, { staged: true }, { diff: "" }])
		assert.equal(
			codeOf(() => prepare(program, "git.stagedDiff", params)),
			"GIT_RESULT_INVALID",
			JSON.stringify(params),
		);
	// Root-only methods still refuse the scope: the new read must not widen them.
	assert.equal(
		codeOf(() => prepare(program, "git.init", {}, "packages/a")),
		"GIT_RESULT_INVALID",
	);
});

// ── main-side result shapes ─────────────────────────────────────────────────────────────────────

const COMMIT = (letter, subject = "subject") => ({ oid: oid(letter), parents: [], authorName: "A", authorEmail: "a@e", authorTimeSec: 1, subject });

test("a log page carries total only when it was asked for, and never invents 0", () => {
	const page = { commits: [COMMIT("a")], hasMore: false };
	assert.deepEqual(plain(readRemoteGitLog(page)), { commits: [COMMIT("a")], hasMore: false });
	assert.deepEqual(plain(readRemoteGitLog({ ...page, total: 7 }, true)), { commits: [COMMIT("a")], hasMore: false, total: 7 });
	assert.equal("total" in readRemoteGitLog(page), false, "an uncounted page has no total field");
	// The request and the answer must agree: a total nobody asked for, or a missing one, is a shape error.
	assert.equal(
		codeOf(() => readRemoteGitLog({ ...page, total: 7 })),
		"GIT_RESULT_INVALID",
	);
	assert.equal(
		codeOf(() => readRemoteGitLog(page, true)),
		"GIT_RESULT_INVALID",
	);
	assert.equal(
		codeOf(() => readRemoteGitLog({ ...page, total: -1 }, true)),
		"GIT_RESULT_INVALID",
	);
	assert.equal(
		codeOf(() => readRemoteGitLog({ ...page, total: 1.5 }, true)),
		"GIT_RESULT_INVALID",
	);
	assert.equal(
		codeOf(() => readRemoteGitLog({ ...page, total: 0 }, true)),
		"GIT_RESULT_INVALID",
		"a total can never be smaller than the page it describes",
	);
});

const DETAIL = (files, extra = {}) => ({ oid: oid("a"), parents: [], authorName: "A", authorEmail: "a@e", authorTimeSec: 1, committerName: "A", committerEmail: "a@e", committerTimeSec: 1, subject: "subject", message: "subject\n", files, ...extra });

test("commit detail accepts line counts and the short stat, and refuses half a count", () => {
	const legacy = readRemoteGitCommitDetail(DETAIL([{ status: "M", path: "a.txt" }]));
	assert.equal("shortStat" in legacy, false);
	assert.equal(legacy.files[0].additions, undefined, "an uncounted file has no additions field, not 0");

	const counted = readRemoteGitCommitDetail(
		DETAIL(
			[
				{ status: "R100", path: "sub/b.txt", oldPath: "sub/a.txt", additions: 2, deletions: 3 },
				{ status: "A", path: "c.bin" },
			],
			{ shortStat: { files: 2, insertions: 2, deletions: 3 } },
		),
		"packages/app",
	);
	assert.deepEqual(plain(counted.files), [
		{ status: "R100", path: "packages/app/sub/b.txt", oldPath: "packages/app/sub/a.txt", additions: 2, deletions: 3 },
		{ status: "A", path: "packages/app/c.bin" },
	]);
	assert.deepEqual(plain(counted.shortStat), { files: 2, insertions: 2, deletions: 3 });

	// A binary record is absent on both sides; one number without the other is not a shape this protocol sends.
	assert.equal(
		codeOf(() => readRemoteGitCommitDetail(DETAIL([{ status: "A", path: "c.bin", additions: 1 }]))),
		"GIT_RESULT_INVALID",
	);
	assert.equal(
		codeOf(() => readRemoteGitCommitDetail(DETAIL([{ status: "M", path: "a.txt", additions: -1, deletions: 0 }]))),
		"GIT_RESULT_INVALID",
	);
	// The short stat describes the same list: a mismatch means the two reads disagreed.
	assert.equal(
		codeOf(() => readRemoteGitCommitDetail(DETAIL([{ status: "M", path: "a.txt", additions: 1, deletions: 0 }], { shortStat: { files: 2, insertions: 1, deletions: 0 } }))),
		"GIT_RESULT_INVALID",
	);
	assert.equal(
		codeOf(() => readRemoteGitCommitDetail(DETAIL([{ status: "M", path: "a.txt" }], { shortStat: { files: 1, insertions: 0 } }))),
		"GIT_RESULT_INVALID",
	);
});

test("compare answers two-dot for trees and merge-base with ahead/behind for threeDot", () => {
	const trees = { base: { ref: "refs/heads/main", oid: oid("a") }, head: { ref: "refs/heads/topic", oid: oid("b") }, files: [{ status: "M", path: "a.txt" }] };
	assert.deepEqual(plain(readRemoteGitCompare(trees, "refs/heads/main", "refs/heads/topic")), trees);
	// A three-dot answer is not a tree answer, and the caller's semantics decide which one it accepts.
	assert.equal(
		codeOf(() => readRemoteGitCompare({ ...trees, mode: "merge-base", mergeBase: oid("c"), ahead: 1, behind: 0 }, "refs/heads/main", "refs/heads/topic")),
		"GIT_RESULT_INVALID",
	);
	assert.equal(
		codeOf(() => readRemoteGitCompare(trees, "refs/heads/main", "refs/heads/topic", "", "threeDot")),
		"GIT_RESULT_INVALID",
	);

	const merged = readRemoteGitCompare({ mode: "merge-base", mergeBase: oid("c"), base: { ref: "refs/heads/main", oid: oid("a") }, head: { ref: "refs/heads/topic", oid: oid("b") }, ahead: 3, behind: 2, files: [] }, "refs/heads/main", "refs/heads/topic", "", "threeDot");
	assert.equal(merged.mode, "merge-base");
	assert.equal(merged.mergeBase, oid("c"));
	assert.deepEqual([merged.ahead, merged.behind], [3, 2]);
	// A move of the merge base or the counts is not a shape this protocol sends.
	assert.equal(
		codeOf(() => readRemoteGitCompare({ mode: "merge-base", mergeBase: "HEAD", base: { ref: "refs/heads/main", oid: oid("a") }, head: { ref: "refs/heads/topic", oid: oid("b") }, ahead: 3, behind: 2, files: [] }, "refs/heads/main", "refs/heads/topic", "", "threeDot")),
		"GIT_RESULT_INVALID",
	);
	assert.equal(
		codeOf(() => readRemoteGitCompare({ mode: "merge-base", mergeBase: oid("c"), base: { ref: "refs/heads/main", oid: oid("a") }, head: { ref: "refs/heads/topic", oid: oid("b") }, ahead: -1, behind: 2, files: [] }, "refs/heads/main", "refs/heads/topic", "", "threeDot")),
		"GIT_RESULT_INVALID",
	);
	assert.equal(
		codeOf(() => readRemoteGitCompare({ mode: "merge-base", mergeBase: oid("c"), base: { ref: "refs/heads/main", oid: oid("a") }, head: { ref: "refs/heads/topic", oid: oid("b") }, files: [] }, "refs/heads/main", "refs/heads/topic", "", "threeDot")),
		"GIT_RESULT_INVALID",
	);
});

// ── End to end on a real repository (Linux, where the frozen worker can run) ────────────────────

const linux = { ...options, timeout: 180_000 };

test("a real repository answers ref/all pages with a matching count, commit line counts and the staged diff", linux, async (t) => {
	const f = fixture(t);
	const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
	f.git("config", "user.name", "Fixture");
	f.git("config", "user.email", "fixture@example.invalid");
	writeFileSync(path.join(f.root, "a.txt"), "one\n");
	f.git("add", "-A");
	f.git(...identity, "commit", "-qm", "first");
	f.git("tag", "v1.0");
	const mainBranch = f.git("symbolic-ref", "--short", "HEAD").trim();

	// A branch that HEAD does not contain: only --all (or its full ref) can see it.
	f.git("switch", "-q", "-c", "side");
	writeFileSync(path.join(f.root, "b.txt"), "two\nthree\n");
	f.git("add", "-A");
	f.git(...identity, "commit", "-qm", "second");
	f.git("switch", "-q", mainBranch);

	const headPage = successful(await f.request("git.log", { maxCount: 10, withCount: true }));
	assert.equal(headPage.commits.length, 1);
	assert.equal(headPage.total, Number(f.git("rev-list", "--count", "HEAD").trim()));
	assert.equal(headPage.hasMore, false);

	const sidePage = successful(await f.request("git.log", { maxCount: 10, ref: "refs/heads/side", withCount: true }));
	assert.equal(sidePage.commits[0].subject, "second");
	assert.equal(sidePage.total, 2);
	assert.equal(sidePage.commits.length, 2);

	const allPage = successful(await f.request("git.log", { maxCount: 10, all: true, withCount: true }));
	assert.equal(allPage.total, Number(f.git("rev-list", "--count", "--all").trim()));
	assert.equal(allPage.commits.length, 2, "--all sees the side commit HEAD does not have");
	// A count that was not asked for stays absent: absent means "not counted", never an empty history.
	const uncounted = successful(await f.request("git.log", { maxCount: 10 }));
	assert.equal("total" in uncounted, false);

	// commitDetail line counts come from the same commit; a binary file has none.
	f.git("switch", "-q", "side");
	writeFileSync(path.join(f.root, "b.txt"), "two\nthree\nfour\n");
	writeFileSync(path.join(f.root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
	f.git("add", "-A");
	f.git(...identity, "commit", "-qm", "binary and text");
	const detail = successful(await f.request("git.commitDetail", { oid: f.git("rev-parse", "HEAD").trim() }));
	const text = detail.files.find((file) => file.path === "b.txt");
	const binary = detail.files.find((file) => file.path === "binary.dat");
	assert.deepEqual({ additions: text.additions, deletions: text.deletions }, { additions: 1, deletions: 0 });
	assert.deepEqual({ additions: binary.additions, deletions: binary.deletions }, { additions: undefined, deletions: undefined }, "a binary record has no count, not 0");
	assert.deepEqual(detail.shortStat, { files: 2, insertions: 1, deletions: 0 });

	// The staged diff is the index's text; an empty index is the empty string, not a refusal.
	f.git("switch", "-q", mainBranch);
	assert.equal(successful(await f.request("git.stagedDiff", {})).diff, "");
	writeFileSync(path.join(f.root, "a.txt"), "one\nstaged\n");
	f.git("add", "a.txt");
	const staged = successful(await f.request("git.stagedDiff", {}));
	assert.match(staged.diff, /^diff --git a\/a\.txt b\/a\.txt/);
	assert.match(staged.diff, /^\+staged$/m);
	// The read takes no parameter at all: a param is a protocol refusal, not a silently ignored extra.
	const refused = await f.request("git.stagedDiff", { path: "a.txt" });
	assert.equal(refused.ok, false);
	assert.equal(refused.error?.code, "GIT_RESULT_INVALID");
	f.git("reset", "-q");
});

test("远端失败自带 stderr 摘要：worker 采集、入口转发、客户端读到 message", () => {
	const read = loadTsCommonJs("src/main/remote/RemoteGitReadSource.ts").REMOTE_GIT_READ_SOURCE;
	const entry = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts").REMOTE_HELPER_INLINE_SOURCE;
	// worker：stderr 有界采集，并挂在 failure 的错误对象上；终态回调把 detail 一起交出去。
	assert.match(read, /lastStderr \+= chunk\.toString\("utf8"\)\.slice\(0, 4096 - lastStderr\.length\)/);
	assert.match(read, /if \(lastStderr\.length > 0\) error\.detail = lastStderr/);
	assert.match(read, /done\(code\(error\), null, error && typeof error\.detail === "string" \? error\.detail : undefined\)/);
	// 入口：稳定码 +可选原文（4 KiB 上限）；refuse/startGit 把原文带过去。
	assert.match(entry, /message: message\.slice\(0, 4096\)/);
	assert.match(entry, /function refuse\(identity, code, message\)/);
	assert.match(entry, /function \(code, result, message\) \{ if \(code !== null\) refuse\(entry\.identity, code, message\)/);
});
