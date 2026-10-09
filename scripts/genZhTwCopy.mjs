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

const HEADER = ["/**", " * 本文件由 `node scripts/genZhTwCopy.mjs` 生成，请勿手改。", " * 文案改动请修改对应的 zh-CN 源文件后重新生成；转换规则见该脚本的 OVERRIDES。", " * 注释刻意保留简体：属于开发者视角文本，不面向用户。", " */"];

const TARGETS = [
	{
		out: "src/renderer/src/i18n/rendererCopy.zh-TW.ts",
		source: "src/renderer/src/i18n/rendererCopy.zh-CN.ts",
		startMarker: "export const zhCN = {",
		endMarker: "} as const;",
		spread: ["...mainProcessZhCN,", "...mainProcessZhTW,"],
		imports: ['import { mainProcessZhTW } from "../../../shared/i18n/mainProcessCopy.zh-TW";', 'import type { TranslationKey } from "./rendererCopy.zh-CN";', "", "export const zhTW: Record<TranslationKey, string> = {"],
	},
	{
		out: "src/shared/i18n/mainProcessCopy.zh-TW.ts",
		source: "src/shared/i18n/mainProcessCopy.ts",
		startMarker: "export const mainProcessZhCN = {",
		endMarker: "} as const;",
		imports: ['import type { MainProcessTranslationKey } from "./mainProcessCopy";', "", "export const mainProcessZhTW: Record<MainProcessTranslationKey, string> = {"],
	},
	{
		out: "src/main/web/WebI18n.zh-TW.ts",
		source: "src/main/web/WebI18n.ts",
		startMarker: "export const webZhCN = {",
		endMarker: "} as const;",
		spread: ["...mainProcessZhCN,", "...mainProcessZhTW,"],
		imports: ['import { mainProcessZhTW } from "../../shared/i18n/mainProcessCopy.zh-TW";', 'import type { WebTranslationKey } from "./WebI18n";', "", "export const webZhTW: Record<WebTranslationKey, string> = {"],
	},
	{
		out: "src/main/feishu/FeishuI18n.zh-TW.ts",
		source: "src/main/feishu/FeishuI18n.ts",
		startMarker: "const zhCN = {",
		endMarker: "} as const;",
		imports: ['import type { FeishuTranslationKey } from "./FeishuI18n";', "", "export const feishuZhTW: Record<FeishuTranslationKey, string> = {"],
	},
];

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
	const lines = readFileSync(join(ROOT, target.source), "utf8").split("\n");
	const start = lines.indexOf(target.startMarker);
	const end = lines.indexOf(target.endMarker, start);
	if (start < 0 || end < 0) throw new Error(`${target.source}: 找不到 ${target.startMarker} / ${target.endMarker} 区块`);
	const { body, entries } = translateBlock(target.source, lines, start, end, target.spread);
	return { content: [...HEADER, ...target.imports, ...body, "};", ""].join("\n"), entries };
}

function main() {
	const stale = [];
	for (const target of TARGETS) {
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
		console.log(`✓ zh-TW 词典与 zh-CN 源同步（${TARGETS.length} 个文件）`);
	}
}

main();
