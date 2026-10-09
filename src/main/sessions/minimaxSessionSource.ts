import { open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readImportMetaHead } from "./importMetaHead";
import { normalizePath, safePathToken } from "./kimiSessionSource";

/**
 * MinimaxCode（CLI 编码助手，~/.minimax）会话源的探测与扫描（纯 Node，无 electron 依赖）。
 *
 * 目录布局（layout: v2-final-dated-session）：
 *   ~/.minimax/v2/sessions/YYYY/MM/DD/HH-mm-ss-SSS-session_<b64id>/
 *     manifest.json        会话元数据（sessionId/createdAtMs/updatedAtMs/paths…）
 *     messages.jsonl       正文：每行 {message_id, turn_id, message:{role, content[], timestamp}}
 *     llm-call.json        模型调用配置（systemPrompt 内含 `working directory: <path>`，cwd 唯一来源）
 *     history-catalog.json / user-message-locators.jsonl  辅助索引（导入不读）
 *
 * 与 Kimi Code（全局索引文件）不同，MinimaxCode 没有索引：直接按日期目录树枚举
 * 含 manifest.json 的目录，cwd 匹配在读取 llm-call.json 后进行。
 *
 * 更正（2026-10 实测）：MinimaxCode 有全局索引——`~/.minimax/v2/sqlite/runtime-state.sqlite`
 * 的 local_runtime_sessions 表（session_id → title/workspace_dir），会话标题只存在这里，
 * 会话目录里没有。标题读取失败静默降级（旧版/损坏 db），cwd 回退 llm-call.json。
 */

/** llm-call.json 读取上界：systemPrompt 随项目规模膨胀，但非会话正文，4MB 足够且防异常文件。 */
export const MINIMAX_LLM_CALL_MAX_BYTES = 4 * 1024 * 1024;

/** messages.jsonl 头部读取上界：扫描只需要标题/预览（前几条消息），与文件总大小解耦。 */
export const MINIMAX_MESSAGES_HEAD_BYTES = 256 * 1024;

/** manifest.json 读取上界：正常仅几十字节；对齐 llm-call 的 4MB 防线，异常巨型文件直接视为无清单。 */
export const MINIMAX_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

export type MinimaxManifest = {
	sessionId: string;
	createdAtMs: number;
	updatedAtMs: number;
};

export type MinimaxSessionMeta = {
	sessionId: string;
	/** 会话目录绝对路径 */
	dir: string;
	/** messages.jsonl 绝对路径 */
	messagesPath: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	sourceMtime: number;
	sourceSize: number;
	/** messages.jsonl 头部行（标题/预览用，有界） */
	headLines: unknown[];
	/** sqlite 索引里的会话标题（minimaxcode UI 显示名，如「打招呼」）；不可用时缺省 */
	sourceTitle?: string;
};

/** sqlite 索引行：会话标题 + 工作目录（workspace_dir 可作 cwd 的第二数据源）。 */
export type MinimaxSqliteEntry = { title?: string; workspaceDir?: string };

/**
 * 读 MinimaxCode 全局索引（~/.minimax/v2/sqlite/runtime-state.sqlite）的会话表。
 * node:sqlite 在 Electron 主进程可用（node ≥22.5）；实验性 API，任何失败（缺模块/损坏/
 * 被锁）都返回空 Map 静默降级——标题是锦上添花，不阻塞导入。
 */
export async function readMinimaxSqliteIndex(v2Dir: string): Promise<Map<string, MinimaxSqliteEntry>> {
	const index = new Map<string, MinimaxSqliteEntry>();
	try {
		// 动态 import：避免顶层静态 import 在无 node:sqlite 的环境（异常打包/老 Electron）崩模块加载
		const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => { prepare: (sql: string) => { all: () => unknown[] }; close: () => void } };
		const db = new DatabaseSync(join(v2Dir, "sqlite", "runtime-state.sqlite"), { readOnly: true });
		try {
			const rows = db.prepare("SELECT session_id, title, workspace_dir FROM local_runtime_sessions").all();
			for (const row of rows) {
				const r = row as { session_id?: unknown; title?: unknown; workspace_dir?: unknown };
				if (typeof r.session_id !== "string") continue;
				index.set(r.session_id, {
					title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : undefined,
					workspaceDir: typeof r.workspace_dir === "string" && r.workspace_dir ? r.workspace_dir : undefined,
				});
			}
		} finally {
			db.close();
		}
	} catch {
		// sqlite 不可读（旧版无表/WAL 锁/权限）：空索引，走文件推导
	}
	return index;
}

export function minimaxSessionsRoot(home: string): string {
	return join(home, ".minimax", "v2", "sessions");
}

export function getMinimaxTargetPath(piRoot: string, projectPath: string, sessionId: string): string {
	const id = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
	return join(piRoot, safePathToken(projectPath), `minimax_${id}.jsonl`);
}

/** 读取导入产物头部的 import 标记（有界读，见 importMetaHead）。 */
export async function readMinimaxImportMeta(targetPath: string): Promise<{ sourceMtime: number; sourceSize: number } | undefined> {
	return readImportMetaHead(targetPath, "minimax_import");
}

/** 枚举 YYYY/MM/DD/session-dir 树里所有含 manifest.json 的会话目录（最多下钻 4 层）。 */
export async function listMinimaxSessionDirs(root: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (depth < 0) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const sub = join(dir, entry.name);
			// 会话目录的标志是 manifest.json；日期层目录没有它
			if (entry.name.includes("-session_")) {
				found.push(sub);
				continue;
			}
			await walk(sub, depth - 1);
		}
	};
	await walk(root, 3);
	return found;
}

