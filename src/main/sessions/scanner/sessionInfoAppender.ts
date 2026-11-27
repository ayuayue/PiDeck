import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Token } from "stream-json/parser.js";

/** rename / copy 追加 session_info 需要的纯函数：pi 兼容性判定由调用方注入。 */
export type SessionInfoAppenderOptions = {
	/** 旧版 PiDeck 私有行（无 type 的 {"sessionName":...}）判定，重写时剔除。 */
	isLegacySessionNameEntry(parsed: unknown): boolean;
	/** session_info 的附加字段（如 copy 的 copiedFrom）。 */
	extra?: Record<string, unknown>;
};

/**
 * 在会话 JSONL 末尾追加 pi 原生 session_info 记录（rename / copy 共用）。
 *
 * id/parentId 规则与 pi SessionManager 一致：id 为文件内不冲突的 8 位十六进制，
 * parentId 指向追加前最后一条带 id 的记录（没有则 null，由 pi 视为新根）。
 * 会话树靠 parentId 串联，指向最后一片叶子可保持链条完整。
 *
 * 同时剔除旧版 PiDeck 的 {"sessionName":...} 私有行（无 type 字段）：pi 无法识别，
 * 位于文件头时会破坏首行校验导致整个会话无法加载（#114 的存量受损文件）。
 *
 * 这里是**流式版**（唯一实现，本地与 WSL 共用）：逐行消费、不把整文件读成字符串。
 * 用法：`rewriteJsonlLines(src, tmp, appender.transform, { keepOversizedLine: appender.keepOversizedLine })`
 * → `appendFile(tmp, appender.build(name) + "\n")` → 原子改名覆盖源文件。
 */
export function createSessionInfoAppender(options: SessionInfoAppenderOptions) {
	const { isLegacySessionNameEntry, extra } = options;
	const ids = new Set<string>();
	let lastId: string | null = null;
	const keepEntry = (parsed: unknown): boolean => {
		if (!parsed || typeof parsed !== "object") return true;
		if (isLegacySessionNameEntry(parsed)) return false;
		if ("id" in parsed && typeof parsed.id === "string" && parsed.id) {
			ids.add(parsed.id);
			lastId = parsed.id;
		}
		return true;
	};
	const transform = (line: string): string | null => {
		const trimmed = line.trim();
		if (!trimmed) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return trimmed;
		}
		return keepEntry(parsed) ? trimmed : null;
	};
	const keepOversizedLine = async (chunks: AsyncIterable<Buffer>): Promise<boolean> => keepEntry(await readSessionEntryMetadata(chunks));
	const build = (name: string): string => {
		// 与 pi appendSessionInfo 相同的清洗规则：换行折叠为空格，避免破坏 JSONL 行结构。
		const sanitized = name.replace(/[\r\n]+/g, " ").trim();
		// 与 pi generateId 一致：randomUUID 前 8 位，冲突时重试
		let id = randomUUID().slice(0, 8);
		while (ids.has(id)) id = randomUUID().slice(0, 8);
		return JSON.stringify({
			type: "session_info",
			id,
			parentId: lastId,
			timestamp: new Date().toISOString(),
			name: sanitized,
			...extra,
		});
	};
	return { transform, keepOversizedLine, build };
}

// 只读取顶层 id 以及 type/sessionName 是否为字符串。附件正文和嵌套 id 不参与命名。
async function readSessionEntryMetadata(chunks: AsyncIterable<Buffer>) {
	const metadata: { id?: string; type?: string; sessionName?: string } = {};
	let depth = 0;
	let key: keyof typeof metadata | undefined;
	const maxMetadataChars = 64 * 1024;
	const { parser } = await import("stream-json/parser.js");
	const tokens = parser.asStream({ packValues: false, packKeys: true, streamKeys: false, maxPackedLength: maxMetadataChars });
	await pipeline(chunks, tokens, async (source: AsyncIterable<Token>) => {
		for await (const token of source) {
			switch (token.name) {
				case "startObject":
				case "startArray":
					depth++;
					break;
				case "endObject":
				case "endArray":
					depth--;
					break;
				case "keyValue":
					if (depth !== 1) break;
					key = token.value === "id" || token.value === "type" || token.value === "sessionName" ? token.value : undefined;
					if (key) delete metadata[key];
					break;
				case "startString":
					if (depth === 1 && key) metadata[key] = "";
					break;
				case "stringChunk":
					if (depth === 1 && key === "id") {
						metadata.id = (metadata.id ?? "") + token.value;
						if (metadata.id.length > maxMetadataChars) throw new Error("Oversized session entry ID");
					}
					break;
			}
		}
	});
	return metadata;
}
