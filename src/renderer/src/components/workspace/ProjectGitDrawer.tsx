import { isRemoteProject } from "../../../../shared/projectLocation";
import type { Project } from "../../../../shared/types";
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
};

/**
 * Single production entry for the Git drawer. The local and remote renderers retain
 * their distinct state machines and host-specific sections; only selection is shared.
 */
export function ProjectGitDrawer({ project, ...props }: ProjectGitDrawerProps) {
	if (project && project.id === props.projectId && isRemoteProject(project)) {
		return <RemoteGitPanel key={JSON.stringify([project.id, project.locator.hostId, project.locator.remotePath])} project={project} />;
	}
	return <LocalGitDrawerHost project={project} {...props} />;
}
