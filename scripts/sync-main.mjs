#!/usr/bin/env node
/**
 * 把开发分支合并进发布分支（默认 `dev` → `main`）并推送 origin + AtomGit。
 *
 * 为什么用临时 worktree：合并需要切到 main，而工作区里经常有别的任务正在编辑的文件——
 * 直接 `git switch main` 会被拒绝或互相打断。worktree 让整个合并发生在系统临时目录里，
 * 当前分支与工作区完全不受影响（合并完自动清理）。
 *
 * 流程：fetch → 建临时 worktree(target) → `merge --no-ff source` → 推 origin target
 *       → 若存在 atomgit 远端再显式推一次（pre-push 钩子已镜像时是幂等兜底）→ 删 worktree。
 *
 * 安全约定：
 * - 合并冲突一律 `merge --abort` 后退出 1，**绝不** `-X ours/theirs` 私自选边；
 * - 不改写历史、不 force push；
 * - 无新提交且本地 target 与远端一致时什么都不做（幂等，可随时跑）；
 * - 任何失败路径都会清理临时 worktree（catch + finally，不用 process.exit 打断清理）；
 * - **只在「本文件就是入口」且不在 CI 时才会合并/推送**：纯函数供单测 import，若顶层直接调 main，
 *   单测 import 就会真的 fetch + 合并 + 推送（2026-09-20 CI 红灯与本机误推 main 的根因）。
 *
 * 用法：
 *   npm run sync:main                        # dev → main，推 origin + atomgit
 *   npm run sync:main -- --dry-run           # 只预览会并入/推送什么
 *   npm run sync:main -- --source dev --target main
 *   npm run sync:main -- --message "自定义合并说明"
 *   npm run sync:main -- --no-atomgit        # 只推 origin
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_REMOTE = "origin";
const ATOMGIT_REMOTE = "atomgit";
/** 合并说明里最多列出多少条待并入提交（更长的用「等 N 个提交」收尾，避免提交信息变成日志） */
const MESSAGE_SUBJECT_LIMIT = 20;

/** 受控中止（冲突、推送失败等）：由 main 捕获后统一收尾，保证临时 worktree 一定被清理。 */
class SyncAbort extends Error {}

/**
 * 解析参数（纯函数，便于单测）。支持 `--key value` 与 `--flag` 两种形式。
 */
export function parseSyncArgs(argv) {
	const options = {
		source: "dev",
		target: "main",
		remote: DEFAULT_REMOTE,
		message: "",
		dryRun: false,
		pushAtomgit: true,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--no-atomgit") options.pushAtomgit = false;
		else if (arg === "--source") options.source = argv[++index] ?? options.source;
		else if (arg === "--target") options.target = argv[++index] ?? options.target;
		else if (arg === "--remote") options.remote = argv[++index] ?? options.remote;
		else if (arg === "--message") options.message = argv[++index] ?? "";
	}
	return options;
}

/**
 * 生成合并提交说明（纯函数）：首行点明方向与提交数，正文列出入并的提交，
 * 便于在 GitHub / AtomGit 上一眼看出这次同步带了什么。
 */
export function buildMergeMessage(input) {
	if (input.message) return input.message;
	const limit = input.subjectLimit ?? MESSAGE_SUBJECT_LIMIT;
	const subjects = input.subjects ?? [];
	const lines = [`Merge branch '${input.source}' into ${input.target}: ${subjects.length} 个提交`, ""];
	for (const subject of subjects.slice(0, limit)) lines.push(`- ${subject}`);
	if (subjects.length > limit) lines.push(`- …等 ${subjects.length - limit} 个提交`);
	return lines.join("\n");
}

function log(message) {
	process.stdout.write(`${message}\n`);
}

function warn(message) {
	process.stderr.write(`${message}\n`);
}

/** 运行 git；返回 { ok, stdout, stderr }。cwd 用于在临时 worktree 内执行。 */
function git(args, cwd) {
	const result = spawnSync("git", args, { encoding: "utf8", cwd });
	return {
		ok: result.status === 0,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
	};
}

function firstLine(text) {
	return text.split("\n")[0] ?? "";
}

function short(sha) {
	return sha ? sha.slice(0, 8) : "(无)";
}

function hasRemote(name) {
	return git(["remote", "get-url", name]).ok;
}

/** 刷新远端状态：不同步这个，「本地 target 领先」的判断会把已推送的提交误当成待推送。 */
function fetchRemote(remote) {
	const result = git(["fetch", remote, "--prune"]);
	if (!result.ok) warn(`⚠️  git fetch ${remote} 失败，改用本地已有的远端引用：${firstLine(result.stderr)}`);
}

function listIncomingCommits(source, target) {
	const result = git(["log", "--no-merges", "--format=%h %s", `${target}..${source}`]);
	return result.ok && result.stdout ? result.stdout.split("\n").filter(Boolean) : [];
}

function remoteHead(remote, branch) {
	const result = git(["ls-remote", remote, `refs/heads/${branch}`]);
	return result.ok && result.stdout ? (result.stdout.split(/\s+/)[0] ?? "") : "";
}

/** 前置检查：分支存在性 + 不能与当前分支冲突（worktree 无法检出当前分支）。 */
function preflight(options) {
	const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
	if (currentBranch === options.target) throw new SyncAbort(`当前正处于 ${options.target} 分支，请先切回 ${options.source} 再执行同步。`);
	for (const branch of [options.source, options.target]) {
		if (!git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) throw new SyncAbort(`本地没有 ${branch} 分支，无法同步。`);
	}
}

