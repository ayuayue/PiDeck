import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// WorktreeService 删除安全回归测试。
// 背景：从子 worktree 打开 PiDeck 时，主工作区会泄漏进 worktree 列表；
// 删除主工作区时 git worktree remove 失败被 catch 吞掉后仍执行 rm -rf，
// 曾导致主项目目录（40G）被整个删除。
// 本测试通过 stub execFile 模拟 git 输出、真实操作临时目录，验证：
// 1) list() 从任意 worktree 视角都排除主工作区；
// 2) remove() 对主工作区路径拒绝且不删除目录；
// 3) git worktree remove 失败时不再物理删除（核心回归）；
// 4) 正常删除仍工作；未注册路径拒绝。

const servicePath = "src/main/git/WorktreeService.ts";

function compile(filePath, stubs = {}) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => stubs[specifier] ?? {};
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: localRequire,
		console,
		// canonicalSync/canonical 依赖 process.platform 做 Windows 大小写归一化
		process,
	}, { filename: filePath });
	return module.exports;
}

// 从 node:fs 导入 readFileSync（compile 用）

/**
 * 构造 fake git execFile（callback 风格，供模块内 promisify(execFile) 包装）。
 * 模拟四种命令：worktree list --porcelain / rev-parse --git-common-dir /
 * worktree remove --force / branch -D；其余命令抛错。
 * failWorktreeRemove=true 时 git worktree remove 报错（模拟 git 拒绝移除）。
 */
function createFakeGit({ worktreeListOutput, commonDir, failWorktreeRemove = false }) {
	const calls = [];
	const fakeExecFile = (file, args, _options, callback) => {
		calls.push({ file, args });
		const ok = (stdout) => callback(null, { stdout, stderr: "" });
		const fail = () => callback(new Error(`git failed: ${args.join(" ")}`));
		if (file !== "git") return fail();
		if (args[0] === "worktree" && args[1] === "list") return ok(worktreeListOutput);
		if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(commonDir);
		if (args[0] === "worktree" && args[1] === "remove") return failWorktreeRemove ? fail() : ok("");
		if (args[0] === "branch") return ok("");
		return fail();
	};
	return { fakeExecFile, calls };
}

function loadService(execFileImpl, trashImpl) {
	const stubs = {
		"node:child_process": { execFile: execFileImpl },
		"node:fs": { existsSync },
		"node:fs/promises": { realpath },
		"node:path": { basename, dirname, join, resolve },
		"node:util": { promisify },
		"../fs/trash": { trashPath: trashImpl },
		"../logging/sharedLogger": { getAppLogger: () => null },
		// gitExecutable 是新引入的运行时依赖（提供 currentGitExecutable）。
		// 未配置时返回字面量 "git"，与测试内 fake execFile 只认 file==="git" 的假设一致。
		"./gitExecutable": { currentGitExecutable: () => "git" },
	};
	return new (compile(servicePath, stubs).WorktreeService)();
}

/** 默认 trashPath：模拟回收站真实移动（删除源），记录调用。 */
function defaultTrash() {
	const calls = [];
	const trashImpl = async (p) => {
		calls.push(p);
		rmSync(p, { recursive: true, force: true });
	};
	return { trashImpl, trashCalls: calls };
}

/** 建立临时仓库骨架：主工作区 root + 两个 linked worktree wtA/wtB，返回清理函数。 */
function setupFixture() {
	const tmp = mkdtempSync(join(tmpdir(), "wt-delete-protection-"));
	const root = join(tmp, "main-repo");
	const wtA = join(tmp, "feat-a");
	const wtB = join(tmp, "feat-b");
	mkdirSync(root, { recursive: true });
	mkdirSync(wtA);
	mkdirSync(wtB);
	const porcelain = [
		`worktree ${root}`,
		"branch refs/heads/main",
		"",
		`worktree ${wtA}`,
		"branch refs/heads/feat-a",
		"",
		`worktree ${wtB}`,
		"branch refs/heads/feat-b",
		"",
	].join("\n");
	const cleanup = () => rmSync(tmp, { recursive: true, force: true });
	return { root, wtA, wtB, porcelain, cleanup };
}

// Windows/macOS 大小写不敏感比较用；Linux 上 resolve 后字符串相等即可。
const lower = (p) => resolve(p).toLowerCase();

test("list() 从子 worktree 视角排除主工作区（核心回归：主工作区不再泄漏为可删项）", async () => {
	const { root, wtA, wtB, porcelain, cleanup } = setupFixture();
	try {
		// 模拟从子 worktree wtA 打开：common-dir 指向主仓库 .git（绝对路径）
		const { fakeExecFile } = createFakeGit({ worktreeListOutput: porcelain, commonDir: join(root, ".git") });
		const { trashImpl } = defaultTrash();
		const svc = loadService(fakeExecFile, trashImpl);
		const entries = await svc.list(wtA);
		const paths = entries.map((e) => lower(e.path));
		assert.ok(!paths.includes(lower(root)), "主工作区不得出现在 worktree 列表中");
		assert.equal(paths.length, 2, "应只剩两个 linked worktree");
		assert.ok(paths.includes(lower(wtA)) && paths.includes(lower(wtB)));
	} finally {
		cleanup();
	}
});

