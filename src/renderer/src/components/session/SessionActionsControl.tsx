import { ChevronDown, LoaderCircle, Play, RefreshCcw, RotateCw, Square } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { canRunSessionAction } from "../../utils/sessionCommands";
import { Button } from "../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { SessionMenuItems, type SessionMenuModel, type SessionMenuRunControl } from "./SessionActionsMenu";

/**
 * 会话操作控制钮：原 Tab 栏「⋯」菜单的唯一入口 + pi 会话的运行/重载快捷钮。
 *
 * 为什么长这样（多轮用户反馈收敛的结果）：
 * - 常驻可见：hover 才出现等于右键菜单，不是快捷入口；
 * - 小体量：28px 高（与头部常规图标齐平），两个动作图标 + 一个下拉箭头，不是带边框的一排按钮；
 * - 功能收口：原来 Tab 栏右上角的「⋯」全部菜单项搬进这个「⋯」，Tab 栏不再有第二个菜单钮；
 * - 只对 pi 显示运行/重载快捷钮（DSH 共享 host、ACP 外部 CLI 没有会话级进程语义），
 *   但「⋯」对所有后端保留，否则 DSH/ACP 会丢掉重命名/导出/工具开关等入口。
 *
 * 视觉上无外框、无底色、无阴影；hover 只有一个小圆角反馈块。
 */
export function SessionActionsControl(props: { runControl?: SessionMenuRunControl; menu?: SessionMenuModel; className?: string }) {
	const { runControl, menu } = props;
	const capabilities = runControl?.capabilities;
	// pi 才有会话级运行控制与热重载（reloadMode=resources）；其它后端只留「⋯」。
	const isPiRuntime = Boolean(capabilities) && (runControl?.reloadMode ?? "none") === "resources";
	// 既没有运行控制也没有任何会话操作时整组不渲染（引导页/空态）。
	if (!menu && !runControl) return null;

	const primaryAction = capabilities?.canAbort ? "abort" : capabilities?.primaryAction;
	const primaryLabel = runControl?.isStopping ? t("app.closing") : runControl?.isRestarting ? t("app.restarting") : capabilities?.canAbort ? t("menu.stopAnswer") : capabilities?.primaryAction === "start" ? t("tabs.startAgent") : t("app.restart");
	const primaryDisabled = !capabilities || primaryAction === "abort" ? !capabilities?.canAbort || Boolean(runControl?.isStopping) : !canRunSessionAction(capabilities, capabilities.primaryAction) || Boolean(runControl?.isRestarting) || Boolean(runControl?.isStopping);
	// 忙碌 loader 只跟随本钮自己的动作（启动/重启）：热重载会把 sessionRunCapabilities 的
	// pending 置真（busy），但它有独立的重载钮旋转与时间线遮罩，重启钮不能跟着转，
	// 否则用户会以为自己的点击被当成了重启。
	const primaryPending = Boolean(runControl?.isRestarting || (capabilities?.pending && !runControl?.isReloading));
	const reloadDisabled = !capabilities || !canRunSessionAction(capabilities, "reloadResources") || Boolean(runControl?.isReloading) || Boolean(runControl?.isStopping);
	const reloadLabel = runControl?.isReloading ? t("app.reloading") : t("menu.reloadResources");
	const primaryIcon = primaryPending ? (
		<LoaderCircle className="size-4 animate-pideck-spin" aria-hidden="true" />
	) : capabilities?.canAbort ? (
		<Square className="size-3" fill="currentColor" strokeWidth={0} aria-hidden="true" />
	) : capabilities?.primaryAction === "start" ? (
		<Play className="size-4" aria-hidden="true" />
	) : (
		// 重启用顺时针圆周箭头；「重载」用逆时针双箭头（RefreshCcw）——方向相反，并排不混淆。
		// 电源符号语义是关机，放这里会被读成「关闭」。
		<RotateCw className="size-4" aria-hidden="true" />
	);

	return (
		<div role="group" aria-label={t("runControl.toolbar")} className={cn("inline-flex shrink-0 items-center", props.className)}>
			{/*
       必须显式顶掉 legacy `.chat-header-actions button` 的 `min-width:60px`、面板底色、
       1px 边框与 `padding:0 var(--space-2)`（foundation.css）：那套规则会给头部每个按钮
       撑出 60px 白块 + hover 描边，直接把迷你控件放大成一块。utilities 层高于 legacy 层，
       只要把冲突属性写成工具类就能压住（同 header-drawer-toggle 的豁免思路）。
      */}
			{isPiRuntime && capabilities && primaryAction ? (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="h-7 w-7 min-w-0 rounded-md rounded-r-none border-0 bg-transparent px-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
					disabled={primaryDisabled}
					title={primaryLabel}
					aria-label={primaryLabel}
					onClick={() => runControl?.onAction(primaryAction)}
				>
					{primaryIcon}
				</Button>
			) : null}
			{isPiRuntime ? (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="h-7 w-7 min-w-0 rounded-none border-0 bg-transparent px-0 text-muted-foreground hover:bg-accent hover:text-foreground"
					disabled={reloadDisabled}
					// 悬停提示只用短文案「重载」：长句说明放在菜单项里，工具条上不铺一长串。
					title={reloadLabel}
					aria-label={reloadLabel}
					onClick={() => runControl?.onAction("reloadResources")}
				>
					{runControl?.isReloading ? <LoaderCircle className="size-4 animate-pideck-spin" aria-hidden="true" /> : <RefreshCcw className="size-4" aria-hidden="true" />}
				</Button>
			) : null}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className={cn("h-7 min-w-0 border-0 bg-transparent px-0 text-muted-foreground hover:bg-accent hover:text-foreground", isPiRuntime ? "w-5 rounded-md rounded-l-none" : "w-7 rounded-md")}
						aria-label={t("runControl.moreActions")}
						title={t("runControl.moreActions")}
					>
						{/* 下拉箭头（不是省略号）：一眼看出这是个菜单，与前面两个动作钮区分开。 */}
						<ChevronDown className="size-4" aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" sideOffset={4} className="min-w-44">
					<SessionMenuItems runControl={runControl} menu={menu} />
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
