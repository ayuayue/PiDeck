import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppLogger } from "../logging/AppLogger";
import { resolveGitToplevel } from "./gitRun";
import { parseWslUncPath } from "../wsl/WslPaths.ts";

/**
 * Git refs 变化检测（主进程侧）。
 *
 * 为什么需要它：push/pull 角标（ahead/behind）与工作区变更列表原本只靠 5 秒轮询，
 * AI 在终端里 commit/push 之后用户往往要等下一轮才看到角标归零。本地 commit、push、
 * fetch、切分支、reset 都会改写 HEAD / refs\*\* / packed-refs，盯住这几个文件的签名
 * 就能把延迟从「最多 5 秒」压到一个轮询间隔（默认 1.5 秒），而 5 秒轮询继续兜底
 * （工作区文件改动不改变 refs 签名，变更列表仍然依赖轮询）。
 *
 * 为什么不用 fs.watch（2026-09 于 Windows 实测）：
 * - 只要在仓库子树里持有任何 fs.watch 句柄，**项目目录就无法被重命名/移动**（EPERM：
 *   Windows 要求待改名的目录子树内没有打开的句柄）。实测连只监听 `.git/HEAD` 一个
 *   文件也照样被挡——Node 在 Windows 上监听文件本质是持有其父目录句柄。删除仓库目录、
 *   删 `.git`、git 操作、`git worktree remove` 都不受影响，但「占用目录」对用户是
 *   不可预期的副作用，不能拿它换几百毫秒。
 * - 换成 stat 轮询后零句柄占用：每仓库每次只 stat 几个小文件（微秒级、不 spawn 进程），
 *   代价是检测延迟等于轮询间隔。
 *
 * 设计取舍：
 * - **按仓库 toplevel 去重 + 订阅计数**：同一仓库被多个项目（项目根是仓库子目录、或项目根
 *   下才另有仓库）订阅时共用一份轮询，计数归零才停掉该仓库；全部归零后停掉全局定时器。
 *   toplevel 靠 `git rev-parse --show-toplevel` 异步解析（见 resolveGitToplevel），解析未完成
 *   期间先按调用方 watchId 记账，完成后并进仓库条目（见 pending 的两段式登记）。
 * - **只在签名变化时通知**：一次 push 会连续改写多个 ref 文件，按间隔取样天然合并成
 *   一次通知；签名未变则完全不惊动渲染层。
 * - **失败静默降级**：非 git 目录、路径不存在、config 读不出来、toplevel 解析失败/超时
 *   只记 warn——检测是加速手段，不是正确性的前提。
 */

/** 默认轮询间隔：用户抱怨的是「5 秒太久」，1.5 秒足够让角标跟平，成本可忽略。 */
const DEFAULT_POLL_INTERVAL_MS = 1500;

/**
 * toplevel 解析的 watchdog（毫秒）。
 *
 * 为什么不能用 execGit 自己的 timeoutMs：WSL 分支把它抬到 60s 下限
 * （gitWsl.resolveWslGitTimeout），解析期间本模块既没起轮询、也不会通告任何变化——
 * UNC 项目每次订阅都会落进这个无轮询盲窗（正常 0.5–3s，wsl.exe 卡住时最坏 ~62s）。
 * 所以解析必须另配一个不随 WSL 下限抬高的上限：超时就走既有的 fallback 分支
 * （退回订阅路径继续盯，签名可能为 null，等价于「不解析 toplevel」的老行为）。
 */
const DEFAULT_RESOLVE_TIMEOUT_MS = 8000;

/** 解析超时时写进 warn 的原因串（与「非仓库 / 未装 git」区分开，便于线上定位）。 */
const RESOLVE_TIMEOUT_REASON = "toplevel resolve timeout";

