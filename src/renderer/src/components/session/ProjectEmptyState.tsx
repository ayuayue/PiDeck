import { FolderGit2, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useSetAtom } from "jotai";
import type { Project } from "../../../../shared/types";
import { isRemoteProject } from "../../../../shared/projectLocation";
import { t } from "../../i18n";
import { GUIDE_BOOTSTRAP_SESSION_ID } from "../../utils/chatSessionBootstrap";
import { isChatProject } from "../../rendererUtils";
import { Button } from "../ui-shadcn/button";
import { remoteEnrollDialogOpenAtom } from "../../atoms/remote-project-atoms";
import { useRemoteFeatureAvailable } from "../../hooks/useRemoteFeatureAvailable";
import { isRemoteEntryVisible } from "../../hooks/remoteFeatureVisibility";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { RemoteProjectPanel } from "./RemoteProjectPanel";
import { SessionStartSurface } from "./SessionStartSurface";

/**
 * 无会话空态（启动 / 清空全部 Tab / 空项目）。
 *
 * 有项目：直接挂「新建页面」同源的 SessionStartSurface（居中 ComposerArea +
 * 快捷动作），绑定 renderer-only 虚拟会话 ID——不创建 Catalog 记录、不拉起 pi、
 * 不占用 Tab 栏；首次发送（或选择 ACP）由 App.ensureSessionForSend 创建真实会话
 * （Chat 匿名 / 非 Chat draft）并把 composer 状态整体提升过去，随后才登记 Tab。
 *
 * 无项目：同样交给 SessionStartSurface 的 no-project 模式渲染——两屏共用同一
 * 骨架（Logo / 860px 列宽 / 23vh 重心 / 间距），无项目时正文换成与输入框同宽的
 * 引导卡，而不是另一套居中按钮。维护点只剩一个组件。
 */
export function ProjectEmptyState(props: {
	activeProject?: Project;
	/** 可切换的目标项目列表：下拉只切换 activeProjectId（selectProject 语义），
      不创建会话；首次发送 / 选择 ACP 按当前选中项目创建（App.ensureSessionForSend） */
	projects: Project[];
	onAddProject: () => void;
	onSelectProject: (projectId: string) => void;
	onOpenTerminal?: () => void;
	/** 远端空态的一键起会话；由 App 注入（与项目行「+」同一条 createDraft 链路）。 */
	onCreateSession?: (projectId: string) => void;
}) {
	// 远端登记弹框由 App 统一挂载，这里只打开开关（与侧栏「+」同一条路径）。
	// 入口与侧栏「+」共用同一道通道门禁：正式包不提供远端能力，起始页也不出现这项。
	const setRemoteEnrollOpen = useSetAtom(remoteEnrollDialogOpenAtom);
	const remoteAvailable = useRemoteFeatureAvailable();
	// 远端项目：输入页与文件浏览是同一个空态里的两级视图；切项目时回到输入页。
	const [remoteFilesOpen, setRemoteFilesOpen] = useState(false);
	useEffect(() => {
		setRemoteFilesOpen(false);
	}, [props.activeProject?.id]);
	// 无项目时没有任何可创建会话的项目上下文，只保留添加项目入口。
	if (!props.activeProject) {
		return <SessionStartSurface mode="no-project" onAddProject={props.onAddProject} {...(isRemoteEntryVisible(remoteAvailable) ? { onOpenRemote: () => setRemoteEnrollOpen(true) } : {})} />;
	}

	// 有项目：引导页 = 新建页面形态。虚拟会话只存在于渲染层 composer atoms，
	// 发送时由 promoteSessionComposerStateAtom 整体搬到真实会话，输入不丢失。
	// 项目下拉只切换 activeProjectId——切项目后仍留在引导页（currentSessionId 保持
	// 空），发送时按选中项目创建；下拉列表 = 已加入的全部项目（含内置 Chat）。
	//
	const projectSwitcher = (
		<Select value={props.activeProject.id} onValueChange={props.onSelectProject}>
			<SelectTrigger aria-label={t("app.guideProjectPicker")} className="gap-2 border-0 bg-transparent px-2.5 text-sm font-normal text-text-secondary shadow-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:hover:bg-accent/50">
				<FolderGit2 size={15} aria-hidden="true" className="shrink-0 text-text-tertiary" />
				<SelectValue />
			</SelectTrigger>
			<SelectContent align="start">
				{props.projects.map((project) => (
					<SelectItem key={project.id} value={project.id}>
						{isChatProject(project) ? t("app.chatProject") : project.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);

	// 远端项目没有本机路径：使用同源远端目录/文本编辑宿主，各本机IPC仍按locator拒绝。
	// 空态与本地同构：先把输入页给用户，文件浏览作为同一页的次级视图（返回即回到输入页）。
	// 首次发送由 App.ensureSessionForSend 创建 pi 会话；后端/模型门控在 composer 内按项目类型锁定。
	const remoteProject = props.activeProject;
	if (isRemoteProject(remoteProject)) {
		if (remoteFilesOpen) {
			return <RemoteProjectPanel projectId={remoteProject.id} projectName={remoteProject.name} onOpenTerminal={props.onOpenTerminal} onBack={() => setRemoteFilesOpen(false)} onCreateSession={props.onCreateSession === undefined ? undefined : () => props.onCreateSession?.(remoteProject.id)} />;
		}
		return (
			<SessionStartSurface
				sessionId={GUIDE_BOOTSTRAP_SESSION_ID}
				bootstrapProjectId={remoteProject.id}
				projectSwitcher={projectSwitcher}
				secondaryAction={
					<Button variant="ghost" size="sm" data-testid="remote-project-browse-files" onClick={() => setRemoteFilesOpen(true)}>
						<FolderOpen className="size-4" aria-hidden="true" />
						{t("project.remote.browseFiles")}
					</Button>
				}
			/>
		);
	}

	return <SessionStartSurface sessionId={GUIDE_BOOTSTRAP_SESSION_ID} bootstrapProjectId={props.activeProject.id} projectSwitcher={projectSwitcher} />;
}
