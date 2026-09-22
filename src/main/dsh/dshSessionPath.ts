import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * DSH 会话持久化路径编码（DshAgentManager 与 DshHost 共用）：
 * $DSH_HOME/sessions/<workspace 编码目录>/<sessionId>/session[.vN].jsonl.zstd。
 * 日志文件名带「格式代」：v0 是无版本名的旧拼法，v1+ 带小写数字 `vN`（详见
 * generationLogFilename 语义与下方 findDshSessionLogFile）。
 * workspace 目录名编码规则与 dsh-session-persistence-jsonl 的 projectKey 一致
 * （2026-08 实测对齐）：路径分隔符与盘符冒号折叠为 "-"，安全字符原样，
 * 其余按 ~XXXX 转义，首尾补 "-" 并截断 251 字符。
 */
export function workspaceDirFor(cwd: string): string {
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i += 1) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * 会话日志文件名（官方 `generationLogFilename` 语义）：格式版本 0 保留无版本名
 * `session.jsonl[.zstd]`，之后每一代带小写数字 `vN`（如 `session.v3.jsonl.zstd`）。
 * 同一会话目录只发布一个 generation（官方 current-generation publication 互斥），
 * 但历史目录仍是 v0，所以发现逻辑必须两种都认。
 *
 * 事故背景：只认 v0 名字会让 v1+ 的新会话在 PiDeck 侧「不存在」——外部会话清单
 * 缺最新会话、findDshSessionDir 找不到目录（删不掉）、sessionPath 指向不存在的文件。
 */
const SESSION_LOG_FILENAME_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;

/**
 * 在会话目录里发现 host 日志文件；返回 undefined 表示不是 DSH 会话目录。
 * 多 generation 并存时取版本号最大的（实际只有归档/异常场景会遇到），同版本优先压缩件。
 * 非官方拼法（前导零、大写、临时名）不认，避免把半成品当成会话。
 */
export function findDshSessionLogFile(dir: string): { path: string; compressed: boolean } | undefined {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return undefined; // 目录不存在/无权限：视为不是会话目录
	}
	let best: { path: string; compressed: boolean; version: number } | undefined;
	for (const name of entries) {
		const match = SESSION_LOG_FILENAME_RE.exec(name);
		if (!match) continue;
		const rawVersion = match[1];
		// 官方 canonical 规则：版本号不带前导零（"v03" 不是已发布的 generation）。
		if (rawVersion !== undefined && rawVersion.length > 1 && rawVersion.startsWith("0")) continue;
		const version = rawVersion === undefined ? 0 : Number(rawVersion);
		if (!Number.isSafeInteger(version)) continue;
		const compressed = match[2] === ".zstd";
		// 跳过：版本更旧，或同版本但本次不是压缩件（压缩态优先）。
		if (best && (version < best.version || (version === best.version && !compressed))) continue;
		best = { path: join(dir, name), compressed, version };
	}
	return best ? { path: best.path, compressed: best.compressed } : undefined;
}

/**
 * DSH 会话的持久化文件路径（zstd 压缩的 host 会话日志）。
 * 已存在的会话按实际 generation 解析（v0 `session.jsonl.zstd` / v1+ `session.v<N>.jsonl.zstd`）；
 * 尚未落盘（新建会话）时返回 v0 规范名，保证调用方拿到确定性路径。
 */
export function dshSessionFilePath(dshHome: string, cwd: string, sessionId: string): string {
	const dir = join(dshHome, "sessions", workspaceDirFor(cwd), sessionId);
	return findDshSessionLogFile(dir)?.path ?? join(dir, "session.jsonl.zstd");
}

/** 会话目录是否带 host 持久化日志（任意 generation 的 session[.vN].jsonl[.zstd]）。 */
function isDshSessionDir(dir: string): boolean {
	return findDshSessionLogFile(dir) !== undefined;
}

/**
 * 定位活跃 DSH 会话目录（删除/归档共用）：先按 cwd 编码路径精确推导；
 * cwd 失配（项目目录被移动/改名、兑底项目无 cwd）时兜底扫描 sessions 树中
 * 目录名 == sessionId 且带会话日志的条目（只读，不会误删非会话目录）。
 * 找不到返回 undefined。
 */
export function findDshSessionDir(dshHome: string, cwd: string, sessionId: string): string | undefined {
	const derived = join(dshHome, "sessions", workspaceDirFor(cwd), sessionId);
	if (isDshSessionDir(derived)) return derived;
	const sessionsRoot = join(dshHome, "sessions");
	if (!existsSync(sessionsRoot)) return undefined;
	let workspaceNames: string[];
	try {
		workspaceNames = readdirSync(sessionsRoot, { withFileTypes: true })
			.filter((item) => item.isDirectory())
			.map((item) => item.name);
	} catch {
		return undefined;
	}
	for (const workspace of workspaceNames) {
		const candidate = join(sessionsRoot, workspace, sessionId);
		if (isDshSessionDir(candidate)) return candidate;
	}
	return undefined;
}
