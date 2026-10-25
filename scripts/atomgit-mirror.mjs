#!/usr/bin/env node
/**
 * 把一次 `git push` 的引用镜像到 AtomGit（由 `.githooks/pre-push` 调用，可单独运行）。
 *
 * 设计要点（为什么长这样）：
 * - **只镜像本次真正推的引用**：pre-push 的 stdin 给出 `<local ref> <local sha> <remote ref> <remote sha>`，
 *   照它逐条构造 refspec，而不是 `--mirror` 全量同步——全量会把「本地临时分支被删」当成删除指令，
 *   误删 AtomGit 上别人还在用的分支。
 * - **引用删除默认不跟删**（`local sha` 全 0）：本地清理分支是高频动作，镜像源应该保守，
 *   需要同步删除时手动 `git push atomgit --delete <branch>`。
 * - **递归防护**：镜像本身也是一次 push，会再次触发本钩子；命中 AtomGit 远端名或 URL 时直接放行，
 *   并且镜像 push 额外带 `--no-verify` 双保险。
 * - **远端自愈**：新设备 / 新 clone 往往没有 atomgit 远端，这里自动 `git remote add`
 *   （地址常量见 DEFAULT_ATOMGIT_URL，可用 PI_DECK_ATOMGIT_URL 覆盖）。
 * - **默认非阻塞**：镜像失败只打印可操作提示，退出码 0，绝不阻断主 push；
 *   设 `PI_DECK_ATOMGIT_STRICT=1` 才把镜像失败升级为「push 失败」。
 * - **低速放弃**：镜像源不可达时按 git 的 lowSpeedLimit/lowSpeedTime 在 ~20s 内放弃，
 *   不让一次 push 挂住几分钟。
 * - 判定逻辑抽成纯函数 `planAtomgitMirror`，单测直接覆盖（见 tests/atomgitPushMirror.test.mjs）。
 *
 * 环境开关：PI_DECK_SKIP_ATOMGIT / PI_DECK_ATOMGIT_STRICT / PI_DECK_ATOMGIT_REMOTE /
 *          PI_DECK_ATOMGIT_URL / PI_DECK_ATOMGIT_DRY_RUN。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** pre-push 用全 0 的 sha 表示「删除该引用」。 */
export const ZERO_SHA = "0".repeat(40);

export const DEFAULT_ATOMGIT_REMOTE = "atomgit";

/** clone 到新设备后没有 atomgit 远端时自动写入的地址。 */
export const DEFAULT_ATOMGIT_URL = "https://atomgit.com/ayuayue/PiDeck.git";

/**
 * 解析 pre-push 的 stdin 契约：每行 `<local ref> <local sha> <remote ref> <remote sha>`。
 * 空行与格式不完整的行直接丢弃——钩子不能因为上游给了怪数据就崩。
 */
export function parsePushRefLines(text) {
	const refs = [];
	for (const rawLine of String(text ?? "").split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
		if (!localRef || !remoteRef) continue;
		refs.push({ localRef, localSha: localSha ?? "", remoteRef, remoteSha: remoteSha ?? "" });
	}
	return refs;
}

/**
 * 规划镜像动作（纯函数，便于单测）。
 * 返回 action=skip 时 reason 说明原因；action=push 时 refspecs 是待推的 `local:remote` 列表。
 */
export function planAtomgitMirror(options) {
	const env = options?.env ?? {};
	const remoteName = String(options?.remoteName ?? "");
	const remoteUrl = String(options?.remoteUrl ?? "");
	const remote = env.PI_DECK_ATOMGIT_REMOTE || DEFAULT_ATOMGIT_REMOTE;
	const empty = { refspecs: [], droppedDeletes: [], remote };

	if (env.PI_DECK_SKIP_ATOMGIT === "1") return { action: "skip", reason: "skip-env", ...empty };
	// 目标就是 AtomGit：本次 push 本身就是镜像动作，再镜像一次会无限递归
	if (remoteName === remote || remoteUrl.includes("atomgit.com")) return { action: "skip", reason: "target-is-atomgit", ...empty };

	const refspecs = [];
	const droppedDeletes = [];
	for (const ref of parsePushRefLines(options?.stdin)) {
		if (ref.localSha === ZERO_SHA) {
			droppedDeletes.push(ref.remoteRef);
			continue;
		}
		refspecs.push(`${ref.localRef}:${ref.remoteRef}`);
	}

	if (refspecs.length === 0) {
		return { action: "skip", reason: droppedDeletes.length > 0 ? "only-deletions" : "nothing-to-mirror", refspecs, droppedDeletes, remote };
	}
	return { action: "push", reason: "", refspecs, droppedDeletes, remote };
}

