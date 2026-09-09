import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { trashPath } from "../fs/trash";
import { currentGitExecutable } from "./gitExecutable";
import { worktreeSlugify } from "../../shared/worktreeSlug";
import type { WorktreeEntry } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";

const execFileAsync = promisify(execFile);
type WorktreeCopy = (
	key: MainProcessTranslationKey,
	params?: Record<string, string | number>,
) => string;

/**
 * 管理 git worktree 的创建、查询、删除。
 *
 * 工作树目录创建在项目目录的同级位置（标准 git worktree 行为）：
 * {dirname(projectPath)}/{slug}，目录名与分支名一致，
 * 用户可以直接在文件管理器中找到 worktree 文件。
 */
export class WorktreeService {
	constructor(
		private readonly translate: WorktreeCopy = () => "Worktree operation failed.",
	) {}

	/**
	 * 获取指定项目仓库的所有 worktree（排除主工作区）。
	 * 使用 git worktree list --porcelain 解析。
	 *
	 * 主工作区 = git 仓库根 checkout（由 --git-common-dir 推导），而非当前 projectPath：
	 * 当 PiDeck 从某个子 worktree 打开时，projectPath 是 worktree 目录，主工作区
	 * 会作为普通条目出现在列表中；若不排除，用户误点删除会整目录 rm -rf（曾导致
	 * 主工作区 40G 数据丢失）。
	 */
	async list(projectPath: string): Promise<WorktreeEntry[]> {
		try {
			const { stdout } = await execFileAsync(
				"git",
				["worktree", "list", "--porcelain"],
				{ cwd: projectPath },
			);
			const mainWorktree = await this.getMainWorktree(projectPath);
			return this.parseWorktreeList(stdout, mainWorktree ?? projectPath);
		} catch {
			// 非 git 目录或 git 未安装
			return [];
		}
	}

	/**
	 * 基于当前 HEAD 创建新的 worktree。
	 * 使用 OpenCode 的方式：--no-checkout -b {branch} 创建分支，再 git reset --hard 填充。
	 */
	async create(
		projectPath: string,
		projectId: string,
		branchName: string,
	): Promise<{ path: string; branch: string }> {
		const baseSlug = worktreeSlugify(branchName);
		// worktree 放在项目目录的同级位置：{dirname(projectPath)}/{slug}
		// 这样用户可以在项目同级目录下直接找到 worktree 文件，符合标准 git worktree 习惯。
		const parentDir = resolve(projectPath, "..");

		const { worktreeDir, branch } = await this.allocateWorktreeTarget(projectPath, parentDir, baseSlug);

		// 创建 worktree（仅创建目录结构，不 checkout），再 reset --hard 填充内容。
		try {
			await execFileAsync(
				"git",
				["worktree", "add", "--no-checkout", "-b", branch, worktreeDir],
				{ cwd: projectPath },
			);
		} catch (error) {
			console.error("[WorktreeService] git worktree add failed", error);
			throw new Error(this.translate("mainWorktree.createFailed"));
		}

		try {
			await execFileAsync(currentGitExecutable(), ["reset", "--hard"], { cwd: worktreeDir });
		} catch (error) {
			// reset 失败时清理刚创建的 worktree，避免残留半初始化目录。
			await this.remove(worktreeDir, projectPath).catch(() => false);
			console.error("[WorktreeService] git reset failed for new worktree", error);
			throw new Error(this.translate("mainWorktree.createFailed"));
		}

		return { path: worktreeDir, branch };
	}

