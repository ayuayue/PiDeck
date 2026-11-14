import type { WorkspaceId } from "@deepseek-ai/dsh-workspace/types";
import { listForeignSessionsFromDiskAsync, scanDshSessionHeadersAsync } from "./dshForeignSessionScan";
import type { DshRemoteClient } from "./dshRemoteClient";

/**
 * DSH 会话索引类查询的宿主协作者：内容搜索 / 磁盘会话扫描 / workspace id 解析。
 * 磁盘两个入口不启动 host（配置页概览不能为了数孤儿去抢 dsh-web），
 * 需要领域客户端的入口由宿主经接口透传（启动兜底留在宿主）。
 */
export type DshSessionIndexHost = {
	ensureStarted(): Promise<void>;
	getClient(): DshRemoteClient | null;
};

/**
 * DSH 会话内容搜索（G9）：wire `session.search` 搜索 user/assistant/steering 消息面，
 * 结果最多 20 个会话（无游标，hasMore 提示收窄查询）。返回 { sessionId, snippet }，
 * 由渲染层按 dshSessionId 映射回 catalog 记录。
 */
export async function searchDshSessions(host: DshSessionIndexHost, query: string): Promise<Array<{ sessionId: string; snippet: string }>> {
	const trimmed = query.trim();
	if (!trimmed) return [];
	await host.ensureStarted();
	const client = host.getClient();
	if (!client) return [];
	const searched = await client.sessionsSearch({ query: trimmed }, new AbortController().signal);
	if (!searched.result.ok) return [];
	return (searched.result.value.items ?? []).map((item) => ({
		sessionId: String(item.sessionId),
		snippet: item.snippet ?? "",
	}));
}

/**
 * 磁盘上全部已持久化会话 id（G3/D11：孤儿检测用）。
 * 只读扫 DSH_HOME/sessions，不启动 host——配置页概览不能为了数孤儿去抢 dsh-web。
 */
export async function listDshSessionIds(homeDir: string): Promise<string[]> {
	// 异步切片版（2027-02 性能审计）：同步整段扫会冻结事件循环数百 ms~秒级
	return (await scanDshSessionHeadersAsync(homeDir)).map((header) => header.id);
}

/**
 * 外部（dsh-web 等其他工具）创建的根会话清单：只读扫磁盘 header，
 * 不 fork host、不 sessions.list / history。双 host 会互相覆盖 session log。
 */
export async function listForeignDshSessions(homeDir: string): Promise<
	Array<{
		dshSessionId: string;
		title?: string;
		cwd?: string;
		updatedAt?: number;
	}>
> {
	// 异步切片版：冷会话折叠（256KiB 前缀 + zstd 解压）按会话让出，不再整段阻塞主进程
	return listForeignSessionsFromDiskAsync(homeDir);
}

/**
 * 解析 cwd 对应的 host workspace id（幂等）：走官方 workspace.create({path})，
 * 已存在目录返回既有 workspace，不会手写 workspace.json。
 * 新会话必须带这个 workspaceId 创建，host 才会 attachSession；
 * 只传 cwd 会永远留在 dsh-web「未分组」。失败返回 undefined，由创建方失败，
 * 不再静默降级成 cwd-only。
 * @param hostCwd 宿主视角的 workspace 路径（宿主已按 WSL 环境转换）。
 */
export async function resolveDshWorkspaceId(host: DshSessionIndexHost, hostCwd: string): Promise<WorkspaceId | undefined> {
	try {
		await host.ensureStarted();
		const client = host.getClient();
		if (!client) return undefined;
		const resolved = await client.workspaceCreate({ path: hostCwd });
		if (!resolved.result.ok) return undefined;
		return resolved.result.value.workspace.workspaceId;
	} catch {
		return undefined;
	}
}
