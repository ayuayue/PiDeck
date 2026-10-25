import { sessionStatusDotClass } from "../../agentListDisplay";
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
