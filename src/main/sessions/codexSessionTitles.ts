import { open, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Codex 会话名读取层（~/.codex/session_index.jsonl）。
 *
 * ── 为什么需要（Codex jsonl 里没有会话名）────────────────────────
 * ~/.codex/sessions/ 的 rollout-*.jsonl（无论新旧格式）都不携带会话标题：
 * session_meta 只有 id/cwd/originator 等字段。Codex 自己维护一份**纯文本索引**
 * session_index.jsonl，每行 `{ id, thread_name, updated_at }`，thread_name 就是
 * 侧栏显示的会话名（用户改过名就是新名，没改过就是官方自动标题）。
 *
 * ── 为什么不用 SQLite 状态库（state_N.sqlite 的 threads 表）──────
 * 早先实现读的是 Codex 的 SQLite 状态库，代价明显：库被 Codex 持锁、WAL 未合并、
 * 只读连接在缺 -shm 时直接打不开，于是只能把库拷到临时目录再读（多用户机器上还
 * 得额外收紧权限）。实测 session_index.jsonl 与状态库**逐条一致**（106 条 0 处
 * 差异，且状态库里所有用户改名它都有），而它只是一份几十 KB 的追加式文本：
 * 直接有界读取即可，没有锁、没有 WAL、没有临时副本，跨平台行为完全一致。
 *
 * 索引里没有的会话（旧 CLI 会话、尚未同步的会话）由导入器从 jsonl 首条用户消息
 * 兜底取名——索引读取失败也只是回退，绝不让导入失败。
 */

/** 索引文件名（Codex Desktop 维护；CLI-only 环境可能不存在） */
const SESSION_INDEX_FILE = "session_index.jsonl";

/** 读取上限：索引是几十 KB 的追加式文件；给 8MB 防御性上限，异常膨胀时不整读。 */
const SESSION_INDEX_MAX_BYTES = 8 * 1024 * 1024;

export type CodexThreadTitle = {
	/** 用户在 Codex 里改过的会话名（未改名时是 Codex 的自动标题） */
	name?: string;
	/** 索引条目的更新时间（诊断用） */
	updatedAt?: string;
};

export type CodexThreadTitleMaps = {
	/** session id → 会话名（索引是追加式：同一 id 取最后一条） */
	byId: Map<string, CodexThreadTitle>;
};

/** 内存缓存：同一进程内反复 scan 不重复读索引（以 mtime + size 作缓存键） */
let cache: (CodexThreadTitleMaps & { source: string; version: string }) | null = null;

function clearCache() {
	cache = null;
}

// 测试注入点：允许重置模块级缓存
export const __resetCodexThreadTitleCacheForTests = clearCache;

function emptyMaps(): CodexThreadTitleMaps {
	return { byId: new Map() };
}

function trimmed(value: unknown): string | undefined {
	const text = typeof value === "string" ? value.trim() : "";
	return text || undefined;
}

/**
 * 读取 session_index.jsonl：每行 `{ id, thread_name, updated_at }`。
 * 追加式文件：同一 id 出现多次时**最后一条为准**（改名就是追加一条新记录）。
 * 坏行/截断行跳过；文件不存在或读不到返回 null（调用方回退 jsonl 提取）。
 */
async function readSessionIndex(indexPath: string): Promise<CodexThreadTitleMaps | null> {
	let raw = "";
	try {
		const info = await stat(indexPath);
		const handle = await open(indexPath, "r");
		try {
			const limit = Math.min(info.size, SESSION_INDEX_MAX_BYTES);
			const buffer = Buffer.allocUnsafe(limit);
			const { bytesRead } = await handle.read(buffer, 0, limit, Math.max(0, info.size - limit));
			raw = buffer.subarray(0, bytesRead).toString("utf8");
			// 从文件尾部读时起点可能落在行中间：丢掉第一段残行
			if (info.size > limit) raw = raw.slice(raw.indexOf("\n") + 1);
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}

	const maps = emptyMaps();
	for (const line of raw.split(/\r?\n/)) {
		const text = line.trim();
		if (!text) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(text) as Record<string, unknown>;
		} catch {
			// 坏行/截断行跳过（索引是追加写，末行可能只写了一半）
			continue;
		}
		const id = trimmed(entry.id);
		const name = trimmed(entry.thread_name);
		if (!id || !name) continue;
		// 追加式：后出现的覆盖先出现的
		maps.byId.set(id, { name, updatedAt: trimmed(entry.updated_at) });
	}
	return maps;
}

/** 从 rollout 文件名里取会话 id（`rollout-<时间戳>-<uuid>.jsonl` → uuid）。 */
function sessionIdFromPath(sourcePath: string | undefined): string | undefined {
	const fileName = String(sourcePath ?? "")
		.replace(/\\/g, "/")
		.split("/")
		.pop();
	if (!fileName) return undefined;
	const match = /^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(fileName);
	return match ? match[1] : undefined;
}

/**
 * 读取 Codex 会话名索引。
 *
 * @param codexHome ~/.codex 目录
 * @returns byId（session id → 会话名）；索引缺失/损坏时返回空映射
 *          （调用方回退到 jsonl 首条用户消息，不报错）。
 */
export async function loadCodexThreadTitles(codexHome: string): Promise<CodexThreadTitleMaps> {
	const indexPath = join(codexHome, SESSION_INDEX_FILE);
	let version = "";
	try {
		const info = await stat(indexPath);
		version = `${info.mtimeMs}:${info.size}`;
	} catch {
		// 索引不存在（CLI-only 环境）：返回空映射
	}
	if (cache && cache.source === indexPath && cache.version === version) return cache;

	const parsed = version ? await readSessionIndex(indexPath) : null;
	cache = { source: indexPath, version, ...(parsed ?? emptyMaps()) };
	return cache;
}

/** 按 session id / 源路径取会话名（路径缺 id 时从 rollout 文件名反解 uuid）。 */
export function lookupCodexThreadTitle(maps: CodexThreadTitleMaps, sessionId: string | undefined, sourcePath: string | undefined): CodexThreadTitle | undefined {
	if (sessionId) {
		const hit = maps.byId.get(sessionId);
		if (hit) return hit;
	}
	const fromPath = sessionIdFromPath(sourcePath);
	return fromPath ? maps.byId.get(fromPath) : undefined;
}
