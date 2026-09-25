import { HatGlasses, Maximize2, Target } from "lucide-react";
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo, useState, type RefObject } from "react";
import type { AgentRuntimeState } from "../../../../shared/types";
import { sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily, sessionSendStateByIdAtom, projectByIdAtomFamily } from "../../atoms";
import { isUserFacingSessionStart } from "../../hooks/useSessionTimelineController";
import { t } from "../../i18n";
import { displayProjectDirectoryName } from "../../rendererUtils";
import { Button } from "../ui-shadcn/button";
import { DshAgentPresetControl } from "./DshAgentPresetControl";
import { DshAgentToolsPanel } from "./DshAgentToolsPanel";

type HeaderActions = {
	headerRef: RefObject<HTMLDivElement | null>;
	isAnonymous?: boolean;
	duration?: number;
	/** 将状态/操作区嵌入 Tab 栏，避免当前会话再单独占一行。 */
	embedded?: boolean;
	/**
	 * 项目目录名（面包屑左段）：多 Tab/分屏时提醒当前会话属于哪个项目。
	 * legacy 模式由上层传入；session 模式可从会话记录自行解析。
	 */
	projectName?: string;
	/**
	 * 分屏栏内显示本栏会话标题，避免「共享顶栏 Tab ↔ 左右栏」对不上号。
	 * 单栏时标题已在外置 Tab 上，通常不传。
	 */
	paneTitle?: string;
	/** 退出会话分屏（扩大为单栏）；仅分屏时提供 */
	onExitSplit?: () => void;
	/** 状态徽章绑定的会话（runtime / 缓存命中率）；与 mode=session 的身份可并存。 */
	statusSessionId?: string;
};

type LegacySessionHeaderProps = HeaderActions & {
	mode?: "legacy";
	sessionId?: never;
	title: string;
	isStarting: boolean;
};

type ModernSessionHeaderProps = HeaderActions & {
	mode: "session";
	sessionId: string;
	title?: never;
	isStarting?: never;
	hasSession?: never;
};

export type SessionHeaderProps = LegacySessionHeaderProps | ModernSessionHeaderProps;

/**
 * 渲染会话状态徽章（+ 分屏身份标题）。
 * 会话运行控制（启动/重启/停止回答/重载）已迁入 Tab 下拉（SessionTabsBar 的 runControl 链路），
 * 此组件不再承载操作菜单；embedded 模式供 Tab 栏 actions 复用；普通模式保留
 * 分屏 pane 外壳（paneTitle + 退出分屏）。
 */
export function SessionHeader(props: SessionHeaderProps) {
	const sessionMode = props.mode === "session";
	const sessionId = props.statusSessionId ?? (sessionMode ? props.sessionId : "");
	const legacyProps = props as LegacySessionHeaderProps;
	const session = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const sendStateSelector = useMemo(() => selectAtom(sessionSendStateByIdAtom, (states) => states[sessionId], Object.is), [sessionId]);
	const sendState = useAtomValue(sendStateSelector);
	// session 模式也只认用户发送；预热 starting 不能给标题栏加 loading（会顶高/半透明）。
	const isStarting = sessionMode ? isUserFacingSessionStart(sendState?.status) : legacyProps.isStarting;
	const isAnonymous = props.isAnonymous || (sessionMode && session?.noSession === true);
	// 项目名：session 模式从会话记录解析 projectId → 项目目录名；
	// legacy 模式（无 sessionId）由上层通过 projectName 传入。
	const project = useAtomValue(projectByIdAtomFamily(session?.projectId ?? ""));
	const projectName = props.projectName ?? (project ? displayProjectDirectoryName(project) : undefined);
	// 会话标题：分屏优先用 paneTitle，其次 legacy title / session 模式记录标题。
	const title = props.paneTitle ?? (sessionMode ? session?.title?.trim() || t("app.chatProject") : props.title);

	const actions = (
		<div ref={props.embedded ? props.headerRef : undefined} className={`chat-header-actions flex min-w-0 items-center justify-end gap-1.5${props.embedded ? " h-7 w-auto shrink-0" : ""}${isStarting ? " loading" : ""}`}>
			{isAnonymous && (
				<span className="anonymous-badge" title={t("app.anonymousChat")} aria-label={t("app.anonymousChat")}>
					<HatGlasses size={14} aria-hidden="true" />
				</span>
			)}
			{props.embedded && session?.backend === "dsh" && <DshAgentPresetControl sessionId={sessionId} />}
			{sessionMode && session?.backend === "dsh" && <DshToolsButton sessionId={sessionId} />}
		</div>
	);

	if (props.embedded) return actions;
	return (
		<div
			ref={props.headerRef}
			role="banner"
			/* 普通模式：分屏 pane 的会话身份行（Tab 已外置）。
         底部分隔线去掉：分屏身份标题下再叠一条线过于碎。 */
			className="chat-header grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 bg-background px-3 py-1"
		>
			<div className="flex min-w-0 items-center gap-1.5">
				{props.onExitSplit ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
						title={t("session.split.exit")}
						aria-label={t("session.split.exit")}
						onClick={(event) => {
							event.stopPropagation();
							props.onExitSplit?.();
						}}
					>
						<Maximize2 className="size-3.5" aria-hidden="true" />
					</Button>
				) : null}
				{/* 会话身份面包屑：项目名 / 会话标题。
            truncate + max-w 限制：项目名最长约 160px，标题吃剩余空间。
            项目段用实底灰胶囊（bg-accent = --color-bg-active，与激活 Tab / 侧栏选中同色）
            + 近正文色文字：早期用 bg-muted（#f4f4f5，浅色主题下贴在 #ffffff 上几乎不可见）
            时用户反馈「项目不够明显」；换成可见面色后项目段一眼可辨，
            标题仍靠 text-foreground + font-medium 保持主次。 */}
				{projectName ? (
					<span className="max-w-40 shrink truncate rounded bg-accent px-1.5 py-0.5 text-caption text-foreground/80" title={projectName}>
						{projectName}
					</span>
				) : null}
				{projectName && title ? (
					<span className="shrink-0 text-caption text-muted-foreground/70" aria-hidden="true">
						/
					</span>
				) : null}
				{title ? (
					<span className="session-pane-title min-w-0 max-w-96 truncate text-caption font-medium text-foreground" title={title}>
						{title}
					</span>
				) : (
					<span className="min-w-0" aria-hidden="true" />
				)}
				{/* DSH 会话模式胶囊：草稿期可点开选择，激活后只读展示 */}
				{session?.backend === "dsh" ? <DshAgentPresetControl sessionId={sessionId} /> : null}
			</div>
			{actions}
		</div>
	);
}

/**
 * DSH 工具按钮（G5/G6：目标 / 子代理面板入口）；仅运行时已激活（有 agentId）时可用。
 */
function DshToolsButton(props: { sessionId: string }) {
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const [open, setOpen] = useState(false);
	const agentId = runtime?.agentId;
	if (!agentId) return null;
	return (
		<>
			<Button type="button" variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground hover:text-foreground" title={t("dshTools.open")} aria-label={t("dshTools.open")} onClick={() => setOpen(true)}>
				<Target className="size-3.5" aria-hidden="true" />
			</Button>
			{open && <DshAgentToolsPanel sessionId={props.sessionId} agentId={agentId} onClose={() => setOpen(false)} />}
		</>
	);
}
