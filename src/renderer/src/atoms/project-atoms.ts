import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { Project } from "../../../shared/types";

export const projectInventoryByIdAtom = atom<Record<string, Project>>({});
export const projectInventoryOrderAtom = atom<string[]>([]);

export const projectInventoryAtom = atom((get) => {
	const projects = get(projectInventoryByIdAtom);
	return get(projectInventoryOrderAtom)
		.map((projectId) => projects[projectId])
		.filter((project): project is Project => Boolean(project));
});

export const replaceProjectInventoryAtom = atom(null, (_get, set, projects: Project[]) => {
	set(projectInventoryByIdAtom, Object.fromEntries(projects.map((project) => [project.id, project])));
	set(
		projectInventoryOrderAtom,
		projects.map((project) => project.id),
	);
});

export const upsertProjectInventoryAtom = atom(null, (get, set, project: Project) => {
	set(projectInventoryByIdAtom, {
		...get(projectInventoryByIdAtom),
		[project.id]: project,
	});
	const order = get(projectInventoryOrderAtom);
	if (!order.includes(project.id)) set(projectInventoryOrderAtom, [...order, project.id]);
});

export const projectByIdAtomFamily = atomFamily((projectId: string) => atom((get) => get(projectInventoryByIdAtom)[projectId]));

export const worktreeProjectsByParentIdAtomFamily = atomFamily((parentId: string) => atom((get) => get(projectInventoryAtom).filter((project) => project.worktreeParentId === parentId)));
