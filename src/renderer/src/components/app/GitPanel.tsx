import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { VirtualStack } from "../ui-shadcn/virtual-stack";
import { createPortal } from "react-dom";
import { useAtom, useSetAtom } from "jotai";
import { ArrowDownToLine, ArrowUpFromLine, Check, CheckCircle2, ChevronDown, ChevronsDownUp, ChevronsUpDown, ClipboardPaste, FileCode2, FolderGit2, GitBranch, List, ListTree, Loader2, Plus, RefreshCw, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "../ui-shadcn/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../ui-shadcn/alert-dialog";
import { LOCAL_GIT_AUTO_REFRESH, useGitAutoRefresh, type GitAutoRefreshCapabilities } from "../../hooks/git/useGitAutoRefresh";
import { createGitOperationGate } from "../../utils/gitOperationGate";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui-shadcn/context-menu";
import { ConfirmDialog } from "./AppParts";
import { showNotice, dismissNotice } from "../../utils/notice";
import { commitGenNoticeText, commitGenToastId, COMMIT_GEN_TIMEOUT_MS, gitErrorToastId, showCommitGenProgressToast } from "./git/gitPanelToasts";
import { htmlToPlainText, readClipboardHtmlConsistent, readClipboardText } from "../../utils/clipboard";
import { deepEqual } from "../../utils/deepEqual";
import type { BranchDiffResult, CommitDetail, CommitEntry, GitAheadBehind, GitChangedFile, GitDiscardResource, GitResource, GitResourceGroupType, GitResourceGroups, ProjectFileTarget } from "../../../../shared/types";
import { GitStatus } from "../../../../shared/types";
import { EMPTY_GIT_COMMIT_COMPOSER, gitCommitComposerByScopeAtom, gitCommitScopeKey, openSettingsAtom, patchGitCommitComposer, type GitCommitComposerState } from "../../atoms";
import { t } from "../../i18n";
import { fileNameOnly, ChangesGroupsStack, getCollapsibleChangeDirs, ResourceRow, type ChangesGroupSpec } from "./git/GitResourceTree";
import { collectChangeTreeDirPaths, collectUnstagedResources, type GitChangeViewMode } from "./git/changeTree";
import { buildChangesGroupSpecs } from "./git/changeGroupSpecs";
import { GitCompactFilter, PaneHeader } from "./git/GitPanelControls";
import { SourceControlGraph } from "./git/GitGraph";
import { Input } from "../ui-shadcn/input";
import { Progress } from "../ui-shadcn/progress";
import { Textarea } from "../ui-shadcn/textarea";
import { Label } from "../../components/ui-shadcn/label";
import type { ProjectGitCapabilities } from "../../services/projectServiceContracts";
import { localGitOperationErrorText } from "../../utils/gitErrorPresentation";
import { normalizeGitCapabilities, SHARED_GIT_BANNER_ITEM_IDS } from "../../utils/remoteGitCapabilityView";
import { RemoteGitCapabilityBanner } from "../workspace/RemoteGitCapabilityBanner";
import { GitInlineErrorNotice } from "./git/GitInlineErrorNotice";
import { BRANCH_BAR_HEIGHT } from "./git/gitPaneLayout";
import { useGitBranchDropdown } from "./git/useGitBranchDropdown";
import { useGitStatusRefresh } from "./git/useGitStatusRefresh";
import { useGitFileActions } from "./git/useGitFileActions";
import { useGitCommitChoice } from "./git/useGitCommitChoice";
import { useGitDiscardConfirm } from "./git/useGitDiscardConfirm";
import { useCommitGenProgress } from "./git/useCommitGenProgress";
import { useGitPaneState } from "./git/useGitPaneState";
import { useGitSyncActions } from "./git/useGitSyncActions";
import { readAheadBehindCache, readChangesViewMode, readSmartCommitPreference, type SmartCommitPreference, writeChangesViewMode } from "./git/gitPanelStorage";

/** 按仓库锁生成：切项目不能清组件 ref，否则旧请求还在飞、新仓库又会被误拦。 */
const inflightCommitGenScopes = new Set<string>();

/** 生成结束：解锁、收进度 toast、把结果写回该仓库的 composer（与当前正在看哪个项目无关）。 */
function finishCommitGen(scopeKey: string, patch: Partial<GitCommitComposerState> = {}) {
	inflightCommitGenScopes.delete(scopeKey);
	dismissNotice(commitGenToastId(scopeKey));
	patchGitCommitComposer(scopeKey, {
		generating: false,
		startedAt: undefined,
		...patch,
	});
}

export type GitPanelProps = {
	projectId: string;
	/** 项目根目录路径，用于把绝对路径显示成相对路径（远端资源已给出相对 path，可不传） */
	projectRoot?: string;
	/**
	 * 当前操作的仓库身份。多仓切换时 projectId 不变，用此项让 status/mutation 序号失效并清空面板。
	 * 未传时等同 projectId，单仓行为与改前一致。
	 */
	repoScopeKey?: string;
	/** 多仓模式中的仓库标题；不传时保持单仓面板的完整布局。 */
	repositoryLabel?: string;
	/**
	 * 多仓拆分：changesOnly 只渲染该仓变更区（按内容自适应，不抢 Graph/Compare 高度）；
	 * historyOnly 只渲染全局一份 Graph + Compare。默认完整三栏。
	 */
	layout?: "full" | "changesOnly" | "historyOnly";
	/** 多仓共享 Graph/Compare 时的仓库下拉；仅 historyOnly 传入。 */
	historyRepoPath?: string;
	historyRepoOptions?: { value: string; label: string }[];
	onSelectHistoryRepo?: (path: string) => void;
	commitLog: (projectId: string, options?: { maxEntries?: number; ref?: string; allBranches?: boolean }) => Promise<CommitEntry[]>;
	/** 与当前图谱过滤一致的提交总数（不分页），供源代码管理图标题徽章使用。 */
	commitCount: (projectId: string, options?: { ref?: string; allBranches?: boolean }) => Promise<number>;
	commitDetail: (projectId: string, ref: string) => Promise<CommitDetail | null>;
	onOpenCommitFileDiff: (commit: CommitEntry, file: GitChangedFile) => void | Promise<void>;
	onOpenWorkspaceFileDiff: (group: GitResourceGroupType, target: ProjectFileTarget) => void | Promise<void>;
	/** 行内“打开文件”按钮：在编辑器面板打开该文件 */
	onOpenFile?: (target: ProjectFileTarget) => void;
	branchCompare: (projectId: string, base: string, target: string) => Promise<BranchDiffResult>;
	getStatus: (projectId: string) => Promise<GitResourceGroups>;
	stageFiles: (projectId: string, targets: ProjectFileTarget[]) => Promise<void>;
	unstageFiles: (projectId: string, targets: ProjectFileTarget[]) => Promise<void>;
	discardFile: (projectId: string, group: "workingTree" | "untracked", target: ProjectFileTarget) => Promise<void>;
	/** 目录级批量回滚；主进程在同一状态快照中校验路径，避免逐文件 IPC 竞态。 */
	discardFiles: (projectId: string, resources: GitDiscardResource[]) => Promise<void>;
	commit: (projectId: string, message: string) => Promise<void>;
	branches: string[];
	currentBranch: string | null;
	/** 切换分支 */
	onSwitchBranch?: (branch: string) => void;
	/** 创建新分支 */
	onCreateBranch?: (branchName: string) => void;
	cherryPick?: (projectId: string, hash: string) => Promise<void>;
	revert?: (projectId: string, hash: string) => Promise<void>;
	reset?: (projectId: string, hash: string, mode: "soft" | "mixed" | "hard") => Promise<void>;
	dropCommit?: (projectId: string, hash: string) => Promise<void>;
	/** AI 生成提交摘要 */
	generateCommitMessage?: (projectId: string, stagedPaths?: string[]) => Promise<import("../../../../shared/types").GitGenerateCommitMessageResult>;
	/** 初始化 Git 仓库 */
	gitInit?: (projectId: string) => Promise<void>;
	/** Push：将当前分支推送到远程 */
	push?: (projectId: string) => Promise<void>;
	/** Pull：从远程拉取并合并到当前分支 */
	pull?: (projectId: string) => Promise<void>;
	/** Fetch：刷新远程跟踪引用，供定时轮询 ahead/behind 角标 */
	fetch?: (projectId: string) => Promise<void>;
	/** 当前分支相对上游的提交差距；无上游返回 null（不显示角标） */
	aheadBehind?: (projectId: string) => Promise<GitAheadBehind | null>;
	/**
	 * 订阅本仓库的 refs 变化（commit/push/fetch/切分支），返回 watchId 供事件过滤。
	 * 与 unwatchRefs 成对：面板卸载/切仓库时必须退订，否则主进程监听句柄会留到退出。
	 */
	watchRefs?: (projectId: string) => Promise<string>;
	unwatchRefs?: (watchId: string) => Promise<void>;
	/** refs 变化推送订阅（返回值退订）；payload 为 watchId */
	onRefsChanged?: (listener: (watchId: string) => void) => () => void;
	/** 从磁盘删除变更文件（移入回收站） */
	deleteFiles?: (projectId: string, targets: ProjectFileTarget[]) => Promise<void>;
	/** 自动刷新能力位；本机全开，缺省即全开。共用宿主给远端传 false，展示层不写 backend 分支。 */
	capabilities?: Partial<GitAutoRefreshCapabilities>;
	/**
	 * 服务能力（G4b）：缺省 = 全可用，现有调用方零行为变化。传入后按能力门禁入口与副作用
	 * （push/pull/fetch、init、stage/unstage/discard/commit、cherryPick/revert/reset/dropCommit、
	 * compare、refs watch、自动 status 刷新、提交快捷键），并把缺失项用同一条能力条置顶解释。
	 * 能力只决定 UI 入口，不替代 main 的逐操作授权。
	 */
	gitCapabilities?: Partial<ProjectGitCapabilities>;
};

const EMPTY_GROUPS: GitResourceGroups = {
	merge: [],
	index: [],
	workingTree: [],
	untracked: [],
};

export function GitPanel(props: GitPanelProps) {
	const panelRef = useRef<HTMLDivElement>(null);
	// Missing-model guidance opens Common settings directly at the Git summary section.
	const openSettings = useSetAtom(openSettingsAtom);
	const repoScopeKey = props.repoScopeKey ?? props.projectId;
	const composerScopeKey = gitCommitScopeKey(props.projectId, repoScopeKey);
	const [composerByScope, setComposerByScope] = useAtom(gitCommitComposerByScopeAtom);
	const composer = composerByScope[composerScopeKey] ?? EMPTY_GIT_COMMIT_COMPOSER;
	const commitMessage = composer.message;
	const commitGenLoading = composer.generating;
	const setCommitMessage = useCallback(
		(value: string | ((current: string) => string)) => {
			setComposerByScope((all) => {
				const prev = all[composerScopeKey] ?? EMPTY_GIT_COMMIT_COMPOSER;
				const message = typeof value === "function" ? value(prev.message) : value;
				return { ...all, [composerScopeKey]: { ...prev, message } };
			});
		},
		[composerScopeKey, setComposerByScope],
	);
	const layout = props.layout ?? "full";
	// 能力表：缺省全可用（零行为变化）。能力经 ref 读取，稳定回调不因能力对象换引用而重建定时器。
	const gitCapabilities = useMemo(() => normalizeGitCapabilities(props.gitCapabilities), [props.gitCapabilities]);
	const gitCapabilitiesRef = useRef(gitCapabilities);
	gitCapabilitiesRef.current = gitCapabilities;
	const paneIdPrefix = useId();
	// GitDrawerHost 会随外层 App 的流式渲染重跑，并为同一仓库重新创建函数包装器。
	// 这些 ref 只跟踪最新实现，避免 API 函数身份变化被误判为仓库变化。
	const projectIdRef = useRef(props.projectId);
	projectIdRef.current = props.projectId;
	const repoScopeKeyRef = useRef(repoScopeKey);
	repoScopeKeyRef.current = repoScopeKey;
	const getStatusRef = useRef(props.getStatus);
	getStatusRef.current = props.getStatus;
	const fetchRef = useRef(props.fetch);
	fetchRef.current = props.fetch;
	const aheadBehindRef = useRef(props.aheadBehind);
	aheadBehindRef.current = props.aheadBehind;
	// 角标读取串行化：心跳与手动刷新可能同时要读，慢仓库（大历史 / 网络盘）单次 rev-list
	// 超过一轮时会把 git 子进程一轮一轮叠起来，而旧结果反正会被作用域守卫丢弃。
	const aheadBehindInFlightRef = useRef<Promise<void> | null>(null);
	// 已写入 localStorage 的角标快照：值没变就不重复写（localStorage 是渲染线程同步存储，
	// 5 秒一次的无效写入既占主线程也没意义）。key 带上作用域，切项目/仓库时自然失效。
	const aheadBehindPersistedRef = useRef<{
		key: string;
		value: GitAheadBehind | null;
	} | null>(null);
	// historyOnly 没有独立仓库标题；changesOnly 把仓库名并进分支栏，不再额外预留标题高度。
	const panelChromeHeight = layout === "historyOnly" ? 0 : BRANCH_BAR_HEIGHT;
	const mutationRequestRef = useRef(0);
	const mutationRunningRef = useRef(false);
	/**
	 * Git 状态机的四条公共规则（取消 / 互斥 / unknown / 迟到读）与远端面板共用同一份实现：
	 * 写单飞由 `mutationRunningRef` 回答（本组件自己的 UI 标志），读用闸门令牌判断是否还能发布。
	 */
	// 组件生命周期内保持同一个闸门（与 refresh 的依赖契约一致：它不随 props 包装器变化）。
	const [gate] = useState(() => createGitOperationGate({ isWriting: () => mutationRunningRef.current }));
	const [groups, setGroups] = useState<GitResourceGroups>(EMPTY_GROUPS);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const commitInputRef = useRef<HTMLTextAreaElement | null>(null);
	/** 右键“粘贴”在光标处插入文本：受控组件用 setRangeText 不触发 onChange，
	 *  手动拼 next 值 + 恢复光标位置（rAF 等重渲染后再定位） */
	const pasteIntoCommitInput = (text: string) => {
		if (!text) return;
		const el = commitInputRef.current;
		const start = el?.selectionStart ?? commitMessage.length;
		const end = el?.selectionEnd ?? commitMessage.length;
		const next = commitMessage.slice(0, start) + text + commitMessage.slice(end);
		setCommitMessage(next);
		requestAnimationFrame(() => {
			el?.focus();
			el?.setSelectionRange(start + text.length, start + text.length);
		});
	};
	/** 原样粘贴：剪贴板有 HTML 时保留段落/换行结构转纯文本，否则直接读纯文本 */
	/** 粘贴：剪贴板有 HTML 时保留段落/换行结构转纯文本（textarea 只能纯文本），否则直接读纯文本 */
	const pasteCommitClipboard = () => {
		// 只接受与当前纯文本同源的 HTML（剪贴板残留问题见 readClipboardHtmlConsistent）
		const html = readClipboardHtmlConsistent();
		pasteIntoCommitInput(html ? htmlToPlainText(html) : readClipboardText());
	};
	const [committing, setCommitting] = useState(false);
	const [pushing, setPushing] = useState(false);
	const [pulling, setPulling] = useState(false);
	const [mutating, setMutating] = useState(false);
	const [notAGitRepo, setNotAGitRepo] = useState(false);
	const [gitNotInstalled, setGitNotInstalled] = useState(false);
	const [initializing, setInitializing] = useState(false);
	const [smartCommitPreference, setSmartCommitPreference] = useState<SmartCommitPreference>(() => readSmartCommitPreference(props.projectId));
	const [showSmartCommitPrompt, setShowSmartCommitPrompt] = useState(false);
	/** 当前分支相对上游的提交差距：ahead 显示在 push、behind 显示在 pull */
	const [aheadBehind, setAheadBehind] = useState<GitAheadBehind | null>(null);
	const [resourceOpen, setResourceOpen] = useState({
		merge: true,
		staged: true,
		changes: true,
	});
	/** 变更文件树的目录折叠态（merge/staged/working 共享，供「收起/展开全部」） */
	const [collapsedChangeDirs, setCollapsedChangeDirs] = useState<Set<string>>(() => new Set());
	/** 变更列表视图模式：树形（默认）/ 平铺，持久化在 localStorage */
	const [changesViewMode, setChangesViewMode] = useState<GitChangeViewMode>(() => readChangesViewMode());
	const { paneAnimating, paneState, resetPaneState, togglePane, paneStyle, renderSash, visibleSashAfterChanges, visibleSashAfterGraph } = useGitPaneState({ projectId: props.projectId, repoScopeKey, layout, panelChromeHeight, panelRef });

	useEffect(() => {
		// 项目切换会复用同一个 GitPanel 实例；退休在途读 + 递增 mutation 序号让旧项目的结果失效。
		gate.retire();
		mutationRequestRef.current += 1;
		resetPaneState();
		setGroups(EMPTY_GROUPS);
		setError(null);
		setCommitting(false);
		// push/pull 与 commit 同属 mutation：旧请求被序号作废后，其 finally 的守卫
		// （mutationRequest === mutationRequestRef.current）不再成立，不会执行
		// setPushing(false)——这里必须显式复位，否则按钮永远转圈。
		setPushing(false);
		setPulling(false);
		mutationRunningRef.current = false;
		setMutating(false);
		setResourceOpen({ merge: true, staged: true, changes: true });
		setCollapsedChangeDirs(new Set());
		setSmartCommitPreference(readSmartCommitPreference(props.projectId));
		setShowSmartCommitPrompt(false);
		setDiscardTarget(null);
		setDeleteTarget(null);
		// 切项目/仓库时先恢复该作用域的缓存角标（秒显），后续由 refresh 成功路径
		// 后台 fetch 校正；不置 null 是避免重挂后角标长时间消失（见 aheadBehindStorageKey 注释）。
		setAheadBehind(readAheadBehindCache(props.projectId, repoScopeKey));
		// 提交框草稿和 AI 生成态按仓库存在 atom 里：切项目只清本面板的 status，不能打断旧仓库还在飞的生成。
		setNotAGitRepo(false);
		setGitNotInstalled(false);
	}, [layout, panelChromeHeight, props.projectId, repoScopeKey]);

	const { readAheadBehind, refreshAheadBehind } = useGitStatusRefresh({ props, repoScopeKey, gitCapabilitiesRef, fetchRef, aheadBehindRef, aheadBehindInFlightRef, aheadBehindPersistedRef, projectIdRef, repoScopeKeyRef, setAheadBehind });

	/**
	 * 拉取最新 Git 工作区状态。
	 *
	 * @param silent - 静默模式：不显示 loading 动画、不清除已有错误和分组数据；
	 *                 用于后台轮询，避免闪烁和打断用户正在查看的 Diff 内容。
	 */
	const refresh = useCallback(
		async (silent = false) => {
			// 静默轮询不打断 mutation，也不与前一个 status 请求重叠；否则慢于 5 秒的请求会彼此作废，列表永久不更新。
			if (silent && mutationRunningRef.current) return;
			// 读闸门：exclusive（静默）在途即跳过；显式刷新总是抢先，旧代结果自然作废（迟到读）。
			const request = gate.beginRead({ exclusive: silent });
			if (request === undefined) return;
			const projectId = props.projectId;
			const current = () => gate.isCurrent(request) && projectId === projectIdRef.current && repoScopeKey === repoScopeKeyRef.current;
			if (!silent) {
				setLoading(true);
				setError(null);
			}
			try {
				const next = await getStatusRef.current(projectId);
				if (current()) {
					// 内容未变保留原引用（2027-02 性能审计）：status 每次返回全新对象树，
					// 直接 set 会让 FileTree（浅比较 memo）每 5 秒对整棵变更树全量
					// reconcile——大仓（万级文件）零变化也一样。与上方 aheadBehind 同款门卫。
					setGroups((current) => (deepEqual(current, next) ? current : next));
					// 静默轮询成功也清掉上一次的失败横幅：作用域恢复（切项目后仓库列表回填、
					// 外部 git 操作修好目录）后，错误文本没有别的出口，会一直挂在变更区。
					setError((current) => (current ? null : current));
					// 刷新成功说明当前目录可用，恢复仓库/工具标记（手动 git init 或安装 git 后自动恢复轮询）
					setNotAGitRepo(false);
					setGitNotInstalled(false);
					// 非 silent refresh 成功后顺带刷角标（内含 fetch 远程校正 behind），不必再单独 fetch
					if (!silent) void refreshAheadBehind();
				}
			} catch (caught) {
				if (current()) {
					const msg = localGitOperationErrorText(caught);
					// 检测"不是 Git 仓库"的错误，展示初始化提示（无论是否静默都要置位，
					// 否则面板打开期间仓库状态变化时轮询永远停不下来）
					if (/not a git repository|fatal:/.test(msg)) {
						setNotAGitRepo(true);
					} else if (/command not found|ENOENT|spawn.*git.*ENOENT/i.test(msg)) {
						setGitNotInstalled(true);
					}
					if (!silent) {
						setGroups(EMPTY_GROUPS);
						if (/not a git repository|fatal:/.test(msg)) {
							setError("");
						} else if (/command not found|ENOENT|spawn.*git.*ENOENT/i.test(msg)) {
							setError("");
						} else {
							setError(msg);
						}
					}
					// 静默失败不影响已展示的旧分组数据；不做错误信息变更。
				}
			} finally {
				if (current() && !silent) setLoading(false);
				gate.endRead(request);
			}
		},
		[props.projectId, repoScopeKey, refreshAheadBehind],
	);

	// refresh 必须经 ref 读取：props.gitInit 内部会 refreshRepos，触发 GitDrawerHost
	// 重渲染后 repoScopeKey 可能变化（无仓库时用 projectRoot，初始化后换成 main 侧
	// resolve 出来的 repo.path，字符串形式不一定一致）。init 按钮闭包里捕获的 refresh
	// 是旧作用域，其成功/收尾守卫（repoScopeKey === repoScopeKeyRef.current）会判失败，
	// 结果被丢弃、loading 卡死——变更区要手动点好几次才恢复。
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;

	/**
	 * 初始化 git 仓库（分支栏 / 空状态两个入口共用）。
	 * gitInit 内部已 refreshRepos（仓库列表变化会触发宿主重渲染并更新作用域），
	 * 完成后用最新作用域的 refresh 拉一次状态，确保刚 init 的仓库立刻出现在变更区。
	 */
	const doInitRepo = useCallback(async () => {
		if (!props.gitInit || !gitCapabilitiesRef.current.init) return;
		setInitializing(true);
		try {
			await props.gitInit(props.projectId);
			setNotAGitRepo(false);
			void refreshRef.current();
		} catch (caught) {
			// 初始化失败不常驻面板错误区（此时面板本就无变更列表），toast 提示即可。
			showNotice(localGitOperationErrorText(caught) || t("git.operationFailed"), 8000, "error", t("git.operationFailed"));
		}
		setInitializing(false);
	}, [props.gitInit, props.projectId]);

	// 打开 Git drawer 时首次加载；historyOnly 只看 Graph/Compare，不必轮询工作区。
	useEffect(() => {
		if (layout === "historyOnly") return;
		// 读能力关闭时不发首轮 status 请求：错误/能力条由宿主与能力条解释。
		if (!gitCapabilities.read) return;
		void refresh();
	}, [layout, refresh, gitCapabilities.read]);

	const autoRefreshCapabilities = useMemo<GitAutoRefreshCapabilities>(
		() => ({
			// 现有 GitAutoRefreshCapabilities 与 ProjectGitCapabilities 取交集：任一层说不可用就不注册 effect。
			statusPoll: (props.capabilities?.statusPoll ?? LOCAL_GIT_AUTO_REFRESH.statusPoll) && gitCapabilities.statusPoll,
			refsWatch: (props.capabilities?.refsWatch ?? LOCAL_GIT_AUTO_REFRESH.refsWatch) && gitCapabilities.refsWatch,
			autoFetch: (props.capabilities?.autoFetch ?? LOCAL_GIT_AUTO_REFRESH.autoFetch) && gitCapabilities.autoFetch,
		}),
		[props.capabilities?.statusPoll, props.capabilities?.refsWatch, props.capabilities?.autoFetch, gitCapabilities.statusPoll, gitCapabilities.refsWatch, gitCapabilities.autoFetch],
	);
	const isMutating = useCallback(() => mutationRunningRef.current, []);
	useGitAutoRefresh({
		enabled: layout !== "historyOnly",
		projectId: props.projectId,
		suspended: notAGitRepo || gitNotInstalled,
		capabilities: autoRefreshCapabilities,
		refreshStatus: refresh,
		readAheadBehind,
		refreshAheadBehind,
		isMutating,
		hasFetch: props.fetch !== undefined,
		hasAheadBehind: props.aheadBehind !== undefined,
		watchRefs: props.watchRefs,
		unwatchRefs: props.unwatchRefs,
		onRefsChanged: props.onRefsChanged,
	});

	// 「未暂存的更改」= 工作区侧改动（workingTree + untracked）。已暂存资源只出现在「暂存的更改」组：
	// 并进本组会让文件暂存后仍留在未暂存列表，点它还按 workingTree 取 diff 而失败（issue #391）。
	// 暂存后又继续改的文件由 porcelain 同时给出 index + workingTree 两条资源，本组只保留后者。
	const workingChanges = useMemo(() => collectUnstagedResources(groups), [groups]);
	const stagedCount = groups.index.length;
	const hasUnresolvedConflicts = groups.merge.length > 0;
	// VS Code enables the action for either staged changes or working-tree changes
	// when smart commit is enabled/suggested; the command decides whether to prompt.
	const hasChangesToCommit = stagedCount > 0 || (workingChanges.length > 0 && (smartCommitPreference.enableSmartCommit || smartCommitPreference.suggestSmartCommit));
	// 写能力关闭时提交入口整体不可用：置灰 + 不发任何 stage/commit 调用（快捷键走同一门禁）。
	const canCommit = gitCapabilities.write && Boolean(commitMessage.trim()) && hasChangesToCommit && !hasUnresolvedConflicts && !committing && !mutating;
	const total = groups.merge.length + stagedCount + workingChanges.length;

	// 合并 merge/staged/working 的可折叠目录，驱动顶部「收起/展开全部」按钮状态。
	// 两种视图的折叠键不同：扁平是一级目录名，树形是每个可见目录的完整相对路径。
	const collapsibleChangeDirs = useMemo(() => {
		const dirs = new Set<string>();
		for (const list of [groups.merge, groups.index, workingChanges]) {
			const entries = changesViewMode === "tree" ? collectChangeTreeDirPaths(list, props.projectRoot) : getCollapsibleChangeDirs(list, props.projectRoot);
			for (const dir of entries) dirs.add(dir);
		}
		return dirs;
	}, [groups.merge, groups.index, workingChanges, props.projectRoot, changesViewMode]);

	const canCollapseChangeDirs = collapsibleChangeDirs.size > 0;
	const allChangeDirsCollapsed = canCollapseChangeDirs && [...collapsibleChangeDirs].every((dir) => collapsedChangeDirs.has(dir));
	const allChangeDirsExpanded = !canCollapseChangeDirs || [...collapsibleChangeDirs].every((dir) => !collapsedChangeDirs.has(dir));

	const toggleChangeDir = useCallback((dir: string) => {
		setCollapsedChangeDirs((prev) => {
			const next = new Set(prev);
			if (next.has(dir)) next.delete(dir);
			else next.add(dir);
			return next;
		});
	}, []);

	const collapseAllChangeDirs = useCallback(() => {
		setCollapsedChangeDirs(new Set(collapsibleChangeDirs));
	}, [collapsibleChangeDirs]);

	const expandAllChangeDirs = useCallback(() => {
		setCollapsedChangeDirs(new Set());
	}, []);

	/** 切换树形/平铺：同时清空折叠态——两种视图的折叠键含义不同，留旧键会出现「看不见却被折叠」的行 */
	const toggleChangesViewMode = useCallback(() => {
		setChangesViewMode((current) => {
			const next: GitChangeViewMode = current === "tree" ? "flat" : "tree";
			writeChangesViewMode(next);
			return next;
		});
		setCollapsedChangeDirs(new Set());
	}, []);

	const { act, actRef, stageFile, stageFiles, unstageFile } = useGitFileActions({ props, gitCapabilities, gate, committing, mutationRunningRef, mutationRequestRef, projectIdRef, setMutating, refresh });
	const { discardTarget, setDiscardTarget, directoryDiscardTarget, setDirectoryDiscardTarget, deleteTarget, setDeleteTarget, discardFile, discardDir, deleteFile, confirmDiscard, confirmDirectoryDiscard, confirmDelete } = useGitDiscardConfirm({ props, act });

	// 变更区三组的规格：合并后交给 ChangesGroupsStack 扁平虚拟化。
	// 用 useMemo 稳定数组引用 —— ChangesGroupsStack 的 items memo 依赖它，每次
	// render 新建数组会让虚拟行全量重算；批量动作走 actRef 保持引用稳定。
	const changeGroupSpecs = useMemo<ChangesGroupSpec[]>(
		() => buildChangesGroupSpecs({ props, gitCapabilities, groups, workingChanges, resourceOpen, setResourceOpen, mutating, committing, actRef, unstageFile, deleteFile, stageFile, discardFile, stageFiles, discardDir }),
		[groups, workingChanges, resourceOpen, mutating, committing, gitCapabilities.write, gitCapabilities.deleteFiles, props.projectId, props.unstageFiles, props.stageFiles, props.deleteFiles, props.onOpenFile, unstageFile, deleteFile, stageFile, discardFile, stageFiles, discardDir],
	);
	const changesScrollRef = useRef<HTMLDivElement | null>(null);

	const runCommit = async (stageAll: boolean) => {
		const message = commitMessage.trim();
		if (!gitCapabilitiesRef.current.write) return;
		if (!message || committing || mutating || hasUnresolvedConflicts || mutationRunningRef.current) return;
		const projectId = props.projectId;
		const mutationRequest = ++mutationRequestRef.current;
		mutationRunningRef.current = true;
		setCommitting(true);
		setError(null);
		try {
			if (stageAll) {
				const paths = workingChanges.map((resource) => resource.target);
				if (paths.length > 0) await props.stageFiles(projectId, paths);
			}
			await props.commit(projectId, message);
			// 提交成功清的是该仓库草稿，哪怕用户已经切到别的项目。
			patchGitCommitComposer(gitCommitScopeKey(projectId, repoScopeKey), {
				message: "",
			});
			if (projectId !== projectIdRef.current) return;
			await refresh();
		} catch (caught) {
			if (projectId === projectIdRef.current) {
				// 提交失败（hook 拒绝/模板错误等）不再常驻面板错误区，统一 toast；
				// 保留 git 自己的 stderr 便于排查（如 pre-commit 输出）。
				showNotice(localGitOperationErrorText(caught) || t("git.commitFailed"), 8000, "error", t("git.commitFailed"), undefined, gitErrorToastId(repoScopeKey, "commit"));
			}
		} finally {
			if (mutationRequest === mutationRequestRef.current) {
				mutationRunningRef.current = false;
				if (projectId === projectIdRef.current) setCommitting(false);
			}
		}
	};

	const { doCommit, chooseSmartCommit } = useGitCommitChoice({ projectId: props.projectId, canCommit, stagedCount, smartCommitPreference, setSmartCommitPreference, workingChanges, setShowSmartCommitPrompt, runCommit });

	/**
	 * 生成提交摘要（AI）。
	 * - 防抖：按仓库 scope 互斥；切项目不能清锁，否则旧请求还在飞、新仓库又会被误拦
	 * - 进度：粘性 toast + 面板进度条；duration 必须 Infinity（0 会被 sonner 立刻关掉）
	 * - 结束：结果写回发起仓库的 atom，与当前正在看哪个项目无关
	 * - 超时：主进程 60s 上限返回 GIT_COMMIT_TIMEOUT，提示更久并带“重试”入口
	 */
	const runGenerateCommitMessage = useCallback(async () => {
		if (!props.generateCommitMessage) return;
		if (groups.index.length === 0) {
			showNotice(t("git.stageBeforeGenerateCommitMessage"), 3000);
			return;
		}
		const projectId = props.projectId;
		const scopeKey = gitCommitScopeKey(projectId, repoScopeKey);
		if (inflightCommitGenScopes.has(scopeKey)) return;
		inflightCommitGenScopes.add(scopeKey);
		patchGitCommitComposer(scopeKey, {
			generating: true,
			startedAt: Date.now(),
		});
		showCommitGenProgressToast(scopeKey);
		try {
			const result = await props.generateCommitMessage(projectId);
			if (result.ok) {
				const message = result.message.trim();
				if (message) {
					finishCommitGen(scopeKey, { message });
					showNotice(t("git.generateCommitMessageDone"), 2500);
				} else {
					// 现在只有「模型返回空串」走到这里：空暂存区 / 无仓库 / 读 diff 失败都有独立错误码（#338）
					finishCommitGen(scopeKey);
					showNotice(t("git.generateCommitMessageEmpty"), 5000, "warning");
				}
			} else if (result.code === "GIT_COMMIT_EMPTY_DIFF") {
				finishCommitGen(scopeKey);
				// 后端以真实暂存区为准判定为空：本地 UI 分组可能是旧快照（#338 的误报场景），
				// 提示先暂存后顺便走一次静默刷新，否则按钮守卫会继续放行、用户反复点出同一提示。
				showNotice(t("git.stageBeforeGenerateCommitMessage"), 5000, "warning");
				void refresh(true);
			} else if (result.code === "GIT_COMMIT_MODEL_REQUIRED") {
				finishCommitGen(scopeKey);
				// 未配置：提示 + “去设置”直达常用设置的 Git 摘要栏（覆盖上次记住的其它 tab）
				showNotice(commitGenNoticeText(result.message, t("git.generateCommitMessageFailed")), 8000, "error", undefined, {
					action: {
						label: t("git.goSettings"),
						onClick: () => openSettings({ tab: "git", section: "git" }),
					},
				});
			} else if (result.code === "GIT_COMMIT_TIMEOUT") {
				finishCommitGen(scopeKey);
				// 生成超时（主进程 60s 上限）：提示更久并给重试入口；重试复用同一防抖锁
				showNotice(commitGenNoticeText(result.message, t("git.generateCommitMessageFailed")), 10000, "error", undefined, {
					action: {
						label: t("git.retryGenerate"),
						onClick: () => void runGenerateCommitMessage(),
					},
				});
			} else {
				finishCommitGen(scopeKey);
				showNotice(commitGenNoticeText(result.message, t("git.generateCommitMessageFailed")), 5000, "error");
			}
		} catch (err) {
			finishCommitGen(scopeKey);
			showNotice(commitGenNoticeText(err instanceof Error ? err.message : undefined, t("git.generateCommitMessageFailed")), 5000, "error");
		}
	}, [openSettings, props.generateCommitMessage, props.projectId, repoScopeKey, groups.index.length, refresh]);

	const { doPush, doPull } = useGitSyncActions({ props, repoScopeKey, gitCapabilitiesRef, mutationRunningRef, mutationRequestRef, projectIdRef, setPushing, setPulling, setError, refresh });

	const commitGenProgress = useCommitGenProgress({ commitGenLoading, startedAt: composer.startedAt, composerScopeKey });
	const { branchOpen, setBranchOpen, branchCreating, setBranchCreating, newBranchName, setNewBranchName, branchDropdownStyle, branchBarRef, branchTriggerRef, branchDropdownRef, updateBranchDropdownPosition } = useGitBranchDropdown();
	// 脏工作区切分支的待确认目标（Wave 5）：非空时弹 ConfirmDialog。
	const [pendingBranchSwitch, setPendingBranchSwitch] = useState<string | null>(null);

	// 面板操作按功能分两组：一列 6 个混排图标（视图切换 / 收起 / 展开 / 刷新 / 推送 / 拉取）看上去就是「一堆按钮」。
	// - 视图组（树形切换、全部收起/展开）只作用于下方变更列表，留在「更改」标题栏；
	// - 同步组（刷新、推送、拉取）作用在仓库/分支上（角标也是相对上游的差距），升到顶部仓库/分支栏与分支同一行。
	// 按钮统一 size-6（24px）：顶部栏 py-1.5 + 24px = 36px，与 BRANCH_BAR_HEIGHT 的高度预算一致；
	// 用 size-7 会把顶部栏撑到 40px，fitPaneHeights 少算 4px 后最后一个 pane 底部会被 overflow 裁掉。
	const changesViewToolbar = (
		<div role="group" aria-label={t("git.changesViewActions")} className="flex shrink-0 items-center gap-0.5">
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="size-6"
				aria-pressed={changesViewMode === "tree"}
				title={changesViewMode === "tree" ? t("git.viewModeFlat") : t("git.viewModeTree")}
				aria-label={changesViewMode === "tree" ? t("git.viewModeFlat") : t("git.viewModeTree")}
				onClick={toggleChangesViewMode}
			>
				{/* 图标表示当前视图（与 aria-pressed 同义），title 表示点击后的动作 */}
				{changesViewMode === "tree" ? <ListTree size={14} /> : <List size={14} />}
			</Button>
			<Button type="button" variant="ghost" size="icon-sm" className="size-6" title={t("drawer.collapseAllDirs")} aria-label={t("drawer.collapseAllDirs")} disabled={!canCollapseChangeDirs || allChangeDirsCollapsed} onClick={collapseAllChangeDirs}>
				<ChevronsDownUp size={14} />
			</Button>
			<Button type="button" variant="ghost" size="icon-sm" className="size-6" title={t("drawer.expandAllDirs")} aria-label={t("drawer.expandAllDirs")} disabled={!canCollapseChangeDirs || allChangeDirsExpanded} onClick={expandAllChangeDirs}>
				<ChevronsUpDown size={14} />
			</Button>
		</div>
	);

	const repoSyncToolbar = (
		<div role="group" aria-label={t("git.repoSyncActions")} className="flex shrink-0 items-center gap-0.5">
			{loading && <Loader2 size={14} className="animate-pideck-spin" aria-label={t("common.loading")} />}
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="size-6"
				title={t("common.refresh")}
				aria-label={t("common.refresh")}
				disabled={!gitCapabilities.read}
				onClick={() => {
					// 读能力关闭时连 status 都不发：按钮置灰 + 这里再挡一次（外部触发同样受约束）。
					if (!gitCapabilitiesRef.current.read) return;
					// 非 silent refresh 成功后会顺带 refreshAheadBehind，不必再单独 fetch
					void refresh();
				}}
			>
				<RefreshCw size={14} />
			</Button>
			{props.push && (
				<div className="relative inline-flex items-center">
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="size-6"
						title={aheadBehind && aheadBehind.ahead > 0 ? t("git.pushAhead", { count: aheadBehind.ahead }) : t("git.push")}
						aria-label={t("git.push")}
						disabled={!gitCapabilities.sync || pushing || mutationRunningRef.current}
						onClick={() => void doPush()}
					>
						{pushing ? <Loader2 size={14} className="animate-pideck-spin" /> : <ArrowUpFromLine size={14} />}
					</Button>
					{/* 领先角标：本地上游提交数，提示需要推送。
              背景用 --color-info 而非 --color-accent：accent 暗色反转为近白（#fafafa），
              与固定 text-white 组合会白底白字不可读；但暗色 info 也是亮蓝 #60a5fa，
              白字对比不足（~2.3:1），文字同样走 --color-text-inverse（暗色近黑）。 */}
					{!pushing && aheadBehind && aheadBehind.ahead > 0 && (
						<span className="pointer-events-none absolute -top-1 -right-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-info)] px-0.5 text-[9px] leading-none font-semibold text-[var(--color-text-inverse)] tabular-nums" aria-label={t("git.pushAhead", { count: aheadBehind.ahead })}>
							{aheadBehind.ahead}
						</span>
					)}
				</div>
			)}
			{props.pull && (
				<div className="relative inline-flex items-center">
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="size-6"
						title={aheadBehind && aheadBehind.behind > 0 ? t("git.pullBehind", { count: aheadBehind.behind }) : t("git.pull")}
						aria-label={t("git.pull")}
						disabled={!gitCapabilities.sync || pulling || mutationRunningRef.current}
						onClick={() => void doPull()}
					>
						{pulling ? <Loader2 size={14} className="animate-pideck-spin" /> : <ArrowDownToLine size={14} />}
					</Button>
					{/* 落后角标：远程领先本地的提交数，提示需要拉取（颜色同领先角标，见上注释） */}
					{!pulling && aheadBehind && aheadBehind.behind > 0 && (
						<span
							className="pointer-events-none absolute -top-1 -right-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-info)] px-0.5 text-[9px] leading-none font-semibold text-[var(--color-text-inverse)] tabular-nums"
							aria-label={t("git.pullBehind", { count: aheadBehind.behind })}
						>
							{aheadBehind.behind}
						</span>
					)}
				</div>
			)}
		</div>
	);

	return (
		<div ref={panelRef} data-pane-animating={paneAnimating || undefined} className={`git-panel flex min-h-0 flex-col overflow-hidden bg-bg-page-raised text-foreground${layout === "full" ? " h-full" : ""}`} aria-label={t("git.sourceControl")}>
			{/* G4b：能力条置顶；只在确有入口被关闭时显示（全可用时不占一行）。 */}
			{props.gitCapabilities === undefined ? null : <RemoteGitCapabilityBanner git={gitCapabilities} items={SHARED_GIT_BANNER_ITEM_IDS} />}
			{layout !== "historyOnly" && (
				<>
					{/* 当前分支 + 切换下拉：无边框、宽度收窄，把空间留给仓库名和提交区。 */}
					<div className={`flex shrink-0 items-center gap-1 border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] px-2${layout === "changesOnly" ? " py-1" : " py-1.5"}`} ref={branchBarRef}>
						{layout === "changesOnly" && props.repositoryLabel && (
							<div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-semibold text-[var(--git-panel-fg)]" title={props.repositoryLabel}>
								<FolderGit2 size={13} className="shrink-0 text-muted-foreground" />
								<span className="min-w-0 truncate">{props.repositoryLabel}</span>
							</div>
						)}
						<Button
							ref={branchTriggerRef}
							type="button"
							variant="ghost"
							size="xs"
							className={`inline-flex h-6 items-center gap-0.5 rounded-sm border-0 bg-transparent px-1 text-left text-micro text-[var(--git-panel-fg)] shadow-none hover:bg-[var(--git-panel-hover)]${layout === "changesOnly" ? " max-w-[26%] shrink min-w-0" : " max-w-[9rem] min-w-0"}`}
							onClick={() => {
								if (!branchOpen) updateBranchDropdownPosition();
								setBranchOpen((v) => !v);
							}}
							title={
								props.currentBranch
									? t("app.branchCurrent", {
											branch: props.currentBranch,
											count: props.branches.length,
										})
									: undefined
							}
						>
							<GitBranch size={12} className="shrink-0 text-muted-foreground" />
							<span className="git-branch-label min-w-0 flex-1 truncate">{props.currentBranch || t("app.branchNone")}</span>
							{/* 多仓变更行已经很挤，数字角标会把按钮撑回宽胶囊；单仓仍显示分支数。 */}
							{layout !== "changesOnly" && props.branches.length > 0 && <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-micro font-medium tabular-nums text-muted-foreground">{props.branches.length}</span>}
							<ChevronDown size={12} className={`shrink-0 text-muted-foreground transition-transform duration-fast${branchOpen ? " rotate-180" : ""}`} />
						</Button>
						{notAGitRepo && (
							<Button type="button" variant="ghost" size="icon-sm" className="inline-grid size-6 place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground" title={t("git.initInBranchBar")} disabled={initializing} onClick={() => void doInitRepo()}>
								{initializing ? <Loader2 size={14} className="animate-pideck-spin" /> : <Plus size={14} />}
							</Button>
						)}
						{branchOpen &&
							createPortal(
								// scroll-ok: transient —— 分支选择下拉：portal 里的一次性弹窗，点选即关、下次打开重建，
								// 行的生命周期等于一次选择；虚拟器要的测量缓存与 ResizeObserver 在这类窗里没有收益。
								<div ref={branchDropdownRef} className="z-50 max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md" style={branchDropdownStyle}>
									{props.branches.map((branch) => (
										<Button
											type="button"
											key={branch}
											variant="ghost"
											size="sm"
											className={`h-auto flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent${branch === props.currentBranch ? " bg-accent font-semibold text-[color:var(--color-accent)]" : ""}`}
											title={branch}
											onClick={() => {
												setBranchOpen(false);
												// 脏工作区切分支确认（Wave 5）：git checkout 默认把未提交改动
												// 携带到目标分支（carry），用户通常不预期这个行为。干净区直接切。
												if (branch === props.currentBranch) return;
												if (total > 0) {
													setPendingBranchSwitch(branch);
													return;
												}
												props.onSwitchBranch?.(branch);
											}}
										>
											{branch === props.currentBranch && <Check size={14} className="shrink-0 text-[color:var(--color-accent)]" />}
											<span className="truncate">{branch}</span>
										</Button>
									))}
									<div className="my-1 h-px bg-border" />
									{branchCreating ? (
										<div className="flex items-center gap-1 px-1 py-1">
											<Input
												className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
												placeholder={t("app.branchNewPlaceholder") ?? t("app.branchNewPlaceholder")}
												value={newBranchName}
												onChange={(e) => setNewBranchName(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter" && newBranchName.trim()) {
														props.onCreateBranch?.(newBranchName.trim());
														setBranchCreating(false);
														setNewBranchName("");
														setBranchOpen(false);
													}
													if (e.key === "Escape") {
														setBranchCreating(false);
														setNewBranchName("");
													}
												}}
												autoFocus
											/>
											<Button
												type="button"
												variant="default"
												size="icon-sm"
												className="inline-grid size-7 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
												disabled={!newBranchName.trim()}
												onClick={() => {
													props.onCreateBranch?.(newBranchName.trim());
													setBranchCreating(false);
													setNewBranchName("");
													setBranchOpen(false);
												}}
											>
												<Check size={14} />
											</Button>
										</div>
									) : (
										<Button type="button" variant="ghost" size="sm" className="h-auto flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs text-text-secondary hover:bg-accent" onClick={() => setBranchCreating(true)}>
											<Plus size={14} />
											<span>{t("app.branchCreate")}</span>
										</Button>
									)}
								</div>,
								document.body,
							)}
						{/* 顶部仓库/分支栏只放「作用在仓库上」的操作：同步组所有布局都在这里；多仓没有「更改」标题栏，视图组并进来后用竖线分组。 */}
						<div className="ml-auto flex shrink-0 items-center gap-0.5">
							{layout === "changesOnly" && (
								<>
									{changesViewToolbar}
									<span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-[var(--git-panel-border)]" />
								</>
							)}
							{repoSyncToolbar}
						</div>
					</div>
					<section
						id={`git-pane-${paneIdPrefix}-changes`}
						className={`flex min-h-0 flex-col overflow-hidden border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] last:border-b-0${layout === "changesOnly" ? " flex-[0_0_auto]" : paneState.open.changes ? " h-[calc(var(--git-pane-height)+32px)] flex-[0_0_auto]" : " h-[32px] flex-[0_0_auto]"}`}
						style={layout === "changesOnly" ? undefined : paneStyle("changes")}
					>
						{layout !== "changesOnly" && (
							<PaneHeader id={`${paneIdPrefix}-changes`} title={t("git.changes")} open={paneState.open.changes} onToggle={() => togglePane("changes")}>
								{changesViewToolbar}
							</PaneHeader>
						)}
						{(layout === "changesOnly" || paneState.open.changes) && (
							<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
								{gitNotInstalled ? (
									<div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
										{/* 未装 git 的空状态用统一的 lucide 矢量图标（三角警示 + 弱化色），弃用 emoji ⚡（跨平台字形不稳、显糙） */}
										<TriangleAlert aria-hidden size={32} strokeWidth={1.5} className="text-text-tertiary" />
										<div className="text-sm font-semibold text-text-primary">{t("git.gitNotInstalled")}</div>
										<div className="max-w-[360px] text-xs leading-[22px] text-text-tertiary">{t("git.gitNotInstalledDesc")}</div>
									</div>
								) : notAGitRepo ? (
									<div className="flex flex-col items-center gap-4 px-4 py-8 text-center">
										<div className="text-control leading-[22px] text-[var(--git-desc-fg)]">{t("git.notAGitRepo")}</div>
										<Button type="button" variant="ghost" size="sm" className=" h-auto px-2.5 text-control" disabled={initializing} onClick={() => void doInitRepo()}>
											{initializing ? <Loader2 size={14} className="animate-pideck-spin" /> : t("git.initRepo")}
										</Button>
									</div>
								) : (
									<div className="flex shrink-0 flex-col gap-2 border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] px-2.5 pt-2 pb-1.5">
										<ContextMenu>
											<ContextMenuTrigger asChild>
												<Textarea
													ref={commitInputRef}
													className="git-scm-input min-h-14 max-h-[100px] w-full resize-y rounded-sm border border-[var(--git-input-border)] bg-[var(--git-input-bg)] px-2 py-1 text-control leading-[20px] text-[var(--git-panel-fg)] outline-none placeholder:text-[var(--git-desc-fg)]"
													placeholder={t("git.commitPlaceholder", {
														branch: props.currentBranch ?? "HEAD",
													})}
													value={commitMessage}
													onChange={(event) => setCommitMessage(event.target.value)}
													onKeyDown={(event) => {
														if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
															event.preventDefault();
															void doCommit();
														}
													}}
													rows={3}
												/>
											</ContextMenuTrigger>
											<ContextMenuContent alignOffset={-6}>
												<ContextMenuItem onSelect={pasteCommitClipboard}>
													<ClipboardPaste size={13} strokeWidth={2} aria-hidden="true" />
													{t("common.paste")}
												</ContextMenuItem>
											</ContextMenuContent>
										</ContextMenu>
										<div className="flex items-stretch gap-1.5">
											{/* AI 摘要钮与「提交」同组同高（32px）：outline 白卡与上方提交框同语言，
											早前 ghost 裸图标与实心主按钮并排显得割裂（用户反馈不统一） */}
											<Button
												type="button"
												variant="outline"
												size="icon"
												className="size-8 shrink-0 text-text-secondary shadow-none hover:text-text-primary"
												title={commitGenLoading ? t("git.generateCommitMessageProgress") : t("git.generateCommitMessage")}
												aria-label={t("git.generateCommitMessage")}
												disabled={commitGenLoading || mutating}
												onClick={() => void runGenerateCommitMessage()}
											>
												{commitGenLoading ? <Loader2 size={14} className="animate-pideck-spin" /> : <Sparkles size={14} />}
											</Button>
											<Button variant="default" className="git-commit-btn min-w-0 flex-1" loading={committing} disabled={!canCommit} onClick={() => void doCommit()}>
												{committing ? t("git.committing") : t("git.commit")}
											</Button>
										</div>
										{commitGenLoading && <Progress value={commitGenProgress} className="h-1" aria-label={t("git.generateCommitMessageProgress")} />}
									</div>
								)}

								{error && <GitInlineErrorNotice variant="changes" message={error} className="flex min-h-[22px] shrink-0 items-center gap-1 px-2.5 text-control text-[var(--git-conflict)]" icon={<TriangleAlert size={13} aria-hidden="true" className="shrink-0" />} />}
								{!loading && total === 0 && !error && (
									/* 工作区干净的完成态：勾图标 + 文案，替代裸一行灰字（用户需要一眼确认「没有待处理」而不是「加载失败」） */
									<div className="git-status-msg flex min-h-[22px] shrink-0 items-center gap-1.5 px-2.5 text-control text-[var(--git-desc-fg)]">
										<CheckCircle2 size={13} aria-hidden="true" className="shrink-0" />
										{t("git.noPendingChanges")}
									</div>
								)}

								{/* 变更区：三组折成一条扁平行列表走一个 VirtualStack（行内 Radix ContextMenu +
					    Seti SVG 的行渲染代价随变更文件数线性增长，无虚拟化时几千文件即卡顿全应用）。 */}
								<div ref={changesScrollRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
									<ChangesGroupsStack scrollRef={changesScrollRef} groups={changeGroupSpecs} viewMode={changesViewMode} collapsedDirs={collapsedChangeDirs} onToggleDir={toggleChangeDir} mutating={mutating || committing} onOpenWorkspaceFileDiff={props.onOpenWorkspaceFileDiff} projectRoot={props.projectRoot} />
								</div>
							</div>
						)}
					</section>
				</>
			)}

			{layout !== "changesOnly" && visibleSashAfterChanges && renderSash("changes", visibleSashAfterChanges)}

			{layout !== "changesOnly" && (
				<SourceControlGraph
					key={`graph-${repoScopeKey}`}
					paneIdPrefix={paneIdPrefix}
					projectId={props.projectId}
					commitLog={props.commitLog}
					commitCount={props.commitCount}
					commitDetail={props.commitDetail}
					onOpenCommitFileDiff={props.onOpenCommitFileDiff}
					branches={props.branches}
					currentBranch={props.currentBranch}
					open={paneState.open.graph}
					height={paneState.heights.graph}
					onToggle={() => togglePane("graph")}
					cherryPick={gitCapabilities.write ? props.cherryPick : undefined}
					revert={gitCapabilities.write ? props.revert : undefined}
					reset={gitCapabilities.write ? props.reset : undefined}
					dropCommit={gitCapabilities.write ? props.dropCommit : undefined}
					historyRepoPath={props.historyRepoPath}
					historyRepoOptions={props.historyRepoOptions}
					onSelectHistoryRepo={props.onSelectHistoryRepo}
				/>
			)}

			{layout !== "changesOnly" && paneState.open.graph && visibleSashAfterGraph && renderSash("graph", visibleSashAfterGraph)}

			{layout !== "changesOnly" && (
				<CompareChanges
					key={`compare-${repoScopeKey}`}
					paneIdPrefix={paneIdPrefix}
					projectId={props.projectId}
					enabled={gitCapabilities.compare}
					branches={props.branches}
					branchCompare={props.branchCompare}
					open={paneState.open.compare}
					height={paneState.heights.compare}
					onToggle={() => togglePane("compare")}
					historyRepoPath={props.historyRepoPath}
					historyRepoOptions={props.historyRepoOptions}
					onSelectHistoryRepo={props.onSelectHistoryRepo}
				/>
			)}

			{discardTarget &&
				createPortal(
					<ConfirmDialog
						title={discardTarget.group === "untracked" ? t("git.discardUntrackedConfirmTitle") : t("git.discardConfirmTitle")}
						message={
							discardTarget.group === "untracked"
								? t("git.discardUntrackedConfirmMessage", {
										path: fileNameOnly(discardTarget.target.relativePath),
									})
								: t("git.discardConfirmMessage", {
										path: fileNameOnly(discardTarget.target.relativePath),
									})
						}
						danger
						confirmLabel={discardTarget.group === "untracked" ? t("common.delete") : t("app.retractDiscard")}
						onConfirm={confirmDiscard}
						onCancel={() => setDiscardTarget(null)}
					/>,
					document.body,
				)}

			{directoryDiscardTarget &&
				createPortal(
					<ConfirmDialog
						title={t("git.discardDirectoryConfirmTitle")}
						message={t("git.discardDirectoryConfirmMessage", {
							path: directoryDiscardTarget.label,
							count: directoryDiscardTarget.resources.length,
						})}
						danger
						confirmLabel={t("app.retractDiscard")}
						onConfirm={confirmDirectoryDiscard}
						onCancel={() => setDirectoryDiscardTarget(null)}
					/>,
					document.body,
				)}

			{/* 右键“删除文件”确认：文件移入回收站（可恢复），danger 提示 */}
			{deleteTarget &&
				createPortal(
					<ConfirmDialog
						title={t("git.deleteFileConfirmTitle")}
						message={t("git.deleteFileConfirmMessage", {
							path: fileNameOnly(deleteTarget.relativePath),
						})}
						danger
						confirmLabel={t("common.delete")}
						onConfirm={confirmDelete}
						onCancel={() => setDeleteTarget(null)}
					/>,
					document.body,
				)}

			{pendingBranchSwitch !== null &&
				createPortal(
					<ConfirmDialog
						title={t("git.branchSwitchConfirmTitle")}
						message={t("git.branchSwitchConfirmMessage", {
							branch: pendingBranchSwitch,
							count: total,
						})}
						danger
						confirmLabel={t("git.branchSwitchConfirmLabel")}
						onConfirm={() => {
							const branch = pendingBranchSwitch;
							setPendingBranchSwitch(null);
							if (branch) props.onSwitchBranch?.(branch);
						}}
						onCancel={() => setPendingBranchSwitch(null)}
					/>,
					document.body,
				)}

			{showSmartCommitPrompt && (
				<AlertDialog open onOpenChange={(next) => !next && setShowSmartCommitPrompt(false)}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>{t("git.smartCommitTitle")}</AlertDialogTitle>
							<AlertDialogDescription className="whitespace-pre-line">{t("git.smartCommitPrompt")}</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel size="sm">{t("common.cancel")}</AlertDialogCancel>
							<Button type="button" variant="outline" size="sm" onClick={() => chooseSmartCommit("never")}>
								{t("git.smartCommitNever")}
							</Button>
							<Button type="button" variant="outline" size="sm" onClick={() => chooseSmartCommit("always")}>
								{t("git.smartCommitAlways")}
							</Button>
							<AlertDialogAction size="sm" autoFocus onClick={() => chooseSmartCommit("yes")}>
								{t("git.smartCommitYes")}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</div>
	);
}

function CompareChanges(props: {
	paneIdPrefix: string;
	projectId: string;
	branches: string[];
	branchCompare: GitPanelProps["branchCompare"];
	/** 对比能力：关闭时整块只读、不发请求（能力条解释原因）。 */
	enabled: boolean;
	open: boolean;
	height: number;
	onToggle: () => void;
	historyRepoPath?: string;
	historyRepoOptions?: { value: string; label: string }[];
	onSelectHistoryRepo?: (path: string) => void;
}) {
	const [base, setBase] = useState("");
	// 对比结果列表的滚动窗：交给 VirtualStack 复用（它要拿它当 getScrollElement）。
	const compareScrollRef = useRef<HTMLDivElement>(null);
	const [target, setTarget] = useState("");
	const [result, setResult] = useState<BranchDiffResult | null>(null);
	const [loading, setLoading] = useState(false);
	const requestSequence = useRef(0);

	useEffect(() => {
		// Branch names overlap across projects; comparison state must not cross that boundary.
		requestSequence.current += 1;
		setBase("");
		setTarget("");
		setResult(null);
		setLoading(false);
	}, [props.projectId]);

	useEffect(() => {
		if (props.branches.length >= 2 && (!base || !target)) {
			setTarget(props.branches[0] ?? "");
			setBase(props.branches[1] ?? "");
		}
	}, [base, props.branches, target]);

	const run = async () => {
		if (!props.enabled) return;
		if (!base || !target || base === target) return;
		const request = ++requestSequence.current;
		const projectId = props.projectId;
		setLoading(true);
		try {
			const next = await props.branchCompare(projectId, base, target);
			if (request === requestSequence.current && projectId === props.projectId) setResult(next);
		} catch (caught) {
			if (request === requestSequence.current && projectId === props.projectId) {
				setResult(null);
				// 对比失败（分支被删/仓库异常）不再占面板错误区，toast 用完即走。
				showNotice(localGitOperationErrorText(caught) || t("git.compareFailed"), 8000, "error", t("git.compareFailed"));
			}
		} finally {
			if (request === requestSequence.current && projectId === props.projectId) setLoading(false);
		}
	};

	return (
		<section
			id={`git-pane-${props.paneIdPrefix}-compare`}
			className={`flex min-h-0 flex-[0_0_auto] flex-col overflow-hidden border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] last:border-b-0${props.open ? " h-[calc(var(--git-pane-height)+32px)]" : " h-[32px]"}`}
			style={{ "--git-pane-height": `${props.height}px` } as React.CSSProperties}
		>
			<PaneHeader id={`${props.paneIdPrefix}-compare`} title={t("git.compareChanges")} count={result?.files.length} open={props.open} onToggle={props.onToggle}>
				{props.historyRepoOptions && props.historyRepoOptions.length > 1 && props.onSelectHistoryRepo && <GitCompactFilter value={props.historyRepoPath ?? ""} ariaLabel={t("git.switchRepository")} options={props.historyRepoOptions} onChange={props.onSelectHistoryRepo} compact className="max-w-[8.5rem]" />}
			</PaneHeader>
			{/* scroll-ok: nested —— 一个滚动窗里两段：上方 base/head 选择控件 + 下方改动文件列表。虚拟器只算得出其中一段的高度，跟容器 scrollHeight 对不上，滚动位置会错。 */}
			{props.open && (
				<div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
					<div className="git-compare-controls">
						<Label>
							<span>{t("git.base")}</span>
							<GitCompactFilter
								value={base}
								ariaLabel={t("git.base")}
								options={[
									{ value: "", label: t("git.selectBase") },
									...props.branches.map((branch) => ({
										value: branch,
										label: branch,
									})),
								]}
								onChange={(value) => setBase(value)}
							/>
						</Label>
						<span className="flex items-center pb-px text-[var(--git-desc-fg)]" aria-hidden="true">
							→
						</span>
						<Label>
							<span>{t("git.compare")}</span>
							<GitCompactFilter
								value={target}
								ariaLabel={t("git.compare")}
								options={[
									{ value: "", label: t("git.selectCompare") },
									...props.branches.map((branch) => ({
										value: branch,
										label: branch,
									})),
								]}
								onChange={(value) => setTarget(value)}
							/>
						</Label>
						<Button type="button" variant="ghost" size="sm" className=" h-auto px-2.5 text-control" disabled={!props.enabled || !base || !target || base === target || loading} onClick={() => void run()}>
							{loading ? <Loader2 size={14} className="animate-pideck-spin" /> : t("git.compare")}
						</Button>
					</div>
					{result && (
						<>
							<div className="flex-[0_0_auto] border-t border-[var(--git-panel-border)] px-2.5 py-1 text-micro text-[var(--git-desc-fg)]">
								{t("git.compareSummary", {
									ahead: result.ahead,
									behind: result.behind,
									count: result.files.length,
								})}
							</div>
							{/*
							     对比结果文件列表：行数 = 两次提交/分支之间改动的文件数，大重构可以上百个，
							     而外层是 flex 填充的滚动窗 —— 正是「行数随数据增长 + 有视口」。
							     行高固定（ResourceRow 是单行 22px 级），measureElement 实测后基本不抖动。
							*/}
							<div ref={compareScrollRef} className="min-h-0 flex-1 overflow-auto overscroll-contain">
								<VirtualStack items={result.files} scrollRef={compareScrollRef} getKey={(file) => file.path} estimateHeight={22} renderItem={(file) => <ResourceRow status={0 as GitStatus} letter="" path={file.path} compareStatus={file.status} />} />
							</div>
						</>
					)}
					{!result && <div className="flex min-h-[22px] shrink-0 items-center gap-1 px-2.5 text-control text-[var(--git-desc-fg)]">{t("git.compareHint")}</div>}
				</div>
			)}
		</section>
	);
}
