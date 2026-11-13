/**
 * 变更区三组的规格（从 `GitPanel.tsx` 的 `changeGroupSpecs` useMemo 原样搬出）。
 *
 * 三组（冲突 / 暂存 / 未暂存）合并成一条扁平列表交给 `ChangesGroupsStack` 虚拟化。
 * 批量动作走 `actRef` 而不是 `act`：调用方每次 render 都新建 `act` 闭包，
 * 直接引用会让 memo 的变更树每敲一个字符重渲一遍。
 */
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { GitDiscardResource, GitResource, GitResourceGroups, ProjectFileTarget } from "../../../../../shared/types";
import { t } from "../../../i18n";
import type { ChangesGroupSpec } from "./GitResourceTree";

/** 装配这三组需要的面板 props 子集（宿主包装器每次 render 都可能换引用）。 */
type ChangesGroupSpecProps = {
	projectId: string;
	deleteFiles?: (projectId: string, targets: ProjectFileTarget[]) => Promise<void>;
	onOpenFile?: (target: ProjectFileTarget) => void;
	stageFiles: (projectId: string, targets: ProjectFileTarget[]) => Promise<void>;
	unstageFiles: (projectId: string, targets: ProjectFileTarget[]) => Promise<void>;
};

type ResourceOpenState = { merge: boolean; staged: boolean; changes: boolean };

export function buildChangesGroupSpecs(input: {
	props: ChangesGroupSpecProps;
	gitCapabilities: { write: boolean; deleteFiles: boolean };
	groups: GitResourceGroups;
	workingChanges: GitResource[];
	resourceOpen: ResourceOpenState;
	setResourceOpen: Dispatch<SetStateAction<ResourceOpenState>>;
	mutating: boolean;
	committing: boolean;
	actRef: MutableRefObject<(operation: () => Promise<void>) => Promise<void>>;
	unstageFile: (target: ProjectFileTarget) => void;
	deleteFile: (target: ProjectFileTarget) => void;
	stageFile: (target: ProjectFileTarget) => void;
	discardFile: (target: ProjectFileTarget, group: "workingTree" | "untracked") => void;
	stageFiles: (targets: ProjectFileTarget[]) => void;
	discardDir: (resources: GitDiscardResource[], label: string) => void;
}): ChangesGroupSpec[] {
	const { props, gitCapabilities, groups, workingChanges, resourceOpen, setResourceOpen, mutating, committing, actRef, unstageFile, deleteFile, stageFile, discardFile, stageFiles, discardDir } = input;
	const mutatingNow = mutating || committing;
	const specs: ChangesGroupSpec[] = [];
	if (groups.merge.length > 0) {
		specs.push({
			key: "merge",
			groupType: "merge",
			title: t("git.mergeChanges"),
			open: resourceOpen.merge,
			onToggle: () => setResourceOpen((current) => ({ ...current, merge: !current.merge })),
			resources: groups.merge,
			readOnly: !gitCapabilities.write,
		});
	}
	if (groups.index.length > 0) {
		specs.push({
			key: "staged",
			groupType: "index",
			title: t("git.stagedChanges"),
			open: resourceOpen.staged,
			onToggle: () =>
				setResourceOpen((current) => ({
					...current,
					staged: !current.staged,
				})),
			resources: groups.index,
			allAction: gitCapabilities.write
				? () =>
						actRef.current(() =>
							props.unstageFiles(
								props.projectId,
								groups.index.map((resource) => resource.target),
							),
						)
				: undefined,
			allLabel: t("git.unstageAll"),
			allDisabled: mutatingNow,
			readOnly: !gitCapabilities.write,
			unstageFile: gitCapabilities.write ? unstageFile : undefined,
			deleteFile: props.deleteFiles && gitCapabilities.deleteFiles ? deleteFile : undefined,
			onOpenFile: props.onOpenFile,
		});
	}
	if (workingChanges.length > 0) {
		specs.push({
			key: "changes",
			groupType: "workingTree",
			title: t("git.unstagedChanges"),
			open: resourceOpen.changes,
			onToggle: () =>
				setResourceOpen((current) => ({
					...current,
					changes: !current.changes,
				})),
			resources: workingChanges,
			allAction: gitCapabilities.write
				? () =>
						actRef.current(() =>
							props.stageFiles(
								props.projectId,
								workingChanges.map((resource) => resource.target),
							),
						)
				: undefined,
			allLabel: t("git.stageAll"),
			allDisabled: mutatingNow,
			readOnly: !gitCapabilities.write,
			stageFile: gitCapabilities.write ? stageFile : undefined,
			discardFile: gitCapabilities.write ? discardFile : undefined,
			deleteFile: props.deleteFiles && gitCapabilities.deleteFiles ? deleteFile : undefined,
			onOpenFile: props.onOpenFile,
			stageDir: gitCapabilities.write ? stageFiles : undefined,
			discardDir: gitCapabilities.write ? discardDir : undefined,
		});
	}
	return specs;
}
