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
// 2026-11-18：根目录也可能写成 const WEB = path.resolve(here, "../src/main/web")。
// 上面那条只认字面量以 src/ 开头，这种写法既不进 sourceOnly、也不进 sourceOnlyBlocks，
// 判据整个看不见它，于是报「新增 0」——tests/webI18nCoverage.test.mjs 就是这样漏的。
const SOURCE_ROOT_RESOLVE = /\b(?:const|let)\s+\w+\s*=\s*(?:path\.)?resolve\([^)]*["'`]\.\.\/src\//;
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
	// 参数是表达式时上面两条都中不了：loadTsCommonJs(join(process.cwd(), …))、
	// loadTsCommonJs(resolve(import.meta.dirname, "../src/…"))、模板串。只要发生
	// 调用就是在运行时加载真模块，路径怎么拼不影响这一点。
	/loadTsCommonJs\s*\(/,
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

// 2026-11-24：路径经过一层包装函数时，上面三条都看不见。
// 反例（真发生过）：tests/jumpChainIntegrity.test.mjs 开头写
//   const read = (p) => readFileSync(p, "utf8");
// 全文零运行时加载，靠 read("src/…") 读源码 —— 是 sourceOnly 文件，
// 却因为字面量里没有 readFileSync("src/…") 而完全绕过门禁。
const READER_WRAPPER = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*[^)]*\)\s*=>\s*readFileSync\s*\(/g;
function readsSourceViaWrapper(source) {
	for (const match of source.matchAll(READER_WRAPPER)) {
		const name = match[1];
		const call = new RegExp("\\b" + name + "\\(\\s*[\"'`]src/");
		if (call.test(source)) return true;
	}
	return false;
}
function isSourceOnly(source) {
	const readsSource = SOURCE_READ.some((re) => re.test(source)) || ((SOURCE_ROOT_DECL.test(source) || SOURCE_ROOT_RESOLVE.test(source)) && /readFileSync\(/.test(source)) || readsSourceViaWrapper(source);
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

// 2026-11-11：文件粒度可被一行运行时加载洗白——文件里 99 条源码断言 + 1 条
// loadTsCommonJs 调用，isSourceOnly 直接返回 false，整文件放行（判据被绕过）。
// 新增文件改为块级判定：任一个 test(…) 块读源码且该块内没有运行时加载就红。
const sourceOnlyBlocks = (source) => [...source.matchAll(/\ntest\(\s*["'\x60](.+?)["'\x60][\s\S]*?(?=\ntest\(|$)/g)].filter((m) => isSourceOnly(m[0])).map((m) => m[1]);
const allBlocks = [];
for (const file of testFiles) {
	const rel = relativePath(file);
	for (const name of sourceOnlyBlocks(readFileSync(file, "utf8"))) allBlocks.push(rel + " → " + name);
}
const baselineBlocks = new Set(baseline.sourceOnlyBlocks ?? []);

if (UPDATE) {
	writeFileSync(BASELINE_FILE, `${JSON.stringify({ capturedAt: new Date().toISOString().slice(0, 10), total: testFiles.length, sourceOnly, sourceOnlyBlocks: allBlocks }, null, "\t")}\n`, "utf8");
	console.log(`[check-test-shape] 基线已刷新：${sourceOnly.length} / ${testFiles.length} 个测试文件是 sourceOnly，块级存量 ${allBlocks.length}`);
	process.exit(0);
}

// 已知绕过登记（scripts/testShapeBypass.json）。
//
// 为什么需要：这 34 个文件用包装函数读源码，2026-11-25 补了识别规则才被看见。
// 批量改成行为断言会把好好的测试改坏，所以先登记理由、逐个改 —— 但登记不是永久豁免：
// 它们一旦改成行为断言或被删掉，本判据必须提示「从登记里移除」，否则登记会烂在那里。
// 反例（这是 pr2 提出的）：只把文件名刷进基线，那 34 个就与普通存量并列，
// 半年后没人知道它们为什么在那儿；改成行为断言或删掉时，数字悄悄变小，没人知道。
const BYPASS_FILE = join(ROOT, "scripts/testShapeBypass.json");
const wrapperOnly = testFiles
	.filter((file) => {
		const text = readFileSync(file, "utf8");
		if (!isSourceOnly(text)) return false;
		// 只算「旧三条规则看不见、全靠包装识别才进 sourceOnly」的那些：
		// 两路都命中的文件旧规则本来就会算进去，不该混进这张待改清单。
		const legacy = SOURCE_READ.some((re) => re.test(text)) || ((SOURCE_ROOT_DECL.test(text) || SOURCE_ROOT_RESOLVE.test(text)) && /readFileSync\(/.test(text));
		return readsSourceViaWrapper(text) && !legacy;
	})
	.map(relativePath)
	.sort();

if (existsSync(BYPASS_FILE)) {
	const bypass = JSON.parse(readFileSync(BYPASS_FILE, "utf8"));
	const listed = new Set(bypass.knownBypass ?? []);
	const scanned = new Set(wrapperOnly);
	// 双向相等。只判一向是单向门禁：
	//   regOnly（登记有、扫描没有）= 登记里的文件改好了或被删了 → 该从登记移除
	//   scanOnly（扫描有、登记没有）= 文件在豁免、却没人记得为什么 → 理由静默消失
	// 反例（pr2 2026-11-25 实测）：从 knownBypass 删掉 acpBackendSwitch.test.mjs，
	// 文件仍存在仍是 sourceOnly，rc 依然 0 —— 那条理由就这么无声无息地没了。
	const regOnly = [...listed].filter((f) => !scanned.has(f));
	const scanOnly = [...scanned].filter((f) => !listed.has(f));
	if (regOnly.length > 0) {
		console.error(`[check-test-shape] 登记里的 ${regOnly.length} 个文件已不再是「仅包装命中」：`);
		for (const f of regOnly.slice(0, 10)) console.error(`  - ${f}`);
		console.error("请从 scripts/testShapeBypass.json 的 knownBypass 里删掉它们——那份登记只记当前状态。");
		process.exit(1);
	}
	if (scanOnly.length > 0) {
		console.error(`[check-test-shape] ${scanOnly.length} 个文件靠包装函数读源码、没跑真模块，但不在登记里：`);
		for (const f of scanOnly.slice(0, 10)) console.error(`  - ${f}`);
		console.error("请加进 scripts/testShapeBypass.json 的 knownBypass 并写清 why（或改成行为断言）。");
		console.error("不写理由的豁免，半年后没人知道它为什么在那儿。");
		process.exit(1);
	}
}

const added = sourceOnly.filter((file) => !known.has(file));
const retired = [...known].filter((file) => !sourceOnly.includes(file)).length;
const newBlocks = allBlocks.filter((key) => !baselineBlocks.has(key));

if (added.length > 0 || newBlocks.length > 0) {
	console.error(`[check-test-shape] 新增了 ${added.length} 个「只读源码」的测试文件、${newBlocks.length} 个只读源码的 test 块：`);
	for (const file of added) console.error(`  - ${file}`);
	for (const row of newBlocks) console.error(`  - 块级：${row}`);
	console.error("\n这类测试对行为零验证，却会在搬迁/改名/换实现时红掉。改成运行时断言：\n" + "  - 直接加载生产模块：tests/helpers/loadTsCommonJs.mjs\n" + "  - 需要 stub 依赖：tests/helpers/createTsSandbox.mjs\n" + "若确实无法运行时验证（例如只校验构建产物结构），用 --update 更新基线并在 PR 说明理由。");
	process.exit(1);
}

console.log(`[check-test-shape] ok：sourceOnly ${sourceOnly.length} / ${testFiles.length} 个测试文件，块级存量 ${allBlocks.length} / 基线 ${baselineBlocks.size}（新增 0${retired > 0 ? `，存量文件已减 ${retired}` : ""}）`);
