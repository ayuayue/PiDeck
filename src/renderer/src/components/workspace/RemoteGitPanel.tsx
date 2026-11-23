import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GitBranchInfo } from "../../../../shared/types";
import type { ProjectFileTarget, RemoteProject } from "../../../../shared/types/project";
import type { GitDrawerDiff } from "../../hooks/useFileEditor";
import { useProjectServices } from "../../hooks/useProjectServices";
import { useRemoteGitRepos } from "../../hooks/useRemoteGitRepos";
import { t } from "../../i18n";
import { remoteGitErrorText } from "../../utils/gitErrorPresentation";
import { gitCapabilityReasonKey } from "../../utils/remoteGitCapabilityView";
import { showNotice } from "../../utils/notice";
import { GitPanel } from "../app/GitPanel";
import type { ProjectServiceCapabilityReasons, ProjectServices } from "../../services/projectServiceContracts";
import { RemoteGitRecoverySection } from "./RemoteGitRecoverySection";
import { RemoteGitTrustGate } from "./RemoteGitTrustGate";
import { createRemoteGitPanelBridge } from "./remoteGitPanelBridge";

const EMPTY_BRANCHES: GitBranchInfo = { current: null, branches: [] };
type RemoteGitPanelView = ProjectServices["capabilities"]["git"];

/** 中间栏 Diff 标签的尾注：与本机 Git Diff 同一套（文件名 + 分组 / 短 hash）。 */
function diffLabel(displayPath: string, suffix: string): string {
	return `${displayPath.split(/[/\\]/).pop() ?? displayPath} (${suffix})`;
}

/** 多仓时 Graph/Compare 只挂一份：记住上次选中的仓，仓库列表变化时落到仍存在的路径。 */
function readStoredHistoryRepo(projectId: string): string | null {
	try {
		return localStorage.getItem(`pideck:remote-git-panel:${projectId}:history-repo`);
	} catch {
		return null;
	}
}

function writeStoredHistoryRepo(projectId: string, path: string): void {
	try {
		localStorage.setItem(`pideck:remote-git-panel:${projectId}:history-repo`, path);
	} catch {
		// 预览/无存储环境仍允许本次会话内切换。
	}
}

/**
 * 一个远端仓库的面板：本机同一块 `GitPanel` + 按位置分派的桥。
 *
 * 仓库是参数而不是“面板选中的单一作用域”：多仓并排时每个仓一份自己的桥、分支、diff 窗口与序号，
 * 切换仓库不再让整块面板重建，也不会让一次异步回调落到另一个仓。
 */
