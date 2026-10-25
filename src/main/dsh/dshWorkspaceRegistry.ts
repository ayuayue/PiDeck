import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 只读解析 DSH 官方 workspace 注册表。
 *
 * 权威落点：`$DSH_HOME/storages/workspace.json`（`@deepseek-ai/dsh-workspace`）。
 * dsh-web「未分组」= 不在任何 workspace.sessionIds 里的会话；
 * 后续只按 cwd 创建的会话官方不会自动入账（README：later cwd-only remain Ungrouped）。
 *
 * 只读、失败跳过：不手写这份文件。认领必须走 host `sessions.create({workspaceId, sessionId})`，
 * 由官方 attachSession 校验 header.cwd === workspace.path。
 */

export const DSH_WORKSPACE_REGISTRY_RELATIVE = join("storages", "workspace.json");

/** 官方 workspace 记录（只取认领/对照需要的字段）。 */
export type DshWorkspaceRecord = {
	workspaceId: string;
	path: string;
	title?: string;
	sessionIds: string[];
};

/** 从一条 workspace 行取出 path / sessionIds；结构不对则跳过。 */
export function workspaceRecordFromUnknown(workspaceId: string, record: unknown): DshWorkspaceRecord | undefined {
	if (!workspaceId.trim() || !record || typeof record !== "object") return undefined;
	const row = record as Record<string, unknown>;
	const path = typeof row.path === "string" ? row.path.trim() : "";
	if (!path) return undefined;
	const rawIds = Array.isArray(row.sessionIds) ? row.sessionIds : [];
	const sessionIds = rawIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()));
	const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : undefined;
	return {
		workspaceId,
		path,
		sessionIds,
		...(title ? { title } : {}),
	};
}

/** 解析整份 workspace.json → workspace 列表。坏 JSON / 缺表返回空。 */
export function parseWorkspaceRegistry(raw: string): DshWorkspaceRecord[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object") return [];
	const tables = (parsed as { tables?: unknown }).tables;
	if (!tables || typeof tables !== "object") return [];
	const workspaces = (tables as { workspaces?: unknown }).workspaces;
	if (!workspaces || typeof workspaces !== "object") return [];
	const found: DshWorkspaceRecord[] = [];
	for (const [workspaceId, record] of Object.entries(workspaces as Record<string, unknown>)) {
		const parsedRecord = workspaceRecordFromUnknown(workspaceId, record);
		if (parsedRecord) found.push(parsedRecord);
	}
	return found;
}

/** 读 DSH_HOME 上的官方 workspace 注册表（缺失/不可读 = 空）。 */
export function readWorkspaceRegistry(dshHome: string): DshWorkspaceRecord[] {
	const filePath = join(dshHome, DSH_WORKSPACE_REGISTRY_RELATIVE);
	if (!existsSync(filePath)) return [];
	try {
		return parseWorkspaceRegistry(readFileSync(filePath, "utf8"));
	} catch {
		return [];
	}
}

/** 已入账会话 id（出现在任一 workspace.sessionIds）。 */
export function accountedSessionIds(workspaces: readonly DshWorkspaceRecord[]): Set<string> {
	const accounted = new Set<string>();
	for (const workspace of workspaces) {
		for (const sessionId of workspace.sessionIds) accounted.add(sessionId);
	}
	return accounted;
}

/**
 * Windows 下忽略大小写与分隔符比较目录（与 ProjectStore.sameProjectPath 对齐）。
 * 认领前只做磁盘对照；真正写入仍由官方 attachSession 做 realpath 校验。
 */
export function sameWorkspacePath(left: string, right: string): boolean {
	const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/g, "").replace(/\/+/g, "/");
	const a = normalize(left);
	const b = normalize(right);
	if (!a || !b) return false;
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 按会话 cwd 找已注册 workspace；没有匹配返回 undefined（不得为此新建 workspace）。 */
export function findWorkspaceByCwd(workspaces: readonly DshWorkspaceRecord[], cwd: string): DshWorkspaceRecord | undefined {
	return workspaces.find((workspace) => sameWorkspacePath(workspace.path, cwd));
}
