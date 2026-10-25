import { FolderOpen } from "lucide-react";
import type { Project } from "../../../../shared/types";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";

/** 受控项目选择器：只选择目录，不隐式恢复或创建会话。 */
export function MiniOverlayProjectPicker(props: { projects: Project[]; value?: string; onSelectProject: (projectId: string) => void; disabled?: boolean; id?: string; className?: string }) {
	return (
		<Select value={props.value ?? ""} onValueChange={props.onSelectProject} disabled={props.disabled || props.projects.length === 0}>
			<SelectTrigger id={props.id} size="sm" className={cn("min-w-0 w-full gap-1.5 text-xs", props.className)} aria-label={t("miniOverlay.project")}>
				<FolderOpen className="size-3.5" aria-hidden="true" />
				<span className="min-w-0 flex-1 truncate text-left">
					<SelectValue placeholder={t("miniOverlay.selectProject")} />
				</span>
			</SelectTrigger>
			<SelectContent>
				{props.projects.map((project) => (
					<SelectItem key={project.id} value={project.id} disabled={project.missing}>
						{project.kind === "chat" ? t("app.chatProject") : project.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