function RemoteRepoPanel(props: {
	project: RemoteProject;
	services: ProjectServices;
	repoPath: string;
	layout: "full" | "changesOnly" | "historyOnly";
	label?: string;
	git: RemoteGitPanelView;
	blocked: ProjectServiceCapabilityReasons;
	onOpenFile?: (target: ProjectFileTarget) => void;
	/** Diff 内容由远端服务取，位置与布局统一交回中间栏阅读面（与本机同一条出口）。 */
	onShowDiff: (diff: GitDrawerDiff) => void;
	onReposChanged: () => Promise<void> | void;
	history?: { path: string; options: { value: string; label: string }[]; onSelect: (path: string) => void };
	footer?: ReactNode;
}) {
	const { project, services, repoPath, git, blocked } = props;
	const repoTarget = useMemo<ProjectFileTarget | undefined>(() => (repoPath === "" ? undefined : { projectId: project.id, relativePath: repoPath }), [project.id, repoPath]);
	const [branches, setBranches] = useState<GitBranchInfo>(EMPTY_BRANCHES);
	const branchRequest = useRef(0);

	const reloadBranches = useCallback(async () => {
		const request = ++branchRequest.current;
		if (!git.branchRead) {
			setBranches(EMPTY_BRANCHES);
			return;
		}
		try {
			const next = await services.git.branches(repoTarget);
			if (request === branchRequest.current) setBranches(next);
		} catch {
			// 分支名只是展示：读失败保留上一份已知值，写动作自己的错误会更明确。
		}
	}, [services, repoTarget, git.branchRead]);

	useEffect(() => {
		setBranches(EMPTY_BRANCHES);
		void reloadBranches();
		return () => {
			branchRequest.current += 1;
		};
	}, [reloadBranches, services.generation]);

	const bridge = useMemo(() => createRemoteGitPanelBridge(services, repoTarget), [services, repoTarget]);
	/**
	 * 新协议的入口按同一枚标记收口（`git.stagedDiff` 与本批全部新增同版本发布）：
	 * 旧 helper 上不展示 AI 摘要/总数/分支过滤，历史仍按 HEAD 分页、比较仍是两树。
	 */
	const upgraded = services.kind === "local" || (services.facts.helperCapabilities?.includes("git.stagedDiff") ?? false);
	/** 图谱写动词是 1.35 的协议面：helper 没声明就不显示入口（点了只会是 UNSUPPORTED_CAPABILITY）。 */
	const historyWrite = services.kind === "local" || (services.facts.helperCapabilities?.includes("git.cherryPick") ?? false);
	const switchBranch = useCallback(
		(branch: string) => {
			void services.git
				.checkout(branch, repoTarget)
				.then((next) => setBranches(next))
				.catch((error: unknown) => {
					showNotice(remoteGitErrorText(error), 6000, "error");
					void reloadBranches();
				});
		},
		[services, repoTarget, reloadBranches],
	);
	const createBranch = useCallback(
		(branchName: string) => {
			// 远端能力位声明 create-and-checkout 时才连切；只有 create 时保持远端原语义，不偷偷切走工作区。
			const mode = git.branchCreateMode === "create" ? "create" : "create-and-checkout";
			void services.git
				.createBranch(branchName, mode, repoTarget)
				.then(() => reloadBranches())
				.catch((error: unknown) => {
					showNotice(remoteGitErrorText(error), 6000, "error");
				});
		},
		[services, repoTarget, git.branchCreateMode, reloadBranches],
	);

	return (
		<div data-testid="remote-git-repo-panel" data-repo-path={repoPath} className="flex min-h-0 flex-col">
			<GitPanel
				projectId={project.id}
				repoScopeKey={repoPath}
				repositoryLabel={props.label}
				layout={props.layout}
				historyRepoPath={props.history?.path}
				historyRepoOptions={props.history?.options}
				onSelectHistoryRepo={props.history?.onSelect}
				gitCapabilities={git}
				blockedReasons={blocked}
				commitLog={bridge.commitLog}
				commitCount={upgraded ? bridge.commitCount : undefined}
				historyRefFilter={upgraded}
				// 服务换代（重连/事实变化）后同一项目也要重拉历史：旧代的失败会一直被搬到新代上。
				historySourceKey={services.generation}
				commitDetail={bridge.commitDetail}
				onOpenFile={props.onOpenFile}
				generateCommitMessage={upgraded ? () => bridge.stagedDiff().then((staged) => (services.git.generateCommitMessage === undefined ? { ok: false as const, code: "GIT_COMMIT_GENERATE_FAILED", message: t("remoteGit.unsupported") } : services.git.generateCommitMessage(staged, repoTarget))) : undefined}
				onOpenCommitFileDiff={(commit, file) => {
					void services.git
						.refFileDiff(commit.parents[0] ?? null, commit.hash, file.target, repoTarget)
						.then((result) => props.onShowDiff({ projectId: project.id, target: result.target, filePath: result.displayPath, originalContent: result.originalContent, modifiedContent: result.modifiedContent, label: diffLabel(result.displayPath, commit.shortHash) }))
						.catch((error: unknown) => showNotice(remoteGitErrorText(error), 6000, "error"));
				}}
				onOpenWorkspaceFileDiff={(group, target) => {
					void services.git
						.workspaceDiff(group, target, repoTarget)
						.then((result) => {
							if (result === null) {
								showNotice(t("git.workspaceDiffUnavailable"), 4000, "warning");
								return;
							}
							const groupLabel = group === "index" ? t("git.stagedChanges") : group === "merge" ? t("git.mergeChanges") : t("git.changes");
							props.onShowDiff({ projectId: project.id, target: result.target, filePath: result.displayPath, originalContent: result.originalContent, modifiedContent: result.modifiedContent, label: diffLabel(result.displayPath, groupLabel) });
						})
						.catch((error: unknown) => showNotice(remoteGitErrorText(error), 6000, "error"));
				}}
				branchCompare={bridge.branchCompare}
				getStatus={bridge.getStatus}
				stageFiles={bridge.stageFiles}
				unstageFiles={bridge.unstageFiles}
				discardFile={bridge.discardFile}
				discardFiles={bridge.discardFiles}
				commit={bridge.commit}
				cherryPick={historyWrite ? bridge.cherryPick : undefined}
				revert={historyWrite ? bridge.revert : undefined}
				reset={historyWrite ? bridge.reset : undefined}
				dropCommit={historyWrite ? bridge.dropCommit : undefined}
				deleteFiles={bridge.deleteFiles}
				branches={branches.branches}
				currentBranch={branches.current}
				onSwitchBranch={switchBranch}
				onCreateBranch={createBranch}
				push={bridge.push}
				pull={bridge.pull}
				fetch={bridge.fetch}
				aheadBehind={bridge.aheadBehind}
				watchRefs={bridge.watchRefs}
				unwatchRefs={bridge.unwatchRefs}
				onRefsChanged={bridge.onRefsChanged}
				gitInit={async () => {
					await bridge.gitInit();
					await props.onReposChanged();
					await reloadBranches();
				}}
				footer={props.footer}
			/>
		</div>
	);
}

