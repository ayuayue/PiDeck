/**
 * genZhTwCopy.mjs —— 繁体中文（台湾）文案生成器。
 *
 * 数据源是各层 zh-CN 词典：把每条文案经 opencc-js 的 s2twp 转换为台湾用语 + 繁体字形，
 * 再套 OVERRIDES 修正少量误配（opencc 的整串分词在个别词上会选错字，例如「只影响」
 * 被当成「隻影響」、「表面」被当成「錶面」）。
 *
 * 产物（全部为生成文件，禁止手改；改文案请改 zh-CN 源文件后重新运行本脚本）：
 *   src/renderer/src/i18n/rendererCopy.zh-TW.ts   ← rendererCopy.zh-CN.ts
 *   src/shared/i18n/mainProcessCopy.zh-TW.ts      ← mainProcessCopy.ts 的 mainProcessZhCN
 *   src/main/web/WebI18n.zh-TW.ts                 ← WebI18n.ts 的 webZhCN（web 客户端专属键）
 *   src/main/feishu/FeishuI18n.zh-TW.ts           ← FeishuI18n.ts 的 zhCN
 *
 * 生成策略是「逐行替换字面量」而不是重新序列化：键序、注释、空行、展开语法、换行排版都原样
 * 保留，因此 zh-TW 与 zh-CN 的 diff 只有值本身；注释保持简体（开发者视角文本，不面向用户）。
 *
 * 转换引擎是 opencc-js 的 s2twp 链路（整串分词，不是逐段转换）。按项目惯例它**不是**项目依赖
 * （与 scripts/generate-t2s-table.cjs 一致：运行时只带生成出来的常量表），首次生成前按需临时安装：
 *
 *   npm i --no-save opencc-js@1.4.2 && node scripts/genZhTwCopy.mjs
 *
 * 用法：
 *   node scripts/genZhTwCopy.mjs            # 生成/覆盖产物
 *   node scripts/genZhTwCopy.mjs --check    # 只断言产物与 zh-CN 同步，不写文件（无 opencc-js 时跳过）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZHTW_TARGETS, readSourceRegion } from "./zhTwCopySources.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

/**
 * opencc-js 只在生成期用；缺失时给出安装指引。--check 下退化为跳过：产物与 zh-CN 的同步
 * 由 tests/zhTwCopy.test.mjs 的键集断言兜底（那份断言不需要 opencc）。
 */
async function loadConverter() {
	try {
		const OpenCC = await import("opencc-js");
		return OpenCC.Converter({ from: "cn", to: "twp" });
	} catch {
		const hint = "缺少 opencc-js：请执行 npm i --no-save opencc-js@1.4.2 后重跑（与 scripts/generate-t2s-table.cjs 同惯例）";
		if (checkOnly) {
			console.warn(`⚠ ${hint}；本次跳过同步断言`);
			process.exit(0);
		}
		console.error(`✗ ${hint}`);
		process.exit(2);
	}
}

const convert = await loadConverter();

/**
 * opencc s2twp 的修正表（左=生成文本，右=修正文本）。任何一条长期不命中都会让脚本报错退出
 * （源文案改了要重新审计，不能留失效规则）；纯词形差异交给 opencc 自己决定，避免人工维护量失控。
 */
const OVERRIDES = [
	// 分词误配：整串转换把词切错，选到了不对的字
	["隻影響", "只影響"],
	["錶面", "表面"],
	["回撥", "回呼"],
	["后展開", "後展開"],
	["名稱空間", "命名空間"],
	["腳本里", "腳本裡"],
	["運行了程式碼", "執行了程式碼"],
	["向用戶提出了問題", "向使用者提出了問題"],
	// 「重载」被 opencc 整串选成「過載」（台湾语义是 overload），这里改回「重載」
	["過載", "重載"],
	// 台湾惯用语：opencc 选到的词形在台湾软件里不这么用
	["全域性", "全域"],
	["許可權", "權限"],
	["賬", "帳"],
	["兼容", "相容"],
	["支持", "支援"],
];

const overrideHits = new Map(OVERRIDES.map(([from]) => [from, 0]));

function toTraditional(text) {
	let out = convert(text);
	for (const [from, to] of OVERRIDES) {
		if (!out.includes(from)) continue;
		overrideHits.set(from, overrideHits.get(from) + out.split(from).length - 1);
		out = out.split(from).join(to);
	}
	return out;
}

/** 单行条目 `\t"key": "value",`（值可以是单引号，值内转义原样保留）。 */
const ENTRY_DQ = /^(\t*)"((?:[^"\\]|\\.)*)"(\s*:\s*)"((?:[^"\\]|\\.)*)"(,?)$/;
const ENTRY_SQ = /^(\t*)"((?:[^"\\]|\\.)*)"(\s*:\s*)'((?:[^'\\]|\\.)*)'(,?)$/;
/** 长文案的键单独一行 `\t"key":`，值换行排版在下一行。 */
const KEY_ONLY = /^\t*"(?:[^"\\]|\\.)*"\s*:\s*$/;
/** 值的续行 `\t\t"value",`，允许 `+` 拼接。 */
const CONT_DQ = /^(\t+)"((?:[^"\\]|\\.)*)"(\s*\+?\s*,?)$/;
const CONT_SQ = /^(\t+)'((?:[^'\\]|\\.)*)'(\s*\+?\s*,?)$/;

