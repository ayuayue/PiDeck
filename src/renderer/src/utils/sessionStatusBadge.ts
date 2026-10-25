import type { AnimatedBadgeStatus } from "../components/motion/animated-badge";

/** Tab 徽章的「操作进行中」标记：重启/停止/重载期间统一切到 loading 旋转。 */
export type SessionTabBusyState = {
	isRestarting?: boolean;
	isStopping?: boolean;
	isReloading?: boolean;
};

export type SessionStatusBadge = { status: AnimatedBadgeStatus; colorClass?: string } | undefined;

/**
 * 会话状态 → Tab 徽章状态映射（纯函数，可单测）。
 *
 * 业务规则（颜色语义与用户约定一致）：
 * - 操作进行中（重启/停止/重载）优先级最高：统一 loading（蓝色旋转），
 *   操作完成后回落 status 徽章——这是 tab 栏下拉菜单操作的可见反馈来源；
 * - starting=loading（启动中：蓝色旋转）；
 * - running/pending/waiting=loading + 黄色覆盖（运行/等待中：黄色旋转）；
 * - idle=neutral（未启动：白/灰图标）；
 * - error=danger（失败：红色图标）；
 * - detached/closed/未启动且无操作返回 undefined（不渲染徽章，避免把「未运行」误读成某种状态）。
 */
export function sessionStatusBadge(status?: string | null, busy?: SessionTabBusyState): SessionStatusBadge {
	// 重启/停止/重载进行中：优先级高于 status，统一显示 loading（旋转）作为可见反馈。
	if (busy?.isRestarting || busy?.isStopping || busy?.isReloading) {
		return { status: "loading" };
	}
	if (!status || status === "detached") return undefined;
	switch (status) {
		case "error":
			return { status: "danger" };
		case "idle":
			return { status: "neutral" };
		// 启动中：官方 loading（primary 蓝）旋转；运行/等待：同 loading 旋转但覆盖为黄色。
		case "starting":
			return { status: "loading" };
		case "running":
		case "pending":
		case "waiting":
			return {
				status: "loading",
				colorClass: "text-amber-500 dark:text-amber-400",
			};
		default:
			return undefined;
	}
}
