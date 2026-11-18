import { createRoot } from "react-dom/client";
import { Provider } from "jotai";
import { GitPanel, type GitPanelProps } from "../../src/renderer/src/components/app/GitPanel";
import { GitStatus } from "../../src/shared/types";
import "../../src/renderer/src/styles.css";

const params = new URLSearchParams(location.search);
const multiple = params.get("mode") === "multiple";
const count = Number(params.get("count") ?? 120);
const height = Number(params.get("height") ?? 600);
const noop = async () => {};
const props: GitPanelProps = {
	projectId: "git-scroll",
	branches: ["main"],
	currentBranch: "main",
	capabilities: { statusPoll: false, refsWatch: false, autoFetch: false },
	getStatus: async () => ({
		merge: [],
		index: [],
		workingTree: [],
		untracked: Array.from({ length: count }, (_, i) => ({ path: `file-${String(i).padStart(3, "0")}.ts`, status: GitStatus.UNTRACKED })),
	}),
	commitLog: async () => [],
	commitCount: async () => 0,
	commitDetail: async () => null,
	branchCompare: async () => ({ files: [], ahead: 0, behind: 0 }),
	stageFiles: noop,
	unstageFiles: noop,
	discardFile: noop,
	discardFiles: noop,
	commit: noop,
	onOpenCommitFileDiff: noop,
	onOpenWorkspaceFileDiff: noop,
};

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
// Match GitDrawerHost's single/multi-repository wrappers, with real GitPanel and styles.
createRoot(root).render(
	<Provider>
		<div style={{ width: 380, height }}>
			<div className="git-panel flex h-full min-h-0 flex-col overflow-hidden">
				{multiple ? (
					<>
						<div data-testid="repositories" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
							{["first", "second"].map((repo) => (
								<section key={repo} className="shrink-0 border-b border-[var(--git-panel-border)] last:border-b-0">
									<GitPanel {...props} repoScopeKey={repo} repositoryLabel={repo} layout="changesOnly" />
								</section>
							))}
						</div>
						<div className="shrink-0 overflow-hidden border-t border-[var(--git-panel-border)]">
							<GitPanel {...props} layout="historyOnly" />
						</div>
					</>
				) : (
					<div className="min-h-0 flex-1">
						<GitPanel {...props} />
					</div>
				)}
			</div>
		</div>
	</Provider>,
);
