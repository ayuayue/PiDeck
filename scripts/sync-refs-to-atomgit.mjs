#!/usr/bin/env node

/**
 * scripts/sync-refs-to-atomgit.mjs
 *
 * 把 GitHub（origin）的「分支 + 标签」同步到 AtomGit 仓库的 git refs（不含 Release 资产）。
 *
 * 为什么需要这个脚本（v0.7.6 发版事故）：
 *   AtomGit 上的 PiDeck 仓库原本是 GitHub 的「镜像仓库」，分支/标签由平台自动跟随同步；
 *   但镜像仓库被平台禁止创建 Release（POST /releases 返回 400 "this operation is not
 *   allowed because the repository is an image repository"），所以 Release 资产一向由
 *   scripts/sync-release-to-atomgit.mjs 走 API 上传。镜像一旦解除（这是让 Release 能建的
 *   前提），分支/标签就**不再自动同步** —— AtomGit 上缺新 tag 时，Release 同步脚本会找不到
 *   对应提交/tag。本脚本就是补上的这条「主动推 refs」通路，由 sync-atomgit.yml 在
 *   Release 资产同步之前调用。
 *
 * 安全与幂等约定：
 * 1. 绝不硬编码 Token：只从 ATOMGIT_TOKEN 环境变量或 --token 读取，仅拼进本次推送 URL，
 *    不写入 git 配置/远程列表，所有日志统一脱敏为 ***。
 * 2. 只做增量：先 ls-remote 双侧比对 SHA，只推 AtomGit 缺失或指向不一致的 ref
 *    （与 sync-release-to-atomgit.mjs 的「同名同大小才跳过」思路一致）。
 * 3. 默认不加 --force：AtomGit 侧已有独有提交（非快进）的 ref 会被跳过并给出人工处理提示，
 *    避免把平台侧的贡献/PR 分支覆盖掉；确需严格镜像时显式传 --force。
 * 4. 不删除只在 AtomGit 存在的 ref（删除不可逆，防误删；只报告，交由人工判断）。
 * 5. 首次推送前做一次写权限探针（临时分支推送 + 删除）：权限不足时立即停止并明确指出
 *    「ATOMGIT_TOKEN 需要 write_repository 权限」，而不是让 76 个 ref 逐个报错刷屏。
 *
 * 用法：
 *   node scripts/sync-refs-to-atomgit.mjs                  # 本地：用 git 凭据管理器推（增量）
 *   ATOMGIT_TOKEN=xxx node scripts/sync-refs-to-atomgit.mjs # CI：用 Token 推
 *   node scripts/sync-refs-to-atomgit.mjs --dry-run         # 只打印计划，不推送
 *   node scripts/sync-refs-to-atomgit.mjs --probe-write     # 只验写权限（推送+删除临时探针分支）
 *   node scripts/sync-refs-to-atomgit.mjs --force           # 严格镜像：允许非快进覆盖
 */

import { execFileSync } from "node:child_process";
import { URL } from "node:url";

const args = process.argv.slice(2);
function getArg(flag, defaultValue = "") {
	const idx = args.indexOf(flag);
	return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultValue;
}
const hasFlag = (flag) => args.includes(flag);

const ghRemote = getArg("--gh-remote", "origin");
const atomgitUrlPlain = getArg("--atomgit-url", "https://atomgit.com/ayuayue/PiDeck.git");
const atomgitUser = getArg("--atomgit-user", "oauth2");
const token = process.env.ATOMGIT_TOKEN || getArg("--token", "");
const batchSize = Math.max(1, Number(getArg("--batch-size", "10")) || 10);
/** 严格镜像模式：允许非快进覆盖 AtomGit 侧 ref（默认关闭，见文件头约定 3） */
const force = hasFlag("--force");
const dryRun = hasFlag("--dry-run");
/** 只验写权限：即使没有待推 ref 也跑一次探针（用于排查 Token 权限） */
const probeWriteOnly = hasFlag("--probe-write");
const skipProbe = hasFlag("--no-probe");
const probeBranch = "pi-deck-refsync-probe";
const inCI = process.env.GITHUB_ACTIONS === "true";

