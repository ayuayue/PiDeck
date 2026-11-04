import { useCallback, useState } from "react";
import type { CloudSyncContentPreferences, CloudSyncResourceCategory, CloudSyncSelectionTree } from "../../../shared/types";
import type { useCloudSync } from "./useCloudSync";

/**
 * 云同步「同步内容」选择状态与操作（session-first 域 hook）：
 * 持有选择集合（勾选态以集合为准，不依赖扫描快照），暴露全部选择操作回调。
 */

/** useCloudSync 中选择/扫描相关的稳定回调集合（窄接口，避免整包透传）。 */
export type CloudSyncSelectionApi = Pick<ReturnType<typeof useCloudSync>, "scan" | "updateSelection" | "resolveConflicts" | "pickCustomPath" | "removeCustomPath" | "pickMountDirectory" | "mountProject" | "unmountProject">;

export function useCloudSyncSelection(api: CloudSyncSelectionApi) {
	const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
	const [selectedResourceIds, setSelectedResourceIds] = useState<Set<string>>(new Set());
	/** 冲突选择（id → local/remote），默认本地优先。 */
	const [conflictChoices, setConflictChoices] = useState<Record<string, "local" | "remote">>({});

	const syncSelection = useCallback(
		async (tree: CloudSyncSelectionTree | null) => {
			await api.updateSelection({
				selectedSessionIds: [...selectedSessionIds],
				selectedResourceIds: [...selectedResourceIds],
			});
		},
		[api, selectedSessionIds, selectedResourceIds],
	);

	const toggleSession = useCallback((selectionId: string) => {
		setSelectedSessionIds((prev) => {
			const next = new Set(prev);
			if (next.has(selectionId)) next.delete(selectionId);
			else next.add(selectionId);
			return next;
		});
	}, []);

	const toggleResource = useCallback((selectionId: string) => {
		setSelectedResourceIds((prev) => {
			const next = new Set(prev);
			if (next.has(selectionId)) next.delete(selectionId);
			else next.add(selectionId);
			return next;
		});
	}, []);

	const toggleNodeSessions = useCallback((tree: CloudSyncSelectionTree | null, projectId: string, all: boolean) => {
		const node = tree?.projects.find((candidate) => candidate.projectId === projectId);
		if (!node) return;
		setSelectedSessionIds((prev) => {
			const next = new Set(prev);
			for (const session of node.sessions) {
				if (all) next.add(session.selectionId);
				else next.delete(session.selectionId);
			}
			return next;
		});
	}, []);

	/** M9：类别分组批量勾选 —— 全选/取消该类所有候选（操作现有选择集合，不引入新 IPC）。 */
	const toggleCategory = useCallback((tree: CloudSyncSelectionTree | null, projectId: string, category: "sessions" | CloudSyncResourceCategory, selected: boolean) => {
		const node = tree?.projects.find((candidate) => candidate.projectId === projectId);
		if (!node) return;
		if (category === "sessions") {
			setSelectedSessionIds((prev) => {
				const next = new Set(prev);
				for (const session of node.sessions) {
					if (selected) next.add(session.selectionId);
					else next.delete(session.selectionId);
				}
				return next;
			});
			return;
		}
		setSelectedResourceIds((prev) => {
			const next = new Set(prev);
			for (const resource of node.resources) {
				if (resource.category !== category) continue;
				if (selected) next.add(resource.selectionId);
				else next.delete(resource.selectionId);
			}
			return next;
		});
	}, []);

	/** M9：弹文件/文件夹选择器（主进程归属计算），把自选路径加入同步清单。 */
	const onAddCustomPath = useCallback(
		async (tree: CloudSyncSelectionTree | null) => {
			await api.pickCustomPath();
			void api.scan();
		},
		[api],
	);

	/** M9：移除自选同步路径并重扫。 */
	const onRemoveCustomPath = useCallback(
		(customPathId: string) => {
			void api.removeCustomPath(customPathId).then(() => api.scan());
		},
		[api],
	);

	/** M9：云端项目手动挂载 —— 弹目录选择器 → mount-project 持久化映射。 */
	const onMountProject = useCallback(
		async (remoteProjectId: string, name: string) => {
			const localPath = await api.pickMountDirectory();
			if (!localPath) return;
			await api.mountProject({ remoteProjectId, remoteProjectName: name, localPath });
		},
		[api],
	);

	/** M9：解除挂载映射。 */
	const onUnmountProject = useCallback(
		(remoteProjectId: string) => {
			void api.unmountProject(remoteProjectId);
		},
		[api],
	);

	/** 内容分类开关（密钥/模型/生图等）：随选择一并持久化。 */
	const toggleContentCategory = useCallback(
		(key: keyof CloudSyncContentPreferences, checked: boolean) => {
			void api.updateSelection({
				selectedSessionIds: [...selectedSessionIds],
				selectedResourceIds: [...selectedResourceIds],
				content: { [key]: checked },
			});
		},
		[api, selectedSessionIds, selectedResourceIds],
	);

	/** 扫描：以扫描结果重置选择集合（扫描快照的 selected 是持久化选择）。 */
	const handleScan = useCallback(async () => {
		const next = await api.scan();
		if (!next) return null;
		setSelectedSessionIds(
			new Set(
				next.projects
					.flatMap((project) => project.sessions)
					.filter((session) => session.selected)
					.map((session) => session.selectionId),
			),
		);
		setSelectedResourceIds(
			new Set(
				next.projects
					.flatMap((project) => project.resources)
					.filter((resource) => resource.selected)
					.map((resource) => resource.selectionId),
			),
		);
		return next;
	}, [api]);

	const handleToggleAll = useCallback((tree: CloudSyncSelectionTree | null, all: boolean) => {
		if (!tree) return;
		setSelectedSessionIds(new Set(all ? tree.projects.flatMap((project) => project.sessions).map((session) => session.selectionId) : []));
		setSelectedResourceIds(new Set(all ? tree.projects.flatMap((project) => project.resources).map((resource) => resource.selectionId) : []));
	}, []);

	const applyConflictResolutions = useCallback(
		async (conflicts: Array<{ id: string; label: string }>) => {
			const resolutions = (conflicts ?? []).map((conflict) => ({
				id: conflict.id,
				choice: conflictChoices[conflict.id] ?? "local",
			}));
			if (resolutions.length === 0) return;
			await api.resolveConflicts(resolutions);
		},
		[api, conflictChoices],
	);

	return {
		selectedSessionIds,
		selectedResourceIds,
		conflictChoices,
		setConflictChoices,
		syncSelection,
		toggleSession,
		toggleResource,
		toggleNodeSessions,
		toggleCategory,
		onAddCustomPath,
		onRemoveCustomPath,
		onMountProject,
		onUnmountProject,
		toggleContentCategory,
		handleScan,
		handleToggleAll,
		applyConflictResolutions,
	};
}
