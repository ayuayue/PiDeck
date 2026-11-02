import { useRef, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { FolderGit2, Plus, Server } from "lucide-react";
import { useSessionPaneServices } from "./SessionPaneServices";
import { ComposerArea } from "./ComposerArea";
import { QueuedPromptPanel } from "./ComposerPanels";
import { SessionAcpRestoreStrip } from "./SessionAcpRestoreStrip";
import { SessionGoalStrip } from "./SessionGoalStrip";
import { SessionSubagentsStrip } from "./SessionSubagentsStrip";
import { SessionTodoStrip } from "./SessionTodoStrip";
import { LogoMark } from "./SurfaceParts";
import { Button } from "../ui-shadcn/button";
import { t } from "../../i18n";
import { sessionRecordByIdAtomFamily } from "../../atoms/session-selectors";
import { sessionStatusInSidebarAtomFamily } from "../../atoms/right-sidebar-atoms";
import { usePaneGitInfo } from "../../hooks/usePaneGitInfo";
import { projectByIdAtomFamily } from "../../atoms/project-atoms";
import { isChatProject } from "../../rendererUtils";
import { GUIDE_BOOTSTRAP_SESSION_ID } from "../../utils/chatSessionBootstrap";

/**
 * 新会话起始页（DeepSeek 式居中输入框）：匿名/新会话还没有消息时，
 * 页面中央直接挂完整的 ComposerArea——模型/思考级别/模式/发送/附件/
 * 安全级别等一切能力都是现成的（services 经 context 注入，零透传），
 * 不再为起始页维护第二套输入框实现。
 *
 * 底部 composer 面板在无消息时不渲染（SessionView 按 messages.length 判断），
 * 避免同屏出现两个输入框；发送后消息出现，居中页自动退出。
 *
 * 同一个组件也承担「还没有项目」的起始页（mode="no-project"）：两屏共用
 * StartSurfaceShell 的 Logo、列宽、垂直重心与间距，只在正文位置换成与输入框
 * 同宽、同圆角、同浮起阴影的引导卡。之前无项目页是单独的一套居中按钮，
 * 与输入页的排版节奏不一致，改一处视觉要改两遍。
 */

type SessionStartProps = {
	/** 真实/虚拟会话 id；无项目引导页不需要。 */
	sessionId: string;
	/** 可选项目切换器：引导页（无会话空态）传入，标明并可切换下一次发送将会话创建到哪个项目 */
	projectSwitcher?: ReactNode;
	/** 项目切换器下方的次级入口（远端空态的「浏览远端文件」）；本机引导页不传。 */
	secondaryAction?: ReactNode;
	/** 引导页虚拟会话没有 SessionRecord，用选中项目兑底加载 @ 引用文件树。 */
	bootstrapProjectId?: string;
	mode?: "session";
};

type NoProjectStartProps = {
	mode: "no-project";
	onAddProject: () => void;
	/** 远端（SSH）登记入口：通道门禁关闭时调用方不传，按钮整条不渲染。 */
	onOpenRemote?: () => void;
};

export type SessionStartSurfaceProps = SessionStartProps | NoProjectStartProps;

/**
 * 两屏共用的骨架：Logo → 内容列。宽度、重心、间距只在这里定义一次，
 * 无项目卡与输入框因此天然对齐（同一 860px 列、同一垂直重心）。
 */
function StartSurfaceShell(props: { slogan?: string; children: ReactNode }) {
	return (
		// session-start-surface 保留类名供壁纸模式契约（bg-transparent 透出下层壁纸）；
		// pt-[23vh] 把输入框重心压向视口中上部，Logo 与正文按视觉节奏留白；
		// [--font-size-input] 在容器作用域放大输入框字号（14→15.5px），
		// 只影响本页，不改全局 token（会话页输入框保持原尺寸）。
		<div className="session-start-surface flex min-h-full w-full flex-col items-center bg-transparent px-6 pb-10 pt-[23vh] [--font-size-input:15.5px] [--line-height-input:25px]">
			<div className="flex w-full max-w-[860px] flex-col items-center gap-12">
				{/* 品牌块：Logo 与一句话标语同属一个视觉单元；
				    标语只在会话模式出现，无项目卡自己带标题，不叠加第二行文案。 */}
				<div className="flex flex-col items-center gap-5">
					<LogoMark size={72} />
					{props.slogan !== undefined ? <p className="text-balance text-heading font-medium tracking-[-0.01em] text-text-primary">{props.slogan}</p> : null}
				</div>
				{props.children}
			</div>
		</div>
	);
}

/**
 * 无项目引导：与输入框同宽的「起始条」——左侧说明、右侧主从动作。
 * 视觉复用输入框的 20px 圆角、1px 墨线、card 底与 lifted 阴影，
 * 让「还没有项目」和「还没有消息」看起来是同一张工作台的不同阶段。
 */
function NoProjectStart(props: { onAddProject: () => void; onOpenRemote?: () => void }) {
	return (
		<div className="w-full max-w-3xl rounded-[20px] border border-border bg-card shadow-[var(--shadow-composer-lifted)]">
			<div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex min-w-0 items-center gap-3">
					<span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-text-secondary" aria-hidden="true">
						<FolderGit2 size={18} />
					</span>
					<div className="min-w-0">
						<h2 id="session-start-no-project" className="text-sm font-medium text-foreground">
							{t("app.emptyNoProjectTitle")}
						</h2>
						<p className="mt-0.5 text-caption text-muted-foreground">{t("app.emptyNoProject")}</p>
					</div>
				</div>
				{/* 主从顺序与输入框底栏一致：低频动作用 ghost，主操作用实心，落在右侧。 */}
				<div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
					{props.onOpenRemote === undefined ? null : (
						<Button variant="ghost" size="sm" onClick={props.onOpenRemote}>
							<Server className="size-4" aria-hidden="true" />
							{t("project.remote.title")}
						</Button>
					)}
					<Button size="sm" onClick={props.onAddProject}>
						<Plus className="size-4" aria-hidden="true" />
						{t("app.addProject")}
					</Button>
				</div>
			</div>
		</div>
	);
}

export function SessionStartSurface(props: SessionStartSurfaceProps) {
	if (props.mode === "no-project")
		return (
			<StartSurfaceShell>
				<NoProjectStart onAddProject={props.onAddProject} onOpenRemote={props.onOpenRemote} />
			</StartSurfaceShell>
		);
	return <SessionStartBody sessionId={props.sessionId} projectSwitcher={props.projectSwitcher} bootstrapProjectId={props.bootstrapProjectId} secondaryAction={props.secondaryAction} />;
}

function SessionStartBody(props: SessionStartProps) {
	const services = useSessionPaneServices();
	// 起始页展示的分支属于“下一个会话将落地”的项目：引导页（虚拟会话）用选中项目，
	// 真实匿名会话用其 record 自身项目。分屏下两个 worktree 各开空会话时，
	// 各自起始页显示各自 worktree 的分支，不跟随 App 聚焦项目（栏级 usePaneGitInfo）。
	const sessionRecord = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const startProjectId = props.bootstrapProjectId ?? sessionRecord?.projectId;
	const { gitInfo, gitUnavailable, switchBranch } = usePaneGitInfo(startProjectId, {
		onChanged: services.onProjectGitChanged,
		onSwitchError: (error) => services.showToast(t("app.branchSwitchFailed", { error: error instanceof Error ? error.message : String(error) })),
	});
	// 固定项目的会话没有切换器，但上下文条要和引导页一致：显示当前项目（只读）。
	// 项目找不到（例如记录尚未加载）时整条不渲染，分支也随之不显示。
	const project = useAtomValue(projectByIdAtomFamily(startProjectId ?? ""));
	const fixedProjectLabel = project === undefined ? undefined : isChatProject(project) ? t("app.chatProject") : project.name;
	// 只有无会话引导页允许换项目；真实会话（包括空的历史会话）始终只读，忽略误传的切换器。
	// 项目记录缺失（Wave 4 §5）：真实会话的 startProjectId 指向尚未加载/已移除的项目时
	// 不再整条静默消失——显式显示「项目不可用」；引导页瞬态（无 startProjectId）仍隐藏。
	const projectMissing = props.sessionId !== GUIDE_BOOTSTRAP_SESSION_ID && startProjectId !== undefined && fixedProjectLabel === undefined;
	const contextBar =
		(props.sessionId === GUIDE_BOOTSTRAP_SESSION_ID ? props.projectSwitcher : undefined) ??
		(projectMissing ? (
			<span className="inline-flex h-6 min-w-0 max-w-56 items-center gap-1.5 rounded-md px-1.5 text-caption font-normal text-muted-foreground/70" title={t("app.projectUnavailable")}>
				<FolderGit2 size={14} strokeWidth={1.8} className="shrink-0 text-muted-foreground/60" aria-hidden="true" />
				<span className="min-w-0 truncate">{t("app.projectUnavailable")}</span>
			</span>
		) : fixedProjectLabel !== undefined ? (
			<span className="inline-flex h-6 min-w-0 max-w-56 items-center gap-1.5 rounded-md px-1.5 text-caption font-normal text-text-secondary">
				<FolderGit2 size={14} strokeWidth={1.8} className="shrink-0 text-text-tertiary" aria-hidden="true" />
				<span className="min-w-0 truncate" title={fixedProjectLabel}>
					{fixedProjectLabel}
				</span>
			</span>
		) : undefined);
	const queuedTrackRef = useRef<HTMLElement | null>(null);
	const activeQueuedPrompts = services.queuedPromptsBySession[props.sessionId] ?? [];
	// 右侧边栏「会话状态」面板正可见地展示本会话时，同类折叠条让位给面板（同 SessionView）
	const statusInSidebar = useAtomValue(sessionStatusInSidebarAtomFamily(props.sessionId));
	// 起步提示：只填草稿、不直接发送；用户仍要自己确认模型/上下文后按发送。
	const starterPrompts = [t("session.start.promptExplain"), t("session.start.promptFindBug"), t("session.start.promptTests")];

	return (
		<StartSurfaceShell slogan={t("session.start.slogan")}>
			{props.secondaryAction !== undefined ? <div className="flex w-full justify-center">{props.secondaryAction}</div> : null}
			{/* 复用会话页底部输入框组件：高度随内容撑开，底部栏（模型/思考/模式/安全级别/git）与发送按钮全保留。
				[--chat-content-pct-set:100%] 只在本页生效，抵消内容宽度设置（默认 80%）在引导页的二次收窄——
				引导页没有消息列要对其，输入框直接用满容器（composer 实际宽 = 容器 - 48px 两侧安全空隙）。 */}
			<div className="w-full [--chat-content-pct-set:100%]">
				<ComposerArea
					sessionId={props.sessionId}
					contextBar={contextBar}
					gitInfo={gitInfo}
					gitUnavailable={gitUnavailable}
					onSwitchBranch={switchBranch}
					enqueue={services.enqueueSessionPrompt}
					ensureSessionId={services.ensureSessionId}
					bootstrapProjectId={props.bootstrapProjectId}
					starterPrompts={starterPrompts}
					widgets={
						<>
							{/* 未激活 ACP 会话：历史存 agent CLI 侧，时间线暂空（非新会话）。 */ <SessionAcpRestoreStrip sessionId={props.sessionId} />}
							{!statusInSidebar && <SessionTodoStrip sessionId={props.sessionId} />}
							{/* 「修改的文件」已改为每轮末尾的 chip 行（TurnFileChanges）；
							    引导页没有轮次，因此这里不再挂文件条。 */}
							{!statusInSidebar && <SessionSubagentsStrip sessionId={props.sessionId} />}
							<SessionGoalStrip sessionId={props.sessionId} />
						</>
					}
					queuePanel={<QueuedPromptPanel trackRef={queuedTrackRef} sessionId={props.sessionId} prompts={activeQueuedPrompts} onRetract={services.queueRetract} onDiscard={services.queueDiscard} onChangeBehavior={services.queueChangeBehavior} />}
				/>
			</div>
		</StartSurfaceShell>
	);
}