// fetch/unshallow 要拉全量历史（本地 ~97MB），给足 20 分钟；单次 push 同样 20 分钟
const GIT_TIMEOUT_MS = 20 * 60 * 1000;

/** 日志脱敏：Token 可能以原文或 URL 编码两种形态出现，都要抹掉 */
function redact(text) {
	let out = String(text ?? "");
	if (!token) return out;
	for (const form of new Set([token, encodeURIComponent(token)])) {
		if (form) out = out.split(form).join("***");
	}
	return out;
}

/** CI 里输出 GitHub Actions 注解（本地跑只是普通文本，便于排查） */
function annotate(level, message) {
	const text = redact(message);
	console.log(inCI ? `::${level}::${text}` : `[${level}] ${text}`);
}

/** 把 Token 拼进推送 URL：用 URL 对象保证特殊字符被正确百分号编码，不落盘、不写 git config */
function authUrl() {
	const url = new URL(atomgitUrlPlain);
	if (token) {
		url.username = atomgitUser;
		url.password = token;
	}
	return url.toString();
}

/**
 * 执行 git 子进程。所有命令都用参数数组传（不经 shell），避免路径/Token 被 shell 解释。
 * allowFail 时返回 { ok, out } 而不是直接退出，供「探针失败要给出可读诊断」等场景使用。
 */
