import { Check, CircleStop, Copy, FileDown, FileText, Fingerprint, Globe, Link2, ListRestart, PanelRight, Pencil, Play, RefreshCcw, RotateCw, X } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { copyTextWithCopiedNotice } from "../../utils/clipboardNotice";
import { canRunSessionAction, type SessionReloadMode, type SessionRunAction, type SessionRunCapabilities } from "../../utils/sessionCommands";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "../ui-shadcn/dropdown-menu";
import type { SessionTabActions, SessionToolAction } from "./SessionTabsBar";

/**
 * 会话操作菜单的数据模型：会话头部控制钮（原 Tab 栏「⋯」）与 Tab 右键菜单共用同一套组。
 * 装配层（App）按 sessionId 算好能力闸门，渲染层只按 flags 与回调存在性出菜单项。
 */
export type SessionMenuModel = {
	/** 会话操作组：重命名 / 复制会话 / 导出 HTML / 复制路径 / 打开文件 */
	sessionActions?: SessionTabActions;
	/** 右侧工具开关：草稿纸 / 终端 / 外部编辑器 */
	toolActions?: readonly SessionToolAction[];
	/** 会话代理（网络代理）入口 */
	onOpenProxySetting?: () => void;
};

/** 运行控制快照（会话头部控制钮）：在通用视图上补「复制 Agent ID / 关闭 Agent」需要的绑定事实。 */
export type SessionMenuRunControl = {
	capabilities?: SessionRunCapabilities;
	/** 关闭 Agent 进行中（closeAgent 期间）：菜单项据此显示进度文案 */
	isStopping?: boolean;
	isRestarting?: boolean;
	isReloading?: boolean;
	/** 重载入口语义：pi 热重载 / 不提供（DSH、ACP 无会话级 reload） */
	reloadMode?: SessionReloadMode;
	/** 当前绑定运行实例的 agentId：仅用于「复制 Agent ID」，无绑定时隐藏该项 */
	agentId?: string;
	/** 关闭 Agent（杀进程 + 解绑，会话记录保留）；无绑定时不传 */
	onCloseAgent?: () => void;
	onAction: (action: SessionRunAction) => void;
};

/**
 * 运行控制菜单项（全状态）。
 *
 * 语义固定，只按策略结论置灰，不做状态 if/else：
 * - 主控项：未启动/失败/已关闭显示「启动 Agent」，live 显示「重启」；
 * - 停止回答：只中断当前正在跑的回合（abort），进程与绑定保留——与输入框停止按钮同义；
 * - 重新加载：扩展热重载（pi）/ 从磁盘刷新（无进程会话）；
 * - 复制 Agent ID / 关闭 Agent：作用于「当前绑定的那个进程实例」，无绑定时不渲染。
 */
function SessionRunMenuItems(props: { control: SessionMenuRunControl }) {
	const { control } = props;
	const capabilities = control.capabilities;
	if (!capabilities) return null;

	const startOrRestartDisabled = !canRunSessionAction(capabilities, "start") || Boolean(control.isRestarting);
	const abortDisabled = !canRunSessionAction(capabilities, "abort");
	const reloadMode = control.reloadMode ?? "none";
	const reloadEntryDisabled = !canRunSessionAction(capabilities, "reloadResources") || Boolean(control.isReloading);
	const reloadDisabled = !canRunSessionAction(capabilities, "reload") || Boolean(control.isReloading);

	// 主控文案：未启动/失败/已关闭 → 「启动 Agent」；live → 「重启」。
	const primaryLabel = control.isRestarting ? t("app.restarting") : capabilities.primaryAction === "start" ? t("tabs.startAgent") : t("app.restart");

	// 先取成局部常量：在 onSelect 闭包里读 control.agentId 会丢掉窄化
	const agentId = control.agentId;

	return (
		<>
			<DropdownMenuItem disabled={startOrRestartDisabled} style={startOrRestartDisabled ? { opacity: 0.4 } : undefined} onSelect={() => control.onAction(capabilities.primaryAction)}>
				<span className="inline-flex items-center gap-2">
					{capabilities.primaryAction === "start" ? <Play className={cn("size-3.5", control.isRestarting && "animate-pulse")} aria-hidden="true" /> : <RotateCw className={cn("size-3.5", control.isRestarting && "animate-pideck-spin")} aria-hidden="true" />}
					{primaryLabel}
				</span>
			</DropdownMenuItem>
			<DropdownMenuItem
				disabled={abortDisabled}
				style={abortDisabled ? { opacity: 0.4 } : undefined}
				// 「停止回答」= abort：只中断当前正在跑的回合，进程与绑定保留；
				// 杀进程的入口是同组的「关闭 Agent」（两者语义不同，别合并）。
				title={t("tabs.stopAnswerHint")}
				onSelect={() => control.onAction("abort")}
			>
				<span className="inline-flex items-center gap-2">
					<CircleStop className="size-3.5" aria-hidden="true" />
					{t("menu.stopAnswer")}
				</span>
			</DropdownMenuItem>
			{reloadMode === "resources" ? (
				<DropdownMenuItem disabled={reloadEntryDisabled} style={reloadEntryDisabled ? { opacity: 0.4 } : undefined} title={t("menu.reloadResourcesHint")} onSelect={() => control.onAction("reloadResources")}>
					<span className="inline-flex items-center gap-2">
						<RefreshCcw className={cn("size-3.5", control.isReloading && "animate-pideck-spin")} aria-hidden="true" />
						{control.isReloading ? t("app.reloading") : t("menu.reloadResources")}
					</span>
				</DropdownMenuItem>
			) : null}
			<DropdownMenuItem disabled={reloadDisabled} style={reloadDisabled ? { opacity: 0.4 } : undefined} title={t("menu.reloadMessagesHint")} onSelect={() => control.onAction("reload")}>
				<span className="inline-flex items-center gap-2">
					<ListRestart className={cn("size-3.5", control.isReloading && "animate-pulse")} aria-hidden="true" />
					{control.isReloading ? t("app.reloading") : t("menu.reloadMessages")}
				</span>
			</DropdownMenuItem>
			{/* 复制 Agent ID：与运行控制同组（它标识的就是当前绑定实例）；
          无绑定（从未启动/已解绑）时不渲染，避免复制一个不存在的 id。 */}
			{agentId ? (
				<DropdownMenuItem onSelect={() => void copyTextWithCopiedNotice(agentId)}>
					<span className="inline-flex items-center gap-2">
						<Fingerprint className="size-3.5" aria-hidden="true" />
						{t("menu.copyAgentId")}
					</span>
				</DropdownMenuItem>
			) : null}
			{control.onCloseAgent ? (
				<DropdownMenuItem variant="destructive" title={t("menu.closeAgentHint")} onSelect={control.onCloseAgent}>
					<span className="inline-flex items-center gap-2">
						<X className={cn("size-3.5", control.isStopping && "animate-pulse")} aria-hidden="true" />
						{control.isStopping ? t("app.closing") : t("menu.closeAgent")}
					</span>
				</DropdownMenuItem>
			) : null}
		</>
	);
}