export type GitRefsWatcherDeps = {
	logger?: Pick<AppLogger, "warn">;
	/** 轮询间隔（毫秒），测试可调小。 */
	intervalMs?: number;
	/**
	 * toplevel 解析的 watchdog 上限（毫秒，默认 8000），测试可调小。
	 * 与 execGit 的 timeoutMs 无关：WSL 分支会在 execGit 内部把它抬到 60s 下限。
	 */
	resolveTimeoutMs?: number;
	/** 签名读取实现（测试注入点）；默认读真实文件。返回 null 表示该路径不是仓库。 */
	readSignature?: (repoPath: string) => string | null;
	/**
	 * 仓库 toplevel 解析（测试注入点）；默认 `git rev-parse --show-toplevel`。
	 * 返回 null / 抛错都表示解析失败——调用方会退回订阅时给的路径，绝不把异常抛出去。
	 */
	resolveRepoRoot?: (cwd: string) => Promise<string | null>;
	/** 定时器注入点（测试用假定时器手动推进），默认真实 setInterval。 */
	setTimer?: (handler: () => void, intervalMs: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	/** 平台注入点（默认 process.platform）：WSL UNC 豁免只在 win32 生效，测试可跨平台注入。 */
	platform?: NodeJS.Platform;
};

type RepoWatch = {
	/** 解析后的仓库 toplevel（解析失败时退回订阅时给的路径），refs 签名就按它采样。 */
	repoPath: string;
	/** 订阅计数：同一仓库被多个面板/多个项目根订阅时共用一份轮询。 */
	refs: number;
	/** 上一次采样到的签名；登记时先读一次做基线，避免第一次 tick 误报变化。 */
	signature: string | null;
	/**
	 * watchId → 该订阅自身的计数：一次变化要逐个通告（渲染层按自己的 id 过滤）。
	 * 必须按 id 分开计数：同一 watchId 可能被重复 acquire（React 双挂载、分屏各订一次），
	 * 聚合计数只会说「仓库还有人订」，退订一方该不该继续收通告得看它自己的计数是否归零。
	 */
	watchIds: Map<string, number>;
};

/**
 * 解析中的登记：toplevel 还没拿到时先按调用方 watchId 记账（退订照样能立即生效），
 * 解析完成后并进按 toplevel 去重的仓库条目。
 */
type PendingWatch = {
	/** 订阅时给的 cwd：解析失败就退回它，行为与「不解析」时完全一致。 */
	cwd: string;
	refs: number;
};

/**
 * 解析工作区对应的 gitDir 与 refs 公共目录。
 *
 * - `.git` 可能是目录（普通仓库），也可能是文件（worktree / submodule，内容形如
 *   `gitdir: ../.git/worktrees/xxx`）。直接拼 `.git/refs` 在 worktree 下指向不存在的
 *   路径，会静默退化成「只靠轮询」。
 * - worktree 的 gitDir 里只有 HEAD 等文件，分支与远程引用在 `commondir` 指向的公共
 *   仓库目录里，所以两边都要看。
 *
 * @returns null 表示这不是仓库 / 无法读取（调用方静默降级）
 */
export function resolveGitDir(repoPath: string): { gitDir: string; commonDir: string } | null {
	const dotGit = join(repoPath, ".git");
	let gitDir: string;
	try {
		const info = statSync(dotGit);
		if (info.isDirectory()) {
			gitDir = dotGit;
		} else if (info.isFile()) {
			const content = readFileSync(dotGit, "utf8");
			const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(content);
			if (!match) return null;
			// 相对路径按工作区目录解析（worktree 的 .git 文件可能写相对路径）
			gitDir = resolve(repoPath, match[1]);
		} else {
			return null;
		}
	} catch {
		return null;
	}
	let commonDir = gitDir;
	try {
		const commonDirFile = join(gitDir, "commondir");
		if (existsSync(commonDirFile)) {
			const raw = readFileSync(commonDirFile, "utf8").trim();
			// commondir 相对 gitDir 解析（worktree 下通常是 "../.."）
			if (raw) commonDir = resolve(gitDir, raw);
		}
	} catch {
		// commondir 读不出来就退回 gitDir：worktree 场景少盯一个 refs 目录，仍有轮询兜底
	}
	return { gitDir, commonDir };
}

/**
 * 文件签名：不存在记 absent，目录只取 mtime，文件取 mtime + size。
 * 文件带上 size 是因为部分文件系统的 mtime 分辨率只有秒级，同一秒内的改写会看不出来。
 */
function fileStamp(path: string): string {
	try {
		const info = statSync(path);
		return info.isDirectory() ? `d${info.mtimeMs}` : `f${info.mtimeMs}.${info.size}`;
	} catch {
		return "absent";
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 读 HEAD 得到当前分支的完整 ref 名（refs/heads/x）；detached HEAD 返回 null。 */
function readHeadBranch(headPath: string): string | null {
	try {
		const match = /^\s*ref:\s*(\S+)\s*$/m.exec(readFileSync(headPath, "utf8"));
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

/**
 * 从 .git/config 取指定分支的 upstream（remote + merge）。
 * 手写解析而不是 `git rev-parse @{upstream}`：轮询里不能起子进程。
 */
export function readBranchUpstream(configText: string, branch: string): { remote: string; merge: string } | null {
	const sectionPattern = new RegExp(`^\\[branch\\s+"${escapeRegExp(branch)}"\\]$`);
	let inSection = false;
	let remote: string | null = null;
	let merge: string | null = null;
	for (const rawLine of configText.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.startsWith("[")) {
			// 进入/离开目标 section：只认当前分支，别的 section 直接跳过
			inSection = sectionPattern.test(line);
			continue;
		}
		if (!inSection || !line || line.startsWith("#") || line.startsWith(";")) continue;
		const separator = line.indexOf("=");
		if (separator < 0) continue;
		const key = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (key === "remote") remote = value;
		else if (key === "merge") merge = value;
	}
	if (!remote || !merge) return null;
	return { remote, merge };
}

/** config 的 remote/merge → 真正需要盯的引用路径（远程跟踪引用，或本地分支）。 */
function upstreamRefPath(upstream: { remote: string; merge: string }): string | null {
	const { remote, merge } = upstream;
	if (merge.startsWith("refs/heads/")) {
		const branchName = merge.slice("refs/heads/".length);
		// remote 为 "." 表示 upstream 是同仓库的另一个本地分支（branch.x.remote = .）
		return remote === "." ? `refs/heads/${branchName}` : `refs/remotes/${remote}/${branchName}`;
	}
	// 少见的 merge 目标（如 refs/tags/x）也能直接当引用路径用
	return merge.startsWith("refs/") ? merge : null;
}

/**
 * 与 ahead/behind 相关的引用状态签名（变化即说明角标/分支可能需要刷新）。
 *
 * 刻意排除 index：`git status` 自己会改写它，收进签名就是「刷新 → status → index →
 * 再刷新」的自激循环。同理不碰 FETCH_HEAD / ORIG_HEAD：它们只记录某次动作，不含新信息。
 */
export function readRefsSignature(repoPath: string): string | null {
	const roots = resolveGitDir(repoPath);
	if (!roots) return null;
	const { gitDir, commonDir } = roots;
	const headPath = join(gitDir, "HEAD");
	const parts = [
		// HEAD：切分支 / detached HEAD
		`HEAD=${fileStamp(headPath)}`,
		// packed-refs：gc / pack-refs / fetch 把松散引用打包（同时删掉松散文件）
		`packed=${fileStamp(join(commonDir, "packed-refs"))}`,
		// config：改 upstream（git push -u、branch --set-upstream-to）会改变角标基线
		`config=${fileStamp(join(commonDir, "config"))}`,
		`configwt=${fileStamp(join(gitDir, "config.worktree"))}`,
		// 目录 mtime 是粗信号（NTFS 会延迟更新，不可靠但免费）：新建/删除分支时兜一下
		`heads=${fileStamp(join(commonDir, "refs", "heads"))}`,
		`remotes=${fileStamp(join(commonDir, "refs", "remotes"))}`,
	];
	const branchRef = readHeadBranch(headPath);
	if (branchRef) {
		// 当前分支：commit / reset / push 都会改写它
		parts.push(`branch=${fileStamp(join(commonDir, branchRef))}`);
		const upstream = readBranchUpstream(readTextIfExists(join(commonDir, "config")) ?? "", branchRef.replace(/^refs\/heads\//, ""));
		const refPath = upstream ? upstreamRefPath(upstream) : null;
		// 上游引用：fetch / push 更新远程跟踪引用
		if (refPath) parts.push(`upstream=${fileStamp(join(commonDir, refPath))}`);
	}
	return parts.join("|");
}

function readTextIfExists(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function buildWatchId(projectId: string, repoPath: string): string {
	return `${projectId}::${repoPath}`;
}

/**
 * 是否应拒绝该仓库进入 refs 轮询（纯函数，可单测）。
 *
 * WSL UNC 路径（\\wsl.localhost\<distro>\... / \\wsl$\...）每轮采样要打 9P 文件系统：
 * statSync / readFileSync 的同步往返典型 1-30ms（发行版忙时更高），一次 tick 同步遍历
 * 多个仓库可阻塞主进程几十至几百 ms，且每 1.5s 周期性发生——表现为开着 WSL 项目的
 * Git 面板时全局 UI 周期性卡顿尖峰。与 file-index 的 WSL 豁免同口径（filesIpc 的
 * indexRootsFor 对 WSL 直接返回空）：refs 推送只是加速手段，拒绝订阅后渲染层仍有
 * 5s git status / ahead-behind 轮询兜底，仅放弃 1.5s 档的即时性。
 */
export function shouldSkipRefsPolling(repoPath: string, platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32" && parseWslUncPath(repoPath) !== null;
}

/**
 * 轮询键规范化：同一仓库的不同书写（结尾分隔符、Windows 盘符/大小写）必须归到同一份轮询，
 * 否则项目根与 toplevel 写法不一致时会各起一份。仅用于去重比对，不用于目录访问。
 */
function normalizeRepoKey(repoPath: string): string {
	const resolved = resolve(repoPath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function describeError(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}

export class GitRefsWatcher {
	private readonly logger: Pick<AppLogger, "warn"> | undefined;
	private readonly intervalMs: number;
	private readonly resolveTimeoutMs: number;
	private readonly readSignatureFn: (repoPath: string) => string | null;
	private readonly resolveRepoRootFn: (cwd: string) => Promise<string | null>;
	private readonly setTimer: (handler: () => void, intervalMs: number) => unknown;
	private readonly clearTimer: (timer: unknown) => void;
	private readonly platform: NodeJS.Platform;
	private readonly listeners = new Set<(watchId: string) => void>();
	/** 仓库条目：键是解析后的 toplevel（同一仓库的多个项目根共用一份）。 */
	private readonly repos = new Map<string, RepoWatch>();
	/** watchId → 仓库键：unwatch 只拿到调用方 watchId，靠它反查到具体轮询。 */
	private readonly bindings = new Map<string, string>();
	/** 解析尚未完成的登记：键是调用方 watchId（退订、重复订阅都在这里结算）。 */
	private readonly pending = new Map<string, PendingWatch>();
	private timer: unknown = null;
	private polling = false;

	constructor(deps: GitRefsWatcherDeps = {}) {
		this.logger = deps.logger;
		this.intervalMs = deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.resolveTimeoutMs = deps.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
		this.readSignatureFn = deps.readSignature ?? readRefsSignature;
		this.resolveRepoRootFn = deps.resolveRepoRoot ?? resolveGitToplevel;
		this.setTimer = deps.setTimer ?? ((handler, intervalMs) => setInterval(handler, intervalMs));
		this.clearTimer = deps.clearTimer ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
		this.platform = deps.platform ?? process.platform;
	}

	/** 订阅「某个仓库的 refs 变化」；返回退订函数。通知 payload 是 watchId，便于渲染层过滤自己的仓库。 */
	on(listener: (watchId: string) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** 当前登记中的仓库数（诊断/测试用）。 */
	get activeRepoCount(): number {
		return this.repos.size;
	}

	/** 解析尚未完成的订阅数（诊断/测试用：退订必须让这个数字回落，否则是孤儿登记）。 */
	get pendingRepoCount(): number {
		return this.pending.size;
	}

	/**
	 * 登记一个仓库订阅，返回调用方 watchId（同一 projectId + repoPath 复用同一个 id 并累加计数）。
	 *
	 * 为什么是「两段式」：toplevel 解析是个异步子进程，而 IPC 不能把一个未定型的 id 给调用方、
	 * 也不能等它——所以先按调用方 watchId 记账并立即返回（退订路径立刻可用），解析完成后再
	 * 把计数并进按 toplevel 去重的仓库条目。非 git 目录同样返回 id，只是永远不会收到通知。
	 */
	acquire(projectId: string, repoPath: string): string {
		const watchId = buildWatchId(projectId, repoPath);
		// WSL UNC：每轮同步采样要打 9P（见 shouldSkipRefsPolling），不登记也不起轮询。
		// 仍返回 watchId 维持 IPC 契约（acquire 恒返回 id）；release 对未知 id 静默忽略，
		// 退订路径天然安全。重复 acquire 同样走到这里直接返回，不会产生半登记状态。
		if (shouldSkipRefsPolling(repoPath, this.platform)) return watchId;
		const repoKey = this.bindings.get(watchId);
		if (repoKey !== undefined) {
			const registered = this.repos.get(repoKey);
			if (registered) {
				registered.refs += 1;
				registered.watchIds.set(watchId, (registered.watchIds.get(watchId) ?? 0) + 1);
				return watchId;
			}
			// 绑定比仓库条目活得久（不应发生）：清掉陈旧绑定，走新登记
			this.bindings.delete(watchId);
		}
		// 解析中的重复订阅（React 双挂载 / 分屏）共用同一次解析，计数累加
		const pending = this.pending.get(watchId);
		if (pending) {
			pending.refs += 1;
			return watchId;
		}
		const entry: PendingWatch = { cwd: repoPath, refs: 1 };
		this.pending.set(watchId, entry);
		// entry 本身就是代际令牌：退订会用同一个 watchId 重新登记，旧解析回调靠对象身份自我作废。
		void this.resolveWithWatchdog(repoPath).then(({ root, error }) => this.commit(watchId, entry, root, error));
		return watchId;
	}

	/**
	 * 解析 toplevel，并加一个不随 WSL 下限抬高的 watchdog。
	 *
	 * 解析实现（注入点）同步抛错也走同一个结算入口，acquire 永不把异常抛给 IPC；
	 * 超时以 root=null + 超时原因结算，交给 commit 走既有 fallback（退回订阅路径 + 起轮询），
	 * 迟到的解析结果靠 pending entry 的对象身份自灭，不会产生第二份登记或第二份轮询。
	 */
	private resolveWithWatchdog(repoPath: string): Promise<{ root: string | null; error: string | null }> {
		return new Promise((done) => {
			let settled = false;
			let watchdog: ReturnType<typeof setTimeout> | null = null;
			const finish = (root: string | null, error: string | null) => {
				if (settled) return;
				settled = true;
				// 解析先回来时必须撤掉 watchdog，否则每订阅一次就留一个空转定时器
				if (watchdog) clearTimeout(watchdog);
				done({ root, error });
			};
			watchdog = setTimeout(() => finish(null, RESOLVE_TIMEOUT_REASON), this.resolveTimeoutMs);
			// 不把进程钉住：解析慢不该阻止应用退出
			watchdog.unref?.();
			void new Promise<string | null>((settle) => settle(this.resolveRepoRootFn(repoPath))).then(
				(root) => finish(root, null),
				(caught: unknown) => finish(null, describeError(caught)),
			);
		});
	}

	/** 退订一次；计数归零才停掉该仓库。未知 id 静默忽略（重复退订必须安全）。 */
	release(watchId: string): void {
		const pending = this.pending.get(watchId);
		if (pending) {
			pending.refs -= 1;
			// 解析还没回来就退订：直接摘掉登记，迟到的解析回调对不上身份会自行作废
			if (pending.refs <= 0) this.pending.delete(watchId);
			return;
		}
		const repoKey = this.bindings.get(watchId);
		if (repoKey === undefined) return;
		const repo = this.repos.get(repoKey);
		if (!repo) {
			this.bindings.delete(watchId);
			return;
		}
		repo.refs -= 1;
		const ownRefs = (repo.watchIds.get(watchId) ?? 0) - 1;
		// 同一个 watchId 还持有订阅（重复 acquire 过）：继续通告，只减自己的计数
		if (ownRefs > 0) {
			repo.watchIds.set(watchId, ownRefs);
			return;
		}
		// 该 id 已全部退订：停止通告并解除绑定。同仓还有别的订阅者时若只减聚合计数，
		// 退订方仍会收到后续通告（渲染层监听已退、消息白跑一趟），watchIds 也会残留陈旧 id。
		repo.watchIds.delete(watchId);
		this.bindings.delete(watchId);
		// 还有别的项目根/面板订阅同一仓库：保留这份轮询（它们退订归零时再停）
		if (repo.refs > 0) return;
		this.repos.delete(repoKey);
		if (this.repos.size === 0) this.stopPolling();
	}

	/** 退出清理：停轮询并清空订阅与登记（装配层 quitCleanup 调用）。 */
	disposeAll(): void {
		this.stopPolling();
		this.repos.clear();
		this.bindings.clear();
		// 清掉解析中的登记：在飞的解析回调回来时会因为找不到对应 entry 而安静退出
		this.pending.clear();
		this.listeners.clear();
	}

	/**
	 * 解析结束后的落地登记：把 pending 计数并进按 toplevel 去重的仓库条目。
	 *
	 * 解析期间已退订 / 已 disposeAll / 已被新一代登记取代时什么都不做（对象身份不等），
	 * 因此不会留下孤儿定时器或孤儿 map 条目——这是「异步解析 + 同步退订」的唯一收敛点。
	 */
	private commit(watchId: string, entry: PendingWatch, root: string | null, resolveError: string | null): void {
		if (this.pending.get(watchId) !== entry) return;
		this.pending.delete(watchId);
		const repoPath = root ?? entry.cwd;
		// 读边界说明（刻意例外）：refs 元数据读写允许越出项目根，落在所属仓库的 toplevel
		// （项目根是 monorepo 子包/子目录时必然发生）。这里只读 HEAD / refs\*\* / packed-refs /
		// config 的 mtime 与 size，以及 config 里 branch.*.remote|merge 两个上游名——不回传任何
		// 文件内容、不落 token。除这几处 stat 与上面那段 config 解析外，不访问仓库内其它路径。
		if (root === null) {
			// 解析失败（非仓库 / 没装 git / 超时）不是错误，只是退回「盯着订阅路径」的老行为
			this.warn("git refs watch: repo toplevel unresolved, falling back to the subscribed path", { repoPath, error: resolveError ?? "not a git work tree" });
		}
		const repoKey = normalizeRepoKey(repoPath);
		const existing = this.repos.get(repoKey);
		if (existing) {
			existing.refs += entry.refs;
			existing.watchIds.set(watchId, (existing.watchIds.get(watchId) ?? 0) + entry.refs);
		} else {
			const signature = this.sample(repoPath);
			// root === null 时上一条 warn 已经给出真实原因（非仓库 / git 不可用 / 解析超时）；
			// 再补一条 "not a git repository" 会把「其实在仓库里、只是解析失败」诊断成非仓库，误导排查。
			if (signature === null && root !== null) this.warn("git refs watch skipped: not a git repository", { repoPath });
			this.repos.set(repoKey, { repoPath, refs: entry.refs, signature, watchIds: new Map([[watchId, entry.refs]]) });
			this.startPolling();
		}
		this.bindings.set(watchId, repoKey);
	}

	private startPolling(): void {
		if (this.polling) return;
		this.polling = true;
		const timer = this.setTimer(() => this.tick(), this.intervalMs);
		// 不把进程钉住；退出路径由装配层的 quitCleanup 负责
		(timer as { unref?: () => void } | null)?.unref?.();
		this.timer = timer;
	}

	private stopPolling(): void {
		if (!this.polling) return;
		this.polling = false;
		this.clearTimer(this.timer);
		this.timer = null;
	}

	/** 一轮采样：签名变化才通知（一次 push 的多文件改写按间隔天然合并成一次）。 */
	private tick(): void {
		for (const repo of this.repos.values()) {
			const next = this.sample(repo.repoPath);
			if (next === repo.signature) continue;
			// 先更新基线再通知：通知处理里若同步引发新的采样，也不会重复上报同一状态
			repo.signature = next;
			// 同一仓库可能被多个项目根/项目订阅：逐个通告，各自按自己的 watchId 过滤
			for (const watchId of repo.watchIds.keys()) this.notify(watchId);
		}
	}

	private notify(watchId: string): void {
		for (const listener of this.listeners) {
			try {
				listener(watchId);
			} catch (caught) {
				// 单个订阅者（如已销毁的窗口回调）抛错不能影响其它订阅者与后续轮询
				this.warn("git refs change listener failed", { watchId, error: describeError(caught) });
			}
		}
	}

	/** 采样失败（目录消失、权限、竞态）不抛给轮询循环：记 warn 后当作「无法判断」。 */
	private sample(repoPath: string): string | null {
		try {
			return this.readSignatureFn(repoPath);
		} catch (caught) {
			this.warn("git refs signature failed", { repoPath, error: describeError(caught) });
			return null;
		}
	}

	private warn(message: string, detail?: Record<string, unknown>): void {
		this.logger?.warn("git", message, detail);
	}
}
