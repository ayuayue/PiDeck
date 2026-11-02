/**
 * SQLite 索引镜像（`node:sqlite`，Node 22+/Electron 43 内置）。
 *
 * 定位：**只是索引，不是真值**。Markdown 永远是权威副本，所以：
 * - 每次写文件后按该文件当前内容**整体重灌**行（先删后插），天然自愈，不需要版本迁移脚本；
 * - 库文件损坏/不可用时整体降级：记忆读写继续可用，检索退化成对 Markdown 的子串扫描；
 *   会话检索则明确报「索引不可用」，绝不返回「看起来成功但空结果」。
 *
 * 为什么不用 better-sqlite3：本仓库禁止原生模块顶层静态 import，跨 arch 打包还要带二进制。
 * `node:sqlite` 是内核内置，`ELECTRON_RUN_AS_NODE` 下同样可用（实测 Node 24.18.1 + FTS5）。
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import { databasePath } from "./paths.mjs";

/**
 * FTS5 不写 tokenize 子句：默认 tokenizer 按词/数字切分并折叠大小写（remove_diacritics 2），
 * 英文按词/数字切分并折叠大小写，足够 `port`/`session` 这类标识符检索。
 * CJK 不在它的切词范围（整串连续汉字会成为一个 token），所以中文查询走 LIKE 通道兜底。
 */

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS entries (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		target TEXT NOT NULL,
		scope TEXT NOT NULL,
		project_id TEXT NOT NULL DEFAULT '',
		content TEXT NOT NULL,
		category TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS entries_key ON entries(target, scope, project_id, content)`,
	`CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(content)`,
	`CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		backend TEXT NOT NULL,
		project TEXT NOT NULL DEFAULT '',
		cwd TEXT NOT NULL DEFAULT '',
		started_at TEXT NOT NULL DEFAULT '',
		ended_at TEXT NOT NULL DEFAULT '',
		message_count INTEGER NOT NULL DEFAULT 0,
		file_path TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE TABLE IF NOT EXISTS session_files (
		path TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		size INTEGER NOT NULL,
		mtime_ms INTEGER NOT NULL,
		indexed_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS messages (
		rowid INTEGER PRIMARY KEY AUTOINCREMENT,
		msg_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		role TEXT NOT NULL,
		content TEXT NOT NULL,
		ts TEXT NOT NULL DEFAULT '',
		tool_calls TEXT NOT NULL DEFAULT ''
	)`,
	// 消息 id 只在会话内唯一：PiDeck 的 fork 会话是父会话的字节前缀副本，两边共享同一批
	// pi entry id。用全局主键会让 fork 插入撞键、整份事务回滚（实测 676 个会话失败 199 个）。
	`CREATE UNIQUE INDEX IF NOT EXISTS messages_session_msg ON messages(session_id, msg_id)`,
	`CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id)`,
	`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content)`,
];

/** 检测一次 `node:sqlite` 是否可用；不可用时整个索引层降级，宿主进程绝不因此崩。 */
let driverCache;

export function loadSqliteDriver() {
	if (driverCache !== undefined) return driverCache;
	try {
		// 只在运行时 require：`node:sqlite` 在旧 Node 上会直接抛，静态 import 会让整个进程起不来。
		const { DatabaseSync } = process.getBuiltinModule?.("node:sqlite") ?? {};
		driverCache = typeof DatabaseSync === "function" ? { DatabaseSync } : null;
	} catch {
		driverCache = null;
	}
	return driverCache;
}

/** 每个进程一个连接；`:memory:` 之外的路径首次打开时建目录。 */
const connections = new Map();

/**
 * 打开（并按需建表）索引库。
 * @returns {{ db: any } | { disabled: string }} 不可用时返回原因码而不是抛错。
 */
export function openDatabase(root) {
	const existing = connections.get(root);
	if (existing) return existing;
	let handle;
	try {
		const driver = loadSqliteDriver();
		if (!driver) throw new Error("driver-unavailable");
		const file = databasePath(root);
		mkdirSync(path.dirname(file), { recursive: true });
		const db = new driver.DatabaseSync(file);
		// WAL：宿主进程与本 MCP 服务器可能同时开着库；写冲突按 5s 重试后放弃，不静默等待。
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec("PRAGMA synchronous = NORMAL");
		for (const statement of SCHEMA) db.exec(statement);
		handle = { db };
	} catch (error) {
		handle = { disabled: error instanceof Error ? error.message : "open-failed" };
	}
	connections.set(root, handle);
	return handle;
}

/** 测试与退出清理用：关掉并忘记连接。 */
export function closeDatabase(root) {
	const handle = connections.get(root);
	connections.delete(root);
	try {
		handle?.db?.close();
	} catch {
		// 关闭失败不影响退出：库是索引，进程结束后由系统回收。
	}
}

/** 记住一个键（最近回填时间等）。 */
export function setMeta(root, key, value) {
	const handle = openDatabase(root);
	if (!handle.db) return;
	handle.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

export function getMeta(root, key) {
	const handle = openDatabase(root);
	if (!handle.db) return undefined;
	const row = handle.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
	return row ? String(row.value) : undefined;
}

/**
 * 把某个 Markdown 文件的当前内容整体重灌进索引。
 * 「先删后插」而不是 diff：条目量本来就小（百量级），整体重灌换来「永远和文件一致」。
 */
export function syncEntries(root, { target, scope, projectId = "", entries, categoryOf }) {
	const handle = openDatabase(root);
	if (!handle.db) return;
	const db = handle.db;
	const now = new Date().toISOString();
	db.exec("BEGIN IMMEDIATE");
	try {
		const stale = db.prepare("SELECT id FROM entries WHERE target = ? AND scope = ? AND project_id = ?").all(target, scope, projectId);
		const deleteEntry = db.prepare("DELETE FROM entries WHERE id = ?");
		const deleteFts = db.prepare("DELETE FROM entries_fts WHERE rowid = ?");
		for (const row of stale) {
			deleteFts.run(row.id);
			deleteEntry.run(row.id);
		}
		const insertEntry = db.prepare("INSERT INTO entries(target, scope, project_id, content, category, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
		const insertFts = db.prepare("INSERT INTO entries_fts(rowid, content) VALUES (?, ?)");
		for (const content of entries) {
			const { lastInsertRowid } = insertEntry.run(target, scope, projectId, content, categoryOf ? categoryOf(content) : "", now);
			insertFts.run(lastInsertRowid, content);
		}
		db.exec("COMMIT");
	} catch {
		db.exec("ROLLBACK");
	}
}

/** LIKE 兜底时的转义：用户输入里的 `%`/`_` 不能当通配符。 */
/**
 * 源文件同步状态：每次工具调用都全量「读 Markdown → DELETE → 重插」太浪费，
 * 记下各文件已同步时的 size+mtime，都没变就直接跳过（与 session_files 的增量索引同一思路）。
 * 状态存在 meta 表里：索引被清空/重建后状态随之消失，下次自然全量重建，无需额外失效逻辑。
 */
const SYNC_STATE_PREFIX = "sync:";

/** 读同步状态；没同步过或索引不可用都返回 undefined（调用方会走全量同步）。 */
export function syncStateOf(root, filePath) {
	const handle = openDatabase(root);
	if (!handle.db) return undefined;
	const row = handle.db.prepare("SELECT value FROM meta WHERE key = ?").get(SYNC_STATE_PREFIX + filePath);
	return row ? String(row.value) : undefined;
}

/** 记录/更新同步状态。stat 传 null 表示「源文件不存在」也缓存，避免每查一次都重扫空缺。 */
export function recordSyncState(root, filePath, stat) {
	const handle = openDatabase(root);
	if (!handle.db) return;
	handle.db
		.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
		.run(SYNC_STATE_PREFIX + filePath, stat ? `${stat.size}:${stat.mtimeMs}` : "missing");
}

function escapeLike(value) {
	return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** 查询里是否含 CJK：含则必须走 LIKE（FTS5 的 tokenizer 不切中文词）。 */
export function hasCjk(value) {
	return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(value);
}

/** 取用于检索的词元：去掉 FTS5 语法字符，避免 `MATCH` 直接报语法错。 */
function sanitizeFtsQuery(query) {
	return query
		.replace(/["'():^*\-]/g, " ")
		.split(/\s+/)
		.filter((token) => token.length > 0)
		.slice(0, 12)
		.map((token) => `${token}*`)
		.join(" ");
}

/**
 * 在记忆条目里检索。
 * @returns {{ ok: true, hits: Array<{content: string, target: string, scope: string, projectId: string, score: number}> } | { ok: false, reason: string }}
 */
export function searchEntries(root, query, { limit = 10, targets = ["memory", "user", "standing", "failure", "project"], projectId = "", deviceProjectId = "" } = {}) {
	const handle = openDatabase(root);
	if (!handle.db) return { ok: false, reason: "index-unavailable" };
	const db = handle.db;
	const targetFilter = targets.map((target) => (target === "project" ? "project" : target));
	const hits = [];
	const seen = new Set();
	const push = (row, score) => {
		const key = `${row.target}|${row.scope}|${row.projectId}|${row.content}`;
		if (seen.has(key)) return;
		seen.add(key);
		// 设备作用域在库里就是 project_id = `device:<key>`，回给调用方时单独标出来：
		// 「本机专属」与「这个项目的」语义不同，混成 project 会让模型误以为能跨机器复用。
		const project = String(row.projectId ?? "");
		hits.push({ content: String(row.content), target: String(row.target), scope: project.startsWith("device:") ? "device" : String(row.scope), projectId: project, score });
	};

	const ftsQuery = sanitizeFtsQuery(query);
	if (ftsQuery && !hasCjk(query)) {
		try {
			// target 过滤必须和 LIKE 通道一致：否则「只搜 project 记忆」会把 user 事实当命中返回。
			const rows = db
				.prepare(
					`SELECT e.target, e.scope, e.project_id AS projectId, e.content, bm25(entries_fts) AS score
					 FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid
					 WHERE entries_fts MATCH ?
					   AND (e.target IN (${targetFilter.map(() => "?").join(",")}) OR (? <> '' AND e.project_id = ?) OR (? <> '' AND e.project_id = ?))
					 ORDER BY score ASC LIMIT ?`,
				)
				.all(ftsQuery, ...targetFilter, projectId, projectId, deviceProjectId, deviceProjectId, limit * 4);
			for (const row of rows) push(row, Number(row.score));
		} catch {
			// FTS 查询语法失败时静默退到 LIKE：检索不可用不等于工具报错。
		}
	}

	// LIKE 通道：CJK 查询、FTS 没命中、或用户就想做子串匹配时都靠它。
	const pattern = `%${escapeLike(query.trim())}%`;
	try {
		const rows = db
			.prepare(
				`SELECT target, scope, project_id AS projectId, content FROM entries
				 WHERE content LIKE ? ESCAPE '\\' AND (target IN (${targetFilter.map(() => "?").join(",")}) OR (? <> '' AND project_id = ?) OR (? <> '' AND project_id = ?))
				 ORDER BY LENGTH(content) ASC LIMIT ?`,
			)
			.all(pattern, ...targetFilter, projectId, projectId, deviceProjectId, deviceProjectId, limit * 4);
		for (const row of rows) push(row, 1);
	} catch {
		// 同上：检索降级不阻断写入与读取。
	}

	return { ok: true, hits: hits.slice(0, limit) };
}

/** 会话文件入库判定：size/mtime 都没变就跳过（增量索引的核心）。 */
export function sessionFileMeta(root, filePath) {
	const handle = openDatabase(root);
	if (!handle.db) return undefined;
	const row = handle.db.prepare("SELECT size, mtime_ms AS mtimeMs, indexed_at AS indexedAt FROM session_files WHERE path = ?").get(filePath);
	return row ? { size: Number(row.size), mtimeMs: Number(row.mtimeMs), indexedAt: String(row.indexedAt) } : undefined;
}

/**
 * 重灌一个会话：先删该会话的旧消息，再插入调用方解析好的消息。
 * 会话文件是 append-only 的 JSONL，整段重灌最省心（单会话几百条，成本可忽略）。
 */
export function replaceSession(root, session, messages) {
	const handle = openDatabase(root);
	if (!handle.db) return false;
	const db = handle.db;
	db.exec("BEGIN IMMEDIATE");
	try {
		const old = db.prepare("SELECT rowid AS rowId FROM messages WHERE session_id = ?").all(session.id);
		const deleteFts = db.prepare("DELETE FROM messages_fts WHERE rowid = ?");
		const deleteMessage = db.prepare("DELETE FROM messages WHERE rowid = ?");
		for (const row of old) {
			deleteFts.run(row.rowId);
			deleteMessage.run(row.rowId);
		}
		const upsertSession = db.prepare(
			`INSERT INTO sessions(id, backend, project, cwd, started_at, ended_at, message_count, file_path)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET backend=excluded.backend, project=excluded.project, cwd=excluded.cwd,
			   started_at=excluded.started_at, ended_at=excluded.ended_at, message_count=excluded.message_count, file_path=excluded.file_path`,
		);
		upsertSession.run(session.id, session.backend, session.project ?? "", session.cwd ?? "", session.startedAt ?? "", session.endedAt ?? "", messages.length, session.filePath ?? "");
		const insertMessage = db.prepare("INSERT INTO messages(msg_id, session_id, role, content, ts, tool_calls) VALUES (?, ?, ?, ?, ?, ?)");
		const insertFts = db.prepare("INSERT INTO messages_fts(rowid, content) VALUES (?, ?)");
		for (const message of messages) {
			const { lastInsertRowid } = insertMessage.run(message.id, session.id, message.role, message.content, message.timestamp ?? "", (message.toolCalls ?? []).join(" "));
			insertFts.run(lastInsertRowid, message.content);
		}
		const upsertFile = db.prepare(
			`INSERT INTO session_files(path, session_id, size, mtime_ms, indexed_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, indexed_at=excluded.indexed_at, session_id=excluded.session_id`,
		);
		upsertFile.run(session.filePath ?? "", session.id, session.size ?? 0, session.mtimeMs ?? 0, new Date().toISOString());
		db.exec("COMMIT");
		return true;
	} catch {
		db.exec("ROLLBACK");
		return false;
	}
}

/** 会话消息检索：返回命中消息 + 所属会话的展示信息。 */
export function searchMessages(root, query, { limit = 10, project } = {}) {
	const handle = openDatabase(root);
	if (!handle.db) return { ok: false, reason: "index-unavailable" };
	const db = handle.db;
	const hits = [];
	const seen = new Set();
	const push = (row, score) => {
		// msg_id 只保证会话内唯一（fork 会话与父会话共享 id），去重键必须带上会话。
		const key = `${row.sessionId}|${row.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		hits.push({
			sessionId: String(row.sessionId),
			project: String(row.project ?? ""),
			role: String(row.role),
			content: String(row.content),
			backend: String(row.backend ?? ""),
			timestamp: String(row.ts ?? ""),
			score,
		});
	};

	const selectJoin = `SELECT m.rowid AS rowId, m.msg_id AS id, m.session_id AS sessionId, m.role, m.content, m.ts, s.project, s.cwd, s.backend FROM messages m JOIN sessions s ON s.id = m.session_id`;
	// 项目过滤下推到 SQL：取 `limit*4` 再在内存里扔的话，命中集中在其它项目时结果会莫名少于 limit。
	const projectClause = project ? " AND s.project = ?" : "";
	const projectArgs = project ? [project] : [];

	const ftsQuery = sanitizeFtsQuery(query);
	if (ftsQuery && !hasCjk(query)) {
		try {
			const rows = db
				.prepare(
					`SELECT m.rowid AS rowId, m.msg_id AS id, m.session_id AS sessionId, m.role, m.content, m.ts, s.project, s.backend FROM messages_fts
					 JOIN messages m ON m.rowid = messages_fts.rowid JOIN sessions s ON s.id = m.session_id
					 WHERE messages_fts MATCH ?${projectClause} ORDER BY bm25(messages_fts) ASC LIMIT ?`,
				)
				.all(...(project ? [ftsQuery, project, limit * 4] : [ftsQuery, limit * 4]));
			for (const row of rows) push(row, Number(row.score ?? 0));
		} catch {
			// 退到 LIKE。
		}
	}

	try {
		const rows = db.prepare(`${selectJoin} WHERE m.content LIKE ? ESCAPE '\\'${projectClause} ORDER BY LENGTH(m.content) ASC LIMIT ?`).all(...(project ? [`%${escapeLike(query.trim())}%`, project, limit * 4] : [`%${escapeLike(query.trim())}%`, limit * 4]));
		for (const row of rows) push(row, 1);
	} catch {
		// 同上。
	}

	const filtered = project ? hits.filter((hit) => hit.project === project) : hits;
	return { ok: true, hits: filtered.slice(0, limit) };
}

