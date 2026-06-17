import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, relative } from "node:path";
import type { GitBranchInfo } from "../../shared/types";

const execFileAsync = promisify(execFile);

export class GitService {
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
		// 分支切换会改变工作区状态，先只支持切换已有本地分支，避免隐式创建或修改远端跟踪关系。
		await execFileAsync("git", ["checkout", branch], { cwd });
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
			const [{ stdout: stagedRaw }, { stdout: unstagedRaw }, { stdout: untrackedRaw }] =
				await Promise.all([
					execFileAsync(
						"git",
						["diff", "--cached", "--name-status", "--diff-filter=ACDMR"],
						{ cwd },
					),
					execFileAsync(
						"git",
						["diff", "--name-status", "--diff-filter=ACDMR"],
						{ cwd },
					),
					execFileAsync(
						"git",
						["ls-files", "--others", "--exclude-standard"],
						{ cwd },
					),
				]);

			const files: { path: string; status: string }[] = [];
			const seen = new Set<string>();

			// 辅助函数：将相对路径转为绝对路径并去重
			const addFile = (relPath: string, status: string) => {
				if (!relPath || seen.has(relPath)) return;
				seen.add(relPath);
				files.push({ path: join(cwd, relPath), status });
			};

			for (const line of stagedRaw.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const [statusChar, ...pathParts] = trimmed.split(/\s+/);
				addFile(
					pathParts.join(" "),
					statusChar === "A" ? "added" : statusChar === "D" ? "deleted" : "modified",
				);
			}

			for (const line of unstagedRaw.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const [statusChar, ...pathParts] = trimmed.split(/\s+/);
				addFile(
					pathParts.join(" "),
					statusChar === "A" ? "added" : statusChar === "D" ? "deleted" : "modified",
				);
			}

			for (const line of untrackedRaw.split(/\r?\n/)) {
				addFile(line.trim(), "added");
			}

			return files;
		} catch {
			return [];
		}
	}
}
