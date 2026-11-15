/**
 * Git 面板的行内/批量变更动作（从 `GitPanel.tsx` 原样搬出）。
 *
 * `act` 是所有写动作的唯一漏斗：写能力关闭、已有写在进行、闸门被占时一律不发调用，
 * 成功后走非 silent 的 `refresh()`；失败统一 toast（错误条会把变更列表顶下去且切换后残留）。
 * `actRef` 的存在只为让下方的 `useCallback` 引用稳定：FileTree 是 memo 组件，
 * 每敲一个字符都新建回调会让整棵变更树重渲。
 */
import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { GitDiscardResource, ProjectFileTarget } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { createGitOperationGate } from "../../../utils/gitOperationGate";
import { localGitOperationErrorText } from "../../../utils/gitErrorPresentation";
import { showNotice } from "../../../utils/notice";
import type { GitPanelProps } from "../GitPanel";

export function useGitFileActions(input: {
	props: GitPanelProps;
	gitCapabilities: { write: boolean };
	gate: ReturnType<typeof createGitOperationGate>;
	committing: boolean;
	mutationRunningRef: MutableRefObject<boolean>;
	mutationRequestRef: MutableRefObject<number>;
	projectIdRef: MutableRefObject<string>;
	setMutating: Dispatch<SetStateAction<boolean>>;
	refresh: () => Promise<void>;
}) {
	const { props, gitCapabilities, gate, committing, mutationRunningRef, mutationRequestRef, projectIdRef, setMutating, refresh } = input;

	const act = async (operation: () => Promise<void>) => {
		// 写能力关闭：所有行内/批量变更动作共用这一个漏斗，能力关闭时一律不发调用。
		if (!gitCapabilities.write) return;
		if (mutationRunningRef.current || committing) return;
		// 写闸门：一次只允许一个写（与远端面板同一份规则）；写一开始，在途 status 结果即作废。
		if (gate.beginWrite() === undefined) return;
		const mutationRequest = ++mutationRequestRef.current;
		mutationRunningRef.current = true;
		setMutating(true);
		const projectId = props.projectId;
		try {
			await operation();
			if (projectId === projectIdRef.current) await refresh();
		} catch (caught) {
			if (projectId === projectIdRef.current) {
				// 变更类操作（放弃更改/重置/拣选等）失败统一走 toast，不再 setError：
				// 面板错误条会把变更列表顶下去，且错误会在切换后残留；toast 用完即走。
				showNotice(localGitOperationErrorText(caught) || t("git.operationFailed"), 8000, "error", t("git.operationFailed"));
			}
		} finally {
			if (mutationRequest === mutationRequestRef.current) {
				mutationRunningRef.current = false;
				if (projectId === projectIdRef.current) setMutating(false);
			}
		}
	};

	// FileTree 是 memo 组件：commit composer 输入会让 GitPanel 每次按键重渲，
	// 行内操作回调若每次重建，memo 失效 → 每敲一键都全量重建变更树行。
	// act 本身每次 render 新建闭包（依赖 committing / mutationRunningRef 等），用 ref 转发保持回调引用稳定。
	const actRef = useRef(act);
	actRef.current = act;
	const stageFile = useCallback(
		(target: ProjectFileTarget) => {
			void actRef.current(() => props.stageFiles(props.projectId, [target]));
		},
		[props.projectId, props.stageFiles],
	);
	const stageFiles = useCallback(
		(targets: ProjectFileTarget[]) => {
			void actRef.current(() => props.stageFiles(props.projectId, targets));
		},
		[props.projectId, props.stageFiles],
	);
	const unstageFile = useCallback(
		(target: ProjectFileTarget) => {
			void actRef.current(() => props.unstageFiles(props.projectId, [target]));
		},
		[props.projectId, props.unstageFiles],
	);

	return { act, actRef, stageFile, stageFiles, unstageFile };
}
