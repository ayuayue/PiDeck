import type { BranchDiffResult, CommitEntry, GitFileStatus } from "../../shared/types";
import { GitStatus } from "../../shared/types";

/** Filesystem-bound shapes used only inside the local Git implementation. */
export type LocalGitChangedFile = {
	path: string;
	status: GitFileStatus;
	originalPath?: string;
};

export type LocalGitResource = {
	path: string;
	status: GitStatus;
	letter: string;
	oldPath?: string;
};

export type LocalGitResourceGroups = {
	merge: LocalGitResource[];
	index: LocalGitResource[];
	workingTree: LocalGitResource[];
	untracked: LocalGitResource[];
};

export type LocalGitBranchDiffResult = Omit<BranchDiffResult, "files"> & {
	files: LocalGitChangedFile[];
};

export type LocalGitCommitDetail = {
	commit: CommitEntry;
	files: LocalGitChangedFile[];
};

export type LocalGitWorkspaceFileDiff = {
	path: string;
	originalContent: string;
	modifiedContent: string;
};

export type LocalGitCommitFileDiff = {
	path: string;
	originalPath?: string;
	originalContent: string;
	modifiedContent: string;
};

export type LocalGitDiscardResource = {
	group: "workingTree" | "untracked";
	path: string;
};

export type LocalGitRepoInfo = {
	path: string;
	name: string;
	relativePath: string;
};

export type LocalWorktreeEntry = {
	path: string;
	branch: string;
};
