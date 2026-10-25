/**
 * 重新生成 src/main/voice/traditionalToSimplifiedTable.ts（繁→简映射表）。
 *
 * 词典来源是 opencc-js 的 TSPhrases / TSCharacters（OpenCC `t2s` 链路的数据部分）。
 * opencc-js **不是**项目依赖——运行时只用生成出来的表，装 26KB 常量比拉一个依赖干净，
 * 所以这里按需临时安装、读取、再卸载：
 *
 *   npm i --no-save opencc-js@1.4.2 && node scripts/generate-t2s-table.cjs
 *
 * 换词典版本时同步更新表头注释里的版本号；生成后再格式化一次，避免长字符串与 biome 基线漂移：
 *
 *   npx biome format --write src/main/voice/traditionalToSimplifiedTable.ts
 */
const fs = require("node:fs");
const path = require("node:path");

const DICT_CANDIDATES = [process.env.OPENCC_DICT_DIR, "../node_modules/opencc-js/dist/esm-lib/dict"].filter(Boolean);
const ROOT = __dirname;

function dictDir() {
	for (const candidate of DICT_CANDIDATES) {
		const dir = path.resolve(ROOT, candidate);
		if (fs.existsSync(path.join(dir, "TSCharacters.js"))) return dir;
	}
	throw new Error("找不到 opencc-js 词典，请先执行：npm i --no-save opencc-js@1.4.2（或用 OPENCC_DICT_DIR 指定词典目录）");
}

function readDict(entry) {
	const src = fs.readFileSync(path.join(dictDir(), `${entry}.js`), "utf8");
	const matched = src.match(/export default "([\s\S]*)"/);
	if (!matched) throw new Error(`unexpected dict format: ${entry}`);
	return JSON.parse(`"${matched[1]}"`);
}

const chars = readDict("TSCharacters")
	.split("|")
	.map((entry) => entry.split(" "))
	.filter(([from, to]) => {
		if (!from || !to || from === to || [...to].length !== 1) return false;
		const fromCode = from.codePointAt(0);
		const toCode = to.codePointAt(0);
		// 只保留常用区：罕见扩展区字符不会出现在口述转写里，留着只增大表体积。
		return fromCode >= 0x4e00 && fromCode <= 0x9fff && toCode >= 0x3400 && toCode <= 0x9fff;
	});

const phrases = readDict("TSPhrases")
	.split("|")
	.map((entry) => entry.split(" "))
	.filter((parts) => {
		if (parts.length !== 2) return false;
		const [from, to] = parts;
		// 必须保留 from === to 的「恒等词条」：它们的作用恰恰是拦住字级直译
		// （「乾隆 乾隆」若被剔除，「乾隆」就会被「乾→干」拆成「干隆」）。
		return from && to && [...from].length > 1;
	});

const charString = chars.map((pair) => pair[0] + pair[1]).join("");
const phraseString = phrases.map((pair) => `${pair[0]} ${pair[1]}`).join("|");
if (/["\\\r\n]/.test(charString + phraseString)) throw new Error("table contains characters needing extra escaping");

const out = `/**
 * 繁体→简体映射表（OpenCC \`t2s\` 链路的数据部分：词表 + 字表）。
 *
 * 来源：opencc-js 1.4.2 的 TSPhrases / TSCharacters 词典，由 \`scripts/generate-t2s-table.cjs\`
 * 生成后提交；转换算法见 \`simplifiedChinese.ts\`。手改此文件没有意义，要换词典请重新运行生成脚本。
 *
 * - \`TRADITIONAL_TO_SIMPLIFIED_PHRASES\`：\`"詞組 词组"\` 用 \`|\` 连接，先按整词匹配
 *   （挡住「乾隆 → 干隆」这类字级直译的歧义）。
 * - \`TRADITIONAL_TO_SIMPLIFIED_PAIRS\`：\`"繁简"\` 两两成对拼接，偶数位繁体、奇数位简体。
 *
 * 为什么打进安装包（约 26KB）而不是按需下载：体积与「语音运行时零增长」的约束不在
 * 一个量级，而它必须是**兜底**——whisper 的中文输出会在繁简之间随机漂移，提示词只能
 * 降低概率，映射表才保证口述结果恒为简体。
 */

/** 词级映射：\`繁詞 简詞\`，以 \`|\` 分隔。 */
export const TRADITIONAL_TO_SIMPLIFIED_PHRASES = "${phraseString}";

/** 字级映射：\`繁简\` 成对拼接（${charString.length / 2} 对）。 */
export const TRADITIONAL_TO_SIMPLIFIED_PAIRS = "${charString}";
`;

const target = path.resolve(ROOT, "../src/main/voice/traditionalToSimplifiedTable.ts");
fs.writeFileSync(target, out, "utf8");
console.log("wrote", path.relative(path.resolve(ROOT, ".."), target), { phrases: phrases.length, chars: chars.length, bytes: Buffer.byteLength(out, "utf8") });
