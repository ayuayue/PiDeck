/**
 * 放弃更改 / 目录回滚 / 删除文件的确认目标与确认动作（从 `GitPanel.tsx` 原样搬出）。
 *
 * 三个目标只保存待办（弹窗在面板里渲染，取消即清空），真正落盘时统一经 `act` 单飞：
 * 能力关闭、已有写在跑、闸门被占都不会发出调用。
 */
import { useCallback, useState } from "react";
import type { GitDiscardResource, ProjectFileTarget } from "../../../../../shared/types";
import type { GitPanelProps } from "../GitPanel";

export function useGitDiscardConfirm(input: { props: GitPanelProps; act: (operation: () => Promise<void>) => Promise<void> }) {
	const { props, act } = input;
	const [discardTarget, setDiscardTarget] = useState<{
		group: "workingTree" | "untracked";
		target: ProjectFileTarget;
	} | null>(null);
	const [directoryDiscardTarget, setDirectoryDiscardTarget] = useState<{
		resources: GitDiscardResource[];
		label: string;
	} | null>(null);
	/** 右键“删除文件”确认目标 */
	const [deleteTarget, setDeleteTarget] = useState<ProjectFileTarget | null>(null);

	// 行内/目录动作只登记待确认目标（实际写动作在弹窗确认后经 act 单飞）；
	// 回调引用稳定，memo 的变更树不会因面板重渲而全量重建行。
	const discardFile = useCallback((target: ProjectFileTarget, group: "workingTree" | "untracked") => {
		setDiscardTarget({ group, target });
	}, []);
	const discardDir = useCallback((resources: GitDiscardResource[], label: string) => {
		setDirectoryDiscardTarget({ resources, label });
	}, []);
	const deleteFile = useCallback((target: ProjectFileTarget) => {
		setDeleteTarget(target);
	}, []);

	const confirmDiscard = () => {
		const target = discardTarget;
		if (!target) return;
		setDiscardTarget(null);
		void act(() => props.discardFile(props.projectId, target.group, target.target));
	};

	const confirmDirectoryDiscard = () => {
		const target = directoryDiscardTarget;
		if (!target) return;
		setDirectoryDiscardTarget(null);
		void act(() => props.discardFiles(props.projectId, target.resources));
	};

	/** 右键菜单“删除文件”确认：移入回收站，可恢复 */
	const confirmDelete = () => {
		const target = deleteTarget;
		const deleteFiles = props.deleteFiles;
		if (!target || !deleteFiles) return;
		setDeleteTarget(null);
		void act(() => deleteFiles(props.projectId, [target]));
	};

	return { discardTarget, setDiscardTarget, directoryDiscardTarget, setDirectoryDiscardTarget, deleteTarget, setDeleteTarget, discardFile, discardDir, deleteFile, confirmDiscard, confirmDirectoryDiscard, confirmDelete };
}
