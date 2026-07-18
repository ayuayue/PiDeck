import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitBranchInfo, CommitEntry, GitRef, BranchDiffResult, GitFileStatus } from "../../shared/types";
import { GitStatus } from "../../shared/types";
import type { GitResource, GitResourceGroups } from "../../shared/types";

const execFileAsync = promisify(execFile);

export class GitService {
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
			// 获取当前分支和所有本地分支（不包含远程分支）
			const [{ stdout: currentRaw }, { stdout: localRaw }] = await Promise.all([
				execFileAsync("git", ["branch", "--show-current"], { cwd }),
				execFileAsync("git", ["branch", "--format=%(refname:short)"], { cwd }),
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
			await execFileAsync("git", ["checkout", branch], { cwd });
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
		await execFileAsync("git", ["checkout", "-b", branchName], { cwd });
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
	async getOriginalContent(filePath: string): Promise<string> {
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

			const { stdout } = await execFileAsync(
				"git",
				["-C", repoRoot, "show", `HEAD:${relPath}`],
				{ maxBuffer: 32 * 1024 * 1024 },
			);
			return stdout;
		} catch {
			return "";
		}
	}

	/**
	 * 获取工作区中相对于 HEAD 被修改的文件列表（包括已暂存和未暂存的修改，
	 * 以及未跟踪的新增文件）。前端根据此列表展示 Git 工作区变动概览。
	 * 返回 { path, status } 数组，status 值为 "modified" | "added" | "deleted" | "renamed"。
	 */
	async getChangedFiles(
		cwd: string,
	): Promise<{ path: string; status: string }[]> {
		try {
			const { stdout: repoRootRaw } = await execFileAsync(
				"git",
				["rev-parse", "--show-toplevel"],
				{ cwd },
			);
			const repoRoot = resolve(repoRootRaw.trim());
			const projectRoot = resolve(cwd);
			const [{ stdout: stagedRaw }, { stdout: unstagedRaw }, { stdout: untrackedRaw }] =
				await Promise.all([
					execFileAsync(
						"git",
						["diff", "--cached", "--name-status", "-z", "--diff-filter=ACDMR"],
						{ cwd: repoRoot },
					),
					execFileAsync(
						"git",
						["diff", "--name-status", "-z", "--diff-filter=ACDMR"],
						{ cwd: repoRoot },
					),
					execFileAsync(
						"git",
						["ls-files", "--others", "--exclude-standard", "-z"],
						{ cwd: repoRoot },
					),
				]);

			const files: { path: string; status: string }[] = [];
			const seen = new Set<string>();

			// Git 始终返回仓库根相对路径；嵌套项目只展示自己目录内的变更。
			const addFile = (repoRelativePath: string, status: string) => {
				if (!repoRelativePath) return;
				const absolutePath = resolve(repoRoot, repoRelativePath);
				const projectRelativePath = relative(projectRoot, absolutePath);
				if (
					projectRelativePath === ".." ||
					projectRelativePath.startsWith(`..${sep}`) ||
					isAbsolute(projectRelativePath) ||
					seen.has(absolutePath)
				) return;
				seen.add(absolutePath);
				files.push({ path: absolutePath, status });
			};

			// `-z` 让 Git 用 NUL 分隔状态和路径，避免空格、引号或非 ASCII 文件名被拆坏。
			// rename/copy 会额外返回旧路径；文件树徽标应绑定到当前存在的新路径。
			const addDiffEntries = (raw: string) => {
				const fields = raw.split("\0");
				for (let index = 0; index < fields.length - 1; ) {
					const statusToken = fields[index++];
					const statusChar = statusToken[0];
					const oldOrCurrentPath = fields[index++];
					const isRenameOrCopy = statusChar === "R" || statusChar === "C";
					const currentPath = isRenameOrCopy ? fields[index++] : oldOrCurrentPath;
					const status =
						statusChar === "A" ? "added"
							: statusChar === "D" ? "deleted"
								: statusChar === "R" ? "renamed"
									: "modified";
					addFile(currentPath, status);
				}
			};

			addDiffEntries(stagedRaw);
			addDiffEntries(unstagedRaw);

			for (const path of untrackedRaw.split("\0")) {
				addFile(path, "added");
			}

			return files;
		} catch {
			return [];
		}
	}

	/**
	 * 获取 Git 工作区状态（VS Code 风格分组）。
	 * 返回 merge/index/workingTree/untracked 四组资源。
	 * 复刻 VS Code repository.ts 的 status() + Resource groups。
	 */
	async getStatus(cwd: string): Promise<GitResourceGroups> {
		try {
			const { stdout: statusRaw } = await execFileAsync(
				"git", ["status", "--porcelain", "-z"], { cwd, maxBuffer: 16 * 1024 * 1024 },
			);
			const resources = parsePorcelainStatus(statusRaw);
			const groups: GitResourceGroups = {
				merge: [], index: [], workingTree: [], untracked: [],
			};
			for (const r of resources) {
				if (r.status === GitStatus.UNTRACKED) groups.untracked.push(r);
				else if (r.status === GitStatus.INDEX_MODIFIED || r.status === GitStatus.INDEX_ADDED ||
					r.status === GitStatus.INDEX_DELETED || r.status === GitStatus.INDEX_RENAMED)
					groups.index.push(r);
				else if (r.status === GitStatus.ADDED_BY_US || r.status === GitStatus.ADDED_BY_THEM ||
					r.status === GitStatus.DELETED_BY_US || r.status === GitStatus.DELETED_BY_THEM ||
					r.status === GitStatus.BOTH_ADDED || r.status === GitStatus.BOTH_DELETED || r.status === GitStatus.BOTH_MODIFIED)
					groups.merge.push(r);
				else groups.workingTree.push(r);
			}
			return groups;
		} catch {
			return { merge: [], index: [], workingTree: [], untracked: [] };
		}
	}

	// ── 以下为 Git 增强方法（复刻 VS Code git.ts） ──────────────────────

	/**
	 * 获取提交历史列表，复刻 VS Code 的 log() 方法。
	 * 同时获取 git log --graph 的 ASCII 图谱行，前端用等宽字体渲染即得分支图。
	 *
	 * @param allBranches 默认 true；设为 false 时只看当前分支线性历史
	 */
	async getCommitLog(
		cwd: string,
		options?: { maxEntries?: number; ref?: string; path?: string; allBranches?: boolean },
	): Promise<CommitEntry[]> {
		const COMMIT_FORMAT = "%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B";
		const args = ["log", `--format=${COMMIT_FORMAT}`, "-z"];
		const useAll = options?.allBranches ?? true;

		if (useAll && !options?.ref) {
			args.push("--all");
		}

		if (options?.ref) {
			args.push(options.ref);
		} else {
			args.push(`-n${options?.maxEntries ?? 32}`);
		}

		if (options?.path) {
			args.push("--", options.path);
		}

		try {
			const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
			if (!stdout) return [];

			const commits = parseCommits(stdout);

			// 单独获取 ASCII graph
			const graphArgs = ["log", "--graph", "--color=never", `--format=%h %d %s`];
			if (useAll && !options?.ref) graphArgs.push("--all");
			if (options?.ref) {
				graphArgs.push(options.ref);
			} else {
				graphArgs.push(`-n${options?.maxEntries ?? 32}`);
			}
			const { stdout: graphOut } = await execFileAsync("git", graphArgs,
				{ cwd, maxBuffer: 32 * 1024 * 1024 });

			return mergeGraphLines(commits, graphOut);
		} catch {
			return [];
		}
	}

	/**
	 * 获取 Git 引用（分支 / 远程分支 / Tag），按 committerdate 倒序。
	 * 复刻 VS Code 的 getRefs() + parseRefs()。
	 */
	async getRefs(cwd: string): Promise<GitRef[]> {
		const format = "%(refname)%00%(objectname)%00%(*objectname)";
		try {
			const { stdout } = await execFileAsync(
				"git",
				["for-each-ref", `--format=${format}`, "--sort=-committerdate"],
				{ cwd, maxBuffer: 32 * 1024 * 1024 },
			);
			return parseRefs(stdout);
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
		const range = `${base}...${target}`;
		try {
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
		const range = `${ref1}...${ref2}`;
		try {
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
	 * 获取单个 commit 的详细信息（含 shortStat 统计）。
	 * 复刻 VS Code 的 getCommit()——git show -s --shortstat。
	 */
	async getCommitDetail(
		cwd: string,
		ref: string,
	): Promise<CommitEntry | null> {
		const COMMIT_FORMAT = "%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B";
		try {
			const { stdout } = await execFileAsync(
				"git",
				["show", "-s", "--shortstat", `--format=${COMMIT_FORMAT}`, "-z", ref, "--"],
				{ cwd, maxBuffer: 32 * 1024 * 1024 },
			);
			if (!stdout) return null;
			const commits = parseCommits(stdout);
			return commits[0] ?? null;
		} catch {
			return null;
		}
	}

	/** Stage 文件（git add） */
	async stageFiles(cwd: string, paths: string[]): Promise<void> {
		await execFileAsync("git", ["add", "--", ...paths], { cwd });
	}

	/** Unstage 文件（git restore --staged） */
	async unstageFiles(cwd: string, paths: string[]): Promise<void> {
		await execFileAsync("git", ["restore", "--staged", "--", ...paths], { cwd });
	}

	/** 创建提交 */
	async commit(cwd: string, message: string): Promise<void> {
		await execFileAsync("git", ["commit", "-m", message], { cwd });
	}
}

// ── 解析工具函数（复刻 VS Code git.ts）──────────────────────────────────

/**
 * VS Code 同款 COMMIT_FORMAT 解析正则。
 * 格式（%n 换行分隔，\0 NUL 分隔 commit）：
 *   hash\nauthorName\nauthorEmail\nauthorDate\ncommitDate\nparents\nrefNames\nmessage\0\n[shortStat]
 */
const commitRegex = /([0-9a-f]{40})\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)(?:\n([^]*?))?(?:\x00)(?:\n((?:.*)files? changed(?:.*))$)?/gm;

function parseCommits(data: string): CommitEntry[] {
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

function parseDiffNameStatus(raw: string): { path: string; status: GitFileStatus }[] {
	const files: { path: string; status: GitFileStatus }[] = [];
	const fields = raw.split("\0");
	for (let i = 0; i < fields.length - 1; ) {
		const statusToken = fields[i++]!;
		const statusChar = statusToken[0]!;
		let currentPath = fields[i++]!;
		if (statusChar === "R" || statusChar === "C") {
			currentPath = fields[i++]!;
		}
		if (!currentPath) continue;
		const status: GitFileStatus =
			statusChar === "A" ? "added"
			: statusChar === "D" ? "deleted"
			: statusChar === "R" ? "renamed"
			: "modified";
		files.push({ path: currentPath, status });
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

	for (let i = 0; i < fields.length; ) {
		const line = fields[i++]!;
		if (line.length < 3) continue;

		const x = line[0]!; // index status
		const y = line[1]!; // working tree status
		let filePath = line.slice(3);
		let oldPath: string | undefined;

		// Rename: next field is the new path
		if (x === "R" || x === "C") {
			oldPath = filePath;
			filePath = fields[i++] ?? filePath;
		}

		let status: number;
		let letter: string;

		// Merge conflicts
		if (x === "U" && y === "U") { status = GitStatus.BOTH_MODIFIED; letter = "!"; }
		else if (x === "A" && y === "A") { status = GitStatus.BOTH_ADDED; letter = "!"; }
		else if (x === "D" && y === "D") { status = GitStatus.BOTH_DELETED; letter = "!"; }
		else if (x === "A" && y === "U") { status = GitStatus.ADDED_BY_US; letter = "!"; }
		else if (x === "U" && y === "A") { status = GitStatus.ADDED_BY_THEM; letter = "!"; }
		else if (x === "D" && y === "U") { status = GitStatus.DELETED_BY_US; letter = "!"; }
		else if (x === "U" && y === "D") { status = GitStatus.DELETED_BY_THEM; letter = "!"; }
		// Index changes
		else if (x === "M") { status = GitStatus.INDEX_MODIFIED; letter = "M"; }
		else if (x === "A") { status = GitStatus.INDEX_ADDED; letter = "A"; }
		else if (x === "D") { status = GitStatus.INDEX_DELETED; letter = "D"; }
		else if (x === "R") { status = GitStatus.INDEX_RENAMED; letter = "R"; }
		else if (x === "C") { status = GitStatus.INDEX_COPIED; letter = "C"; }
		else if (x === "T") { status = GitStatus.TYPE_CHANGED; letter = "T"; }
		// Working tree changes
		else if (y === "M") { status = GitStatus.MODIFIED; letter = "M"; }
		else if (y === "D") { status = GitStatus.DELETED; letter = "D"; }
		// Untracked / Ignored
		else if (x === "?" && y === "?") { status = GitStatus.UNTRACKED; letter = "U"; }
		else if (x === "!" && y === "!") { status = GitStatus.IGNORED; letter = "I"; }
		// Type changed
		else if (y === "T") { status = GitStatus.TYPE_CHANGED; letter = "T"; }
		else { status = GitStatus.MODIFIED; letter = "M"; } // fallback

		result.push({ path: filePath, status: status as import("../../shared/types").GitStatus, letter, oldPath });
	}

	return result;
}

/** 匹配 git log --graph 输出中的 commit 节点行（以 `*` 开头，前面只有图谱字符） */
const graphCommitNodeRe = /^[|\\/\s]*\*/;

/**
 * 将 git log --graph 的 ASCII 输出合并到 commit 记录中。
 */
function mergeGraphLines(commits: CommitEntry[], graphOutput: string): CommitEntry[] {
	if (!graphOutput.trim()) return commits;
	const graphLines = graphOutput.split(/\r?\n/).filter(Boolean);

	const commitGraphIndices: number[] = [];
	for (let i = 0; i < graphLines.length; i++) {
		if (graphCommitNodeRe.test(graphLines[i]!)) {
			commitGraphIndices.push(i);
		}
	}

	if (commitGraphIndices.length !== commits.length) {
		return commits;
	}

	for (let i = 0; i < commits.length; i++) {
		const commitIdx = commitGraphIndices[i]!;
		const startIdx = i > 0 ? commitGraphIndices[i - 1]! + 1 : 0;
		commits[i] = {
			...commits[i]!,
			graph: graphLines.slice(startIdx, commitIdx + 1),
		};
	}

	return commits;
}
