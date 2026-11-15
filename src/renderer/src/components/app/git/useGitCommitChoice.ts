/**
 * 提交按钮的「smart commit」决策（从 `GitPanel.tsx` 原样搬出）。
 *
 * 有暂存就直接提交；没有暂存时按用户偏好决定「总是带上工作区改动」、「先问一次」
 * 还是只提示先暂存——问的那次由 `showSmartCommitPrompt` 弹 AlertDialog。
 * 偏好按项目落盘（`writeSmartCommitPreference`），Never 之后不再打扰。
 */
import type { Dispatch, SetStateAction } from "react";
import type { GitResource } from "../../../../../shared/types";
import { writeSmartCommitPreference, type SmartCommitPreference } from "./gitPanelStorage";

export function useGitCommitChoice(input: {
	projectId: string;
	canCommit: boolean;
	stagedCount: number;
	smartCommitPreference: SmartCommitPreference;
	setSmartCommitPreference: Dispatch<SetStateAction<SmartCommitPreference>>;
	workingChanges: GitResource[];
	setShowSmartCommitPrompt: Dispatch<SetStateAction<boolean>>;
	runCommit: (stageAll: boolean) => Promise<void>;
}) {
	const { projectId, canCommit, stagedCount, smartCommitPreference, setSmartCommitPreference, workingChanges, setShowSmartCommitPrompt, runCommit } = input;

	const doCommit = async () => {
		if (!canCommit) return;
		if (stagedCount > 0) {
			await runCommit(false);
			return;
		}
		if (smartCommitPreference.enableSmartCommit) {
			await runCommit(true);
			return;
		}
		if (smartCommitPreference.suggestSmartCommit && workingChanges.length > 0) {
			setShowSmartCommitPrompt(true);
		}
	};

	const chooseSmartCommit = (choice: "yes" | "always" | "never") => {
		setShowSmartCommitPrompt(false);
		if (choice === "never") {
			const next = { ...smartCommitPreference, suggestSmartCommit: false };
			setSmartCommitPreference(next);
			writeSmartCommitPreference(projectId, next);
			return;
		}
		if (choice === "always") {
			const next = { enableSmartCommit: true, suggestSmartCommit: true };
			setSmartCommitPreference(next);
			writeSmartCommitPreference(projectId, next);
		}
		void runCommit(true);
	};

	return { doCommit, chooseSmartCommit };
}
