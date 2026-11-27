#!/usr/bin/env node
/**
 * PiDeck 交付脚本：**只交付完整安装包**，并清掉其它形态的产物。
 *
 * 一条命令做完：全格式打包（nsis 安装包 + portable + zip）→ 校验产物 → 校验内嵌 asar
 * 的修复符号 → 打印路径与 sha16 → 删除解包目录等重复产物。
 *
 * 为什么不再交付 `--dir` 解包目录（release-dev / win-unpacked 单独拷出去）：
 * 2026-11-26 连续三次「已部署」都写在用户没在跑的目录上（AppData\Local\Programs），
 * 用户每次都说「还是没好」。解包目录没有版本号、没有安装记录、可以同时存在几份 ——
 * 「我改的是哪一份」本身不可判。安装包只有一个版本号，装完就是它。
 *
 *
 * **本脚本只打包，不安装、不关闭应用。** 装与重启由用户自己点（2026-11-26 用户原话
 * 「下次我自己点，你别强制关」）。装完用 verify-installed-pideck.mjs 校验「他跑的那份」。
 * 用法：
 *   node deliver-pideck.mjs             打包 + 校验 + 清理
 *   node deliver-pideck.mjs --no-build  只校验 + 清理（产物已存在时）
 *   node deliver-pideck.mjs --keep-dir  保留 release-dev（默认删）
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

// 打包目录必须显式给：v099 与 jump-rw2 是两个 worktree，同一个仓的两条线。
// 2026-11-27 实测：v099(P3, 9202a8f6b) 不含 #625 的任何提交（929ff4404 32 轮取页、
// 60c304c6e、258738901、72b08e3af 全部「无」），而它们全在 jump-rw2(72b08e3af)。
// 旧版这里硬编码 v099 —— 打出来的包符号名齐全、sha 也对，但实现是旧的，
// 用户装上仍是「跳转还是很慢」。符号名不是新代码的证明（同名不同实现）。
// 不给 --repo 就退出，不猜。旧版默认 v099 —— 而 v099 不是要交付的那条线，
// 靠第二条判据兜住是「靠别处挡住」，默认值本身仍然是错的：
// 将来 v099 若也有那些提交，就会静默打出一条混线包。
const repoArg = process.argv.indexOf("--repo");
if (repoArg < 0 || !process.argv[repoArg + 1]) {
	console.error("必须给 --repo <打包目录>（如 C:/Users/15066212pp/src/PiDeck/jump-rw2）；不猜默认值。");
	process.exit(2);
}
const REPO = process.argv[repoArg + 1];
const argv = process.argv.slice(2);
const skipBuild = argv.includes("--no-build");
const keepDir = argv.includes("--keep-dir");

const sha16 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
/**
 * 每个修复一个符号：交付前必须全部出现在 asar 里，缺就说明打的不是这一版。
 *
 * **但符号名只证明「有同名函数」，证明不了「新实现」。** 2026-11-27 实测：
 * 同一个仓里两条线互有对方没有的符号，而同名符号在两边的实现并不相同。
 * 所以每个符号标所属线，按打包目录所在线判定 —— 不是「全都在」才算过。
 *
 *   "both"      两条线都该有（跨线的稳定修复）
 *   "jump-rw2"  只在 #625 这条线（origin/dev + 32 轮取页 + 状态栏同源）
 *   "v099"      只在 #612 那条线（P1/P2/P3 跳转重写）
 *
 * 判据：对 jump-rw2 打包时，"v099" 那组缺席**不算错**（实测 10 个全 0）；
 * 反之亦然。这是「缺席」被写成「失败」的典型误报，不是修复缺失。
 */
