#!/usr/bin/env node
/**
 * 面板基线（A0 + P + S/T 的未提交成果）显式同步工具。
 *
 * F/G 从 `24529c394` 新建 worktree 时**不会**继承这些未提交文件。本工具把「同一份基线」变成
 * 可校验、可重入的动作，而不是口头约定：
 *
 *   node scripts/panel-baseline.mjs write                 # 在集成工作区重建清单（公共文件单写者执行）
 *   node scripts/panel-baseline.mjs verify [--dir <dir>]  # 只校验：每个文件 sha256 是否等于清单
 *   node scripts/panel-baseline.mjs sync --to <dir>       # 同步到 F/G 的 worktree（先查冲突，再写入）
 *
 * 规则：
 * - 清单 `docs/panel-service-baseline.manifest`：每行 `<sha256>  <相对仓库根的路径>`；
 *   清单自身不在清单内（它是参照物）。
 * - sync 只覆盖「目标未被改动」的文件：目标已存在、内容既不是清单值、也不干净（相对它自己的 HEAD
 *   有改动）时，视为冲突并**整体中止**（先检查、后写入），绝不覆盖别人未提交的改动。
 * - 目标文件不存在（基线里的新增文件）→ 写入；已存在且等于清单值 → 跳过（可重入）。
 * - 源文件与清单不一致时整体中止：清单过期就必须先在集成工作区重建，不允许「半新半旧」的基线。
 *
 * 只读源、无网络；退出码：0 成功，1 校验不一致，2 冲突/中止。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_REL = "docs/panel-service-baseline.manifest";
const MANIFEST_PATH = join(ROOT, MANIFEST_REL);

function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function gitLines(cwd, args) {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
			.split(/\r?\n/)
			.filter(Boolean);
	} catch {
		return undefined;
	}
}

/** 工作树里相对 HEAD 的未提交/未跟踪文件（不含被忽略与 .agents 工作区）。 */
function dirtyFiles(cwd) {
	const lines = gitLines(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (lines === undefined) throw new Error(`not a git work tree: ${cwd}`);
	return lines.map((line) => line.slice(3)).filter((rel) => rel !== MANIFEST_REL && !rel.startsWith(".agents/"));
}

function readManifest() {
	if (!existsSync(MANIFEST_PATH)) throw new Error(`missing manifest: ${MANIFEST_REL}`);
	return readFileSync(MANIFEST_PATH, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "" && !line.startsWith("#"))
		.map((line) => {
			const separator = line.indexOf("  ");
			if (separator !== 64) throw new Error(`malformed manifest line: ${line}`);
			return { hash: line.slice(0, 64), rel: line.slice(66) };
		});
}

function write() {
	const files = dirtyFiles(ROOT)
		.filter((rel) => existsSync(join(ROOT, rel)))
		.sort();
	const lines = files.map((rel) => `${sha256(join(ROOT, rel))}  ${rel}`);
	writeFileSync(MANIFEST_PATH, `${lines.join("\n")}\n`, "utf8");
	console.log(`[panel-baseline] wrote ${lines.length} files -> ${MANIFEST_REL}`);
}

function verify(dir) {
	const entries = readManifest();
	const mismatches = [];
	for (const entry of entries) {
		const file = join(dir, entry.rel);
		if (!existsSync(file)) {
			mismatches.push(`missing ${entry.rel}`);
			continue;
		}
		const actual = sha256(file);
		if (actual !== entry.hash) mismatches.push(`mismatch ${entry.rel} (期望 ${entry.hash.slice(0, 12)}，实际 ${actual.slice(0, 12)})`);
	}
	if (mismatches.length > 0) {
		for (const line of mismatches) console.error(`[panel-baseline] ${line}`);
		console.error(`[panel-baseline] ${mismatches.length}/${entries.length} files differ from the baseline`);
		return 1;
	}
	console.log(`[panel-baseline] ok: ${entries.length} files match the baseline in ${dir}`);
	return 0;
}

/** 目标文件的归属：none=可写，equal=已是基线，dirty=有自己的改动（冲突）。 */
function targetState(dir, entry) {
	const file = join(dir, entry.rel);
	if (!existsSync(file)) return "none";
	if (sha256(file) === entry.hash) return "equal";
	const status = gitLines(dir, ["status", "--porcelain=v1", "--", entry.rel]);
	return status !== undefined && status.length === 0 ? "stale-clean" : "dirty";
}

function sync(to) {
	if (to === undefined) throw new Error("sync needs --to <dir>");
	const target = resolve(to);
	if (!existsSync(target)) throw new Error(`target does not exist: ${target}`);
	const entries = readManifest();
	// 源自己先对齐：清单过期时不允许把半新半旧的文件带到 F/G。
	const sourceDrift = entries.filter((entry) => !existsSync(join(ROOT, entry.rel)) || sha256(join(ROOT, entry.rel)) !== entry.hash);
	if (sourceDrift.length > 0) {
		for (const entry of sourceDrift) console.error(`[panel-baseline] 源已变更，先重建清单: ${entry.rel}`);
		return 2;
	}
	const plan = entries.map((entry) => ({ ...entry, action: targetState(target, entry) }));
	const conflicts = plan.filter((entry) => entry.action === "dirty");
	if (conflicts.length > 0) {
		for (const entry of conflicts) console.error(`[panel-baseline] 冲突（目标有未提交改动）: ${entry.rel}`);
		console.error(`[panel-baseline] 中止：${conflicts.length} 个目标文件与基线冲突，未写入任何文件`);
		return 2;
	}
	let written = 0;
	for (const entry of plan) {
		if (entry.action === "equal") continue;
		const file = join(target, entry.rel);
		mkdirSync(dirname(file), { recursive: true });
		copyFileSync(join(ROOT, entry.rel), file);
		if (sha256(file) !== entry.hash) throw new Error(`copy mismatch: ${entry.rel}`);
		written += 1;
	}
	const skipped = plan.length - written;
	console.log(`[panel-baseline] synced ${written} files into ${target} (${skipped} already equal)`);
	return verify(target);
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
	const index = rest.indexOf(name);
	return index === -1 ? undefined : rest[index + 1];
};

try {
	if (command === "write") write();
	else if (command === "verify") process.exitCode = verify(resolve(flag("--dir") ?? ROOT));
	else if (command === "sync") process.exitCode = sync(flag("--to"));
	else {
		console.error("usage: node scripts/panel-baseline.mjs <write|verify|sync> [--dir <dir>] [--to <dir>]");
		process.exitCode = 2;
	}
} catch (error) {
	console.error(`[panel-baseline] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 2;
}
