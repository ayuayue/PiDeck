import { Fragment } from "react";
import type { ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "../ui-shadcn/button";
import { t } from "../../i18n";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { cn } from "../../lib/utils";

/**
 * 抽屉活动栏动作项：由 App 层组装（复用与 outline 相同的打开/关闭语义），
 * rail 本体只负责渲染与激活态展示，不感知具体面板业务。
 */
export type WorkspaceDrawerRailAction = {
	id: string;
	label: string;
	icon: ReactNode;
	active: boolean;
	pinned?: boolean;
	canRemove?: boolean;
	onClick: () => void;
	onTogglePinned?: () => void;
};

/**
 * 右侧抽屉活动栏（#115 pure official）：横排 tab，shadcn ghost/secondary 按钮。
 * 抽屉打开期间始终可见，无活跃会话时也能切换 files/git/browser。
 * 可移除 tab 的 X 收在 tab 右上角角标里（活动 tab 常驻，其余悬停/聚焦才显现），
 * 不再是 tab 后面跟一颗独立按钮（用户反馈「× 挂在 tab 后面太丑」）；
 * X 与所属 tab 同组渲染、加号下拉收尾的结构保持不变（2026-10 remove 错位回归），
 * 契约见 tests/workspaceDrawer.test.mjs。
 * 开/关抽屉按钮留在会话 Tab 栏右侧，不进本栏。
 */
export function WorkspaceDrawerRail(props: { actions: WorkspaceDrawerRailAction[]; addLabel: string }) {
	if (props.actions.length === 0) return null;
	const optionalActions = props.actions.filter((action) => action.canRemove && action.onTogglePinned);
	// 活动面板必须在 rail 里可见：外部入口（消息里的「在浏览器打开」、插件打开本地服务 UI）只切内容
	// 不钉住 tab，漏掉 active 会让面板内容看起来「没有归属 tab」（2026-10 用户反馈）。
	const visibleActions = props.actions.filter((action) => (action.pinned ?? false) || !action.canRemove || action.active);
	return (
		<div className="drawer-activity-rail flex h-10 shrink-0 items-center gap-1 border-b border-border/40 bg-background px-2" role="tablist" aria-orientation="horizontal">
			{visibleActions.map((action) => (
				<Fragment key={action.id}>
					{/* group 容器：X 角标相对 tab 定位，悬停/聚焦时显现，活动 tab 常驻 */}
					<div className="group relative shrink-0" role="presentation">
						<Button
							type="button"
							role="tab"
							aria-selected={action.active}
							data-testid={`drawer-rail-${action.id}`}
							variant={action.active ? "secondary" : "ghost"}
							size="icon"
							className={cn("drawer-activity-rail-button relative size-8", action.active && "active")}
							title={action.label}
							aria-label={action.label}
							onClick={action.onClick}
						>
							{action.icon}
							{action.active ? <span className="pointer-events-none absolute inset-x-1.5 -bottom-1 h-0.5 rounded-full bg-foreground" aria-hidden="true" /> : null}
						</Button>
						{action.canRemove && action.pinned && action.onTogglePinned ? (
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className={cn(
									"drawer-rail-remove absolute -top-1 -right-1 z-10 size-4 rounded-full border border-border/60 bg-background p-0 text-muted-foreground shadow-sm transition-opacity hover:bg-bg-hover hover:text-text-primary focus-visible:opacity-100",
									action.active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
								)}
								title={t("drawer.removePanel", { label: action.label })}
								aria-label={t("drawer.removePanel", { label: action.label })}
								onClick={action.onTogglePinned}
							>
								<X size={10} />
							</Button>
						) : null}
					</div>
				</Fragment>
			))}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button type="button" variant="ghost" size="icon" className="size-8" title={props.addLabel} aria-label={props.addLabel}>
						<Plus size={16} />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					{optionalActions.map((action) => (
						<DropdownMenuCheckboxItem key={action.id} checked={action.pinned ?? false} onCheckedChange={() => action.onTogglePinned?.()}>
							{action.icon}
							{action.label}
						</DropdownMenuCheckboxItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
