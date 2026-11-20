import type { Project } from "../../../../shared/types";
import { isRemoteProject } from "../../../../shared/projectLocation";

export type ComposerPiSkillSource = { kind: "pending" } | { kind: "remote"; hostId: string } | { kind: "local"; projectId?: string } | { kind: "global" };

/** Resolve the skill directory that a pi composer is allowed to query. */
export function resolveComposerPiSkillSource(projectId: string | undefined, project: Project | undefined): ComposerPiSkillSource {
	if (projectId !== undefined && project === undefined) return { kind: "pending" };
	if (project !== undefined && isRemoteProject(project)) return { kind: "remote", hostId: project.locator.hostId };
	if (project?.kind === "chat") return { kind: "global" };
	return projectId === undefined ? { kind: "global" } : { kind: "local", projectId };
}
