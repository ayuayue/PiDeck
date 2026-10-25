/**
 * 旧版 PiDeck 私有 sessionName 行识别与剔除（纯函数，零运行时依赖，便于单测）。
 *
 * 历史背景：旧版 PiDeck 重命名会话时会在 JSONL 文件头前置
 * {"sessionName":<名称>,"ts":<时间戳>}（无 type 字段）。pi 要求会话文件
 * 首条可解析记录必须是 type:"session" 头（loadEntriesFromFile 校验 entries[0]），
 * 私有行位于头部时 pi 会拒绝加载（"Session file is not a valid pi session"，exit 1），
 * 表现为桌面端「Failed to start session runtime」。新版已改为追加 pi 原生
 * session_info 记录；本模块负责识别并剔除存量私有行（#114）。
 */

/** 判定解析后的记录是否为旧版私有 sessionName 行：有 sessionName 字符串且无 type（pi 原生记录一律有 type）。 */
export function isLegacySessionNameEntry(parsed: unknown): boolean {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
	const record = parsed as Record<string, unknown>;
	return typeof record.sessionName === "string" && typeof record.type !== "string";
}

/** 解析单行 JSON 并判定是否为旧版私有 sessionName 行；不可解析的行返回 false（原样保留）。 */
export function isLegacySessionNameLine(line: string): boolean {
	try {
		return isLegacySessionNameEntry(JSON.parse(line));
	} catch {
		return false;
	}
}

/**
 * 检测「首行被写成 <任意前缀>.jsonl{JSON} 粘连」的损坏模式，返回剥离后的首行 JSON，否则 null。
 *
 * 2026-08 用户现场：会话文件首行 = `C:\Users\...\xxx.jsonl{"type":"session",...}`（路径与 header
 * 无换行粘连）。pi 的 loadEntriesFromFile 会跳过无法解析的行、只校验 entries[0].type==="session"；
 * 该行解析失败被跳过，第二条记录（如 model_change）成为首条 → 校验失败「Session file is not a valid
 * pi session」。修复 = 保留 `{` 起的 JSON 部分。
 *
 * 只接受一种明确模式：首行含 `.jsonl{`，且 `{` 后是合法 JSON 且 type==="session" 且 id 为字符串
 * （与 pi 校验语义一致，确保与文件名同源的 header）——其余损坏形态不动，留给人工处理。
 */
export function tryRestorePathGluedHeader(head: string): string | null {
	const newline = head.indexOf("\n");
	const firstLine = newline === -1 ? head : head.slice(0, newline);
	const marker = firstLine.indexOf(".jsonl{");
	if (marker < 0) return null;
	const candidate = firstLine.slice(marker + ".jsonl{".length - 1); // 从 `{` 起
	try {
		const parsed = JSON.parse(candidate) as Record<string, unknown>;
		if (parsed.type === "session" && typeof parsed.id === "string") return candidate;
		return null;
	} catch {
		return null;
	}
}

/**
 * 剔除 JSONL 文本中的空行与旧版私有 sessionName 行，返回规范化文本
 * （\n 连接，末尾换行；文件为空或只剩私有行时返回空串）。
 * 供会话修复与重命名共用，保证两处清理口径一致；非私有行内容与顺序原样保留。
 */
export function stripLegacySessionNameLine(raw: string): string {
	const kept: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (isLegacySessionNameLine(trimmed)) continue;
		kept.push(trimmed);
	}
	return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}
