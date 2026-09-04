import { execFile } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { lstat, open, readlink, realpath, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { trashPath } from "../fs/trash";
import { REF_BASE } from "../rewind/checkpointConstants";
import { runGit } from "./gitProcess";
import type { GitBranchInfo, CommitDetail, CommitEntry, GitRef, BranchDiffResult, GitChangedFile, GitFileStatus, GitCommitFileDiff, GitResourceGroupType, GitWorkspaceFileDiff, GitAheadBehind } from "../../shared/types";
import { GitStatus } from "../../shared/types";
import type { GitResource, GitResourceGroups } from "../../shared/types";

const execFileAsync = promisify(execFile);
const GIT_MUTATION_TIMEOUT_MS = 30_000;

export class GitService {
	/** 只缓存轻量 commit 元数据/文件清单；正文永不缓存，且 LRU 总预算不超过 2MB。 */
	private readonly commitDetailCache = new Map<string, { detail: CommitDetail; bytes: number }>();
	private readonly commitDetailCacheLimit = 16;
	private readonly commitDetailCacheByteLimit = 2 * 1024 * 1024;
	private commitDetailCacheBytes = 0;

	private estimateCommitDetailBytes(detail: CommitDetail): number {
		const commit = detail.commit;
		const text = [
			commit.hash,
			commit.shortHash,
			commit.authorName,
			commit.authorEmail,
			commit.message,
			commit.fullMessage ?? "",
			...commit.parents,
			...commit.refNames,
		];
		for (const file of detail.files) text.push(file.path, file.originalPath ?? "");
		// JS 字符串通常按 UTF-16 存储；对象本身按每条文件记录追加小额估算。
		return text.reduce((total, value) => total + value.length * 2, 0) + detail.files.length * 64;
	}

	private readCommitDetailCache(key: string): CommitDetail | undefined {
		const cached = this.commitDetailCache.get(key);
		if (!cached) return undefined;
		this.commitDetailCache.delete(key);
		this.commitDetailCache.set(key, cached);
		return cached.detail;
	}

	private writeCommitDetailCache(key: string, detail: CommitDetail): void {
		const bytes = this.estimateCommitDetailBytes(detail);
		if (bytes > this.commitDetailCacheByteLimit) return;
		const previous = this.commitDetailCache.get(key);
		if (previous) this.commitDetailCacheBytes -= previous.bytes;
		this.commitDetailCache.delete(key);
		this.commitDetailCache.set(key, { detail, bytes });
		this.commitDetailCacheBytes += bytes;
		while (
			this.commitDetailCache.size > this.commitDetailCacheLimit ||
			this.commitDetailCacheBytes > this.commitDetailCacheByteLimit
		) {
			const oldestKey = this.commitDetailCache.keys().next().value;
			if (oldestKey === undefined) break;
			const oldest = this.commitDetailCache.get(oldestKey);
			if (oldest) this.commitDetailCacheBytes -= oldest.bytes;
			this.commitDetailCache.delete(oldestKey);
		}
	}

	/** 将 renderer 提供的 commit-ish 安全解析为完整 SHA，后续命令只接收 hash。 */
	private async resolveCommitHash(cwd: string, ref: string): Promise<string | null> {
		try {
			const { stdout } = await execFileAsync(
				"git",
				["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
				{ cwd },
			);
			const hash = stdout.trim();
			return /^[0-9a-f]{40}$/i.test(hash) ? hash : null;
		} catch {
			return null;
		}
	}

	/**
	 * 判断给定目录是否处于一个 git 仓库内。
	 * 启用工作区模式前做前置校验，避免非 git 项目开启后只能看到空列表、
	 * 直到点击"新建工作区"才在 create 阶段报错。
	 */
	async isGitRepo(cwd: string): Promise<boolean> {
		try {
			await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
			return true;
		} catch {
			return false;
		}
	}

	async getBranches(cwd: string): Promise<GitBranchInfo> {
		try {
			// 获取当前分支和所有本地分支（不包含远程分支）。
			// 显式设置 maxBuffer 防止仓库分支数过多时 stdout 超过 1MB 默认上限而被截断。
			const BRANCH_MAX_BUFFER = 10 * 1024 * 1024;
			const [{ stdout: currentRaw }, { stdout: localRaw }] = await Promise.all([
				execFileAsync("git", ["branch", "--show-current"], { cwd }),
				execFileAsync("git", ["branch", "--format=%(refname:short)"], { cwd, maxBuffer: BRANCH_MAX_BUFFER }),
			]);

			const current = currentRaw.trim() || null;
			const branches = localRaw
				.split(/\r?\n/)
				.map((b) => b.trim())
				.filter(Boolean);

			// 当前分支排在最前
			const sorted = current
				? [current, ...branches.filter((b) => b !== current)]
				: branches;

			return { current, branches: sorted };
		} catch {
			// 非 Git 目录或未安装 git 时只返回空信息，UI 可以降级展示为 no git。
			return { current: null, branches: [] };
		}
	}

	async checkout(cwd: string, branch: string): Promise<GitBranchInfo> {
		try {
			if (!branch || branch.startsWith("-")) throw new Error("Invalid branch name");
			const fullRef = `refs/heads/${branch}`;
			await runGit(["check-ref-format", fullRef], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
			await runGit(["show-ref", "--verify", "--quiet", fullRef], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
			await runGit(["checkout", "--end-of-options", branch], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			// execFile 默认只输出 stdout；checkout 失败时 stderr 包含真正原因。
			throw new Error(`Git checkout "${branch}" failed: ${msg}`);
		}
		return this.getBranches(cwd);
	}

	/**
	 * 基于当前分支创建新分支并切换。
	 * 使用 checkout -b 命令在当前分支基础上创建新分支。
	 */
	async createBranch(cwd: string, branchName: string): Promise<GitBranchInfo> {
		if (!branchName || branchName.startsWith("-")) throw new Error("Invalid branch name");
		await runGit(["check-ref-format", `refs/heads/${branchName}`], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
		await runGit(["checkout", "-b", branchName], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
		return this.getBranches(cwd);
	}

	/**
	 * 读取文件在 Git HEAD 中的原始内容，用于差异编辑器左侧基准列。
	 *
	 * 策略：通过 rev-parse 找到仓库根，用 node path.relative 计算 repoRoot→filePath 的相对路径，
	 * 再用 git -C repoRoot show HEAD:<relpath> 获取 HEAD 版本。
	 *
	 * 边界条件：
	 * - 文件不在任何 Git 仓库内（git 命令失败）→ 返回空字符串。
	 * - 文件是未跟踪的新增文件（HEAD 中不存在该路径）→ git show 报错，返回空字符串。
	 */
	async getOriginalContent(filePath: string, maxBytes = 5 * 1024 * 1024): Promise<string> {
		try {
			const dir = dirname(filePath);
			const { stdout: rootRaw } = await execFileAsync(
				"git",
				["rev-parse", "--show-toplevel"],
				{ cwd: dir },
			);
			const repoRoot = rootRaw.trim();
			if (!repoRoot) return "";

			// 用 path.relative 计算相对路径，node 会自动处理跨平台分隔符
			const relPath = relative(repoRoot, filePath).replace(/\\/g, "/");
			if (!relPath || relPath.startsWith("..")) return "";

			const blobRef = `HEAD:${relPath}`;
			const limit = Math.max(1, Math.floor(maxBytes));
			const { stdout } = await execFileAsync(
				"git",
				["-C", repoRoot, "show", blobRef],
				{ maxBuffer: limit + 1 },
			);
			return Buffer.byteLength(stdout, "utf8") > limit || stdout.includes("\0") ? "" : stdout;
		} catch {
			return "";
		}
	}

	private async getStatusContext(cwd: string): Promise<{
		groups: GitResourceGroups;
		repoRoot: string;
		inputProjectRoot: string;
		projectRoot: string;
	}> {
		// `-- .` 将 monorepo 中的状态限定到当前项目目录，避免 sibling 资源进入抽屉。
		const [{ stdout: statusRaw }, { stdout: rootRaw }] = await Promise.all([
			execFileAsync(
				"git", ["status", "--porcelain", "-z", "--untracked-files=all", "--", "."],
				{ cwd, maxBuffer: 16 * 1024 * 1024, timeout: GIT_MUTATION_TIMEOUT_MS },
			),
			execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: GIT_MUTATION_TIMEOUT_MS }),
		]);
		const repoRoot = await realpath(resolve(rootRaw.trim()));
		const inputProjectRoot = resolve(cwd);
		const projectRoot = await realpath(inputProjectRoot);
		const toProjectPath = (canonicalPath: string): string | null => {
			const scoped = relative(projectRoot, canonicalPath);
			if (scoped === ".." || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) return null;
			// 对外保留 ProjectStore 中的路径表示（Windows 可能是 8.3 短路径）。
			return resolve(inputProjectRoot, scoped);
		};
		const resources = parsePorcelainStatus(statusRaw).flatMap((resource) => {
			const displayPath = toProjectPath(resolve(repoRoot, resource.path));
			if (!displayPath) return [];
			const displayOldPath = resource.oldPath
				? toProjectPath(resolve(repoRoot, resource.oldPath))
				: null;
			if (resource.oldPath && !displayOldPath) return [];
			return [{
				...resource,
				path: displayPath,
				...(displayOldPath ? { oldPath: displayOldPath } : {}),
			}];
		});
		const groups: GitResourceGroups = { merge: [], index: [], workingTree: [], untracked: [] };
		for (const resource of resources) {
			if (resource.status === GitStatus.UNTRACKED) groups.untracked.push(resource);
			else if (resource.status === GitStatus.INDEX_MODIFIED || resource.status === GitStatus.INDEX_ADDED ||
				resource.status === GitStatus.INDEX_DELETED || resource.status === GitStatus.INDEX_RENAMED ||
				resource.status === GitStatus.INDEX_COPIED || resource.status === GitStatus.INDEX_TYPE_CHANGED)
				groups.index.push(resource);
			else if (resource.status === GitStatus.ADDED_BY_US || resource.status === GitStatus.ADDED_BY_THEM ||
				resource.status === GitStatus.DELETED_BY_US || resource.status === GitStatus.DELETED_BY_THEM ||
				resource.status === GitStatus.BOTH_ADDED || resource.status === GitStatus.BOTH_DELETED || resource.status === GitStatus.BOTH_MODIFIED)
				groups.merge.push(resource);
			else groups.workingTree.push(resource);
		}
		return { groups, repoRoot, inputProjectRoot, projectRoot };
	}

	/** 获取 Git 工作区状态（VS Code 风格分组）。
	 * 非 Git 仓库和 Git 未安装的错误向上抛出，让渲染层展示初始化提示或安装引导。 */
	async getStatus(cwd: string): Promise<GitResourceGroups> {
		try {
			return (await this.getStatusContext(cwd)).groups;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// 非 Git 仓库或 Git 未安装时抛出异常，让渲染层展示对应提示
			if (/not a git repository|fatal:|command not found|ENOENT|spawn.*git.*ENOENT/i.test(msg)) {
				throw err;
			}
			return { merge: [], index: [], workingTree: [], untracked: [] };
		}
	}

	/**
	 * 按 VS Code SCM 资源组语义读取单个工作区文件的两侧快照。
	 * 该方法只在点击资源行时执行，并先用最新 status 验证资源仍属于请求组；
	 * 主进程同时按编辑器文件上限拒绝大对象，避免 renderer 和 Monaco 获得超大字符串。
	 */
	async getWorkspaceFileDiff(
		cwd: string,
		group: GitResourceGroupType,
		filePath: string,
		maxBytes: number,
	): Promise<GitWorkspaceFileDiff | null> {
		try {
			if (group !== "merge" && group !== "index" && group !== "workingTree" && group !== "untracked") {
				return null;
			}
			const {
				groups,
				repoRoot,
				inputProjectRoot: inputRoot,
				projectRoot,
			} = await this.getStatusContext(cwd);
			const samePath = (left: string, right: string) => process.platform === "win32"
				? left.toLocaleLowerCase() === right.toLocaleLowerCase()
				: left === right;
			// GitPanel 的 Changes 组把 untracked 文件合并显示但统一传 workingTree 组，
			// 导致未跟踪文件在 workingTree 组里找不到而打不开；容错回查 untracked 组。
			const resource =
				groups[group].find((entry) => samePath(entry.path, resolve(filePath)))
				?? (group === "workingTree"
					? groups.untracked.find((entry) => samePath(entry.path, resolve(filePath)))
					: undefined);
			if (!resource) return null;
			// 经容错匹配到的未跟踪资源：读取语义与 untracked 组一致（左侧为空 + 只读工作区）
			const effectiveGroup =
				group === "workingTree" && resource.status === GitStatus.UNTRACKED
					? "untracked"
					: group;

			const toRepoPath = (absolutePath: string) => {
				const scoped = relative(inputRoot, resolve(absolutePath));
				if (scoped === ".." || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) {
					throw new Error("Git resource is outside the project");
				}
				const canonicalPath = resolve(projectRoot, scoped);
				const result = relative(repoRoot, canonicalPath).replace(/\\/g, "/");
				if (!result || result === ".." || result.startsWith("../") || isAbsolute(result)) {
					throw new Error("Git resource is outside the repository");
				}
				return result;
			};
			const currentPath = toRepoPath(resource.path);
			const oldPath = resource.oldPath ? toRepoPath(resource.oldPath) : currentPath;
			const limit = Math.max(1, Math.floor(maxBytes));
			const readBlob = async (blobRef: string): Promise<string | null> => {
				try {
					// maxBuffer 按字节硬限制输出；一次 git show 即可兼顾内存边界与较低进程开销。
					const { stdout } = await execFileAsync("git", ["show", blobRef], {
						cwd: repoRoot,
						maxBuffer: limit + 1,
					});
					return Buffer.byteLength(stdout, "utf8") > limit || stdout.includes("\0") ? null : stdout;
				} catch {
					return null;
				}
			};
			const readWorkingTree = async (): Promise<string | null> => {
				try {
					const pathMetadata = await lstat(resource.path);
					if (pathMetadata.isSymbolicLink()) {
						const target = await readlink(resource.path);
						return Buffer.byteLength(target, "utf8") <= limit && !target.includes("\0") ? target : null;
					}
					if (!pathMetadata.isFile()) return null;
					// 从同一个、不跟随 symlink 的文件句柄做有界读取，消除 stat/readFile 间增长或替换竞态。
					const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
					const handle = await open(resource.path, constants.O_RDONLY | noFollow);
					try {
						const metadata = await handle.stat();
						if (!metadata.isFile() || metadata.size > limit) return null;
						// 按打开后实际大小分配，仅多读 1 字节用于发现读取期间的增长。
						const capacity = Math.min(limit + 1, Math.max(1, metadata.size + 1));
						const content = Buffer.allocUnsafe(capacity);
						let total = 0;
						while (total < capacity) {
							const { bytesRead } = await handle.read(content, total, capacity - total, total);
							if (bytesRead === 0) break;
							total += bytesRead;
						}
						if (total > limit) return null;
						const bounded = content.subarray(0, total);
						return bounded.includes(0) ? null : bounded.toString("utf8");
					} finally {
						await handle.close();
					}
				} catch {
					return null;
				}
			};

			let originalContent: string | null;
			let modifiedContent: string | null;
			if (effectiveGroup === "untracked") {
				originalContent = "";
				modifiedContent = await readWorkingTree();
			} else if (effectiveGroup === "index") {
				originalContent = resource.status === GitStatus.INDEX_ADDED
					? ""
					: await readBlob(`HEAD:${oldPath}`);
				modifiedContent = resource.status === GitStatus.INDEX_DELETED
					? ""
					: await readBlob(`:${currentPath}`);
			} else if (effectiveGroup === "workingTree") {
				originalContent = await readBlob(`:${resource.oldPath ? oldPath : currentPath}`);
				modifiedContent = resource.status === GitStatus.DELETED ? "" : await readWorkingTree();
			} else {
				const missingFromHead = resource.status === GitStatus.ADDED_BY_THEM ||
					resource.status === GitStatus.DELETED_BY_US ||
					resource.status === GitStatus.BOTH_DELETED;
				originalContent = missingFromHead ? "" : await readBlob(`HEAD:${currentPath}`);
				modifiedContent = resource.status === GitStatus.BOTH_DELETED ? "" : await readWorkingTree();
			}
			if (originalContent === null || modifiedContent === null) return null;
			return { path: resource.path, originalContent, modifiedContent };
		} catch {
			return null;
		}
	}

	/**
	 * 获取当前暂存区（staged）的完整 diff 文本，用于 AI 生成提交摘要。
	 * 优先返回暂存区的 diff，无暂存文件时返回工作区 diff。
	 * @param cwd 仓库工作目录
	 * @param maxBytes 最大返回字符数（默认 100KB），超出截断。maxBuffer 固定为 10MB 确保 git 完整输出。
	 */
	async getStagedDiff(cwd: string, maxBytes = 100 * 1024): Promise<string> {
		try {
			// 先试暂存区 diff
			let { stdout } = await execFileAsync("git", ["diff", "--staged", "--unified=3"], {
				cwd,
				encoding: "utf8",
				timeout: GIT_MUTATION_TIMEOUT_MS,
				maxBuffer: 10 * 1024 * 1024,
			});
			// 无暂存内容时直接返回空，不再回退到工作区 diff；由调用方提示用户先暂存
			if (!stdout.trim()) return "";
			const truncated = stdout.length > maxBytes
				? stdout.slice(0, maxBytes) + "\n\n... (diff truncated)"
				: stdout;
			return truncated;
		} catch {
			return "";
		}
	}

	// ── 以下为 Git 增强方法（复刻 VS Code git.ts） ──────────────────────

	/**
	 * 获取提交历史列表。图谱由前端根据 parent hashes 构建连续 swimlane，
	 * 与 VS Code 的 SCM History 模型一致，不再混用 git --graph 的 ASCII 行。
	 */
	async getCommitLog(
		cwd: string,
		options?: { maxEntries?: number; ref?: string; path?: string; allBranches?: boolean },
	): Promise<CommitEntry[]> {
		// 列表只需要 subject；完整 body 仅在按需 commit detail 中读取，避免无用的大字符串传输。
		const COMMIT_FORMAT = "%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%s";
		const maxEntries = Math.min(500, Math.max(1, Math.floor(options?.maxEntries ?? 32)));
		const args = ["log", `--format=${COMMIT_FORMAT}`, "-z", "--topo-order", `-n${maxEntries}`];
		const useAll = options?.allBranches ?? true;

		if (useAll && !options?.ref) {
			// rewind checkpoint 是挂在 refs/pi-checkpoints 下的普通 commit，--all 会把它们
			// 一并拉进图，占满 maxEntries 名额、刷屏成「一堆 pi-rewind」。--exclude 需与
			// --all 配对（显式 ref 场景不涉及），故只在无 ref 的全图模式排除。
			args.push(`--exclude=${REF_BASE}/*`, "--all");
		}

		if (options?.ref) {
			const hash = await this.resolveCommitHash(cwd, options.ref);
			if (!hash) return [];
			args.push(hash);
		}

		if (options?.path) {
			args.push("--", options.path);
		}

		try {
			const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
			if (!stdout) return [];

			return parseCommits(stdout);
		} catch {
			return [];
		}
	}

	/**
	 * 获取 Git 引用（分支 / 远程分支 / Tag），按 committerdate 倒序。
	 * 复刻 VS Code 的 getRefs() + parseRefs()。
	 * rewind checkpoint refs（refs/pi-checkpoints/*）是应用内部快照数据，
	 * 不进用户可见的引用列表，先滤掉再解析。
	 */
	async getRefs(cwd: string): Promise<GitRef[]> {
		const format = "%(refname)%00%(objectname)%00%(*objectname)";
		try {
			const { stdout } = await execFileAsync(
				"git",
				["for-each-ref", `--format=${format}`, "--sort=-committerdate"],
				{ cwd, maxBuffer: 32 * 1024 * 1024 },
			);
			// for-each-ref 一行一 ref（字段间 NUL），先按行滤掉内部快照 ref 再解析，
			// 避免 refs/pi-checkpoints/* 出现在用户可见的分支/标签引用列表里。
			const rows = stdout.split(/\r?\n/).filter(
				(line) => line.trim() && !line.startsWith(`${REF_BASE}/`),
			);
			return parseRefs(rows.join("\n"));
		} catch {
			return [];
		}
	}

	/**
	 * 对比两个分支，返回变更文件列表 + ahead/behind 计数。
	 * 复刻 VS Code 的 diffBetween()——使用三点语法 ... 做 symmetric difference。
	 */
	async compareBranches(
		cwd: string,
		base: string,
		target: string,
	): Promise<BranchDiffResult> {
		try {
			const [baseHash, targetHash] = await Promise.all([
				this.resolveCommitHash(cwd, base),
				this.resolveCommitHash(cwd, target),
			]);
			if (!baseHash || !targetHash) return { files: [], ahead: 0, behind: 0 };
			const range = `${baseHash}...${targetHash}`;
			const [{ stdout: diffOut }, { stdout: countOut }] = await Promise.all([
				execFileAsync(
					"git",
					["diff", "--name-status", "-z", "--diff-filter=ADMR", range],
					{ cwd, maxBuffer: 32 * 1024 * 1024 },
				),
				execFileAsync(
					"git",
					["rev-list", "--left-right", "--count", range],
					{ cwd },
				).catch(() => ({ stdout: "0\t0" })),
			]);

			const [leftCount, rightCount] = countOut.trim().split(/	/);
			const behind = parseInt(leftCount ?? "0", 10) || 0;
			const ahead = parseInt(rightCount ?? "0", 10) || 0;

			const files = parseDiffNameStatus(diffOut);
			return { files, ahead, behind };
		} catch {
			return { files: [], ahead: 0, behind: 0 };
		}
	}

	/**
	 * 获取任意两个 ref 之间单个文件的 diff 文本。
	 * 复刻 VS Code 的 diffBetween(ref1, ref2, path)。
	 */
	async diffFileBetweenRefs(
		cwd: string,
		ref1: string,
		ref2: string,
		filePath: string,
	): Promise<string> {
		try {
			const [leftHash, rightHash] = await Promise.all([
				this.resolveCommitHash(cwd, ref1),
				this.resolveCommitHash(cwd, ref2),
			]);
			if (!leftHash || !rightHash) return "";
			const range = `${leftHash}...${rightHash}`;
			const { stdout } = await execFileAsync(
				"git",
				["diff", range, "--", filePath],
				{ cwd, maxBuffer: 32 * 1024 * 1024 },
			);
			return stdout;
		} catch {
			return "";
		}
	}

	/**
	 * 获取单个 commit 的详细信息和相对第一父提交的文件变更。
	 * Merge commit 与 VS Code SCM History 一样只比较第一父提交；根提交通过
	 * diff-tree --root 与空树比较，避免为根提交伪造不存在的 parent ref。
	 */
	async getCommitDetail(
		cwd: string,
		ref: string,
	): Promise<CommitDetail | null> {
		const COMMIT_FORMAT = "%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B";
		try {
			// Graph 已提供完整 SHA 时直接使用；其他 renderer ref 必须先安全解析，不能进入 git 选项区。
			const commitHash = /^[0-9a-f]{40}$/i.test(ref)
				? ref
				: await this.resolveCommitHash(cwd, ref);
			if (!commitHash) return null;
			const cacheKey = `${resolve(cwd)}\0${commitHash.toLowerCase()}`;
			const cached = this.readCommitDetailCache(cacheKey);
			if (cached) return cached;
			const { stdout } = await execFileAsync(
				"git",
				["show", "-s", "--shortstat", `--format=${COMMIT_FORMAT}`, "-z", commitHash, "--"],
				{ cwd, maxBuffer: 32 * 1024 * 1024 },
			);
			if (!stdout) return null;

			const commit = parseCommits(stdout, true)[0];
			if (!commit) return null;

			const diffArgs = commit.parents[0]
				? ["diff", "--name-status", "-z", "--find-renames", commit.parents[0], commit.hash]
				: ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", "--find-renames", commit.hash];
			const { stdout: filesRaw } = await execFileAsync("git", diffArgs, {
				cwd,
				maxBuffer: 32 * 1024 * 1024,
			});

			const detail = { commit, files: parseDiffNameStatus(filesRaw) };
			// LRU 准入预算同时作为 IPC 硬上限，防止异常大 message/文件清单进入 renderer。
			if (this.estimateCommitDetailBytes(detail) > this.commitDetailCacheByteLimit) return null;
			this.writeCommitDetailCache(cacheKey, detail);
			return detail;
		} catch {
			return null;
		}
	}

	/**
	 * 读取提交详情中单个文件相对第一父提交的两侧内容。
	 * 文件路径必须先命中 getCommitDetail 返回的变更列表，避免调用方读取该提交中的任意路径；
	 * 根提交使用 Git 空树作为父版本，新增和删除文件缺失的一侧自然返回空内容。
	 */
	async getCommitFileDiff(
		cwd: string,
		ref: string,
		filePath: string,
		originalPath?: string,
		maxBytes = 5 * 1024 * 1024,
	): Promise<GitCommitFileDiff | null> {
		try {
			const detail = await this.getCommitDetail(cwd, ref);
			if (!detail) return null;
			const file = detail.files.find(
				(entry) => entry.path === filePath && entry.originalPath === originalPath,
			);
			if (!file) return null;

			const parent = detail.commit.parents[0] ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
			const oldPath = file.originalPath ?? file.path;
			const limit = Math.max(1, Math.floor(maxBytes));
			const readBlob = async (blobRef: string): Promise<string | null> => {
				try {
					const { stdout } = await execFileAsync("git", ["show", blobRef], {
						cwd,
						maxBuffer: limit + 1,
					});
					return Buffer.byteLength(stdout, "utf8") > limit || stdout.includes("\0") ? null : stdout;
				} catch {
					return null;
				}
			};
			// 只有 Git 状态明确表示该侧不存在时才返回空字符串。两侧顺序读取，
			// 避免两个接近上限的 git show 缓冲区同时驻留在主进程内存中。
			const originalContent = file.status === "added" ? "" : await readBlob(`${parent}:${oldPath}`);
			if (originalContent === null) return null;
			const modifiedContent = file.status === "deleted" ? "" : await readBlob(`${detail.commit.hash}:${file.path}`);
			if (originalContent === null || modifiedContent === null) return null;
			return {
				path: file.path,
				...(file.originalPath ? { originalPath: file.originalPath } : {}),
				originalContent,
				modifiedContent,
			};
		} catch {
			return null;
		}
	}

	/**
	 * 依据最新 status 校验 renderer 请求的资源，并为 rename/copy 补齐新旧两个 pathspec。
	 * 这样既阻止项目目录外路径，也避免单路径 Unstage 留下旧路径的 staged deletion。
	 */
	private async resolveMutationPaths(
		cwd: string,
		paths: string[],
		operation: "stage" | "unstage",
	): Promise<string[]> {
		const { groups, projectRoot } = await this.getStatusContext(cwd);
		const candidates = operation === "stage"
			? [...groups.merge, ...groups.workingTree, ...groups.untracked]
			: groups.index;
		const normalizePath = (entry: string) => {
			const normalized = resolve(entry);
			// projectRoot 来自 fs/promises.realpath（异步版，Windows 上展开 8.3 短路径为长名）；
			// 同步 realpathSync 不展开（JS 实现），必须用 realpathSync.native（libuv）保持同空间，
			// 否则短路径（如 ADMINI~1）下项目内文件会被误判为 outside（stage/unstage 直接报错）。
			// 路径已不存在（stale/删除竞态）时 native 抛错，回退 resolve（短名空间）。
			const canonical = process.platform === "win32"
				? (() => {
					try {
						return realpathSync.native(normalized);
					} catch {
						return normalized;
					}
				})()
				: normalized;
			return process.platform === "win32" ? canonical.toLocaleLowerCase() : canonical;
		};
		const requested = new Set(paths.map(normalizePath));
		const matched = candidates.filter((resource) => requested.has(normalizePath(resource.path)));
		// 竞态容错：渲染层持有的 status 快照可能落后于主进程最新状态（外部工具 stage/
		// 删除/改名后未及时刷新）。未匹配路径区分两类处理：项目目录内的视为 stale——该
		// 路径当前已无对应可操作状态，静默跳过（不弹无意义的报错，用户感知为“无操作”）；
		// 项目目录外的视为安全违规，必须拒绝。边界用 projectRoot（cwd 的 realpath）判定，
		// monorepo 下 sibling 目录同样被拦截。
		const matchedPaths = new Set(matched.map((resource) => normalizePath(resource.path)));
		const normalizedRoot = process.platform === "win32"
			? projectRoot.toLocaleLowerCase()
			: projectRoot;
		// resolve 空间兜底：已被删除/不可操作的 stale 路径无法 native 展开（回退短名），
		// 用 projectRoot 的 resolve 形态判定仍在项目内 → 静默跳过，而非误报 outside。
		const resolvedRoot = process.platform === "win32"
			? resolve(projectRoot).toLocaleLowerCase()
			: resolve(projectRoot);
		const isInsideProject = (normalizedPath: string) =>
			normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`)
			|| normalizedPath === resolvedRoot || normalizedPath.startsWith(`${resolvedRoot}${sep}`);
		const outsideProject = [...requested].filter(
			(p) => !matchedPaths.has(p) && !isInsideProject(p),
		);
		if (outsideProject.length > 0) {
			throw new Error("Git resource is outside the project");
		}
		return [...new Set(matched.flatMap((resource) => {
			// 只有 unstaged rename/copy 的 Stage 和 staged rename/copy 的 Unstage 需要新旧路径；
			// 普通工作区修改（包括 staged rename 后的新路径编辑）只操作当前路径，避免不存在的 oldPath 令整条命令失败。
			const includeOldPath = operation === "unstage" ||
				resource.status === GitStatus.INTENT_TO_RENAME;
			return includeOldPath && resource.oldPath
				? [resource.path, resource.oldPath]
				: [resource.path];
		}))];
	}

	/** Stage 文件（git add） */
	async stageFiles(cwd: string, paths: string[]): Promise<void> {
		const safePaths = await this.resolveMutationPaths(cwd, paths, "stage");
		if (safePaths.length === 0) return;
		await runGit(["--literal-pathspecs", "add", "--", ...safePaths], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
	}

	/** Unstage 文件（git restore --staged） */
	async unstageFiles(cwd: string, paths: string[]): Promise<void> {
		const safePaths = await this.resolveMutationPaths(cwd, paths, "unstage");
		if (safePaths.length === 0) return;
		const head = await this.resolveCommitHash(cwd, "HEAD");
		if (head) {
			await runGit(["--literal-pathspecs", "restore", "--staged", "--", ...safePaths], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
		} else {
			// Unborn repository 没有 HEAD，restore --staged 无基线；从 index 移除但保留工作区文件。
			await runGit(["--literal-pathspecs", "rm", "--cached", "--ignore-unmatch", "--", ...safePaths], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
		}
	}

	/**
	 * 丢弃单个未暂存资源。Tracked 文件只恢复 worktree 到 index，因此 MM/AM 文件的暂存内容不会丢失；
	 * untracked 资源只允许删除 status 明确列出的单个文件或符号链接，目录必须由用户在文件管理器中处理。
	 */
	async discardFile(
		cwd: string,
		group: "workingTree" | "untracked",
		filePath: string,
	): Promise<void> {
		if (group !== "workingTree" && group !== "untracked") {
			throw new Error("Git resource group cannot be discarded");
		}
		const { groups, repoRoot } = await this.getStatusContext(cwd);
		const requestedPath = resolve(filePath);
		const samePath = (left: string, right: string) => process.platform === "win32"
			? left.toLocaleLowerCase() === right.toLocaleLowerCase()
			: left === right;
		const resource = groups[group].find((entry) => samePath(resolve(entry.path), requestedPath));
		if (!resource) throw new Error("Git resource is stale or outside the project");

		if (group === "untracked") {
			const metadata = await lstat(resource.path);
			if (!metadata.isFile() && !metadata.isSymbolicLink()) {
				throw new Error("Only individual untracked files can be discarded");
			}
			// 符号链接：unlink 只删链接自身（不跟随目标），无用户数据风险，保持轻量删除；
			// 普通文件：丢弃未跟踪 = 删除用户内容，走系统回收站（可恢复）；回收站不可用时抛错。
			if (metadata.isSymbolicLink()) {
				await unlink(resource.path);
				return;
			}
			await trashPath(resource.path, { source: "git:discard-file" });
			return;
		}

		await runGit(["--literal-pathspecs", "restore", "--worktree", "--", resource.path], { cwd: repoRoot, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
	}

	/**
	 * 批量丢弃同一目录下的未暂存资源。
	 * 先用一次状态快照校验分组和路径，再合并 tracked restore；未跟踪文件逐个进回收站，
	 * 这样既保持单文件回滚语义，也避免渲染层并发发送多个相互覆盖的 Git 操作。
	 */
	async discardFiles(cwd: string, resources: Array<{ group: "workingTree" | "untracked"; path: string }>): Promise<void> {
		if (resources.length === 0) return;
		const { groups, repoRoot } = await this.getStatusContext(cwd);
		const samePath = (left: string, right: string) => process.platform === "win32"
			? left.toLocaleLowerCase() === right.toLocaleLowerCase()
			: left === right;
		const trackedPaths: string[] = [];
		const untrackedPaths: string[] = [];
		for (const resource of resources) {
			const requestedPath = resolve(resource.path);
			const match = groups[resource.group].find((entry) => samePath(resolve(entry.path), requestedPath));
			if (!match) throw new Error("Git resource is stale or outside the project");
			if (resource.group === "untracked") {
				const metadata = await lstat(match.path);
				if (!metadata.isFile() && !metadata.isSymbolicLink()) {
					throw new Error("Only individual untracked files can be discarded");
				}
				untrackedPaths.push(match.path);
			} else {
				trackedPaths.push(match.path);
			}
		}
		if (trackedPaths.length > 0) {
			await runGit(
				["--literal-pathspecs", "restore", "--worktree", "--", ...[...new Set(trackedPaths)]],
				{ cwd: repoRoot, timeoutMs: GIT_MUTATION_TIMEOUT_MS },
			);
		}
		for (const filePath of [...new Set(untrackedPaths)]) {
			const metadata = await lstat(filePath);
			if (metadata.isSymbolicLink()) {
				await unlink(filePath);
			} else {
				await trashPath(filePath, { source: "git:discard-files" });
			}
		}
	}

	/** 创建提交 */
	async commit(cwd: string, message: string): Promise<void> {
		await runGit(["commit", "-m", message], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
	}

	/** Cherry-pick：将指定提交应用到当前分支 */
	async cherryPick(cwd: string, hash: string): Promise<void> {
		await runGit(["cherry-pick", hash], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
	}

	/** Revert：创建一个反向提交撤销指定提交的变更 */
	async revertCommit(cwd: string, hash: string): Promise<void> {
		await runGit(["revert", "--no-edit", hash], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
	}

	/**
	 * Reset：移动 HEAD 到指定提交
	 * @param mode soft｜mixed｜hard，默认 soft
	 */
	async resetToCommit(cwd: string, hash: string, mode: "soft" | "mixed" | "hard" = "soft"): Promise<void> {
		await runGit(["reset", `--${mode}`, hash], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
	}

	/**
	 * Drop：从当前分支删除指定提交（使用 rebase --onto）
	 * 注意：只能删除非 HEAD 的提交
	 */
	async dropCommit(cwd: string, hash: string): Promise<void> {
		// 先获取 parent hash
		const { stdout: parentHash } = await runGit(["rev-parse", `${hash}^`], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
		await runGit(["rebase", "--onto", parentHash.trim(), hash], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS });
	}

	/** Push：将当前分支推送到远程 */
	async push(cwd: string): Promise<void> {
		await runGit(["push"], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS * 4 });
	}

	/** Pull：从远程拉取并合并到当前分支 */
	async pull(cwd: string): Promise<void> {
		await runGit(["pull"], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS * 4 });
	}

	/** Fetch：从远程获取最新数据但不合并。
	 * 非仓库 / 未安装 git 时静默返回，避免 Git 面板挂载或手动刷新时把
	 * `fatal: not a git repository` 打进主进程 unhandledRejection。 */
	async fetch(cwd: string): Promise<void> {
		try {
			await runGit(["fetch"], { cwd, timeoutMs: GIT_MUTATION_TIMEOUT_MS * 4 });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/not a git repository|fatal:|command not found|ENOENT|spawn.*git.*ENOENT/i.test(msg)) {
				return;
			}
			throw err;
		}
	}

	/**
	 * 计算当前分支相对上游（@{upstream}）的提交差距，驱动 push/pull 角标。
	 * 无上游（未 push 过/本地分支）、非仓库或命令失败时返回 null，UI 不显示角标。
	 * 调用方应先行 fetch，使 behind 反映远程最新状态。
	 */
	async getAheadBehind(cwd: string): Promise<GitAheadBehind | null> {
		try {
			// 无上游时该命令失败（exit 128），直接视为无角标
			const { stdout: upstreamRaw } = await execFileAsync(
				"git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
				{ cwd, timeout: GIT_MUTATION_TIMEOUT_MS },
			);
			const upstream = upstreamRaw.trim();
			if (!upstream) return null;
			// --left-right --count 输出 "<left> <right>"：左=HEAD 独有（ahead），右=上游独有（behind）
			const { stdout: countRaw } = await execFileAsync(
				"git", ["rev-list", "--left-right", "--count", `HEAD...${upstream}`],
				{ cwd, timeout: GIT_MUTATION_TIMEOUT_MS },
			);
			const [left, right] = countRaw.trim().split(/\s+/);
			return {
				ahead: parseInt(left ?? "0", 10) || 0,
				behind: parseInt(right ?? "0", 10) || 0,
			};
		} catch {
			return null;
		}
	}

	/**
	 * 从磁盘删除变更文件（移入系统回收站，可恢复）。
	 * 仅允许删除 status 明确列出的单个文件/符号链接，目录必须由用户在文件管理器中处理；
	 * 删除后 tracked 文件在 status 中变为 deleted，由用户决定是否提交该删除。
	 */
	async deleteFiles(cwd: string, paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		const { groups } = await this.getStatusContext(cwd);
		const all = [...groups.merge, ...groups.index, ...groups.workingTree, ...groups.untracked];
		const normalize = (p: string) => {
			const resolved = resolve(p);
			// Windows 文件系统大小写不敏感：统一小写做键，避免大小写差异导致匹配失败
			return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
		};
		const requested = new Set(paths.map(normalize));
		// 只匹配 status 中的路径：防路径穿越与过期资源（已删除/移动的文件）；
		// 同一文件可能同时出现在 index 与 workingTree（暂存后又修改），按归一化路径去重再比对
		const matchedResources = all.filter((resource) => requested.has(normalize(resource.path)));
		const matchedPaths = new Set(matchedResources.map((resource) => normalize(resource.path)));
		if (matchedPaths.size !== requested.size) throw new Error("Git resource is stale or outside the project");
		const deleted = new Set<string>();
		for (const resource of matchedResources) {
			const key = normalize(resource.path);
			if (deleted.has(key)) continue;
			deleted.add(key);
			const metadata = await lstat(resource.path);
			if (!metadata.isFile() && !metadata.isSymbolicLink()) {
				throw new Error("Only individual files can be deleted");
			}
			// 统一走回收站：删除可恢复，避免误删用户内容（与 discard untracked 同一策略）；
			// 逐文件记录审计日志（路径 + 来源），批量误删时可按路径检索回溯。
			await trashPath(resource.path, { source: "git:delete-files" });
		}
	}
}

// ── 解析工具函数（复刻 VS Code git.ts）──────────────────────────────────

/**
 * VS Code 同款 COMMIT_FORMAT 解析正则。
 * 格式（%n 换行分隔，\0 NUL 分隔 commit）：
 *   hash\nauthorName\nauthorEmail\nauthorDate\ncommitDate\nparents\nrefNames\nmessage\0\n[shortStat]
 */
const commitRegex = /([0-9a-f]{40})\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)(?:\n([^]*?))?(?:\x00)(?:\n((?:.*)files? changed(?:.*))$)?/gm;

function parseCommits(data: string, includeFullMessage = false): CommitEntry[] {
	const commits: CommitEntry[] = [];
	let match: RegExpExecArray | null;

	do {
		match = commitRegex.exec(data);
		if (match === null) break;

		const [, hash, authorName, authorEmail, authorDate, , parentsRaw, refNamesRaw, messageRaw, shortStatRaw] = match;

		let message = messageRaw ?? "";
		if (message.endsWith("\n")) {
			message = message.slice(0, -1);
		}

		commits.push({
			hash: hash!,
			shortHash: hash!.slice(0, 7),
			message: message.split("\n")[0] ?? message,
			authorName: authorName!,
			authorEmail: authorEmail!,
			authorDate: Number(authorDate) * 1000,
			parents: parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [],
			refNames: refNamesRaw
				? refNamesRaw.split(",").map((s: string) => s.trim()).filter(Boolean)
				: [],
			graph: [],
			...(includeFullMessage ? { fullMessage: message } : {}),
			shortStat: shortStatRaw ? parseShortStat(shortStatRaw) : undefined,
		});
	} while (true);

	return commits;
}

const shortStatRegex = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;
function parseShortStat(data: string): { files: number; insertions: number; deletions: number } {
	const m = data.trim().match(shortStatRegex);
	if (!m) return { files: 0, insertions: 0, deletions: 0 };
	return {
		files: parseInt(m[1]!, 10),
		insertions: parseInt(m[2] ?? "0", 10),
		deletions: parseInt(m[3] ?? "0", 10),
	};
}

const refRegex = /^(refs\/[^\0]+)\0([0-9a-f]{40})\0([0-9a-f]{40})?$/gm;
function parseRefs(data: string): GitRef[] {
	const refs: GitRef[] = [];
	let match: RegExpExecArray | null;

	do {
		match = refRegex.exec(data);
		if (match === null) break;

		const [, fullName, hash, peeledHash] = match;
		const effectiveHash = peeledHash || hash;

		let type: GitRef["type"];
		if (fullName!.startsWith("refs/heads/")) {
			type = "head";
		} else if (fullName!.startsWith("refs/remotes/")) {
			type = "remote";
		} else if (fullName!.startsWith("refs/tags/")) {
			type = "tag";
		} else {
			continue;
		}

		refs.push({
			name: fullName!.replace(/^refs\/(heads|remotes|tags)\//, ""),
			fullName: fullName!,
			hash: effectiveHash!,
			type,
		});
	} while (true);

	return refs;
}

function parseDiffNameStatus(raw: string): GitChangedFile[] {
	const files: GitChangedFile[] = [];
	const fields = raw.split("\0");
	for (let index = 0; index < fields.length - 1; ) {
		const statusToken = fields[index++] ?? "";
		const statusChar = statusToken[0] ?? "";
		const originalOrCurrentPath = fields[index++] ?? "";
		const isRenameOrCopy = statusChar === "R" || statusChar === "C";
		const currentPath = isRenameOrCopy ? fields[index++] ?? "" : originalOrCurrentPath;
		if (!currentPath) continue;
		const status: GitFileStatus =
			statusChar === "A" ? "added"
				: statusChar === "D" ? "deleted"
					: statusChar === "R" || statusChar === "C" ? "renamed"
						: "modified";
		files.push({
			path: currentPath,
			status,
			...(status === "renamed" && originalOrCurrentPath
				? { originalPath: originalOrCurrentPath }
				: {}),
		});
	}
	return files;
}

/**
 * 解析 git status --porcelain -z 输出，映射为 VS Code Status 枚举。
 * 复刻 VS Code repository.ts Resource 类的状态分类逻辑。
 */
function parsePorcelainStatus(raw: string): GitResource[] {
	const result: GitResource[] = [];
	const fields = raw.split("\0").filter(Boolean);

	for (let index = 0; index < fields.length; ) {
		const line = fields[index++]!;
		if (line.length < 3) continue;

		const x = line[0]!; // index status
		const y = line[1]!; // working tree status
		const filePath = line.slice(3);
		// porcelain -z 的 rename/copy 顺序是“当前路径\0原路径\0”，与普通可读格式相反。
		const oldPath = x === "R" || x === "C" || y === "R" || y === "C"
			? fields[index++]
			: undefined;
		const push = (status: GitStatus, letter: string, includeOldPath = false) => {
			result.push({
				path: filePath,
				status,
				letter,
				...(includeOldPath && oldPath ? { oldPath } : {}),
			});
		};

		// 未解决冲突是一条独立资源，不能再同时拆入 index/workingTree。
		if (x === "U" && y === "U") { push(GitStatus.BOTH_MODIFIED, "!"); continue; }
		if (x === "A" && y === "A") { push(GitStatus.BOTH_ADDED, "!"); continue; }
		if (x === "D" && y === "D") { push(GitStatus.BOTH_DELETED, "!"); continue; }
		if (x === "A" && y === "U") { push(GitStatus.ADDED_BY_US, "!"); continue; }
		if (x === "U" && y === "A") { push(GitStatus.ADDED_BY_THEM, "!"); continue; }
		if (x === "D" && y === "U") { push(GitStatus.DELETED_BY_US, "!"); continue; }
		if (x === "U" && y === "D") { push(GitStatus.DELETED_BY_THEM, "!"); continue; }
		if (x === "?" && y === "?") { push(GitStatus.UNTRACKED, "U"); continue; }
		if (x === "!" && y === "!") { push(GitStatus.IGNORED, "I"); continue; }

		// X 与 Y 必须分别生成资源：同一文件可以同时含“已暂存”和“未暂存”修改。
		if (x === "M") push(GitStatus.INDEX_MODIFIED, "M");
		else if (x === "A") push(GitStatus.INDEX_ADDED, "A");
		else if (x === "D") push(GitStatus.INDEX_DELETED, "D");
		else if (x === "R") push(GitStatus.INDEX_RENAMED, "R", true);
		else if (x === "C") push(GitStatus.INDEX_COPIED, "C", true);
		else if (x === "T") push(GitStatus.INDEX_TYPE_CHANGED, "T");

		if (y === "M") push(GitStatus.MODIFIED, "M");
		else if (y === "D") push(GitStatus.DELETED, "D");
		else if (y === "R" || y === "C") push(GitStatus.INTENT_TO_RENAME, "R", true);
		else if (y === "T") push(GitStatus.TYPE_CHANGED, "T");
	}

	return result;
}
