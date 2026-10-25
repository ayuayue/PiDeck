import { useRef, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { useSessionPaneServices } from "./SessionPaneServices";
import { ComposerArea } from "./ComposerArea";
import { QueuedPromptPanel } from "./ComposerPanels";
import { SessionAcpRestoreStrip } from "./SessionAcpRestoreStrip";
import { SessionGoalStrip } from "./SessionGoalStrip";
import { SessionSubagentsStrip } from "./SessionSubagentsStrip";
import { SessionTodoStrip } from "./SessionTodoStrip";
import { LogoMark } from "./SurfaceParts";
import { sessionRecordByIdAtomFamily } from "../../atoms/session-selectors";
import { sessionStatusInSidebarAtomFamily } from "../../atoms/right-sidebar-atoms";
import { usePaneGitInfo } from "../../hooks/usePaneGitInfo";

/**
 * 新会话起始页（DeepSeek 式居中输入框）：匿名/新会话还没有消息时，
 * 页面中央直接挂完整的 ComposerArea——模型/思考级别/模式/发送/附件/
 * 安全级别等一切能力都是现成的（services 经 context 注入，零透传），
 * 不再为起始页维护第二套输入框实现。
 *
 * 底部 composer 面板在无消息时不渲染（SessionView 按 messages.length 判断），
 * 避免同屏出现两个输入框；发送后消息出现，居中页自动退出。
 */

export function SessionStartSurface(props: {
	sessionId: string;
	/** 可选项目切换器：引导页（无会话空态）传入，标明并可切换下一次发送将会话创建到哪个项目 */
	projectSwitcher?: ReactNode;
	/** 引导页虚拟会话没有 SessionRecord，用选中项目兑底加载 @ 引用文件树。 */
	bootstrapProjectId?: string;
}) {
	const services = useSessionPaneServices();
	// 起始页展示的分支属于“下一个会话将落地”的项目：引导页（虚拟会话）用选中项目，
	// 真实匿名会话用其 record 自身项目。分屏下两个 worktree 各开空会话时，
	// 各自起始页显示各自 worktree 的分支，不跟随 App 聚焦项目（栏级 usePaneGitInfo）。
	const sessionRecord = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const startProjectId = props.bootstrapProjectId ?? sessionRecord?.projectId;
	const { gitInfo } = usePaneGitInfo(startProjectId);
	const queuedTrackRef = useRef<HTMLElement | null>(null);
	const activeQueuedPrompts = services.queuedPromptsBySession[props.sessionId] ?? [];
	// 右侧边栏「会话状态」面板正可见地展示本会话时，同类折叠条让位给面板（同 SessionView）
	const statusInSidebar = useAtomValue(sessionStatusInSidebarAtomFamily(props.sessionId));

	return (
		// session-start-surface 保留类名供壁纸模式契约（bg-transparent 透出下层壁纸）；
		// pt-[18vh] 把重心压向视口中心（输入框顶约 36-40%、框心 ~55%），接近 DeepSeek
		// 新会话页；[--font-size-input] 在容器作用域放大输入框字号（14→15.5px），
		// 只影响本页，不改全局 token（会话页输入框保持原尺寸）。
		<div className="session-start-surface flex min-h-full w-full flex-col items-center gap-8 bg-transparent px-6 pb-10 pt-[18vh] [--font-size-input:15.5px] [--line-height-input:25px]">
			<LogoMark size={72} />
			{props.projectSwitcher}
			{/* 复用会话页底部输入框组件：高度随内容撑开，底部栏（模型/思考/模式/安全级别/git）与发送按钮全保留。
				宽度：容器 1080px；[--chat-content-pct-set:100%] 只在本页生效，抵消内容宽度设置（默认 80%）
				在引导页的二次收窄——引导页没有消息列要对其，输入框直接用满容器
				（composer 实际宽 = 容器 - 48px 两侧安全空隙）。 */}
			<div className="w-full max-w-[1080px] [--chat-content-pct-set:100%]">
				<ComposerArea
					sessionId={props.sessionId}
					gitInfo={gitInfo}
					enqueue={services.enqueueSessionPrompt}
					ensureSessionId={services.ensureSessionId}
					bootstrapProjectId={props.bootstrapProjectId}
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
					queuePanel={<QueuedPromptPanel trackRef={queuedTrackRef} sessionId={props.sessionId} prompts={activeQueuedPrompts} visiblePrompts={activeQueuedPrompts} onRetract={services.queueRetract} onDiscard={services.queueDiscard} onChangeBehavior={services.queueChangeBehavior} />}
				/>
			</div>
		</div>
	);
}