const SYMBOLS = [
	// 两条线都有的稳定修复（实测两边均 > 0）。
	["listProjectPrompts", "both"],
	// 11-26 那批（sameJumpEntry 等）只在 v099；实测 v099=1..4 文件、jump-rw2=0。
	// 2026-11-27 状态栏与导轨同源（72b08e3af）——只在 jump-rw2。
	["sessionTurnCountOf", "jump-rw2"],
	// mergeOutlineRailItems **不能**区分线：v099 里也有它（SessionOutlinePanel.tsx /
	// SessionSurfaceStage.tsx / timeline/outlineRailTicks.ts 三处），实测 grep -rl。
	// 能区分 jump-rw2 的只有 sessionTurnCountOf（v099=0 文件 / jump-rw2=2 文件）。
	// 这条写错会让下一个判线的人照抄错表——2026-11-27 组 1 当场指出。
	["mergeOutlineRailItems", "both"],
	// 2026-11-26 跳转链那批（三处判据合流 / 认不出就说 / 选因不硬编码）——只在 v099。
	["sameJumpEntry", "v099"],
	["jumpEntryKey", "v099"],
	["resolveStaleTargetReason", "v099"],
	["JUMP_TARGET_WAIT_UNINDEXED_FRAMES", "v099"],
	["insertByOrdinal", "v099"],
	["toMessageEpochMs", "v099"],
	["visibleInViewport", "v099"],
	["messageIdentityKey", "v099"],
	["resolveLiveThinkingKey", "v099"],
	["patchWindowWithRicher", "v099"],
];
/** 打包目录属于哪条线：按 HEAD 里有没有该线的锚提交判，不看目录名。 */
function lineOfRepo(repo) {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", "72b08e3af", "HEAD"], { cwd: repo, stdio: "ignore" });
		return "jump-rw2";
	} catch {
		return "v099";
	}
}

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const version = pkg.version;
const releaseDir = join(REPO, "release");
// 硬判据：这些提交必须在打包目录的 HEAD 里。缺一个 = 打的不是这一版，拒打。
// 符号名只能证明「有同名函数」，证明不了「新实现」——2026-11-27 就是靠这条才看出
// 18:07 那个包的实现是旧的（v099 四个修复提交全无，符号名却全在）。
const REQUIRED_COMMITS = [
	// 只列**能区分这两条线**的提交。缺任何一个，打出来的包就不是这一版。
	["929ff4404", "跳转取页 200 轮 -> 32 轮（#625 性能）"],
	["60c304c6e", "取页索引空间判据（tests/，无功能差异但同属这条线）"],
	["258738901", "timestamp 判据（tests/，同上）"],
	["72b08e3af", "状态栏轮数与导轨同源（那个「多出来的刻度」）"],
];
const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
const missingCommits = REQUIRED_COMMITS.filter(([sha]) => {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: REPO, stdio: "ignore" });
		return false;
	} catch {
		return true;
	}
});
if (missingCommits.length > 0) {
	console.error("✗ 打包目录 " + REPO + "（HEAD " + head + "）缺这些提交，打的不是这一版：");
	for (const [sha, why] of missingCommits) console.error("    " + sha + "  " + why);
	console.error("  换 --repo 指向含这些提交的 worktree 再打。");
	process.exit(1);
}
console.log("  HEAD " + head + " 已含必需的 " + REQUIRED_COMMITS.length + " 个提交");

if (!skipBuild) {
	console.log("[1/3] 全格式打包 v" + version + "（nsis + portable + zip）…");
	execFileSync("npm", ["run", "dist:win"], { cwd: REPO, stdio: "inherit", shell: true });
} else {
	console.log("[1/3] 跳过打包（--no-build）");
}

console.log("[2/3] 校验产物");
const artifacts = [
	[join(releaseDir, "PiDeck-" + version + "-setup.exe"), "安装包 (nsis)", true],
	[join(releaseDir, "PiDeck-" + version + "-setup.exe.blockmap"), "增量更新 blockmap", false],
	[join(releaseDir, "latest.yml"), "自动更新清单", false],
	[join(releaseDir, "PiDeck-" + version + "-portable.exe"), "免安装", false],
	[join(releaseDir, "PiDeck-" + version + "-win.zip"), "压缩包", false],
];
let failed = 0;
for (const [path, label, required] of artifacts) {
	if (!existsSync(path)) {
		if (required) {
			console.error("  ✗ 缺少必需产物：" + label + " → " + path);
			failed++;
		}
		continue;
	}
	console.log("  " + label.padEnd(20) + statSync(path).size + "B  sha16=" + sha16(readFileSync(path)) + "  " + path);
}

const asarPath = join(releaseDir, "win-unpacked", "resources", "app.asar");
if (existsSync(asarPath)) {
	const asar = readFileSync(asarPath);
	const asarText = asar.toString("latin1");
	const line = lineOfRepo(REPO);
	const hits = {};
	const notThisLine = [];
	for (const [sym, owner] of SYMBOLS) {
		const n = asarText.split(sym).length - 1;
		hits[sym] = n;
		if (n === 0 && owner !== "both" && owner !== line) notThisLine.push(sym + "(" + owner + ")");
	}
	console.log("  app.asar            " + asar.length + "B  sha16=" + sha16(asar));
	console.log("  本条线 " + line + " 的修复符号 " + JSON.stringify(hits));
	if (notThisLine.length > 0) console.log("  不属于本条线（不算错）：" + notThisLine.join(", "));
	const missing = SYMBOLS.filter(([sym, owner]) => (owner === "both" || owner === line) && hits[sym] === 0).map(([sym]) => sym);
	if (missing.length > 0) {
		console.error("  ✗ 本条线该有的符号缺失：" + missing.join(", "));
		failed++;
	}
} else {
	console.error("  ✗ 找不到 win-unpacked/app.asar：打包没完成");
	failed++;
}

console.log("[3/3] 清理重复产物");
const redundant = [[join(REPO, "release-dev"), "dev 解包目录（与安装包重复）"]];
for (const [path, label] of redundant) {
	if (!existsSync(path)) continue;
	if (keepDir) {
		console.log("  保留 " + label + "：" + path);
		continue;
	}
	rmSync(path, { recursive: true, force: true });
	console.log("  已删 " + label + "：" + path);
}

if (failed > 0) {
	console.error("✗ 校验失败，不要交付");
	process.exit(1);
}
console.log("✓ 可以交付：安装包 " + join(releaseDir, "PiDeck-" + version + "-setup.exe"));
