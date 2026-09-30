import { FolderGit2, Plus } from "lucide-react";
import type { Project } from "../../../../shared/types";
import { isRemoteProject } from "../../../../shared/projectLocation";
import { t } from "../../i18n";
import { GUIDE_BOOTSTRAP_SESSION_ID } from "../../utils/chatSessionBootstrap";
import { isChatProject } from "../../rendererUtils";
import { Button } from "../ui-shadcn/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { RemoteProjectPanel } from "./RemoteProjectPanel";
import { LogoMark } from "./SurfaceParts";
import { SessionStartSurface } from "./SessionStartSurface";

/**
 * 无会话空态（启动 / 清空全部 Tab / 空项目）。
 *
 * 有项目：直接挂「新建页面」同源的 SessionStartSurface（居中 ComposerArea +
 * 快捷动作），绑定 renderer-only 虚拟会话 ID——不创建 Catalog 记录、不拉起 pi、
 * 不占用 Tab 栏；首次发送由 App.ensureSessionForSend 创建真实会话（Chat 匿名 /
 * 非 Chat draft）并把 composer 状态整体提升过去，随后才登记 Tab。
 * 无项目：只保留添加项目入口。
 */
export function ProjectEmptyState(props: {
	activeProject?: Project;
	/** 可切换的目标项目列表：下拉只切换 activeProjectId（selectProject 语义），
      不创建会话；首次发送按当前选中项目创建（App.ensureSessionForSend） */
	projects: Project[];
	onAddProject: () => void;
	onSelectProject: (projectId: string) => void;
}) {
	// 无项目时没有任何可创建会话的项目上下文，只保留添加项目入口。
	// 与有项目引导页同比例：Logo 72 / gap-8 / pt-[18vh] 靠中。
	if (!props.activeProject) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 overflow-y-auto px-6 pb-10 pt-[18vh]">
					<LogoMark size={72} />
					<Button size="lg" className="h-14 rounded-xl bg-foreground px-8 text-base text-background shadow-sm hover:bg-foreground/85" onClick={props.onAddProject}>
						<Plus className="size-5" aria-hidden="true" />
						<span>{t("app.addProject")}</span>
					</Button>
				</div>
			</div>
		);
	}

	// 有项目：引导页 = 新建页面形态。虚拟会话只存在于渲染层 composer atoms，
	// 发送时由 promoteSessionComposerStateAtom 整体搬到真实会话，输入不丢失。
	// 项目下拉只切换 activeProjectId——切项目后仍留在引导页（currentSessionId 保持
	// 空），发送时按选中项目创建；下拉列表 = 已加入的全部项目（含内置 Chat）。
	//
	// 远端项目例外：它没有本机路径，发送即创建本地会话的路径不适用于它。只读浏览远端
	// 目录，把写入/Agent 留到后续阶段（各本地 IPC 也已按 locator 拒绝）。
	if (isRemoteProject(props.activeProject)) {
		return <RemoteProjectPanel projectId={props.activeProject.id} projectName={props.activeProject.name} />;
	}

	return (
		<SessionStartSurface
			sessionId={GUIDE_BOOTSTRAP_SESSION_ID}
			// 虚拟会话无 record：用选中项目加载 @ 引用文件树与模型目录。
			bootstrapProjectId={props.activeProject.id}
			projectSwitcher={
				<Select value={props.activeProject.id} onValueChange={props.onSelectProject}>
					<SelectTrigger aria-label={t("app.guideProjectPicker")} className="h-9 gap-2 border-0 bg-transparent px-2.5 text-sm font-normal text-text-secondary shadow-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:hover:bg-accent/50">
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
			}
		/>
	);
}
