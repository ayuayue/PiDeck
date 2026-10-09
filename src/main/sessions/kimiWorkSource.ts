import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { KimiWorkShareRootInfo, KimiWorkShareRootOrigin } from "../../shared/types/imports";
import { getSharedSqlJs } from "../sqlJsRuntime";
import { readImportMetaHead } from "./importMetaHead";
import { assertSourceWithinRoot } from "./importPathGuard";
import { readSessionSourceHead } from "./sessionSourceHead";
import { getProjectSessionDir, type KimiRecord } from "./kimiSessionSource";

/**
 * Kimi Work（kimi-desktop 桌面版）会话源解析：数据目录探测 + 会话定位。
 *
 * 本模块保持纯 Node（无 electron import）：appData 等环境路径全部由调用方注入，
 * node --test 可以直接加载做行为级单测。electron 侧的装配在 KimiWorkSessionImporter。
 *
 * 数据布局（实测 Kimi Work 1.x，Windows，2026-10 用真实 D:\KimiData 实例验证）：
 *   <share>/daimon/runtime/kimi-code/home/sessions/<wd 标记>/<conv-id>/agents/main/wire.jsonl
 *     └ 会话真身。Kimi Work 内嵌 Kimi Code CLI 作 agent runtime，wire 格式与 CLI
 *       完全一致（metadata/config.update 头 + context.append_message + loop 事件流）。
 *       <wd 标记> 形如 wd_pi-desktop-dev_98629d2b9dda（工作目录名 + hash）。
 *   <share>/daimon/agents/main/sessions/hosted-logical/conversations.sqlite
 *     └ hosted UI 层的元数据索引（title/workspace_path/kernel_records_path）。
 *       ⚠ SQLite WAL 模式：Kimi Work 运行中最近提交可能还没 checkpoint 进主文件，
 *       sql.js 只读主文件字节 → 里面可能是 0 行。所以 scan 的主索引必须是文件
 *       系统扫描，sqlite 行只作 title/workspace 的增强（读不到就回退）。
 */

/** conversations.sqlite 异常体积上界：正常几十 KB；超界按解析失败处理，防主进程被拉爆。 */
const KIMI_WORK_DB_BYTES_LIMIT = 64 * 1024 * 1024;

/** daimon-storage.json 体积上界：正常几十字节。 */
const KIMI_WORK_STORAGE_JSON_BYTES = 16 * 1024;

/** Kimi Work 相对 electron userData 的目录名（kimi-desktop 的 userData 默认 %APPDATA%/kimi-desktop）。 */
export const KIMI_WORK_APP_DIR = "kimi-desktop";
/** daimon-storage.json：Kimi Work 记录自定义数据目录（shareDir）的配置文件。 */
export const KIMI_WORK_STORAGE_FILE = "daimon-storage.json";
/** 默认安装（未自定义）时 daimon-share 与 userData 同级同名。 */
export const KIMI_WORK_DEFAULT_SHARE_NAME = "daimon-share";

/** conversations.sqlite 在 daimon-share 内的固定相对位置。 */
export function kimiWorkDbPath(shareRoot: string): string {
	return join(shareRoot, "daimon", "agents", "main", "sessions", "hosted-logical", "conversations.sqlite");
}

/** 内嵌 Kimi Code runtime 的会话索引目录（scan 主索引所在）。 */
export function kimiWorkRuntimeSessionsDir(shareRoot: string): string {
	return join(shareRoot, "daimon", "runtime", "kimi-code", "home", "sessions");
}

/** 扫描会话数上界：正常个人使用远低于此；超界防 readdir 失控（并发写入/损坏目录）。 */
const KIMI_WORK_SESSIONS_LIMIT = 5000;

async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * 读 kimi-desktop 的 daimon-storage.json，取用户自定义的 shareDir。
 * 文件缺失/损坏/字段非法 → 返回空（探测链继续走默认位置）。
 */
