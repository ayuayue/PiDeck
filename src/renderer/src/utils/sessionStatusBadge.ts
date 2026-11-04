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
 * - 操作进行中（重启/停止/重载）优先级最高：统一 loading + 黄色覆盖，
 *   操作完成后回落 status 徽章——这是 tab 栏下拉菜单操作的可见反馈来源；
 * - starting/running/pending/waiting=loading + 黄色覆盖（启动/运行/等待中：黄色旋转）；
 * - idle=neutral + 蓝色覆盖（空闲：蓝色圆环，与侧栏一致）；
 * - error=danger（失败：红色图标）；
 * - detached/closed/未启动且无操作返回 undefined（不渲染徽章，避免把「未运行」误读成某种状态）。
 */
export function sessionStatusBadge(status?: string | null, busy?: SessionTabBusyState): SessionStatusBadge {
	// 重启/停止/重载进行中：优先级高于 status，统一显示 loading（旋转）作为可见反馈。
	if (busy?.isRestarting || busy?.isStopping || busy?.isReloading) {
		return { status: "loading", colorClass: "text-warning" };
	}
	if (!status || status === "detached") return undefined;
	switch (status) {
		case "error":
			return { status: "danger" };
		case "idle":
			return { status: "neutral", colorClass: "text-info" };
		// 启动/运行/等待中统一黄色，与侧栏和简洁模式一致，保留 loading 旋转。
		case "starting":
		case "running":
		case "pending":
		case "waiting":
			return {
				status: "loading",
				colorClass: "text-warning",
			};
		default:
			return undefined;
	}
}
