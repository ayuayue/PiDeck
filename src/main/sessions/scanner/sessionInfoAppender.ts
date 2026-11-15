import { randomUUID } from "node:crypto";
import type { JsonlLineContext } from "../jsonlLineStream";

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
 * 用法：`rewriteJsonlLines(src, tmp, appender.transform)`
 * → `appendFile(tmp, appender.build(name) + "\n")` → 原子改名覆盖源文件。
 */
export function createSessionInfoAppender(options: SessionInfoAppenderOptions) {
	const { isLegacySessionNameEntry, extra } = options;
	const ids = new Set<string>();
	let lastId: string | null = null;
	const transform = (line: string, context: JsonlLineContext | null): string | null => {
		// context === null：超长行未 decode（jsonlLineStream 语义），无从变换 → 丢弃
		if (context === null) return null;
		const trimmed = line.trim();
		if (!trimmed) return null;
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// 不可解析的行原样保留，不做破坏性清理
		}
		if (parsed !== null && isLegacySessionNameEntry(parsed)) return null;
		if (parsed !== null && typeof (parsed as { id?: unknown }).id === "string" && (parsed as { id?: string }).id) {
			ids.add((parsed as { id: string }).id);
			lastId = (parsed as { id: string }).id;
		}
		return trimmed;
	};
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
	return { transform, build };
}