export async function readKimiWorkStorageShareDir(appDataDir: string): Promise<string> {
	const storagePath = join(appDataDir, KIMI_WORK_APP_DIR, KIMI_WORK_STORAGE_FILE);
	try {
		const head = await readFile(storagePath, "utf8");
		if (head.length > KIMI_WORK_STORAGE_JSON_BYTES) return "";
		const parsed = JSON.parse(head) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
		const shareDir = (parsed as Record<string, unknown>).shareDir;
		return typeof shareDir === "string" ? shareDir : "";
	} catch {
		return "";
	}
}

export type ResolvedKimiWorkRoot = { root: string; origin: KimiWorkShareRootOrigin };

/**
 * 数据目录探测链（优先级从高到低）：
 * 1. PiDeck settings 里用户显式指定的目录（kimiWorkShareRoot）；
 * 2. kimi-desktop daimon-storage.json 里记录的 shareDir（用户在 Kimi Work 里自定义过数据位置——
 *    Kimi Work 自身重启也靠这个文件，是自定义位置的唯一权威来源）；
 * 3. 默认安装位置 %APPDATA%/kimi-desktop/daimon-share。
 *
 * 命中判据：目录存在即认（runtime sessions 目录缺失 = 装了但还没有会话，UI 侧用 sessionsFound 区分提示）。
 * 全部落空 → 返回 undefined（渲染层提示「未检测到 Kimi Work」）。
 */
export async function resolveKimiWorkShareRoot(appDataDir: string, customRoot?: string): Promise<ResolvedKimiWorkRoot | undefined> {
	const candidates: Array<{ root: string; origin: KimiWorkShareRootOrigin }> = [];
	if (customRoot && customRoot.trim()) candidates.push({ root: customRoot.trim(), origin: "settings" });
	const storageShareDir = await readKimiWorkStorageShareDir(appDataDir);
	if (storageShareDir) candidates.push({ root: storageShareDir, origin: "app-config" });
	candidates.push({ root: join(appDataDir, KIMI_WORK_APP_DIR, KIMI_WORK_DEFAULT_SHARE_NAME), origin: "default" });

	for (const candidate of candidates) {
		if (await pathExists(candidate.root)) return candidate;
	}
	return undefined;
}

/** 探测结果（导入弹窗展示用）：root/origin + 会话索引目录是否存在。 */
export async function describeKimiWorkShareRoot(appDataDir: string, customRoot?: string): Promise<KimiWorkShareRootInfo> {
	const resolved = await resolveKimiWorkShareRoot(appDataDir, customRoot);
	if (!resolved) return { root: null, origin: null, sessionsFound: false };
	return {
		root: resolved.root,
		origin: resolved.origin,
		sessionsFound: await pathExists(kimiWorkRuntimeSessionsDir(resolved.root)),
	};
}

/** conversations 表行的白名单投影：extra_json / peer 等含敏感内容的列一概不读。 */
export type KimiWorkConversationRow = {
	conversationId: string;
	title: string;
	firstUserText: string;
	workspacePath: string;
	recordsPath: string;
	createdAtMs: number;
	updatedAtMs: number;
};

function toRow(record: Record<string, unknown>): KimiWorkConversationRow {
	const text = (value: unknown) => (typeof value === "string" ? value : "");
	const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	return {
		conversationId: text(record.conversation_id),
		title: text(record.title),
		firstUserText: text(record.first_user_text),
		workspacePath: text(record.workspace_path),
		recordsPath: text(record.kernel_records_path),
		createdAtMs: number(record.created_at_ms),
		updatedAtMs: number(record.updated_at_ms),
	};
}

/**
 * 只读 conversations.sqlite 列出全部会话（按更新时间倒序）。
 *
 * - sql.js 把整个文件读进 WASM 内存解析——所以必须有 KIMI_WORK_DB_BYTES_LIMIT 上界；
 * - WAL 注意：Kimi Work 运行中最近的提交可能还在 conversations.sqlite-wal 里，
 *   sql.js 不读 WAL → 运行中扫描可能缺最新一两条会话（口径与 Codex 标题一致，
 *   UI 侧提示「建议关闭 Kimi Work 后导入」）。
 * - db 文件不存在 / 超界 / 坏库 → 抛错，由调用方决定按空列表兜底。
 * - 本函数只提供元数据增强（title/workspace/精确时间）；会话主索引是
 *   scanKimiWorkRuntimeSessions 的文件扫描，不依赖这里读得到行。
 */
