import { isActiveSessionStatus, sessionStatusDotClass } from "../../agentListDisplay";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";

/**
 * 侧栏会话行的运行状态点（活动行与最近会话行共用）。
 *
 * 没有可展示的状态时**整格不渲染**，而不是渲染一个没有底色的 span：
 * 早期的活动页只判 `runtime &&`，会话关闭后 runtime 仍在位（status=closed/detached），
 * 空 span 连同 `gap-1.5` 一起占掉标题左侧约 12px，用户看到「关闭后标题左边多出一截
 * 内边距」（#390）。色点语义仍由 sessionStatusDotClass 决定（idle 蓝 / 运行黄 / error 红）。
 */
export function SidebarStatusDot(props: { status?: string | null }) {
	const dotClass = sessionStatusDotClass(props.status);
	if (!dotClass) return null;
	return <span className={cn("size-1.5 shrink-0 rounded-full", dotClass)} aria-hidden="true" />;
}

/**
 * 带无障碍标签与活跃脉动的会话状态点：项目树会话行与分组树会话行共用。
 * 与 SidebarStatusDot 同色语义，区别只在 label / 脉动（#483：只有活跃状态才脉动，
 * 空闲会话挂 animate-pulse 会让侧栏常驻合成）。
 * 没有 runtime 的历史记录传 undefined，纯打开记录不会被误标成已启动。
 */
export function SessionRuntimeStatusDot(props: { status?: string | null }) {
	const dotClass = sessionStatusDotClass(props.status);
	if (!dotClass) return null;
	const active = isActiveSessionStatus(props.status);
	const label = props.status === "idle" ? t("app.statusIdle") : props.status === "error" ? t("app.statusError") : active ? t("app.statusRunning") : undefined;
	return <span className={cn("size-1.5 shrink-0 rounded-full", dotClass, active && "animate-pulse")} aria-label={label} title={label} />;
}