function readNumber(value: unknown, fallback = 0): number {
	const num = Number(value);
	return Number.isFinite(num) ? num : fallback;
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export async function readMinimaxManifest(dir: string): Promise<MinimaxManifest | undefined> {
	let raw: string;
	try {
		const manifestPath = join(dir, "manifest.json");
		const info = await stat(manifestPath);
		// 异常巨型 manifest（畸形/被替换）不进内存，静默降级为无清单
		if (info.size > MINIMAX_MANIFEST_MAX_BYTES) return undefined;
		raw = await readFile(manifestPath, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const sessionId = readString(parsed.sessionId);
		if (!sessionId) return undefined;
		return {
			sessionId,
			createdAtMs: readNumber(parsed.createdAtMs),
			updatedAtMs: readNumber(parsed.updatedAtMs),
		};
	} catch {
		return undefined;
	}
}

/**
 * 从 llm-call.json 的 systemPrompt 里提取工作目录（`working directory: <path>`）。
 * llm-call.json 与 messages.jsonl 同目录；读取带上界，超界/缺文件/无匹配都返回空串
 * （调用方按「不属于任何项目」处理）。
 */
export async function readMinimaxCwd(dir: string): Promise<string> {
	const llmCallPath = join(dir, "llm-call.json");
	let handle;
	try {
		handle = await open(llmCallPath, "r");
	} catch {
		return "";
	}
	try {
		const { size } = await handle.stat();
		if (size > MINIMAX_LLM_CALL_MAX_BYTES) return "";
		const buffer = Buffer.alloc(Math.min(size, MINIMAX_LLM_CALL_MAX_BYTES));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		// llm-call.json 是标准 JSON：先 parse 再在 systemPrompt 值上找（原始文本里路径分隔符与换行
		// 都是 JSON 转义形式，直接 regex 会把换行后的尾巴扫进路径）。
		let systemPrompt: unknown;
		try {
			systemPrompt = (JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as { systemPrompt?: unknown }).systemPrompt;
		} catch {
			return "";
		}
		if (typeof systemPrompt !== "string") return "";
		// systemPrompt 内嵌明文行：`working directory: C:/Users/...` 或 `C:\\Users\\...`（到行尾都是路径，反斜杠合法；trim 掉行尾空白）
		const match = systemPrompt.match(/working directory:\s*([^\r\n"']+)/);
		const candidate = match?.[1]?.trim();
		if (!candidate || (!/^[a-zA-Z]:[\\/]/.test(candidate) && !candidate.startsWith("/"))) return "";
		return candidate;
	} catch {
		return "";
	} finally {
		await handle.close();
	}
}

/** 读 messages.jsonl 头部若干行（标题/预览用；与文件总大小解耦）。 */
async function readMessagesHeadLines(messagesPath: string): Promise<unknown[]> {
	let handle;
	try {
		handle = await open(messagesPath, "r");
	} catch {
		return [];
	}
	try {
		const buffer = Buffer.alloc(MINIMAX_MESSAGES_HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const head = buffer.subarray(0, bytesRead).toString("utf8");
		const lines: unknown[] = [];
		for (const line of head.split(/\r?\n/)) {
			if (!line) continue;
			try {
				lines.push(JSON.parse(line));
				// 标题（首条 user）与预览（首条 assistant）都在前几行，多读无益
				if (lines.length >= 8) break;
			} catch {
				// 坏行/截断行跳过
			}
		}
		return lines;
	} finally {
		await handle.close();
	}
}

/** 解析单个会话目录为元数据；messages 缺失或为空视为无效（返回 undefined）。 */
export async function readMinimaxSessionMeta(dir: string): Promise<MinimaxSessionMeta | undefined> {
	const manifest = await readMinimaxManifest(dir);
	if (!manifest) return undefined;
	const messagesPath = join(dir, "messages.jsonl");
	try {
		const info = await stat(messagesPath);
		if (!info.isFile() || info.size === 0) return undefined;
		const [cwd, headLines] = await Promise.all([readMinimaxCwd(dir), readMessagesHeadLines(messagesPath)]);
		return {
			sessionId: manifest.sessionId,
			dir,
			messagesPath,
			cwd,
			createdAt: manifest.createdAtMs,
			updatedAt: Math.max(manifest.updatedAtMs, info.mtimeMs),
			sourceMtime: info.mtimeMs,
			sourceSize: info.size,
			headLines,
		};
	} catch {
		return undefined;
	}
}

/**
 * 扫描属于指定项目的会话：cwd（llm-call.json；缺失时用 sqlite 索引的 workspace_dir）
 * 与项目路径匹配的才返回，更新时间新在前。
 */
export async function scanMinimaxSessions(root: string, projectPath: string, index?: Map<string, MinimaxSqliteEntry>): Promise<MinimaxSessionMeta[]> {
	const target = normalizePath(projectPath);
	const dirs = await listMinimaxSessionDirs(root).catch(() => []);
	// v2 目录 = sessions 根的父目录；仅在需要时读一次 sqlite（调用方也可注入预读索引/测试假索引）
	const sqliteIndex = index ?? (await readMinimaxSqliteIndex(dirname(root)));
	const metas: MinimaxSessionMeta[] = [];
	for (const dir of dirs) {
		const meta = await readMinimaxSessionMeta(dir).catch(() => undefined);
		if (!meta) continue;
		const entry = sqliteIndex.get(meta.sessionId);
		meta.sourceTitle = entry?.title;
		// cwd 优先 llm-call.json（逐会话精确）；缺失时用 sqlite 的 workspace_dir
		const effectiveCwd = meta.cwd || entry?.workspaceDir || "";
		if (!effectiveCwd || normalizePath(effectiveCwd) !== target) continue;
		meta.cwd = effectiveCwd;
		metas.push(meta);
	}
	return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}
