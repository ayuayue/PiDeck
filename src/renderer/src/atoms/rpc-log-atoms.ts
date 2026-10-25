import { atom } from "jotai";

/**
 * 开启了 RPC 日志记录的 agentId 集合（渲染层镜像；主进程 per-agent 开关是权威数据源）。
 *
 * 写入方（都跟随主进程回执，不自行推测状态）：
 * - App 层 rpc.setLogging 包装的 IPC 回执（侧栏菜单开关与日志面板内开关共用此路径）；
 * - 侧栏菜单打开时的 getRpcLogging 预查（修正重启/跨窗口造成的状态漂移）。
 * 读取方：
 * - 侧栏右键菜单的开关文案（isAgentRpcLogging）；
 * - 右侧抽屉 rpcLog 专属 Tab 的显隐门控（App.tsx 活动栏组装）。
 *
 * agentId 每次 spawn 随机、旧键无复用价值：关闭即删键；Tab 门控还会叠加
 * 「该 agent 仍有活跃 runtime」判定，因此镜像里偶发的陈旧键只会让 Tab 隐藏（保守方向）。
 */
export const rpcLoggingAgentIdsAtom = atom<ReadonlySet<string>>(new Set<string>());

/**
 * 返回增删 agentId 后的新集合；无变化时返回原引用（jotai Object.is 比较，避免无谓重渲）。
 * 纯函数，供三处写入方共用同一份增删语义。
 */
export function toggleRpcLoggingAgent(ids: ReadonlySet<string>, agentId: string, enabled: boolean): ReadonlySet<string> {
	if (enabled ? ids.has(agentId) : !ids.has(agentId)) return ids;
	const next = new Set(ids);
	if (enabled) next.add(agentId);
	else next.delete(agentId);
	return next;
}
