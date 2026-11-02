#!/usr/bin/env node
/**
 * 单测形态增量门禁：禁止新增「只读源码字符串、零运行时验证」的测试。
 *
 *   node scripts/check-test-shape.mjs           # 校验（CI / 本地门禁）
 *   node scripts/check-test-shape.mjs --update  # 存量变化后刷新基线（需在 PR 里说明理由）
 *
 * 背景：`tests/` 里有一批测试只 `readFileSync` 生产源码再用正则断言「这行代码长什么样」。
 * 它们对行为零验证，却会在任何搬迁/改名/换实现时红掉（2026-10 死代码清理撞了 5 处），
 * 并且能反向掩盖 bug（正则匹配得上、行为已经坏了）。
 *
 * 判定「sourceOnly」需同时满足：
 *   1. 读了生产源码文本（`readFileSync("src/…")`，或先声明 `const root = "src/…"` 再 read）；
 *   2. 没有运行时加载生产模块（`loadTsCommonJs("src/…")`、`from "../src/…"`、`await import("../src/…")`）。
 * 只要跑过真模块（哪怕同时读源码），就算行为测试，不在门禁范围内。
 *
 * 基线是**存量快照**，本次门禁不要求迁移任何现有测试；新增测试走行为断言即可。
 * 正确姿势见 tests/helpers/loadTsCommonJs.mjs（直接加载生产 TS 模块）与
 * tests/helpers/createTsSandbox.mjs（需要 stub 依赖时）。
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = join(ROOT, "scripts/testShapeBaseline.json");
const UPDATE = process.argv.includes("--update");

// `readFileSync(new URL("../src/…", import.meta.url))` 也要算：2026-11 那个「分批扩窗」守卫
// 就是用这个写法躲过门禁的——三条正则都没覆盖它，于是被当成行为测试放行。
const SOURCE_READ = [/readFileSync\(\s*["'`]src\//, /readFileSync\(\s*`\$\{root\}/, /readFileSync\(\s*join\(\s*["'`]src\//, /readFileSync\(\s*new URL\(\s*["'`]\.\.\/src\//];
const SOURCE_ROOT_DECL = /\b(?:const|let)\s+\w*(?:root|Root|SRC|src)\w*\s*=\s*["'`]src\//;
// 说明：`loadTsCommonJs(MODULE)`（路径先存常量再传入）同样是运行时加载真模块，
// 但字面量正则识别不到，会被误判成 sourceOnly（changelogSections / rendererVirtualization 就是如此）。
const RUNTIME_LOAD = [
	/loadTsCommonJs\(\s*["'\`]src\//,
	/loadTsCommonJs\(\s*[A-Za-z_$][\w$]*\s*[,)]/,
	/from\s+["'\`]\.\.\/src\//,
	/await\s+import\(\s*["'\`]\.\.\/src\//,
	/require\(\s*["'\`]\.\.\/src\//,
	// 任意 helper 用 src/… 路径加载生产模块都算运行时加载：createTsSandbox 的用法
	// （const load = createTsSandbox(); load("src/…")）就是把生产 TS 编译后放进 vm 执行，
	// 运行时断言一条不少，只是多了 stub 依赖。2026-11 曾被判成 sourceOnly —— 那是判据缺项。
	/\b\w*[Ll]oad\w*\(\s*["'\`]src\/[^"'\`]*\.[cm]?ts["'\`]/,
];

function collectTests(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) collectTests(path, out);
		else if (/\.test\.mjs$/.test(entry.name)) out.push(path);
	}
	return out;
}

/** `const loadTs = loadTsCommonJs;` 这类别名：别名调用也是运行时加载真模块。 */
const LOAD_ALIAS = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*loadTsCommonJs\s*;/g;

function hasRuntimeLoad(source) {
	if (RUNTIME_LOAD.some((re) => re.test(source))) return true;
	for (const match of source.matchAll(LOAD_ALIAS)) {
		if (new RegExp(`\\b${match[1]}\\s*\\(`).test(source)) return true;
	}
	return false;
}

function isSourceOnly(source) {
	const readsSource = SOURCE_READ.some((re) => re.test(source)) || (SOURCE_ROOT_DECL.test(source) && /readFileSync\(/.test(source));
	if (!readsSource) return false;
	return !hasRuntimeLoad(source);
}

const testFiles = collectTests(join(ROOT, "tests"));
const relativePath = (file) => relative(ROOT, file).split(sep).join("/");
const sourceOnly = testFiles
	.filter((file) => isSourceOnly(readFileSync(file, "utf8")))
	.map(relativePath)
	.sort();

const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : { sourceOnly: [] };
const known = new Set(baseline.sourceOnly ?? []);

if (UPDATE) {
	writeFileSync(BASELINE_FILE, `${JSON.stringify({ capturedAt: new Date().toISOString().slice(0, 10), total: testFiles.length, sourceOnly }, null, "\t")}\n`, "utf8");
	console.log(`[check-test-shape] 基线已刷新：${sourceOnly.length} / ${testFiles.length} 个测试文件是 sourceOnly`);
	process.exit(0);
}

const added = sourceOnly.filter((file) => !known.has(file));
const retired = [...known].filter((file) => !sourceOnly.includes(file)).length;

if (added.length > 0) {
	console.error(`[check-test-shape] 新增了 ${added.length} 个「只读源码」的测试：`);
	for (const file of added) console.error(`  - ${file}`);
	console.error("\n这类测试对行为零验证，却会在搬迁/改名/换实现时红掉。改成运行时断言：\n" + "  - 直接加载生产模块：tests/helpers/loadTsCommonJs.mjs\n" + "  - 需要 stub 依赖：tests/helpers/createTsSandbox.mjs\n" + "若确实无法运行时验证（例如只校验构建产物结构），用 --update 更新基线并在 PR 说明理由。");
	process.exit(1);
}

console.log(`[check-test-shape] ok：sourceOnly ${sourceOnly.length} / ${testFiles.length} 个测试文件（基线 ${known.size}，新增 0${retired > 0 ? `，存量已减 ${retired}` : ""}）`);
