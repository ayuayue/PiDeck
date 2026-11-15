#!/usr/bin/env node
// check-version-not-lower.mjs —— PR 的 package.json version 不得低于 base 分支。
//
// 为什么存在：2026-11-15 实测，PR #552 的分支从某个 0.6.x 的 dev 拉出来之后长期没 rebase，
// 而 dev 已升到 0.12.0。分支里那一行还是 0.6.72，合并时取 PR 侧就是版本倒退。
// 版本倒退会让更新机制把新包判成旧包（Updater 比版本号，不比时间）。
//
// 为什么不算风格问题：这个 PR 里其余生成物（skills-manifest.json、fileSizeBaseline.json）
// 都是「按内容生成」的，跑生成器就对；只有 version 是人写的、按时间单调增，出现在这里没有理由。
//
// 口径上限：只比 semver 三段数字，不认预发布后缀（0.12.0-beta 按 0.12.0 算）。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseVersion(v) {
	const m = String(v || "")
		.trim()
		.match(/^(\d+)\.(\d+)\.(\d+)/);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersion(head, base) {
	const a = parseVersion(head);
	const b = parseVersion(base);
	if (!a || !b) return null;
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return 0;
}

// 显式传的 ref 优先于环境变量：CI 里 GITHUB_BASE_REF 恒有值（dev），若让它压过命令行，
// workflow 传的 -- <base.sha> 永远用不上（2026-11-15 评审实测：Dev Guard 第 8 步显示绿，
// 日志却是 SKIP 取不到 base 版本（origin/dev），因为 fetch-depth:1 没拉这个引用）。
export function resolveBaseRef(explicit, envBaseRef) {
	if (explicit) return explicit;
	if (envBaseRef) return "origin/" + envBaseRef;
	return "origin/dev";
}

function versionOf(ref) {
	const text = execFileSync("git", ["show", ref + ":package.json"], { cwd: ROOT, encoding: "utf8" });
	return JSON.parse(text).version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--selftest")) {
		const cases = [
			["同版本 → 绿", "0.12.0", "0.12.0", 0],
			["高版本 → 绿", "0.12.1", "0.12.0", 1],
			["低版本 → 负", "0.6.72", "0.12.0", -1],
			["字符串比较会判错的例子", "0.9.0", "0.12.0", -1],
			["大版本低 → 负", "0.12.0", "1.0.0", -1],
		];
		let fail = 0;
		for (const [name, head, base, wantSign] of cases) {
			const got = compareVersion(head, base);
			const ok = wantSign === 0 ? got === 0 : wantSign > 0 ? got > 0 : got < 0;
			if (!ok) {
				fail++;
				console.log("FAIL 自检坏样本：" + name + " → " + got);
			}
		}
		const extra = [
			["显式 sha 优先于环境变量", resolveBaseRef("abc123", "dev") === "abc123"],
			["无显式时用环境变量", resolveBaseRef(undefined, "dev") === "origin/dev"],
			["都没有时退 origin/dev", resolveBaseRef(undefined, undefined) === "origin/dev"],
			["显式带 origin 前缀原样用", resolveBaseRef("origin/main", "dev") === "origin/main"],
			["空串解析为 null", parseVersion("") === null],
			["非数字解析为 null", parseVersion("abc") === null],
		];
		for (const [name, ok] of extra)
			if (!ok) {
				fail++;
				console.log("FAIL 自检坏样本：" + name);
			}
		if (fail) {
			console.log("自检失败 " + fail + " 条");
			process.exit(1);
		}
		console.log("selftest PASS：" + (cases.length + extra.length) + " 条");
		process.exit(0);
	}
	const explicit = process.argv.slice(2).find((a) => !a.startsWith("-"));
	const baseRef = resolveBaseRef(explicit, process.env.GITHUB_BASE_REF);
	const head = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
	let base;
	try {
		base = versionOf(baseRef);
	} catch (e) {
		// 显式给了输入却读不到，不能当「没事」滑过：那正是这条判据要抓的静默放行。
		if (explicit) {
			console.log("FAIL 显式指定的 base 取不到（" + baseRef + "）：" + String(e).slice(0, 80));
			process.exit(1);
		}
		console.log("SKIP 取不到 base 版本（" + baseRef + "，没显式指定 ref）：" + String(e).slice(0, 80));
		process.exit(0);
	}
	const cmp = compareVersion(head, base);
	if (cmp === null) {
		console.log("FAIL 版本号解析不出数字：head=" + head + " base=" + base);
		process.exit(1);
	}
	if (cmp < 0) {
		console.log("FAIL 版本倒退：head " + head + " < base(" + baseRef + ") " + base + "。合并会降版本，更新机制会把新包判成旧包。");
		process.exit(1);
	}
	console.log("PASS 版本不倒退：head " + head + " ≥ base(" + baseRef + ") " + base);
}