/** 索引规模控制：只保留最近的 N 个会话，其余连同消息一起删掉。 */
export function pruneSessions(root, maxSessions) {
	const handle = openDatabase(root);
	if (!handle.db) return 0;
	const db = handle.db;
	const victims = db.prepare("SELECT id FROM sessions ORDER BY started_at DESC LIMIT -1 OFFSET ?").all(maxSessions);
	if (victims.length === 0) return 0;
	db.exec("BEGIN IMMEDIATE");
	try {
		const deleteFts = db.prepare("DELETE FROM messages_fts WHERE rowid = ?");
		const idsOfSession = db.prepare("SELECT rowid AS rowId FROM messages WHERE session_id = ?");
		const deleteMessage = db.prepare("DELETE FROM messages WHERE session_id = ?");
		const deleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");
		for (const victim of victims) {
			for (const row of idsOfSession.all(victim.id)) deleteFts.run(row.rowId);
			deleteMessage.run(victim.id);
			deleteSession.run(victim.id);
		}
		db.exec("COMMIT");
	} catch {
		db.exec("ROLLBACK");
		return 0;
	}
	return victims.length;
}

/** 索引统计（注入/自检用）。 */
/**
 * 清空索引（不碰 Markdown 真值）。
 *
 * 用 DELETE 而不是删库文件：宿主进程与 MCP 服务器可能同时开着这个库，
 * Windows 上删一个被打开的文件会直接失败。清空后下一次检索会自动重灌，
 * 所以这个操作随时可逆（代价是一次重建）。
 */
