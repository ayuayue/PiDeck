/**
 * 激活 Agent 数量监测的纯逻辑（无 React 依赖，便于单测）。
 *
 * 语义约定：
 * - 「激活」= 对应 pi 进程仍存活、占用内存的 Agent，包括 starting（启动中）、
 *   idle（空闲，侧栏蓝色点）、running（工作中，黄色点）、error（出错待处理，红色点）；
 * - closed / detached 不算激活：进程已结束或从未绑定运行时；
 * - 阈值语义：激活数量 >= HIGH_AGENT_COUNT_THRESHOLD 时，每次应用启动都会提示一次，
 *   建议用户右键关闭蓝色（空闲）状态的会话释放内存。
 */

import type { AgentStatus } from "../../../shared/types/agent";

/** 激活 Agent 数量告警阈值：达到该数量后每次启动提示用户释放资源。 */
export const HIGH_AGENT_COUNT_THRESHOLD = 15;

/** 视为「激活、占内存」的运行时状态集合。 */
export const ACTIVATED_AGENT_STATUSES: ReadonlySet<AgentStatus | "detached"> = new Set(["starting", "idle", "running", "error"]);

/** 统计激活 Agent 数量；入参用结构类型，避免单测时引入 jotai 依赖。 */
export function countActivatedAgents(runtimes: Record<string, { status?: string | null }>): number {
	let count = 0;
	for (const runtime of Object.values(runtimes)) {
		if (ACTIVATED_AGENT_STATUSES.has(runtime.status as AgentStatus | "detached")) {
			count += 1;
		}
	}
	return count;
}