function matchEntry(line) {
	for (const [re, quote] of [
		[ENTRY_DQ, '"'],
		[ENTRY_SQ, "'"],
	]) {
		const m = line.match(re);
		if (m) return { indent: m[1], key: m[2], mid: m[3], quote, value: m[4], tail: m[5] };
	}
	return null;
}

function matchContinuation(line) {
	for (const [re, quote] of [
		[CONT_DQ, '"'],
		[CONT_SQ, "'"],
	]) {
		const m = line.match(re);
		if (m) return { indent: m[1], quote, value: m[2], tail: m[3] };
	}
	return null;
}

/**
 * 产物头部。`source-sha256` 是 zh-CN 词典区块的指纹（见 zhTwCopySources.mjs）：生成器写进头部，
 * tests/zhTwCopy.test.mjs 直接复算它做「值新鲜度」门禁——不需要 opencc 就能发现「改了值但没重跑」。
 */
function buildHeader(target, regionSha256) {
	return [
		"/**",
		" * 本文件由 `node scripts/genZhTwCopy.mjs` 生成，请勿手改。",
		" * 文案改动请修改对应的 zh-CN 源文件后重新生成；转换规则见该脚本的 OVERRIDES。",
		" * 注释刻意保留简体：属于开发者视角文本，不面向用户。",
		` * source-sha256: ${regionSha256}（来自 ${target.source} 的词典区块指纹，由 tests/zhTwCopy.test.mjs 校验新鲜度）`,
		" */",
	];
}

/**
 * 逐行翻译一份词典区块。除字符串字面量外的一切（注释、空行、展开语法、排版）原样保留；
 * 遇到不认识的行直接报错退出，避免源文件改结构后生成器静默漏掉文案。
 */
function translateBlock(source, lines, start, end, spread) {
	const body = [];
	let entries = 0;
	let inBlockComment = false;
	let inValue = false;
	for (let i = start + 1; i < end; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (inBlockComment) {
			body.push(line);
			if (trimmed.includes("*/")) inBlockComment = false;
			continue;
		}
		if (trimmed === "") {
			body.push(line);
			inValue = false;
			continue;
		}
		if (trimmed.startsWith("/*")) {
			body.push(line);
			if (!trimmed.includes("*/")) inBlockComment = true;
			continue;
		}
		if (trimmed.startsWith("//")) {
			body.push(line);
			continue;
		}
		const entry = matchEntry(line);
		if (entry) {
			body.push(`${entry.indent}"${entry.key}"${entry.mid}${entry.quote}${toTraditional(entry.value)}${entry.quote}${entry.tail}`);
			entries++;
			continue;
		}
		if (spread && trimmed === spread[0]) {
			body.push(line.replace(spread[0], spread[1]));
			continue;
		}
		if (KEY_ONLY.test(line)) {
			body.push(line);
			inValue = true;
			continue;
		}
		const continuation = inValue ? matchContinuation(line) : null;
		if (continuation) {
			body.push(`${continuation.indent}${continuation.quote}${toTraditional(continuation.value)}${continuation.quote}${continuation.tail}`);
			entries++;
			if (/,$/.test(line)) inValue = false;
			continue;
		}
		throw new Error(`${source}:${i + 1} 非预期的行（只支持注释、空行、字符串条目、换行值与展开语法）：${line}`);
	}
	return { body, entries };
}

function buildTarget(target) {
	const { lines, start, end, regionSha256 } = readSourceRegion(ROOT, target);
	const { body, entries } = translateBlock(target.source, lines, start, end, target.spread);
	return { content: [...buildHeader(target, regionSha256), ...target.imports, ...body, "};", ""].join("\n"), entries };
}

function main() {
	const stale = [];
	for (const target of ZHTW_TARGETS) {
		const { content, entries } = buildTarget(target);
		const outPath = join(ROOT, target.out);
		if (checkOnly) {
			let existing = null;
			try {
				existing = readFileSync(outPath, "utf8");
			} catch {
				existing = null;
			}
			if (existing !== content) stale.push(target.out);
			continue;
		}
		writeFileSync(outPath, content, "utf8");
		console.log(`✓ ${target.out}（${entries} 条 ← ${target.source}）`);
	}

	const unused = OVERRIDES.filter(([from]) => overrideHits.get(from) === 0).map(([from]) => from);
	if (unused.length > 0) {
		console.error(`✗ OVERRIDES 有 ${unused.length} 条未命中（源文案可能已改，请重新审计并删除失效规则）：${unused.join("、")}`);
		process.exit(1);
	}
	if (checkOnly) {
		if (stale.length > 0) {
			console.error(`✗ 以下文件与 zh-CN 源不同步，请运行 node scripts/genZhTwCopy.mjs 重新生成：\n  ${stale.join("\n  ")}`);
			process.exit(1);
		}
		console.log(`✓ zh-TW 词典与 zh-CN 源同步（${ZHTW_TARGETS.length} 个文件）`);
	}
}

main();