export function clearIndex(root) {
	const handle = openDatabase(root);
	if (!handle.db) return { ok: false, reason: handle.disabled ?? "index-unavailable" };
	const db = handle.db;
	let removed = 0;
	for (const table of ["entries", "sessions", "session_files", "messages", "entries_fts", "messages_fts"]) {
		const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
		db.exec(`DELETE FROM ${table}`);
		removed += count;
	}
	// 让 AUTOINCREMENT 归零，重建后 rowid 从 1 开始（FTS 行号与新表对齐更直观）。
	db.exec("DELETE FROM sqlite_sequence WHERE name IN ('entries', 'messages')");
	// VACUUM 需要独占，可能被另一进程的写事务挡住：失败只是没缩小文件，不该让清空失败。
	try {
		db.exec("VACUUM");
	} catch {
		// 忽略
	}
	return { ok: true, removed };
}

/**
 * 取某会话最近的若干条消息（学习循环的输入源）。
 *
 * 为什么走索引而不是重读会话文件：学习循环由宿主在「回合结算」时触发，三种后端的
 * 原始格式各不相同（pi JSONL / ACP 归档 JSON），索引层已经把三者归一成同一张 messages
 * 表；宿主只需要一个会话 id。ORDER BY rowid DESC 再翻转，保证拿到的是最后 N 条。
 */
