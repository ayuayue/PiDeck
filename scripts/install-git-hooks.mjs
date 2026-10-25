#!/usr/bin/env node
/**
 * 安装 / 校验 PiDeck 的仓库级 git 钩子：每次 `git push` 自动把引用镜像到 AtomGit。
 *
 * 为什么需要「安装」这一步：git 不跟踪 `.git/hooks`，钩子必须放在仓库里（`.githooks/`）
 * 并把 `core.hooksPath` 指过去，**其他设备** clone 或拉取后才能有同样行为。本脚本幂等，
 * 反复执行安全：
 *   1. `git config --local core.hooksPath .githooks`（只写本仓库，不动全局配置）；
 *   2. POSIX 上给钩子补执行位（Windows 不需要，git 直接调用 sh）；
 *   3. 确保 `atomgit` 远端存在（新设备常见缺失），地址取自 scripts/atomgit-mirror.mjs；
 *   4. 打印可自检的命令。
 *
 * 用法：
 *   node scripts/install-git-hooks.mjs            # 安装（npm install 会经 prepare 自动跑）
 *   node scripts/install-git-hooks.mjs --check    # 只检查，未安装则退出码 1
 *   node scripts/install-git-hooks.mjs --force    # 覆盖已有的 core.hooksPath（例如 husky）
 *   node scripts/install-git-hooks.mjs --strict   # 出错时以非零码退出
 *
 * 约定（重要）：默认「尽力而为、绝不打断 npm install」——不在 git 工作区、没有 git、
 * 配置写不进去，都只打印提示并退出 0；只有 --check（状态查询）与 --strict 才会非零退出。
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ATOMGIT_REMOTE, DEFAULT_ATOMGIT_URL } from "./atomgit-mirror.mjs";

const HOOKS_PATH = ".githooks";
const HOOK_FILE = join(HOOKS_PATH, "pre-push");

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const force = args.has("--force");
const strict = args.has("--strict");

function log(message) {
	process.stdout.write(`${message}\n`);
}

function warn(message) {
	process.stderr.write(`⚠️  ${message}\n`);
}

function git(gitArgs) {
	const result = spawnSync("git", gitArgs, { encoding: "utf8" });
	if (result.error) return { ok: false, output: "" };
	return { ok: result.status === 0, output: (result.stdout ?? "").trim() };
}

/** 统一出口：默认永远 0，避免 npm install 因为钩子安装失败而报错。 */
function finish(code, message) {
	if (message) (code === 0 ? log : warn)(message);
	process.exit(strict || checkOnly ? code : 0);
}

function main() {
	const root = git(["rev-parse", "--show-toplevel"]);
	if (!root.ok) {
		finish(checkOnly ? 1 : 0, "当前目录不是 git 工作区，跳过 git 钩子安装（安装包/CI 解压目录属正常情况）");
		return;
	}
	if (!existsSync(HOOK_FILE)) {
		finish(checkOnly ? 1 : 0, `未找到 ${HOOK_FILE}，仓库可能不完整，跳过安装`);
		return;
	}

	const current = git(["config", "--local", "--get", "core.hooksPath"]);
	const installed = current.ok && current.output === HOOKS_PATH;
	if (installed && checkOnly) {
		log(`✅ core.hooksPath = ${HOOKS_PATH}（pre-push → AtomGit 镜像已启用）`);
	}

	if (!installed) {
		if (current.ok && current.output && !force) {
			// 别人（husky 等）已经接管 hooks：不抢，给出明确指引
			log(`ℹ️  core.hooksPath 已被设置为「${current.output}」，未改动；如需接管请执行 node scripts/install-git-hooks.mjs --force`);
		} else if (checkOnly) {
			warn(`未安装：core.hooksPath 当前为「${current.ok ? current.output : "未设置"}」，执行 node scripts/install-git-hooks.mjs 安装`);
		} else {
			const set = git(["config", "--local", "core.hooksPath", HOOKS_PATH]);
			if (!set.ok) {
				finish(1, `写入 core.hooksPath 失败，请手动执行：git config --local core.hooksPath ${HOOKS_PATH}`);
				return;
			}
			log(`✅ 已启用仓库级钩子：core.hooksPath = ${HOOKS_PATH}`);
		}
	}

	// POSIX 需要执行位；Windows 上 git 用自带的 sh 直接跑，chmod 失败也无所谓
	try {
		chmodSync(HOOK_FILE, 0o755);
	} catch {
		// 忽略：权限模型的差异不该让安装失败
	}

	// 新设备自愈：没有 atomgit 远端就补一个
	if (!git(["remote", "get-url", DEFAULT_ATOMGIT_REMOTE]).ok) {
		if (checkOnly) {
			warn(`未配置远端 ${DEFAULT_ATOMGIT_REMOTE}：首次 push 时钩子会自动添加，或现在执行 git remote add ${DEFAULT_ATOMGIT_REMOTE} ${DEFAULT_ATOMGIT_URL}`);
		} else if (git(["remote", "add", DEFAULT_ATOMGIT_REMOTE, DEFAULT_ATOMGIT_URL]).ok) {
			log(`✅ 已添加远端 ${DEFAULT_ATOMGIT_REMOTE} → ${DEFAULT_ATOMGIT_URL}`);
		} else {
			warn(`添加远端 ${DEFAULT_ATOMGIT_REMOTE} 失败，可手动执行：git remote add ${DEFAULT_ATOMGIT_REMOTE} ${DEFAULT_ATOMGIT_URL}`);
		}
	}

	if (!checkOnly) {
		log("");
		log("每次 git push 会把本次推送的引用同步到 AtomGit（失败只提示，不阻断 push）。");
		log("自检：PI_DECK_ATOMGIT_DRY_RUN=1 git push <remote> <branch>   # 只打印将执行的镜像命令");
		log("开关：PI_DECK_SKIP_ATOMGIT=1 跳过；PI_DECK_ATOMGIT_STRICT=1 镜像失败即失败");
	}
	finish(0);
}

try {
	main();
} catch (error) {
	// 钩子安装永远不该打断 npm install
	finish(1, `git 钩子安装异常：${error instanceof Error ? error.message : String(error)}`);
}
