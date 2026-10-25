import { TRADITIONAL_TO_SIMPLIFIED_PAIRS, TRADITIONAL_TO_SIMPLIFIED_PHRASES } from "./traditionalToSimplifiedTable";

/**
 * 转写结果繁简收口：whisper 的中文输出会在繁简之间漂移（同一台机器、同一个 small 模型，
 * 一句话可能前半简体后半繁体），用户诉求很明确——「默认要简体」。
 *
 * 两层做法，缺一不可：
 * 1. **提示词**（VOICE_SIMPLIFIED_CHINESE_PROMPT）在解码阶段就把分布推向简体，代价是
 *    一段文本，收益是绝大多数结果直接正确，且不需要任何词表；
 * 2. **映射表**（traditionalToSimplifiedTable.ts，OpenCC t2s 链路）做确定性兜底，
 *    保证漏网的繁体字一定变简体。
 *
 * 云端同理：OpenAI 兼容端点没有 prompt 参数可用（ whisper API 的 `prompt` 字段可选，
 * 但各家实现不一），所以映射表是两条引擎**共用**的收口，写在 VoiceTranscriptionService
 * 的结果出口处。
 */

/** 解码提示词：告诉模型「参考文本是简体中文」，实测可显著降低繁体输出概率。 */
export const VOICE_SIMPLIFIED_CHINESE_PROMPT = "以下是简体中文的普通话转录。";

let charTable: Map<string, string> | null = null;
let phraseTable: Map<string, string> | null = null;
let phraseMaxLength = 0;

function ensureTables(): void {
	if (charTable) return;
	const chars = new Map<string, string>();
	for (let index = 0; index + 1 < TRADITIONAL_TO_SIMPLIFIED_PAIRS.length; index += 2) {
		chars.set(TRADITIONAL_TO_SIMPLIFIED_PAIRS.slice(index, index + 1), TRADITIONAL_TO_SIMPLIFIED_PAIRS.slice(index + 1, index + 2));
	}
	const phrases = new Map<string, string>();
	let maxLength = 2;
	for (const entry of TRADITIONAL_TO_SIMPLIFIED_PHRASES.split("|")) {
		const separator = entry.indexOf(" ");
		if (separator <= 0) continue;
		const from = entry.slice(0, separator);
		const to = entry.slice(separator + 1);
		// from === to 的恒等词条必须留在表里：它们是「拦住字级直译」的守卫，
		// 过滤掉就等于把「乾隆」交还给「乾→干」的单字规则。
		if (!from || !to) continue;
		phrases.set(from, to);
		maxLength = Math.max(maxLength, from.length);
	}
	charTable = chars;
	phraseTable = phrases;
	phraseMaxLength = maxLength;
}

/**
 * 繁体→简体：先整词、后单字（与 OpenCC `t2s` 的 conversionChain 顺序一致）。
 * 词级先行是为了避开字级直译的歧义，例如「乾隆」整词保留，而单独出现的「乾」按简体写为「干」。
 * 表里没有的字符（含全部非 CJK 文本）原样返回，因此对英文转写是纯 no-op。
 */
export function toSimplifiedChinese(text: string): string {
	if (!text || !/[\u3400-\u9fff]/.test(text)) return text;
	ensureTables();
	const chars = charTable as Map<string, string>;
	const phrases = phraseTable as Map<string, string>;
	const output: string[] = [];
	for (let index = 0; index < text.length; ) {
		const phrase = matchPhrase(text, index, phrases);
		if (phrase) {
			output.push(phrase.replacement);
			index += phrase.length;
			continue;
		}
		const character = text.slice(index, index + 1);
		const next = text.slice(index + 1, index + 2);
		// 代理对（emoji / 扩展汉字）必须整体输出，按 UTF-16 单元查表会拆坏字符。
		if (isHighSurrogatePair(character, next)) {
			output.push(character + next);
			index += 2;
			continue;
		}
		output.push(chars.get(character) ?? character);
		index += 1;
	}
	return output.join("");
}

/** 从 start 起做最长匹配（词表最长串有限，按长度从长到短试）。 */
function matchPhrase(text: string, start: number, phrases: Map<string, string>): { replacement: string; length: number } | null {
	for (let length = Math.min(phraseMaxLength, text.length - start); length >= 2; length -= 1) {
		const replacement = phrases.get(text.slice(start, start + length));
		if (replacement) return { replacement, length };
	}
	return null;
}

function isHighSurrogatePair(first: string, second: string): boolean {
	return Boolean(first) && Boolean(second) && first.charCodeAt(0) >= 0xd800 && first.charCodeAt(0) <= 0xdbff && second.charCodeAt(0) >= 0xdc00 && second.charCodeAt(0) <= 0xdfff;
}