/** 合并与推送都发生在临时 worktree 内；返回是否真的推送了。 */
function mergeAndPush(worktree, options, mergeMessage) {
	const merged = git(["merge", "--no-ff", options.source, "-m", mergeMessage], worktree);
	if (!merged.ok) {
		git(["merge", "--abort"], worktree);
		throw new SyncAbort(`合并冲突，已 abort（未推送）。请手动解决后重试：\n${merged.stderr || merged.stdout}`);
	}
	log(`✅ 已合并：${git(["log", "-1", "--format=%h %s"], worktree).stdout}`);

	// target 独有的历史内容（如 star-history 资源）会出现在这里，属于正常差异，只提示不阻断
	const treeDiff = git(["diff", options.source, "--stat"], worktree).stdout;
	if (treeDiff) log(`ℹ️  ${options.target} 相对 ${options.source} 的差异：\n${treeDiff}`);

	const ahead = Number(git(["rev-list", "--count", `${options.remote}/${options.target}..${options.target}`], worktree).stdout || "0");
	if (ahead === 0) {
		log(`✅ ${options.remote}/${options.target} 已是最新，无需推送`);
		return false;
	}

	const pushed = git(["push", options.remote, options.target], worktree);
	if (!pushed.ok) throw new SyncAbort(`推送 ${options.remote} ${options.target} 失败：${firstLine(pushed.stderr)}`);
	log(`✅ 已推送 ${options.remote} ${options.target}（${ahead} 个提交）`);

	if (options.pushAtomgit) {
		// 钩子（.githooks/pre-push）通常已把同一次 push 镜像过去，这里再显式推一次做兜底
		const atomgitPush = git(["push", ATOMGIT_REMOTE, options.target], worktree);
		if (atomgitPush.ok) log(`✅ 已同步 ${ATOMGIT_REMOTE} ${options.target}`);
		else warn(`⚠️  ${ATOMGIT_REMOTE} 同步失败（可重试或检查凭据）：${firstLine(atomgitPush.stderr)}`);
	}
	return true;
}

function printSummary(options) {
	log("");
	log("— 最终位置 —");
	log(`  local ${options.target}      = ${short(git(["rev-parse", options.target]).stdout)}`);
	log(`  ${options.remote}/${options.target}       = ${short(git(["rev-parse", `${options.remote}/${options.target}`]).stdout)}`);
	if (options.pushAtomgit) log(`  ${ATOMGIT_REMOTE}/${options.target}    = ${short(remoteHead(ATOMGIT_REMOTE, options.target))}`);
}

function main() {
	// 发布分支的合并必须由人发起：流水线里没有 sync:main 的正当场景（CI 的 contents: read 只是第二道防线），
	// 所以宁可立刻失败，也不允许 CI 顺手把 main 推上去。
	if (process.env.CI) {
		warn("检测到 CI 环境：sync:main 是本地开发脚本，拒绝在流水线里合并/推送 main。");
		process.exitCode = 1;
		return;
	}
	const options = parseSyncArgs(process.argv.slice(2));
	const canPushAtomgit = options.pushAtomgit && hasRemote(ATOMGIT_REMOTE);
	if (options.pushAtomgit && !canPushAtomgit) warn(`ℹ️  未找到 ${ATOMGIT_REMOTE} 远端，本次只推 ${options.remote}。`);
	options.pushAtomgit = canPushAtomgit;

	let worktree = "";
	try {
		preflight(options);
		fetchRemote(options.remote);

		const subjects = listIncomingCommits(options.source, options.target);
		log(`📋 同步 ${options.source} → ${options.target}`);
		log(`   待并入提交：${subjects.length} 个`);
		for (const subject of subjects.slice(0, MESSAGE_SUBJECT_LIMIT)) log(`   · ${subject}`);
		if (subjects.length > MESSAGE_SUBJECT_LIMIT) log(`   · …等 ${subjects.length - MESSAGE_SUBJECT_LIMIT} 个提交`);
		log(`   本地 ${options.target}：${short(git(["rev-parse", options.target]).stdout)}  ｜  ${options.remote}/${options.target}：${short(git(["rev-parse", `${options.remote}/${options.target}`]).stdout)}`);

		if (options.dryRun) {
			log("");
			log("🧪 dry-run：不建 worktree、不合并、不推送。");
			process.exitCode = 0;
			return;
		}

		const mergeMessage = buildMergeMessage({ source: options.source, target: options.target, subjects, message: options.message });
		// 无事可做就别建 worktree：source 已全在 target 里，且 target 与远端一致
		const localTargetSha = git(["rev-parse", options.target]).stdout;
		if (subjects.length === 0 && localTargetSha && localTargetSha === git(["rev-parse", `${options.remote}/${options.target}`]).stdout) {
			log(`✅ ${options.target} 已与 ${options.source} 同步且已推送（${short(localTargetSha)}），无需操作`);
			process.exitCode = 0;
			return;
		}

		worktree = mkdtempSync(join(tmpdir(), "pideck-sync-main-"));
		// git worktree add 要求目标目录不存在，先把 mkdtemp 建出来的空目录删掉
		rmSync(worktree, { recursive: true, force: true });
		const added = git(["worktree", "add", worktree, options.target]);
		if (!added.ok) throw new SyncAbort(`无法创建临时 worktree：${firstLine(added.stderr)}`);

		mergeAndPush(worktree, options, mergeMessage);
		printSummary(options);
		process.exitCode = 0;
	} catch (error) {
		warn(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		// 无论成功、冲突还是推送失败，临时 worktree 都必须清掉
		if (worktree) {
			git(["worktree", "remove", "--force", worktree]);
			git(["worktree", "prune"]);
		}
	}
}

// 只有被直接执行为入口时才跑主流程（惯例同 scripts/atomgit-mirror.mjs）：本模块顶层导出纯函数
// 供 tests/mainSyncScript.test.mjs 直接断言，一旦 import 就执行主流程，单测会真的合并并推 main。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
