import { useAtomValue } from "jotai";
import { Check, FolderGit2, FolderPlus } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Project } from "../../../../../shared/types/project";
import { projectInventoryAtom } from "../../../atoms/project-atoms";
import { t } from "../../../i18n";
import { isChatProject } from "../../../rendererUtils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui-shadcn/dropdown-menu";

/**
 * 「使用」落点上下文：市场来自 App 装配层，菜单在卡片和详情面板里共用。
 * 项目清单直接从 projectInventoryAtom 读，只有「当前项目」和「添加目录」需要宿主注入。
 */
export type AgentUseTarget = {
	/** 当前项目 id：菜单里打勾，也是未指定目录时的默认落点。 */
	activeProjectId: string | null;
	/** 打开系统目录选择框并登记新项目；用户取消返回 null。 */
	onAddProject: () => Promise<Project | null>;
};

interface AgentUseTargetMenuProps {
	useTarget: AgentUseTarget;
	/** 建会话请求进行中：禁用选项，避免连点建出多个会话。 */
	pending: boolean;
	onPick: (projectId: string) => void;
	/** 触发按钮（卡片/详情面板各自的「使用」Button）。 */
	children: ReactNode;
}

/** 菜单里显示给用户的目录：聊天项目没有真实目录，远端项目只有远端路径。 */
function projectPathLabel(project: Project): string {
	if (project.kind === "chat") return "";
	if ("locator" in project) return project.locator.remotePath;
	return project.path;
}

/**
 * 「使用」的目录选择菜单：点「使用」先选工作目录，再在所选目录新建会话并绑定智能体。
 *
 * 为什么不是弹窗：`Use` 是低风险高频动作，多一层确认反而打断；菜单直接把
 * 「当前项目」打勾，默认只多点一次就能落在原处。卡片悬停行的操作区用
 * `has-data-[state=open]` 保持可见——菜单走 Portal，指针移出卡片会掉 hover。
 */
export function AgentUseTargetMenu({ useTarget, pending, onPick, children }: AgentUseTargetMenuProps) {
	const projects = useAtomValue(projectInventoryAtom);
	const [adding, setAdding] = useState(false);

	const handleAdd = async () => {
		if (adding) return;
		setAdding(true);
		try {
			const project = await useTarget.onAddProject();
			if (project) onPick(project.id);
		} finally {
			setAdding(false);
		}
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
			<DropdownMenuContent align="end" sideOffset={6} className="w-[min(320px,80vw)]">
				<DropdownMenuLabel>{t("agentMarket.useTargetTitle")}</DropdownMenuLabel>
				<p className="px-2 pb-1 text-micro leading-snug text-muted-foreground">{t("agentMarket.useTargetHint")}</p>
				<DropdownMenuSeparator />
				{projects.length === 0 ? <p className="px-2 py-1.5 text-micro text-muted-foreground">{t("agentMarket.useTargetEmpty")}</p> : null}
				{projects.map((project) => {
					const path = projectPathLabel(project);
					const current = project.id === useTarget.activeProjectId;
					return (
						<DropdownMenuItem key={project.id} disabled={pending} className="items-start" onSelect={() => onPick(project.id)}>
							<FolderGit2 className="mt-0.5 size-3.5" aria-hidden="true" />
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="flex min-w-0 items-center gap-1">
									<span className="min-w-0 truncate">{isChatProject(project) ? t("app.chatProject") : project.name}</span>
									{current ? <Check className="size-3 shrink-0 text-primary" aria-label={t("agentMarket.useTargetCurrent")} /> : null}
								</span>
								{path ? (
									<span className="w-full truncate text-micro text-muted-foreground" title={path}>
										{path}
									</span>
								) : null}
							</span>
						</DropdownMenuItem>
					);
				})}
				<DropdownMenuSeparator />
				<DropdownMenuItem disabled={pending || adding} onSelect={() => void handleAdd()}>
					<FolderPlus className="size-3.5" aria-hidden="true" />
					{t("agentMarket.useTargetAddDirectory")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