function git(gitArgs, { allowFail = false, timeout = GIT_TIMEOUT_MS } = {}) {
	try {
		const out = execFileSync("git", gitArgs, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
			timeout,
			// 禁止交互式口令提示：CI 无终端，卡在提示上会白等到 job 超时
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		return { ok: true, out };
	} catch (error) {
		const out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
		if (!allowFail) {
			console.error(`❌ git ${gitArgs[0]} 失败：\n${redact(out).trim()}`);
			process.exit(1);
		}
		return { ok: false, out: redact(out) };
	}
}

/** ls-remote 解析成 { heads, tags }：ref 名 → SHA（跳过 annotated tag 的 ^{} 解引用行） */
function lsRemote(remoteOrUrl, label) {
	const res = git(["ls-remote", remoteOrUrl], { allowFail: true });
	if (!res.ok) {
		console.error(`❌ 无法访问 ${label}：\n${res.out.trim()}`);
		console.error("   本地请确认网络/代理与 git 凭据；CI 请确认 ATOMGIT_TOKEN 有效。");
		process.exit(1);
	}
	const heads = new Map();
	const tags = new Map();
	for (const rawLine of res.out.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = /^([0-9a-f]{40,64})\s+(.+)$/.exec(line);
		if (!match) continue;
		const [, sha, ref] = match;
		if (ref.endsWith("^{}")) continue;
		if (ref.startsWith("refs/heads/")) heads.set(ref.slice("refs/heads/".length), sha);
		else if (ref.startsWith("refs/tags/")) tags.set(ref.slice("refs/tags/".length), sha);
	}
	return { heads, tags };
}

/** 比对单侧 ref 集合：只推「GitHub 有而 AtomGit 没有/指向不同」的，AtomGit 独有的只报告 */
function planRefs(ghMap, agMap) {
	const missing = [];
	const differing = [];
	let upToDate = 0;
	for (const [name, sha] of ghMap) {
		const agSha = agMap.get(name);
		if (agSha === undefined) missing.push({ name, sha });
		else if (agSha !== sha) differing.push({ name, sha, agSha });
		else upToDate += 1;
	}
	const agOnly = [...agMap.keys()].filter((name) => !ghMap.has(name));
	return { missing, differing, upToDate, agOnly };
}

/** 本地对象里能否判断「agSha 是 ghSha 的祖先」——只有如此才允许不加 --force 推送 */
function isFastForward(agSha, ghSha) {
	const known = git(["cat-file", "-e", `${agSha}^{commit}`], { allowFail: true });
	if (!known.ok) return false;
	const res = git(["merge-base", "--is-ancestor", agSha, ghSha], { allowFail: true });
	return res.ok;
}

function shortRef(kind, name) {
	return `${kind === "tags" ? "tag" : "分支"} ${name}`;
}

// ── 1. 双侧比对 ───────────────────────────────────────────────────────────────
console.log("🔍 比对 GitHub 与 AtomGit 的 refs …");
const ghRefs = lsRemote(ghRemote, `GitHub（${ghRemote}）`);
const agRefs = lsRemote(authUrl(), "AtomGit");

const branchPlan = planRefs(ghRefs.heads, agRefs.heads);
const tagPlan = planRefs(ghRefs.tags, agRefs.tags);

console.log(`   分支：GitHub ${ghRefs.heads.size} / AtomGit ${agRefs.heads.size}，` + `待补 ${branchPlan.missing.length}、待更新 ${branchPlan.differing.length}、已一致 ${branchPlan.upToDate}`);
console.log(`   标签：GitHub ${ghRefs.tags.size} / AtomGit ${agRefs.tags.size}，` + `待补 ${tagPlan.missing.length}、待更新 ${tagPlan.differing.length}、已一致 ${tagPlan.upToDate}`);

// ── 2. 无待推内容：按需只跑写权限探针 ─────────────────────────────────────────
const hasWork = branchPlan.missing.length + branchPlan.differing.length + tagPlan.missing.length + tagPlan.differing.length > 0;

if (!hasWork && !probeWriteOnly) {
	console.log("✅ AtomGit 的 git refs 已与 GitHub 一致，无需推送。");
	if (branchPlan.agOnly.length || tagPlan.agOnly.length) {
		console.log(`ℹ️  AtomGit 独有（仅报告，不自动删除）：${[...branchPlan.agOnly, ...tagPlan.agOnly].join("、") || "无"}`);
	}
	process.exit(0);
}

if (dryRun) {
	for (const item of branchPlan.missing) console.log(`   [将推送] 分支 ${item.name} → ${item.sha.slice(0, 8)}`);
	for (const item of branchPlan.differing) {
		console.log(`   [将更新] 分支 ${item.name} ${item.agSha.slice(0, 8)} → ${item.sha.slice(0, 8)}`);
	}
	for (const item of tagPlan.missing) console.log(`   [将推送] 标签 ${item.name} → ${item.sha.slice(0, 8)}`);
	for (const item of tagPlan.differing) {
		console.log(`   [将更新] 标签 ${item.name} ${item.agSha.slice(0, 8)} → ${item.sha.slice(0, 8)}`);
	}
	console.log("🧪 --dry-run：仅打印计划，未做任何推送。");
	process.exit(0);
}

// ── 3. 准备本地对象 ──────────────────────────────────────────────────────────
// 推送需要目标 ref 指向的提交在本地存在。CI 的 actions/checkout 默认只拉 1 个提交
// （浅克隆），浅克隆仓库被接收端拒绝推送（shallow update not allowed），因此先补全历史。
if (git(["rev-parse", "--is-shallow-repository"], { allowFail: true }).out.trim() === "true") {
	console.log("⏳ 补全浅克隆历史（--unshallow）…");
	git(["fetch", "--unshallow", ghRemote], { timeout: 30 * 60 * 1000 });
}
// refspec 用 ghRemote 的实际 fetch URL 作目标名，而不是写死 origin：
// 无论远端叫 origin 还是别的名字，对象都会落到 refs/remotes/<name>/ 下，后续推送直接引用它。
const remoteName = git(["remote", "get-url", ghRemote], { allowFail: true }).ok ? ghRemote : "origin";
console.log("⏳ 拉取全部分支与标签对象（本地全量历史，首次约 100MB）…");
git(["fetch", remoteName, `+refs/heads/*:refs/remotes/${remoteName}/*`, "+refs/tags/*:refs/tags/*"], {
	timeout: 30 * 60 * 1000,
});

// 「指向不一致」要区分快进/非快进：非快进说明 AtomGit 侧有独有提交，默认不动它
const branchFf = [];
const branchDiverged = [];
for (const item of branchPlan.differing) {
	(isFastForward(item.agSha, item.sha) ? branchFf : branchDiverged).push(item);
}
const tagFf = [];
const tagDiverged = [];
for (const item of tagPlan.differing) {
	(isFastForward(item.agSha, item.sha) ? tagFf : tagDiverged).push(item);
}

if (branchDiverged.length || tagDiverged.length) {
	const lines = [...branchDiverged.map((i) => `分支 ${i.name}（AtomGit 独有提交 ${i.agSha.slice(0, 8)}，GitHub ${i.sha.slice(0, 8)}）`), ...tagDiverged.map((i) => `标签 ${i.name}（AtomGit ${i.agSha.slice(0, 8)}，GitHub ${i.sha.slice(0, 8)}）`)];
	if (force) {
		console.log(`⚠️  以下 ref 非快进，--force 已开启，将强制覆盖：\n   ${lines.join("\n   ")}`);
	} else {
		annotate("warning", `以下 ref 在 AtomGit 侧存在独有提交（非快进），已跳过以防覆盖平台侧贡献：\n   ${lines.join("\n   ")}\n` + "   确认要严格镜像时，重跑本脚本并加 --force。");
	}
}

// ── 4. 写权限探针：一次性确认 Token 能推，避免逐个 ref 报错 ────────────────────
const targetUrl = authUrl();
async function probePushPermission() {
	const headSha = git(["rev-parse", "HEAD"]).out.trim();
	console.log(`🔐 写权限探针：推送临时分支 ${probeBranch} …`);
	const pushed = git(["push", targetUrl, `${headSha}:refs/heads/${probeBranch}`], { allowFail: true });
	if (!pushed.ok) {
		const output = pushed.out;
		let hint = "请检查 ATOMGIT_TOKEN 是否有效、是否对该仓库有写权限。";
		if (/image repository/i.test(output)) {
			hint = "AtomGit 仓库仍是「镜像仓库」模式：请先解除镜像，否则任何 git 推送都会被拒。";
		} else if (/write_repository|403|Forbidden|not allowed|denied|Authentication failed/i.test(output)) {
			hint = "ATOMGIT_TOKEN 缺少写权限：请到 AtomGit「个人设置 → 访问令牌」为其勾选 write_repository（仓库写）权限，并更新仓库 Secret。";
		}
		annotate("error", `写权限探针失败，未推送任何 ref。${hint}\n   远端返回：\n${output.trim()}`);
		process.exit(1);
	}
	// 探针分支只用于验权限，立刻删除；删不掉只告警（多一个临时分支不影响使用）
	const removed = git(["push", targetUrl, "--delete", `refs/heads/${probeBranch}`], { allowFail: true });
	if (!removed.ok) {
		annotate("warning", `临时探针分支 ${probeBranch} 删除失败（不影响本次同步，可稍后手动清理）：\n${removed.out.trim()}`);
	} else {
		console.log("   写权限 OK（探针分支已删除）");
	}
}

if (!skipProbe) {
	await probePushPermission();
	if (probeWriteOnly && !hasWork) {
		console.log("✅ --probe-write：写权限验证通过，当前无待推送 ref。");
		process.exit(0);
	}
}

// ── 5. 分批推送（批失败时逐个重试，定位到具体 ref）───────────────────────────
const tasks = [
	...branchPlan.missing.map((i) => ({ kind: "branches", name: i.name, refspec: `refs/remotes/${remoteName}/${i.name}:refs/heads/${i.name}` })),
	...branchFf.map((i) => ({ kind: "branches", name: i.name, refspec: `refs/remotes/${remoteName}/${i.name}:refs/heads/${i.name}` })),
	...(force ? branchDiverged.map((i) => ({ kind: "branches", name: i.name, refspec: `+refs/remotes/${remoteName}/${i.name}:refs/heads/${i.name}` })) : []),
	...tagPlan.missing.map((i) => ({ kind: "tags", name: i.name, refspec: `refs/tags/${i.name}:refs/tags/${i.name}` })),
	...tagFf.map((i) => ({ kind: "tags", name: i.name, refspec: `refs/tags/${i.name}:refs/tags/${i.name}` })),
	...(force ? tagDiverged.map((i) => ({ kind: "tags", name: i.name, refspec: `+refs/tags/${i.name}:refs/tags/${i.name}` })) : []),
];

const pushArgs = force ? ["push", "--force", targetUrl] : ["push", targetUrl];
const failures = [];
let pushedOk = 0;

for (let start = 0; start < tasks.length; start += batchSize) {
	const batch = tasks.slice(start, start + batchSize);
	const result = git([...pushArgs, ...batch.map((t) => t.refspec)], { allowFail: true });
	if (result.ok) {
		pushedOk += batch.length;
		console.log(`   ✔️ 推送 ${batch.length} 个 ref（${batch.map((t) => t.name).join("、")}）`);
		continue;
	}
	// 批量推送只要有一个 ref 被拒就整体非 0，因此在批内逐个重试以给出精确结论
	console.log(`   ⚠️ 批量推送失败，逐个重试以定位：${redact(result.out).trim().split("\n").slice(0, 3).join(" | ")}`);
	for (const task of batch) {
		const single = git([...pushArgs, task.refspec], { allowFail: true });
		if (single.ok) {
			pushedOk += 1;
			console.log(`   ✔️ 推送 ${shortRef(task.kind, task.name)}`);
		} else {
			failures.push({ ...task, error: single.out.trim() });
			console.log(`   ❌ 推送 ${shortRef(task.kind, task.name)} 失败`);
		}
	}
}

// ── 6. 复核：以 AtomGit 实际返回的 SHA 为准，不只看 git push 的退出码 ─────────
console.log("🔎 复核 AtomGit 侧 refs …");
const verifyRefs = lsRemote(authUrl(), "AtomGit");
const mismatches = [];
for (const task of tasks) {
	if (failures.some((f) => f.kind === task.kind && f.name === task.name)) continue;
	const map = task.kind === "tags" ? verifyRefs.tags : verifyRefs.heads;
	const expected = (task.kind === "tags" ? ghRefs.tags : ghRefs.heads).get(task.name);
	if (map.get(task.name) !== expected) mismatches.push({ kind: task.kind, name: task.name, got: map.get(task.name) ?? "(缺失)" });
}

console.log("");
console.log("📦 AtomGit refs 同步结果");
console.log(`   GitHub 侧：分支 ${ghRefs.heads.size}、标签 ${ghRefs.tags.size}`);
console.log(`   本次推送成功 ${pushedOk} 个，推送失败 ${failures.length} 个，复核不一致 ${mismatches.length} 个`);
if (branchPlan.agOnly.length || tagPlan.agOnly.length) {
	console.log(`   AtomGit 独有（仅报告，未删除）：${[...branchPlan.agOnly, ...tagPlan.agOnly].join("、")}`);
}
for (const item of failures) {
	console.log(`   ❌ ${shortRef(item.kind, item.name)}：${item.error.split("\n").slice(0, 2).join(" | ")}`);
}
for (const item of mismatches) {
	console.log(`   ❌ ${shortRef(item.kind, item.name)}：复核 SHA 为 ${String(item.got).slice(0, 8)}，期望 ${String((item.kind === "tags" ? ghRefs.tags : ghRefs.heads).get(item.name)).slice(0, 8)}`);
}

if (failures.length || mismatches.length) {
	annotate("error", `AtomGit refs 同步未完全成功：失败 ${failures.length} 个、复核不一致 ${mismatches.length} 个。`);
	process.exit(1);
}
console.log("✅ AtomGit 的 git refs 已与 GitHub 一致。");