export function sessionMessages(root, sessionId, { limit = 40 } = {}) {
	const handle = openDatabase(root);
	if (!handle.db) return { ok: false, reason: "index-unavailable", messages: [], userTurns: 0 };
	try {
		const rows = handle.db.prepare("SELECT role, content, ts FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT ?").all(sessionId, limit) ?? [];
		// userTurns 必须是**整个会话**的用户回合数，不能只看这次的窗口：学习进度记的是水位线，
		// 用窗口长度当水位会让窗口满了之后永远学不到下一轮。
		const turns = Number(handle.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND role = 'user'").get(sessionId)?.count ?? 0);
		return {
			ok: true,
			userTurns: turns,
			messages: rows.reverse().map((row) => ({ role: String(row.role), content: String(row.content), timestamp: String(row.ts ?? "") })),
		};
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error), messages: [], userTurns: 0 };
	}
}

export function indexStats(root) {
	const handle = openDatabase(root);
	if (!handle.db) return { ok: false, reason: "index-unavailable" };
	const one = (sql) => Number(handle.db.prepare(sql).get()?.count ?? 0);
	return { ok: true, entries: one("SELECT COUNT(*) AS count FROM entries"), sessions: one("SELECT COUNT(*) AS count FROM sessions"), messages: one("SELECT COUNT(*) AS count FROM messages") };
}