test("list() 从主工作区视角同样排除自身（相对 --git-common-dir 输出）", async () => {
	const { root, wtA, wtB, porcelain, cleanup } = setupFixture();
	try {
		// 从主工作区打开时 git 输出相对路径 ".git"
		const { fakeExecFile } = createFakeGit({ worktreeListOutput: porcelain, commonDir: ".git" });
		const { trashImpl } = defaultTrash();
		const svc = loadService(fakeExecFile, trashImpl);
		const entries = await svc.list(root);
		const paths = entries.map((e) => lower(e.path));
		assert.ok(!paths.includes(lower(root)));
		assert.equal(paths.length, 2);
	} finally {
		cleanup();
	}
});

test("remove() 拒绝删除主工作区路径，目录必须保留", async () => {
	const { root, wtA, porcelain, cleanup } = setupFixture();
	try {
		const { fakeExecFile } = createFakeGit({ worktreeListOutput: porcelain, commonDir: join(root, ".git") });
		const { trashImpl, trashCalls } = defaultTrash();
		const svc = loadService(fakeExecFile, trashImpl);
		const ok = await svc.remove(root, wtA);
		assert.equal(ok, false, "主工作区删除必须被拒绝");
		assert.ok(existsSync(root), "主工作区目录必须保留");
		assert.equal(trashCalls.length, 0, "主工作区不得进入回收站");
	} finally {
		cleanup();
	}
});

test("remove() 在 git worktree remove 失败时不再物理删除目录（核心回归：40G 误删根因）", async () => {
	const { root, wtA, wtB, porcelain, cleanup } = setupFixture();
	try {
		// git 拒绝移除 wtB（模拟主工作区场景中 git 的拒绝行为），旧实现会继续 rm -rf
		const { fakeExecFile } = createFakeGit({
			worktreeListOutput: porcelain,
			commonDir: join(root, ".git"),
			failWorktreeRemove: true,
		});
		const { trashImpl, trashCalls } = defaultTrash();
		const svc = loadService(fakeExecFile, trashImpl);
		const ok = await svc.remove(wtB, wtA);
		assert.equal(ok, false);
		assert.ok(existsSync(wtB), "git 拒绝时必须保留目录，不得删除");
		assert.equal(trashCalls.length, 0, "git 拒绝时不得进入回收站");
	} finally {
		cleanup();
	}
});

test("remove() 正常删除 worktree：目录进回收站、分支被删除", async () => {
	const { root, wtA, wtB, porcelain, cleanup } = setupFixture();
	try {
		const { fakeExecFile, calls } = createFakeGit({ worktreeListOutput: porcelain, commonDir: join(root, ".git") });
		const { trashImpl, trashCalls } = defaultTrash();
		const svc = loadService(fakeExecFile, trashImpl);
		const ok = await svc.remove(wtB, wtA);
		assert.equal(ok, true);
		// 目录应移入回收站（fake trashPath 模拟真实移动：源目录被删除）
		assert.ok(trashCalls.some((p) => lower(p) === lower(wtB)), "worktree 目录应移入回收站");
		assert.ok(!existsSync(wtB), "回收站移动后源目录应不存在");
		// 分支名（feat-b）等于目录名 → PiDeck 创建的 worktree，应删除分支
		assert.ok(
			calls.some((c) => c.args[0] === "branch" && c.args[1] === "-D" && c.args[2] === "feat-b"),
			"应删除同名分支 feat-b",
		);
	} finally {
		cleanup();
	}
});

test("remove() 对未注册路径返回 false 且不调用 git worktree remove", async () => {
	const { root, wtA, porcelain, cleanup } = setupFixture();
	try {
		const { fakeExecFile, calls } = createFakeGit({ worktreeListOutput: porcelain, commonDir: join(root, ".git") });
		const { trashImpl, trashCalls } = defaultTrash();
		const svc = loadService(fakeExecFile, trashImpl);
		const ghost = join(root, "..", "not-a-worktree");
		const ok = await svc.remove(ghost, wtA);
		assert.equal(ok, false);
		assert.ok(
			!calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove"),
			"未注册路径不得触发 git worktree remove",
		);
		assert.equal(trashCalls.length, 0, "未注册路径不得进入回收站");
	} finally {
		cleanup();
	}
});

test("remove() 对已不存在目录的残留记录允许清理（外部删除场景不回退）", async () => {
	const { root, wtA, wtB, porcelain, cleanup } = setupFixture();
	try {
		// 模拟目录已被外部删除：git remove 失败，但目录已不存在
		rmSync(wtB, { recursive: true, force: true });
		const { fakeExecFile } = createFakeGit({
			worktreeListOutput: porcelain,
			commonDir: join(root, ".git"),
			failWorktreeRemove: true,
		});
		const { trashImpl, trashCalls } = defaultTrash();
		const svc = loadService(fakeExecFile, trashImpl);
		const ok = await svc.remove(wtB, wtA);
		assert.equal(ok, true, "目录已不存在时允许清理残留记录");
		assert.equal(trashCalls.length, 0, "目录已不存在时无需回收站");
	} finally {
		cleanup();
	}
});

test("remove() 回收站不可用时抛错（拒绝静默硬删）", async () => {
	const { root, wtA, wtB, porcelain, cleanup } = setupFixture();
	try {
		const { fakeExecFile } = createFakeGit({ worktreeListOutput: porcelain, commonDir: join(root, ".git") });
		// 回收站不可用：trashPath 抛错 → remove 必须向上抛，且目录保留
		const failingTrash = async () => {
			throw new Error("trash unavailable");
		};
		const svc = loadService(fakeExecFile, failingTrash);
		await assert.rejects(() => svc.remove(wtB, wtA), /trash unavailable/);
		assert.ok(existsSync(wtB), "回收站失败时目录必须保留（不得硬删）");
	} finally {
		cleanup();
	}
});