export async function readKimiWorkConversations(dbPath: string, locateFile: (file: string) => string): Promise<KimiWorkConversationRow[]> {
	const bytes = await readFile(dbPath);
	if (bytes.byteLength > KIMI_WORK_DB_BYTES_LIMIT) {
		throw new Error(`Kimi Work conversations.sqlite exceeds ${KIMI_WORK_DB_BYTES_LIMIT} bytes`);
	}
	const SQL = await getSharedSqlJs(locateFile);
	const db = new SQL.Database(bytes);
	try {
		// stmt 持有期间 close 会在部分 sql.js 版本上报错，这里同步全部消费完再释放
		const stmt = db.prepare("SELECT conversation_id, title, first_user_text, workspace_path, kernel_records_path, created_at_ms, updated_at_ms FROM conversations ORDER BY updated_at_ms DESC");
		try {
			const rows: KimiWorkConversationRow[] = [];
			while (stmt.step()) {
				rows.push(toRow(stmt.getAsObject() as Record<string, unknown>));
			}
			return rows;
		} finally {
			stmt.free();
		}
	} finally {
		db.close();
	}
}

/** kernel_records_path 归一化（Windows 反斜杠/正斜杠混用）。 */
export function normalizeKimiWorkPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** wd 标记 → 工作目录名：wd_pi-desktop-dev_98629d2b9dda → pi-desktop-dev。 */
export function parseWorkdirMarker(marker: string): string {
	// 目录名可含 -/_；尾部 hash ≥ 6 位 hex。非贪婪 + 锚定尾部：目录名末段恰似 hex 时可能错切，
	// 错切的后果只是项目匹配降级为「不匹配」（会话仍列出，只是不排前），可接受。
	const match = /^wd_(.+?)_([0-9a-f]{6,})$/i.exec(marker);
	return match ? match[1] : "";
}

export type KimiWorkRuntimeSession = {
	conversationId: string;
	wirePath: string;
	/** wd 标记提取的工作目录名（标记不合规为空串）。 */
	workdirName: string;
	/** wire mtime（scan 排序与导入标记比对用）。 */
	updatedAtMs: number;
};

/** 校验 wirePath 是内嵌 runtime 的合法会话文件（大小写/斜杠无关），提取标记与 conv-id。 */
export function parseKimiWorkRuntimeWirePath(shareRoot: string, wirePath: string): { marker: string; conversationId: string } | null {
	const base = normalizeKimiWorkPath(shareRoot).toLowerCase();
	const target = normalizeKimiWorkPath(wirePath).toLowerCase();
	if (target !== base && !target.startsWith(`${base}/`)) return null;
	const rel = "daimon/runtime/kimi-code/home/sessions/";
	if (!target.startsWith(`${base}/${rel}`)) return null;
	const parts = target.slice(base.length + rel.length + 1).split("/");
	if (parts.length !== 5 || parts[2] !== "agents" || parts[3] !== "main" || parts[4] !== "wire.jsonl") return null;
	return { marker: parts[0], conversationId: parts[1] };
}

/**
 * 文件系统扫描内嵌 Kimi Code runtime 会话（scan 主索引）。
 *
 * 为什么不用 conversations.sqlite 作索引：Kimi Work 运行中 WAL 未 checkpoint 时主 db
 * 是空的（sql.js 读不到 WAL），列表会整个丢失；runtime 目录下的 wire.jsonl 是落盘
 * 事实，目录即索引。不读 sqlite 也能工作，见 readKimiWorkConversations 注释。
 */
