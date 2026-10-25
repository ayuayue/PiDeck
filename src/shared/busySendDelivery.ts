/**
 * Agent 忙碌时发送消息的默认投递行为（设置项 busySendDelivery 的取值与解析）。
 *
 * 纯函数无依赖：主进程 SettingsStore 用 parse 做磁盘值校验，
 * 渲染层发送链路用 resolveBusySendDelivery 做统一决策——pi/dsh 共用同一入口，
 * UI 行为对齐；各后端主进程自行把语义映射到 wire 协议
 * （pi streamingBehavior / DSH sessions.prompt mode）。
 */

/** 忙碌时默认投递行为：steer=插入当前回合（尽快送达）；followUp=排队到下一轮 */
export type BusySendDelivery = "steer" | "followUp";

export const DEFAULT_BUSY_SEND_DELIVERY: BusySendDelivery = "steer";

/**
 * 解析持久化/渲染层传入的投递行为配置。
 * 磁盘 JSON 无类型，旧数据或坏值一律回落默认（steer），不抛错。
 */
export function parseBusySendDelivery(value: unknown): BusySendDelivery {
	return value === "followUp" ? "followUp" : DEFAULT_BUSY_SEND_DELIVERY;
}

/**
 * 忙碌时发送的统一决策入口：
 * - 空闲 → undefined（直发，无需队列语义）；
 * - 忙碌 → 按设置返回 "steer" | "followUp"。
 * - 例外：ACP 后端忙碌恒 followUp——ACP v1 没有 steer 协议通道（agent 回合中
 *   只有 session/cancel），忙碌时直发只会被 AcpAgentManager 拒收成失败队列项；
 *   收敛为排队到下一轮（Zed 同款队列体验），设置项对它失效。
 * 渲染层的入队快捷路径与 flush 投递都消费该结果。
 */
export function resolveBusySendDelivery(busy: boolean, configured: unknown, backend?: string): BusySendDelivery | undefined {
	if (!busy) return undefined;
	if (backend === "acp") return "followUp";
	return parseBusySendDelivery(configured);
}