function log(message) {
	process.stdout.write(`${message}\n`);
}

function warn(message) {
	process.stderr.write(`${message}\n`);
}

/** 读 pre-push 的 stdin；没有 stdin（手动运行、管道关闭）时返回空串。 */
function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

function runGit(args, env) {
	const result = spawnSync("git", args, { encoding: "utf8", env });
	if (result.error) return { ok: false, output: String(result.error.message ?? result.error) };
	const output = [result.stdout, result.stderr].filter(Boolean).join("").trim();
	return { ok: result.status === 0, output };
}

/**
 * 确保远端存在：新设备的 `.git/config` 里通常只有 origin。
 * 失败只提示（除非 strict），因为「缺远端」不该让开发者的 push 直接失败。
 */
function ensureRemote(remote, env) {
	if (runGit(["remote", "get-url", remote], env).ok) return true;
	const url = env.PI_DECK_ATOMGIT_URL || DEFAULT_ATOMGIT_URL;
	if (runGit(["remote", "add", remote, url], env).ok) {
		log(`ℹ️  已自动添加远端 ${remote} → ${url}`);
		return true;
	}
	warn(`⚠️  未能添加 ${remote} 远端，跳过镜像（可手动 git remote add ${remote} ${url}）`);
	return false;
}

function strictEnabled(env) {
	return env.PI_DECK_ATOMGIT_STRICT === "1";
}

function main() {
	const env = process.env;
	const plan = planAtomgitMirror({ remoteName: process.argv[2] ?? "", remoteUrl: process.argv[3] ?? "", stdin: readStdin(), env });

	if (plan.action === "skip") {
		if (plan.reason === "skip-env") log("ℹ️  AtomGit 镜像：PI_DECK_SKIP_ATOMGIT=1，按开关跳过");
		else if (plan.reason === "only-deletions") log(`ℹ️  AtomGit 镜像：本次只有引用删除，已跳过（需要同步删除请手动 git push ${plan.remote} --delete <branch>）`);
		// target-is-atomgit（镜像自身）/ nothing-to-mirror 属于正常路径，不打印噪音
		process.exit(0);
	}

	if (!ensureRemote(plan.remote, env)) process.exit(strictEnabled(env) ? 1 : 0);

	const args = ["push", "--no-verify", plan.remote, ...plan.refspecs];
	if (env.PI_DECK_ATOMGIT_DRY_RUN === "1") {
		log(`ℹ️  AtomGit 镜像 dry-run：git ${args.join(" ")}`);
		process.exit(0);
	}

	log(`🔁 同步到 AtomGit（${plan.remote}）：${plan.refspecs.join(" ")}`);
	const result = runGit(args, {
		...env,
		// 镜像源不可达时快速放弃，避免一次 push 被镜像拖住
		GIT_HTTP_LOW_SPEED_LIMIT: env.GIT_HTTP_LOW_SPEED_LIMIT || "1000",
		GIT_HTTP_LOW_SPEED_TIME: env.GIT_HTTP_LOW_SPEED_TIME || "20",
	});
	if (result.ok) {
		log("✅ AtomGit 同步完成");
		process.exit(0);
	}

	warn("⚠️  AtomGit 镜像失败（本次 push 不受影响）。常见原因与处理：");
	warn(`    · 新设备首次推送需要凭据：先手动执行 git push ${plan.remote} <branch> 完成一次授权`);
	warn("    · 网络/代理不可达 AtomGit：PI_DECK_SKIP_ATOMGIT=1 跳过本次镜像");
	warn("    · 希望镜像失败即 push 失败：PI_DECK_ATOMGIT_STRICT=1");
	if (result.output) warn(`    · git 输出：${result.output.split("\n").slice(-3).join(" / ")}`);
	if (plan.droppedDeletes.length > 0) log(`ℹ️  另有 ${plan.droppedDeletes.length} 个引用删除未镜像：${plan.droppedDeletes.join(", ")}`);
	process.exit(strictEnabled(env) ? 1 : 0);
}

// 被单测 import 时不执行 main（否则会去读 stdin / 调用 git）
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
