#!/usr/bin/env node
/**
 * 巨文件门禁（机械落地 `docs/architecture.md` §文件体量 与 `docs/mega-file-split-plan.md`）。
 *
 *   node scripts/check-file-size.mjs            # 校验（CI / 本地）
 *   node scripts/check-file-size.mjs --update   # 拆完之后收紧基线（额度只降不升）
 *
 * 三条规则（与 docs 口径一致）：
 * 1. `hard` 基线（首版 = 现存 >600 行的存量巨文件）**不得净增长**：行数 > 基线值 → 红。
 * 2. 不在 `hard` 里的文件 **> 600 行 → 红**（新增或从 ≤400 长大：先写拆分计划再合入）。
 * 3. 不在 `hard`/`soft` 里的文件 400–600 行 → 黄（提示；`soft` 记录冻结时就在这个区间的存量文件，不打扰）。
 *
 * 为什么要有 `soft`：400–600 区间有一百多个存量文件，每次跑都提示一遍就是噪音；
 * 只对「第一次越过 400 行」的文件说一次，靠 `--update` 把它归档进 `soft`。
 *
 * 豁免：`/i18n/` 下的词典与生成物（`rendererCopy.*`、`*.zh-TW.ts`、manifest）——同一份文案
 * 天然上千行，按域拆只会把 4 个 locale 的同步成本翻倍（见 `docs/architecture.md`）。
 *
 * 只读 src/，无网络，约 0.2 秒。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOT = join(ROOT, "src");
const BASELINE_FILE = join(ROOT, "scripts/fileSizeBaseline.json");

/** 巨文件硬线：超过就必须有拆分计划。 */
const MAX_NEW = 600;
/** 单文件目标上限：超过只提示。 */
const SOFT_NEW = 400;

const EXEMPT_DIR = /(^|\/)i18n\//;
const SOURCE_FILE = /\.(ts|tsx|mjs|cjs|js)$/;

function* walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			yield* walk(path);
		} else if (SOURCE_FILE.test(entry.name)) {
			yield path;
		}
	}
}

function lineCount(path) {
	const source = readFileSync(path, "utf8");
	if (source.length === 0) return 0;
	const newlines = source.match(/\n/g)?.length ?? 0;
	return source.endsWith("\n") ? newlines : newlines + 1;
}

function collect() {
	const files = new Map();
	for (const path of walk(SCAN_ROOT)) {
		if (!statSync(path).isFile()) continue;
		const rel = relative(ROOT, path).split("\\").join("/");
		if (EXEMPT_DIR.test(rel)) continue;
		files.set(rel, lineCount(path));
	}
	return files;
}

const files = collect();
const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : {};
const hard = baseline.hard ?? {};
const soft = new Set(baseline.soft ?? []);
const update = process.argv.includes("--update");

if (update) {
	const nextHard = {};
	const nextSoft = [];
	for (const [path, lines] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const previous = hard[path];
		const ceiling = previous === undefined ? lines : Math.min(previous, lines);
		if (ceiling > MAX_NEW) nextHard[path] = ceiling;
		else if (lines > SOFT_NEW) nextSoft.push(path);
	}
	const tightened = Object.entries(nextHard).filter(([path, lines]) => hard[path] !== undefined && lines < hard[path]);
	const dropped = Object.keys(hard).filter((path) => nextHard[path] === undefined);
	writeFileSync(BASELINE_FILE, `${JSON.stringify({ hard: nextHard, soft: nextSoft }, null, "\t")}\n`);
	console.log(`[check-file-size] 基线更新：hard ${Object.keys(hard).length} → ${Object.keys(nextHard).length} 条，soft ${soft.size} → ${nextSoft.length} 条`);
	for (const [path, lines] of tightened) console.log(`  ↓ 收紧 ${path}：${hard[path]} → ${lines}`);
	for (const path of dropped) console.log(`  ✓ 出基线 ${path}（已 ≤${MAX_NEW} 行）`);
	process.exit(0);
}

const failures = [];
const hints = [];

for (const [path, lines] of [...files.entries()].sort((a, b) => b[1] - a[1])) {
	const ceiling = hard[path];
	if (ceiling !== undefined) {
		if (lines > ceiling) failures.push(`${path}：${lines} 行 > 基线 ${ceiling}（净增长 ${lines - ceiling} 行，新逻辑放新模块）`);
		continue;
	}
	if (lines > MAX_NEW) {
		failures.push(`${path}：${lines} 行 > ${MAX_NEW}，先写拆分计划（docs/mega-file-split-plan.md）再合入`);
	} else if (lines > SOFT_NEW && !soft.has(path)) {
		hints.push(`${path}：${lines} 行 > ${SOFT_NEW}（单文件目标 ≤400）`);
	}
}

const releasable = Object.entries(hard).filter(([path, ceiling]) => files.has(path) && files.get(path) < ceiling);
const stale = Object.keys(hard).filter((path) => !files.has(path));

for (const [path, ceiling] of releasable.slice(0, 10)) {
	console.log(`[check-file-size] 可收紧 ${path}：${files.get(path)} < 基线 ${ceiling}`);
}
if (releasable.length > 10) console.log(`[check-file-size] 另有 ${releasable.length - 10} 个文件可收紧`);
for (const path of stale) console.warn(`[check-file-size] 提示 ${path}：基线条目已不存在，跑 --update 清理`);
for (const line of hints) console.warn(`[check-file-size] 提示 ${line}`);

if (failures.length > 0) {
	console.error(`[check-file-size] ${failures.length} 处违规：`);
	for (const line of failures) console.error(`  - ${line}`);
	console.error("\n口径：存量巨文件（>600 行）行数只准降不准升；新文件 >400 行需说明、>600 行需先写拆分计划。" + "\n拆完一波跑 `node scripts/check-file-size.mjs --update` 收紧基线，回涨立刻被发现。");
	process.exit(1);
}

console.log(`[check-file-size] ok：${files.size} 个源文件，hard 基线 ${Object.keys(hard).length} 条` + (releasable.length > 0 ? `，${releasable.length} 个可收紧（跑 --update）` : ""));
