import type { ProjectSortModeId } from "./types/project";

export const DEFAULT_PROJECT_SORT_MODE: ProjectSortModeId = "manual";

export function normalizeProjectSortMode(value: unknown): ProjectSortModeId {
	return value === "updatedAt" || value === "createdAt" || value === "title" ? value : DEFAULT_PROJECT_SORT_MODE;
}
