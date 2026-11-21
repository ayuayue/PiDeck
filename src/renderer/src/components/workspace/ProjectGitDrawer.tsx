import { isRemoteProject } from "../../../../shared/projectLocation";
import type { Project } from "../../../../shared/types";
import type { GitDrawerDiff } from "../../hooks/useFileEditor";
import { useProjectServices } from "../../hooks/useProjectServices";
import { GitDrawerHost, type GitDrawerHostProps } from "./GitDrawerHost";
import { RemoteGitPanel } from "./RemoteGitPanel";

function LocalGitDrawerHost({ project, ...props }: GitDrawerHostProps & { project: Project | undefined }) {
	const services = useProjectServices(project);
	return <GitDrawerHost {...props} gitCapabilities={services?.capabilities.git} />;
}

export type ProjectGitDrawerProps = GitDrawerHostProps & {
	/** The active project only when the file surface and Git surface agree on its identity. */
	project: Project | undefined;
	/**
	 * 中间栏展示一份 Git Diff：远端面板经远端服务取内容后交给这里，与本机同一条位置/布局出口。
	 * 不放在 GitDrawerHostProps 里——本机宿主自己按 group/target 走 IPC，不需要这份已取好的内容。
	 */
	onShowGitDiff: (diff: GitDrawerDiff) => void;
};

/**
 * Single production entry for the Git drawer. The local and remote renderers retain
 * their distinct state machines and host-specific sections; only selection is shared.
 */
export function ProjectGitDrawer({ project, onShowGitDiff, ...props }: ProjectGitDrawerProps) {
	if (project && project.id === props.projectId && isRemoteProject(project)) {
		return <RemoteGitPanel key={JSON.stringify([project.id, project.locator.hostId, project.locator.remotePath])} project={project} onShowDiff={onShowGitDiff} onOpenFile={props.onOpenFile} />;
	}
	return <LocalGitDrawerHost project={project} {...props} />;
}
