import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * DSH 会话持久化路径编码（DshAgentManager 与 DshHost 共用）：
 * $DSH_HOME/sessions/<workspace 编码目录>/<sessionId>/session.jsonl.zstd。
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

/** DSH 会话的持久化文件路径（session.jsonl.zstd，zstd 压缩的 host 会话日志）。 */
export function dshSessionFilePath(dshHome: string, cwd: string, sessionId: string): string {
	return join(dshHome, "sessions", workspaceDirFor(cwd), sessionId, "session.jsonl.zstd");
}

/** 会话目录是否带 host 持久化日志（session.jsonl.zstd 或未压缩 session.jsonl）。 */
function isDshSessionDir(dir: string): boolean {
	return existsSync(join(dir, "session.jsonl.zstd")) || existsSync(join(dir, "session.jsonl"));
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