export async function scanKimiWorkRuntimeSessions(shareRoot: string): Promise<KimiWorkRuntimeSession[]> {
	const sessionsRoot = kimiWorkRuntimeSessionsDir(shareRoot);
	let markers: Array<{ name: string; path: string }>;
	try {
		const entries = await readdir(sessionsRoot, { withFileTypes: true });
		markers = entries.filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, path: join(sessionsRoot, entry.name) }));
	} catch {
		return [];
	}

	const sessions: KimiWorkRuntimeSession[] = [];
	for (const marker of markers) {
		if (sessions.length > KIMI_WORK_SESSIONS_LIMIT) break;
		let conversations: Array<{ name: string; path: string }>;
		try {
			const entries = await readdir(marker.path, { withFileTypes: true });
			conversations = entries.filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, path: join(marker.path, entry.name) }));
		} catch {
			continue;
		}
		for (const conversation of conversations) {
			if (sessions.length > KIMI_WORK_SESSIONS_LIMIT) break;
			const wirePath = join(conversation.path, "agents", "main", "wire.jsonl");
			try {
				const info = await stat(wirePath);
				if (!info.isFile()) continue;
				sessions.push({
					conversationId: conversation.name,
					wirePath,
					workdirName: parseWorkdirMarker(marker.name),
					updatedAtMs: info.mtimeMs,
				});
			} catch {
				// wire.jsonl 缺失（目录在但会话没落盘）跳过
			}
		}
	}
	sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
	return sessions;
}

/** 从 wire 头部记录提取 metadata.created_at（sqlite 行缺失时的合成元数据用）。 */
export function extractKimiWorkCreatedAt(entries: KimiRecord[]): number {
	for (const entry of entries) {
		if (entry.type === "metadata") {
			const value = entry.created_at;
			if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
		}
	}
	return 0;
}

/**
 * 路径安全：kernel_records_path 来自外部数据库（不可信输入），导入前必须
 * 校验它落在 daimon-share 根之内，防止被注入「读任意文件」的路径。
 */
export function assertKimiWorkSourcePath(shareRoot: string, filePath: string): void {
	// 语义校验（resolve 后比较）：词法 startsWith 不解析 `..`（2026-03 导入器安全审计）
	assertSourceWithinRoot(shareRoot, filePath, "Kimi Work");
}

/** wire.jsonl 的 stat（新鲜度判据：size/mtime 与导入标记比对）。文件缺失返回 null。 */
export async function statKimiWorkWire(wirePath: string): Promise<{ size: number; mtimeMs: number } | null> {
	try {
		const info = await stat(wirePath);
		return { size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return null;
	}
}

/** 导入产物文件名：kimiwork_<conversationId>.jsonl（与 CLI 版 kimi_<id>.jsonl 区分开）。 */
export function getKimiWorkTargetPath(piRoot: string, projectPath: string, conversationId: string): string {
	const id = conversationId.replace(/[^a-zA-Z0-9_-]/g, "-");
	return join(getProjectSessionDir(piRoot, projectPath), `kimiwork_${id}.jsonl`);
}

/** 导入标记读取（有界头部，见 importMetaHead 注释）。不存在 = 未导入。 */
export async function readKimiWorkImportMeta(targetPath: string): Promise<{ sourceMtime: number; sourceSize: number } | undefined> {
	return readImportMetaHead(targetPath, "kimi_work_import");
}

/**
 * wire.jsonl 有界头部读取（scan 摘要用）：返回已解析的头部记录。
 * 坏行跳过（头部截断可能切在行中间）；体积与 wire 大小解耦（sessionSourceHead 注释）。
 */
export async function readKimiWorkWireHead(wirePath: string): Promise<KimiWorkHeadRecords> {
	const { head, size, mtimeMs } = await readSessionSourceHead(wirePath);
	const entries: KimiRecord[] = [];
	for (const line of head.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (parsed && typeof parsed === "object") entries.push(parsed as KimiRecord);
		} catch {
			// 坏行跳过：截断可能切在多字节字符上
		}
	}
	return { entries, size, mtimeMs };
}

export type KimiWorkHeadRecords = {
	entries: KimiRecord[];
	size: number;
	mtimeMs: number;
};