/**
 * 远端项目的 Git 面板 = 本机同一块 `GitPanel` + 一个按位置分派的桥。
 *
 * 与远端原来“单一活动仓库 + 选择器”的区别：多仓项目**并排**渲染每个仓的变更区，
 * Graph/Compare 仍只挂一份并带仓库切换——与本机宿主同形。这不是把令牌作用域放宽：
 * 每个仓的读写仍带自己的 repo target，令牌也按 (项目, 仓库) 各自取。
 *
 * 剩下三块远端前置条件仍在这里：trust 门、仓库发现截断说明、恢复区（仓库级插槽）。
 */
export function RemoteGitPanel({ project, onOpenFile, onShowDiff }: { project: RemoteProject; onOpenFile?: (target: ProjectFileTarget) => void; onShowDiff: (diff: GitDrawerDiff) => void }) {
	const services = useProjectServices(project);
	const git = services.capabilities.git;
	const blocked = services.capabilities.blocked;
	const { repos, truncated, reload: reloadRepos } = useRemoteGitRepos(project, git.repos);
	const [historyRepoPath, setHistoryRepoPath] = useState<string | undefined>(() => readStoredHistoryRepo(project.id) ?? undefined);
	const historyRepoPathRef = useRef(historyRepoPath);
	historyRepoPathRef.current = historyRepoPath;

	useEffect(() => {
		if (repos === undefined) return;
		// 记住上次选中的仓；仓库列表变化时落到仍存在的路径，否则回第一个。
		const match = repos.find((repo) => repo.path === readStoredHistoryRepo(project.id)) ?? repos.find((repo) => repo.path === historyRepoPathRef.current) ?? repos[0];
		setHistoryRepoPath(match?.path);
	}, [project.id, repos]);

	const selectHistoryRepo = useCallback(
		(path: string) => {
			setHistoryRepoPath(path);
			writeStoredHistoryRepo(project.id, path);
		},
		[project.id],
	);

	// 多个仓、或只有嵌套仓（没有根仓）时并排：根仓缺席时“项目根”不是可用作用域。
	const multiRepo = repos !== undefined && (repos.length > 1 || (repos.length > 0 && !repos.some((repo) => repo.path === "")));
	const trustBlocked = gitCapabilityReasonKey(blocked["git.read"] ?? "") === "remoteGit.trustRequired";
	const historyRepo = multiRepo ? (repos?.find((repo) => repo.path === historyRepoPath) ?? repos?.[0]) : undefined;
	const repoOptions = useMemo(() => (repos ?? []).map((repo) => ({ value: repo.path, label: repo.path === "" ? t("remoteGit.repoScopeRoot") : repo.name })), [repos]);

	if (trustBlocked) {
		return (
			<div data-testid="remote-git-panel" data-project-id={project.id} className="git-panel relative flex min-h-0 flex-1 flex-col overflow-hidden text-foreground" aria-label={t("git.sourceControl")}>
				<p data-testid="remote-git-blocked" role="alert" className="px-2.5 py-1 text-micro text-[var(--git-desc-fg)]">
					{t("remoteGit.trustRequired")}
				</p>
				<RemoteGitTrustGate project={project} onApproved={() => void services.refresh()} />
			</div>
		);
	}

	const truncatedNote = truncated ? (
		<p data-testid="remote-git-repos-truncated" className="border-b border-[var(--git-panel-border)] px-2.5 py-1 text-micro text-[var(--git-desc-fg)]">
			{t("remoteGit.repoReposTruncated")}
		</p>
	) : null;

	if (!multiRepo) {
		return (
			<div data-testid="remote-git-panel" data-project-id={project.id} className="git-panel relative flex min-h-0 flex-1 flex-col overflow-hidden text-foreground" aria-label={t("git.sourceControl")}>
				{truncatedNote}
				<RemoteRepoPanel
					project={project}
					services={services}
					repoPath={repos?.[0]?.path ?? ""}
					layout="full"
					git={git}
					blocked={blocked}
					onOpenFile={onOpenFile}
					onShowDiff={onShowDiff}
					onReposChanged={reloadRepos}
					footer={
						<RemoteGitRecoverySection
							service={services.git}
							repo={repos?.[0]?.path === "" || repos?.[0] === undefined ? undefined : { projectId: project.id, relativePath: repos[0].path }}
							enabled={git.recovery}
							closedText={t(gitCapabilityReasonKey(blocked["git.recovery"] ?? "") ?? "remoteGit.failed")}
							reloadKey={`${services.generation}:${repos?.[0]?.path ?? ""}`}
						/>
					}
				/>
			</div>
		);
	}

	return (
		<div data-testid="remote-git-panel" data-project-id={project.id} className="git-panel relative flex min-h-0 flex-1 flex-col overflow-hidden text-foreground" aria-label={t("git.sourceControl")}>
			{truncatedNote}
			{/* scroll-ok: bounded —— 仓库数由发现上限封顶（50），不随数据无限增长 */}
			<div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
				{(repos ?? []).map((repo) => (
					<section key={repo.path} className="shrink-0 border-b border-[var(--git-panel-border)] last:border-b-0">
						<RemoteRepoPanel project={project} services={services} repoPath={repo.path} layout="changesOnly" label={repo.path === "" ? t("remoteGit.repoScopeRoot") : repo.name} git={git} blocked={blocked} onOpenFile={onOpenFile} onShowDiff={onShowDiff} onReposChanged={reloadRepos} />
					</section>
				))}
			</div>
			{/* 不预留固定高度：折叠时只占两行标题，避免截图里大块空白。 */}
			<div className="shrink-0 overflow-hidden border-t border-[var(--git-panel-border)]">
				{historyRepo !== undefined ? (
					<RemoteRepoPanel
						project={project}
						services={services}
						repoPath={historyRepo.path}
						layout="historyOnly"
						git={git}
						blocked={blocked}
						onOpenFile={onOpenFile}
						onShowDiff={onShowDiff}
						onReposChanged={reloadRepos}
						history={{ path: historyRepo.path, options: repoOptions, onSelect: selectHistoryRepo }}
						footer={
							<RemoteGitRecoverySection
								service={services.git}
								repo={historyRepo.path === "" ? undefined : { projectId: project.id, relativePath: historyRepo.path }}
								enabled={git.recovery}
								closedText={t(gitCapabilityReasonKey(blocked["git.recovery"] ?? "") ?? "remoteGit.failed")}
								reloadKey={`${services.generation}:${historyRepo.path}`}
							/>
						}
					/>
				) : null}
			</div>
		</div>
	);
}