	/**
	 * 删除指定 worktree。
	 * 先 git worktree remove --force，再清理目录，最后删除对应的分支。
	 *
	 * 安全约束（防止误删主工作区/非 worktree 目录）：
	 * 1. 目标必须出现在 list() 中（list 已排除主工作区）；
	 * 2. 目标与仓库主工作区 realpath 相等时直接拒绝（硬性兜底，即使 list 过滤被绕过）；
	 * 3. git worktree remove 失败时：目录仍存在则拒绝物理删除——旧实现 catch 后
	 *    无条件 rm -rf，若 git 因“不能移除主工作区”等拒绝，会把主项目目录整个删掉；
	 *    目录已不存在（外部删过的残留记录）则继续清理，rm 无物理内容可删。
	 */
	async remove(worktreePath: string, projectPath: string): Promise<boolean> {
		const entries = await this.list(projectPath);
		// 统一 resolve 路径空间（与 porcelain 解析/同一台机器 8.3 短名一致）；
		// 此前 canonical（realpath 长名）与 samePath（resolve 空间）混用，
		// Windows 短路径下 entry 永远匹配不上 → 删除按钮静默失效。
		const normalizedTarget = this.canonicalSync(worktreePath);
		const entry = entries.find(asyncEntry => this.samePath(asyncEntry.path, normalizedTarget));
		if (!entry) return false;

		// 硬性防护：目标与仓库主工作区相同时拒绝删除（realpath 比较，兼容 junction/8.3 短路径）。
		const mainWorktree = await this.getMainWorktree(projectPath);
		if (mainWorktree && this.samePath(this.canonicalSync(mainWorktree), normalizedTarget)) {
			return false;
		}

		try {
			await execFileAsync(currentGitExecutable(), ["worktree", "remove", "--force", worktreePath], { cwd: projectPath });
		} catch {
			// git 拒绝移除：目录仍存在 → 拒绝物理删除（安全优先，删不掉也比删错强）；
			// 目录已不存在 → 残留记录清理场景，无需回收站（无内容可删），继续视为成功。
			if (existsSync(worktreePath)) return false;
		}

		// git 已确认移除后，把物理目录移入系统回收站（可恢复删除）。
		// 目录已被外部删除时无需回收站，直接返回成功（残留记录清理路径）。
		if (!existsSync(worktreePath)) return true;
		// 回收站不可用时 trashPath 抛错：删除失败比永久丢失安全（历史教训：误删 40G）。
		await trashPath(worktreePath, { source: "git:worktree-remove" });

		// 删除 PiDeck 创建的分支：旧版本使用 pideck/{slug}，新版本使用与目录名一致的 {slug}。
		// 对外部 worktree 尽量保守，只在“分支名等于目录名”时认为是 PiDeck 创建的同名工作区。
		const worktreeDirName = basename(worktreePath);
		if (entry.branch?.startsWith("pideck/") || entry.branch === worktreeDirName) {
			await execFileAsync(currentGitExecutable(), ["branch", "-D", entry.branch], { cwd: projectPath }).catch(() => undefined);
		}

		return true;
	}

	/**
	 * 生成目标目录名和分支名。
	 * 不再静默追加 -a/-b：用户输入 test 就只尝试创建 test，
	 * 若同级目录或分支已存在则明确报错，避免最终出现非用户预期的 test-a。
	 */
	private async allocateWorktreeTarget(projectPath: string, parentDir: string, baseSlug: string) {
		const slug = baseSlug;
		const worktreeDir = join(parentDir, slug);
		const branch = slug;
		if (existsSync(worktreeDir)) {
			throw new Error(this.translate("mainWorktree.folderExists"));
		}
		const ref = await execFileAsync(currentGitExecutable(), ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: projectPath })
			.then(() => true)
			.catch(() => false);
		if (ref) {
			throw new Error(this.translate("mainWorktree.branchExists"));
		}
		return { worktreeDir, branch };
	}


	/**
	 * 推导仓库主工作区目录（git 仓库根 checkout）。
	 * 通过 git rev-parse --git-common-dir 拿到共享 .git 目录（主仓库的 .git），
	 * 其父目录即主工作区；相对路径基于 cwd（= projectPath）解析。
	 * 非 git 目录或命令失败返回 null。
	 */
	private async getMainWorktree(projectPath: string): Promise<string | null> {
		try {
			const { stdout } = await execFileAsync(
				"git",
				["rev-parse", "--git-common-dir"],
				{ cwd: projectPath },
			);
			const commonDir = stdout.trim();
			if (!commonDir) return null;
			return dirname(resolve(projectPath, commonDir));
		} catch {
			return null;
		}
	}

	/**
	 * 解析 git worktree list --porcelain 输出。
	 * 过滤掉主工作区（rootPath，由 getMainWorktree 推导的仓库根），只返回其他 worktree。
	 */
	private parseWorktreeList(stdout: string, rootPath: string): WorktreeEntry[] {
		const entries: WorktreeEntry[] = [];
		// 规范化路径用于比较（Windows 忽略大小写）
		const normalizedRoot = this.canonicalSync(rootPath);

		const lines = stdout.split(/\r?\n/);
		let current: Partial<WorktreeEntry> | null = null;

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				// 空行 = 条目结束
				if (current) {
					const path = current.path ? resolve(current.path) : "";
					if (!this.samePath(path, normalizedRoot)) {
						entries.push({
							path,
							branch: current.branch?.replace(/^refs\/heads\//, "") ?? "detached",
						});
					}
					current = null;
				}
				continue;
			}

			if (trimmed.startsWith("worktree ")) {
				current = { path: trimmed.slice("worktree ".length).trim() };
				continue;
			}

			if (current && trimmed.startsWith("branch ")) {
				current.branch = trimmed.slice("branch ".length).trim();
			}
		}

		// 处理最后一条（文件可能不以空行结尾）
		if (current) {
			const path = current.path ? resolve(current.path) : "";
			if (!this.samePath(path, normalizedRoot)) {
				entries.push({
					path,
					branch: current.branch?.replace(/^refs\/heads\//, "") ?? "detached",
				});
			}
		}

		return entries;
	}

	private canonicalSync(input: string) {
		const normalized = resolve(input);
		return process.platform === "win32" ? normalized.toLowerCase() : normalized;
	}

	private samePath(a: string, b: string) {
		return this.canonicalSync(a) === this.canonicalSync(b);
	}
}
