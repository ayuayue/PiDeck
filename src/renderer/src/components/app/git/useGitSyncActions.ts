/**
 * Git 面板的 push / pull 动作（从 `GitPanel.tsx` 原样搬出）。
 *
 * 两者同属「mutation」：写闸门靠 `mutationRunningRef` 单飞，请求序号作废旧结果；
 * 成功后走非 silent 的 `refresh()`（它先读本地角标再 fetch），因此不必再单独等一轮角标刷新。
 */
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { t } from "../../../i18n";
import { writeClipboard } from "../../../utils/clipboard";
import { localGitOperationErrorText } from "../../../utils/gitErrorPresentation";
import { showNotice } from "../../../utils/notice";
import type { GitPanelProps } from "../GitPanel";
import { gitErrorToastId, NO_UPSTREAM_RE } from "./gitPanelToasts";

export function useGitSyncActions(input: {
	props: GitPanelProps;
	repoScopeKey: string;
	gitCapabilitiesRef: MutableRefObject<{ sync: boolean }>;
	mutationRunningRef: MutableRefObject<boolean>;
	mutationRequestRef: MutableRefObject<number>;
	projectIdRef: MutableRefObject<string>;
	setPushing: Dispatch<SetStateAction<boolean>>;
	setPulling: Dispatch<SetStateAction<boolean>>;
	setError: Dispatch<SetStateAction<string | null>>;
	refresh: () => Promise<void>;
}) {
	const { props, repoScopeKey, gitCapabilitiesRef, mutationRunningRef, mutationRequestRef, projectIdRef, setPushing, setPulling, setError, refresh } = input;

	const doPush = async () => {
		// 同步能力关闭时按钮已置灰；这里再挡一次，防止绕过 UI 的调用变成网络写。
		if (!props.push || !gitCapabilitiesRef.current.sync || mutationRunningRef.current) return;
		const projectId = props.projectId;
		const mutationRequest = ++mutationRequestRef.current;
		mutationRunningRef.current = true;
		setPushing(true);
		setError(null);
		try {
			await props.push(projectId);
			if (projectId !== projectIdRef.current) return;
			// refresh() 的非 silent 成功路径会先读本地角标再 fetch：push 后本地 refs 已更新，
			// ahead 立即归零且不依赖 fetch 成败，不必再单独等一轮角标刷新。
			await refresh();
		} catch (caught) {
			if (projectId === projectIdRef.current) {
				const text = localGitOperationErrorText(caught);
				if (NO_UPSTREAM_RE.test(text) && props.currentBranch) {
					// 首次推送新分支：给“建立上游”引导而非裸报错；复制按钮可直接粘到终端执行。
					const command = `git push --set-upstream origin ${props.currentBranch}`;
					showNotice(
						t("git.pushNoUpstreamDesc", {
							branch: props.currentBranch,
							command,
						}),
						8000,
						"error",
						t("git.pushNoUpstreamTitle"),
						{
							action: {
								label: t("common.copy"),
								onClick: () => {
									void writeClipboard(command);
								},
							},
						},
						gitErrorToastId(repoScopeKey, "push"),
					);
				} else {
					showNotice(text || t("git.pushFailed"), 8000, "error", t("git.pushFailed"), undefined, gitErrorToastId(repoScopeKey, "push"));
				}
			}
		} finally {
			if (mutationRequest === mutationRequestRef.current) {
				mutationRunningRef.current = false;
				if (projectId === projectIdRef.current) setPushing(false);
			}
		}
	};

	const doPull = async () => {
		if (!props.pull || !gitCapabilitiesRef.current.sync || mutationRunningRef.current) return;
		const projectId = props.projectId;
		const mutationRequest = ++mutationRequestRef.current;
		mutationRunningRef.current = true;
		setPulling(true);
		setError(null);
		try {
			await props.pull(projectId);
			if (projectId !== projectIdRef.current) return;
			// 同 push：pull 后本地 refs 已是最终结果，本地角标计数先给出准确值
			await refresh();
		} catch (caught) {
			if (projectId === projectIdRef.current) {
				// 拉取失败同样不常驻面板错误区，避免错误条占位挤压变更列表。
				showNotice(localGitOperationErrorText(caught) || t("git.pullFailed"), 8000, "error", t("git.pullFailed"), undefined, gitErrorToastId(repoScopeKey, "pull"));
			}
		} finally {
			if (mutationRequest === mutationRequestRef.current) {
				mutationRunningRef.current = false;
				if (projectId === projectIdRef.current) setPulling(false);
			}
		}
	};

	return { doPush, doPull };
}