/**
 * 会话操作菜单的完整内容（原 Tab 栏「⋯」菜单整组搬迁）。
 * 会话头部控制钮是唯一挂载点；Tab 右键菜单复用同一套能力闸门，但渲染成 ContextMenuItem。
 */
export function SessionMenuItems(props: { runControl?: SessionMenuRunControl; menu?: SessionMenuModel }) {
	const { runControl, menu } = props;
	const sessionActions = menu?.sessionActions;
	const toolActions = menu?.toolActions;
	const hasRunGroup = Boolean(runControl?.capabilities);
	const hasSessionGroup = Boolean(runControl) || Boolean(sessionActions) || Boolean(menu?.onOpenProxySetting);

	return (
		<>
			{hasRunGroup && runControl ? (
				<>
					<DropdownMenuLabel>{t("tabs.currentSessionGroup")}</DropdownMenuLabel>
					<SessionRunMenuItems control={runControl} />
					<DropdownMenuSeparator />
				</>
			) : null}
			{sessionActions ? (
				<>
					{!hasRunGroup && <DropdownMenuLabel>{t("tabs.currentSessionGroup")}</DropdownMenuLabel>}
					{/* 侧边任务：在目标会话的项目里开一条轻量会话，结果落在右侧抽屉面板 */}
					<DropdownMenuItem onSelect={sessionActions.onCreateSideTask}>
						<span className="inline-flex items-center gap-2">
							<PanelRight className="size-3.5" aria-hidden="true" />
							{t("menu.createSideTask")}
						</span>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={sessionActions.onRename}>
						<span className="inline-flex items-center gap-2">
							<Pencil className="size-3.5" aria-hidden="true" />
							{t("common.rename")}
						</span>
					</DropdownMenuItem>
					{sessionActions.canCopySession ? (
						<DropdownMenuItem onSelect={sessionActions.onCopySession}>
							<span className="inline-flex items-center gap-2">
								<Copy className="size-3.5" aria-hidden="true" />
								{t("menu.copySession")}
							</span>
						</DropdownMenuItem>
					) : null}
					{sessionActions.canExportHtml && sessionActions.onExportSessionHtml ? (
						<DropdownMenuItem onSelect={sessionActions.onExportSessionHtml}>
							<span className="inline-flex items-center gap-2">
								<FileDown className="size-3.5" aria-hidden="true" />
								{t("menu.exportHtml")}
							</span>
						</DropdownMenuItem>
					) : null}
					{sessionActions.hasFilePath ? (
						<>
							<DropdownMenuItem onSelect={sessionActions.onCopySessionFilePath}>
								<span className="inline-flex items-center gap-2">
									<Link2 className="size-3.5" aria-hidden="true" />
									{t("menu.copySessionFilePath")}
								</span>
							</DropdownMenuItem>
							{sessionActions.onOpenSessionFile ? (
								<DropdownMenuItem onSelect={sessionActions.onOpenSessionFile}>
									<span className="inline-flex items-center gap-2">
										<FileText className="size-3.5" aria-hidden="true" />
										{t("menu.openSessionFile")}
									</span>
								</DropdownMenuItem>
							) : null}
						</>
					) : null}
					{menu?.onOpenProxySetting ? <DropdownMenuSeparator /> : null}
				</>
			) : null}
			{/* 会话代理：保存后自动重启 runtime 生效，语义上属于会话级配置而非面板开关。 */}
			{menu?.onOpenProxySetting ? (
				<>
					{!hasSessionGroup && <DropdownMenuLabel>{t("tabs.currentSessionGroup")}</DropdownMenuLabel>}
					<DropdownMenuItem onSelect={() => menu.onOpenProxySetting?.()}>
						<Globe className="size-3.5" aria-hidden="true" />
						<span>{t("menu.sessionProxy")}</span>
					</DropdownMenuItem>
				</>
			) : null}
			{toolActions && toolActions.length > 0 ? (
				<>
					<DropdownMenuSeparator />
					<DropdownMenuLabel>{t("tabs.toolsGroup")}</DropdownMenuLabel>
					{toolActions.map((action) => (
						<DropdownMenuItem key={action.id} onClick={action.onClick}>
							{action.icon}
							<span>{action.label}</span>
							{action.active ? <Check className="ml-auto size-3.5 text-[var(--color-accent)]" aria-hidden="true" /> : null}
						</DropdownMenuItem>
					))}
				</>
			) : null}
		</>
	);
}
