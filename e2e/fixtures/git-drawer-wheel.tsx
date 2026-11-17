import { createRoot } from "react-dom/client";
import { Provider } from "jotai";
import { GitDrawerHost, type GitDrawerApi } from "../../src/renderer/src/components/workspace/GitDrawerHost";
import { GitStatus, type GitBranchInfo, type GitRepoInfo, type GitResourceGroups } from "../../src/shared/types";
import "../../src/renderer/src/styles.css";

const params = new URLSearchParams(location.search);
const multiple = params.get("mode") === "multiple";
const count = Number(params.get("count") ?? 120);
const height = Number(params.get("height") ?? 600);
const projectId = "git-drawer-wheel";
const noop = async () => {};
const branchInfo: GitBranchInfo = { current: "main", branches: ["main"] };
const repos: GitRepoInfo[] = (multiple ? ["", "nested"] : [""]).map((relativePath) => ({
	target: { projectId, relativePath },
	relativePath,
	displayPath: relativePath || ".",
	name: relativePath || "root",
}));

// Use the production host so repository discovery and the nested scroll containers stay covered.
const gitApi: GitDrawerApi = {
	listRepos: async () => repos,
	status: async (_id, repo): Promise<GitResourceGroups> => ({
		merge: [],
		index: [],
		workingTree: [],
		untracked: Array.from({ length: count }, (_, index) => {
			const displayPath = `file-${String(index).padStart(3, "0")}.ts`;
			const path = repo?.relativePath ? `${repo.relativePath}/${displayPath}` : displayPath;
			return { path, displayPath, target: { projectId, relativePath: path }, status: GitStatus.UNTRACKED, letter: "U" };
		}),
	}),
	commitLog: async () => [],
	commitCount: async () => 0,
	commitDetail: async () => null,
	branchCompare: async () => ({ files: [], ahead: 0, behind: 0 }),
	stage: noop,
	unstage: noop,
	discard: noop,
	discardFiles: noop,
	commit: noop,
	cherryPick: noop,
	revert: noop,
	reset: noop,
	dropCommit: noop,
	generateCommitMessage: async () => ({ ok: true, message: "" }),
	init: noop,
	push: noop,
	pull: noop,
	fetch: noop,
	aheadBehind: async () => null,
	watchRefs: async () => "wheel-fixture",
	unwatchRefs: noop,
	onRefsChanged: () => () => {},
	deleteFiles: noop,
	branches: async () => branchInfo,
	checkout: async () => branchInfo,
	createBranch: async () => branchInfo,
};

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
	<Provider>
		<div data-testid="git-drawer-fixture" style={{ width: 380, height }}>
			<GitDrawerHost projectId={projectId} gitApi={gitApi} fallbackGitInfo={branchInfo} fallbackSwitchBranch={noop} fallbackCreateBranch={noop} onOpenCommitFileDiff={noop} onOpenWorkspaceFileDiff={noop} gitCapabilities={{ statusPoll: false, refsWatch: false, autoFetch: false }} />
		</div>
	</Provider>,
);
