/**
 * rewind checkpoint 核心（纯 git，零 pi 依赖；移植自 pi-rewind core.ts，MIT）。
 *
 * 快照模型：一次 checkpoint = 三个 git 树（HEAD 树 / index 树 / worktree 树）的
 * 引用 + 元数据 commit，存在 `refs/pi-checkpoints/<id>` 下。worktree 树用临时
 * GIT_INDEX_FILE 构建（先 read-tree HEAD 播种，再 add --all 收入未跟踪文件），
 * 因此一个 ref 就足够完整恢复「HEAD + 暂存区 + 工作区」三态。
 *
 * 为什么用 refs 而非分支：不污染用户历史/分支列表，重启不丢，且与 pi CLI
 * 场景下 pi-rewind 创建的 checkpoint 互相可读（ref 名与元数据格式完全对齐）。
 *
 * 安全恢复：分支守卫（不在创建时的分支上拒绝恢复）+ safeClean（只删「快照时
 * 不存在、现在新出现」的未跟踪文件；快照时已存在的、被忽略的、大文件/大目录
 * 全部受保护）。恢复前应先由调用方创建 before-restore 快照（redo 栈），本模块
 * 只保证「恢复本身不破坏工作区」。
 *
 * git 执行复用 src/main/git/gitProcess.ts 的 runGit（spawn + 进程树 kill + 超时
 * 兜底），比 pi-rewind 自带的字符串拼接 spawn 更安全：路径全部走数组参数，
 * 无 shell 注入面。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RewindCheckpointSummary } from "../../shared/types/rewind.ts";
import { runGit } from "../git/gitProcess.ts";
import {
	DEFAULT_MAX_CHECKPOINTS,
	MAX_UNTRACKED_DIR_FILES,
	MAX_UNTRACKED_FILE_SIZE,
	REF_BASE,
	ZEROS,
} from "./checkpointConstants.ts";
import {
	detectLargeDirs,
	isPathWithinAny,
	normalizeGitPath,
	shouldIgnoreForSnapshot,
} from "./checkpointFilter.ts";

/** 会话 ref 名里嵌入的 UUID 形态（5 段，用于 pruneOldSessions 从 ref 名解析会话 id）。 */
const SESSION_UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CheckpointData {
	/** checkpoint id（= ref 名最后一段，如 turn-<uuid>-<turn>-<ts>） */
	id: string;
	/** 所属会话 id */
	sessionId: string;
	trigger: "turn" | "tool" | "resume" | "before-restore";
	turnIndex: number;
	/** trigger === "tool" 时的工具名 */
	toolName?: string;
	/** 人类可读描述（prompt 摘要 / 工具参数摘要） */
	description?: string;
	/** 快照时刻所在 git 分支（恢复守卫用） */
	branch: string;
	/** HEAD SHA（空仓库为 ZEROS） */
	headSha: string;
	/** 真实 index 树 SHA（恢复暂存区态用） */
	indexTreeSha: string;
	/** 全量 worktree 树 SHA（index + 未跟踪；恢复工作区用） */
	worktreeTreeSha: string;
	/** 创建时刻（epoch ms） */
	timestamp: number;
	/** 快照时已存在的未跟踪文件（safeClean 保护名单） */
	preexistingUntrackedFiles?: string[];
	/** 因 >10MiB 跳过的文件（safeClean 保护名单） */
	skippedLargeFiles?: string[];
	/** 因 >=200 文件跳过的目录（safeClean 保护名单） */
	skippedLargeDirs?: string[];
}

/** git 命令小封装：跑 runGit、只回 trim 后的 stdout（错误原样抛给调用方 catch）。 */
async function gitOp(
	root: string,
	args: string[],
	env?: NodeJS.ProcessEnv,
): Promise<string> {
	const { stdout } = await runGit(args, { cwd: root, env });
	return stdout.trim();
}

// ============================================================================
// 状态快照（快照前先枚举「需要进快照的文件」）
// ============================================================================

interface StatusSnapshot {
	/** 被跟踪且需要记录的路径（含修改/删除/未暂存） */
	trackedPaths: string[];
	/** 未跟踪文件（含大文件） */
	untrackedFiles: string[];
	/** 未跟踪文件里进 index 快照的（排除大文件） */
	untrackedFilesForIndex: string[];
	/** 未跟踪目录 */
	untrackedDirs: string[];
	/** 超过 10MiB 的文件 */
	skippedLargeFiles: string[];
}

/**
 * 用 `status --porcelain=2 -z --untracked-files=all` 枚举仓库状态。
 * -z 模式下记录以 NUL 分隔、路径原样输出（不转义），所以路径里的空格安全：
 * 除重命名记录外路径都是记录最后一个字段，取「第 N 个空格之后」即可完整拿到。
 */
async function captureStatusSnapshot(root: string): Promise<StatusSnapshot> {
	const snap: StatusSnapshot = {
		trackedPaths: [],
		untrackedFiles: [],
		untrackedFilesForIndex: [],
		untrackedDirs: [],
		skippedLargeFiles: [],
	};

	const output = await gitOp(root, [
		"status",
		"--porcelain=2",
		"-z",
		"--untracked-files=all",
	]).catch(() => "");
	if (!output) return snap;

	const entries = output.split("\0").filter(Boolean);
	// 重命名记录（tag "2"）的第二段路径是独立的 NUL 记录，需在下一轮单独消费。
	let expectRename = false;

	for (const entry of entries) {
		if (expectRename) {
			const n = normalizeGitPath(entry);
			if (n) snap.trackedPaths.push(n);
			expectRename = false;
			continue;
		}

		const tag = entry[0];
		if (tag === "?" || tag === "!") {
			// 未跟踪 / 被忽略：字段是「tag + 空格 + 路径」
			const sp = entry.indexOf(" ");
			if (sp === -1) continue;
			const raw = normalizeGitPath(entry.slice(sp + 1));
			if (!raw || shouldIgnoreForSnapshot(raw)) continue;

			let st: ReturnType<typeof statSync> | null = null;
			try {
				st = statSync(join(root, raw));
			} catch {
				// 目录可能刚被外部删除，按不存在处理。
			}

			if (st?.isDirectory()) {
				snap.untrackedDirs.push(raw);
				continue;
			}

			snap.untrackedFiles.push(raw);
			const large = st?.isFile() ? st.size > MAX_UNTRACKED_FILE_SIZE : false;
			if (large) snap.skippedLargeFiles.push(raw);
			else snap.untrackedFilesForIndex.push(raw);
		} else if (tag === "1") {
			// 常规跟踪项：路径是第 8 字段（最后一个）
			const p = extractField(entry, 8);
			if (p) snap.trackedPaths.push(normalizeGitPath(p));
		} else if (tag === "2") {
			// 重命名：路径是第 9 字段，目标路径在下一记录
			const p = extractField(entry, 9);
			if (p) snap.trackedPaths.push(normalizeGitPath(p));
			expectRename = true;
		} else if (tag === "u") {
			// 冲突未合并：路径是第 10 字段（最后一个）
			const p = extractField(entry, 10);
			if (p) snap.trackedPaths.push(normalizeGitPath(p));
		}
	}
	return snap;
}

/** 取记录里第 n 个空格之后的内容（路径是最后字段，内部空格不影响）。 */
function extractField(record: string, n: number): string | null {
	let spaces = 0;
	for (let i = 0; i < record.length; i++) {
		if (record[i] === " " && ++spaces === n) {
			const p = record.slice(i + 1);
			return p.length > 0 ? p : null;
		}
	}
	return null;
}

interface FilesToAddResult {
	/** 实际进快照的路径（跟踪 + 未跟踪，已剔除大目录/忽略） */
	filtered: string[];
	/** 全部未跟踪文件（含大文件，供 preexisting 保护名单） */
	allUntracked: string[];
	skippedLargeFiles: string[];
	skippedLargeDirs: string[];
}

async function getFilesToAdd(root: string): Promise<FilesToAddResult> {
	const status = await captureStatusSnapshot(root);
	const largeDirs = detectLargeDirs(
		status.untrackedFiles,
		status.untrackedDirs,
		MAX_UNTRACKED_DIR_FILES,
	);
	const largeDirsSet = new Set(largeDirs);

	const untrackedForIndex = status.untrackedFilesForIndex.filter(
		(p) => !isPathWithinAny(p, largeDirsSet),
	);
	const skippedLargeFiles = status.skippedLargeFiles.filter(
		(p) => !isPathWithinAny(p, largeDirsSet),
	);

	const all = new Set<string>();
	status.trackedPaths.forEach((p) => all.add(p));
	untrackedForIndex.forEach((p) => all.add(p));

	return {
		filtered: [...all],
		allUntracked: status.untrackedFiles,
		skippedLargeFiles,
		skippedLargeDirs: largeDirs,
	};
}

// ============================================================================
// Checkpoint 创建 / 恢复
// ============================================================================

export interface CreateCheckpointOpts {
	root: string;
	id: string;
	sessionId: string;
	trigger: CheckpointData["trigger"];
	turnIndex: number;
	toolName?: string;
	/** 人类可读标签（用户 prompt / 工具参数摘要） */
	description?: string;
}

/**
 * 把 HEAD + index + worktree 快照成一个 git ref，返回完整元数据。
 *
 * 临时 index 说明：worktree 树要包含未跟踪文件，但不能污染用户真实 index，
 * 所以用 GIT_INDEX_FILE 指向临时文件：read-tree HEAD 播种 → add --all 收入
 * 未跟踪/修改 → write-tree。100 个一批分批 add，避免超长命令行。
 */
export async function createCheckpoint(
	opts: CreateCheckpointOpts,
): Promise<CheckpointData> {
	const { root, id, sessionId, trigger, turnIndex, toolName, description } = opts;
	const timestamp = Date.now();
	const iso = new Date(timestamp).toISOString();

	// 空仓库（无提交）时 rev-parse HEAD 失败 → ZEROS，恢复时跳过 reset。
	const headSha = await gitOp(root, ["rev-parse", "HEAD"]).catch(() => ZEROS);
	const branch = await gitOp(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(
		() => "unknown",
	);
	const indexTreeSha = await gitOp(root, ["write-tree"]);

	const tmpDir = await mkdtemp(join(tmpdir(), "pi-rewind-"));
	// Windows 上 git 环境变量里的反斜杠路径偶尔有歧义，统一转正斜杠。
	const tmpIndex = join(tmpDir, "index").replace(/\\/g, "/");
	const tmpEnv = { GIT_INDEX_FILE: tmpIndex };

	try {
		const { filtered, allUntracked, skippedLargeFiles, skippedLargeDirs } =
			await getFilesToAdd(root);

		const largeDirsSet = new Set(skippedLargeDirs);
		const largeFilesSet = new Set(skippedLargeFiles);
		// 保护名单：快照时已存在的未跟踪文件（不含忽略/大文件/大目录内），
		// 恢复时这些文件即使现在还在也不会被 clean。
		const preexistingUntrackedFiles = allUntracked.filter((f) => {
			if (shouldIgnoreForSnapshot(f)) return false;
			if (largeFilesSet.has(f)) return false;
			if (isPathWithinAny(f, largeDirsSet)) return false;
			return true;
		});

		// 用 HEAD 播种临时 index；空仓库跳过（临时 index 本来就是空的）。
		if (headSha !== ZEROS) {
			await gitOp(root, ["read-tree", headSha], tmpEnv);
		}

		// 分批 add：--all + 显式 pathspec 保证「已删除的文件也从 index 移除」。
		const BATCH = 100;
		for (let i = 0; i < filtered.length; i += BATCH) {
			const batch = filtered.slice(i, i + BATCH);
			await gitOp(root, ["add", "--all", "--", ...batch], tmpEnv);
		}

		const worktreeTreeSha = await gitOp(root, ["write-tree"], tmpEnv);

		// commit message 存全部元数据（loadCheckpointFromRef 按行正则解析）。
		// 注意：description 多行时只保留首行（与 pi-rewind 行为一致，可接受）。
		const msg = [
			`pi-rewind:${id}`,
			`sessionId ${sessionId}`,
			`trigger ${trigger}`,
			`turn ${turnIndex}`,
			toolName ? `toolName ${toolName}` : null,
			description ? `description ${description}` : null,
			`branch ${branch}`,
			`head ${headSha}`,
			`index-tree ${indexTreeSha}`,
			`worktree-tree ${worktreeTreeSha}`,
			`created ${iso}`,
			`untracked ${JSON.stringify(preexistingUntrackedFiles)}`,
			`largeFiles ${JSON.stringify(skippedLargeFiles)}`,
			`largeDirs ${JSON.stringify(skippedLargeDirs)}`,
		]
			.filter(Boolean)
			.join("\n");

		// 固定 author/committer，避免依赖本机 git 身份配置导致 commit-tree 失败。
		const commitEnv = {
			GIT_AUTHOR_NAME: "pi-rewind",
			GIT_AUTHOR_EMAIL: "rewind@pi",
			GIT_AUTHOR_DATE: iso,
			GIT_COMMITTER_NAME: "pi-rewind",
			GIT_COMMITTER_EMAIL: "rewind@pi",
			GIT_COMMITTER_DATE: iso,
		};

		// commit-tree 的 message 走 stdin（runGit 的 input 通道；不给消息且不开 stdin
		// 时 commit-tree 会挂起等输入，所以必须带 input）。
		const { stdout: commitSha } = await runGit(["commit-tree", worktreeTreeSha], {
			cwd: root,
			env: { ...tmpEnv, ...commitEnv },
			input: msg,
		});

		await gitOp(root, ["update-ref", `${REF_BASE}/${id}`, commitSha.trim()]);

		return {
			id,
			sessionId,
			trigger,
			turnIndex,
			toolName,
			description,
			branch,
			headSha,
			indexTreeSha,
			worktreeTreeSha,
			timestamp,
			preexistingUntrackedFiles,
			skippedLargeFiles:
				skippedLargeFiles.length > 0 ? skippedLargeFiles : undefined,
			skippedLargeDirs: skippedLargeDirs.length > 0 ? skippedLargeDirs : undefined,
		};
	} finally {
		await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * 恢复工作区 + index 到 checkpoint 状态。
 *
 * 安全保证：
 * 1. 分支守卫——不在创建时的分支上直接抛错，防止把别的分支工作区覆盖掉；
 * 2. reset --hard 回 HEAD（空仓库跳过）；
 * 3. read-tree --reset -u 用快照的 worktree 树铺工作区（含未跟踪文件）；
 * 4. safeClean 只删「快照时没有、现在新出现」的未跟踪文件；
 * 5. read-tree --reset 恢复暂存区态（不碰工作区文件）。
 */
export async function restoreCheckpoint(
	root: string,
	cp: CheckpointData,
): Promise<void> {
	if (cp.branch) {
		const currentBranch = await gitOp(root, [
			"rev-parse",
			"--abbrev-ref",
			"HEAD",
		]).catch(() => "unknown");
		if (currentBranch !== cp.branch) {
			throw new Error(
				`Branch mismatch: checkpoint was created on "${cp.branch}" but you are on "${currentBranch}". ` +
					`Switch to "${cp.branch}" first, or this restore could corrupt your worktree.`,
			);
		}
	}

	if (cp.headSha !== ZEROS) {
		await gitOp(root, ["reset", "--hard", cp.headSha]);
	}

	await gitOp(root, ["read-tree", "--reset", "-u", cp.worktreeTreeSha]);

	await safeClean(
		root,
		cp.preexistingUntrackedFiles || [],
		cp.skippedLargeFiles || [],
		cp.skippedLargeDirs || [],
	);

	await gitOp(root, ["read-tree", "--reset", cp.indexTreeSha]);
}

/**
 * 安全清理：删除「当前未跟踪且快照时不存在」的文件。
 * 保护名单：快照时已存在的未跟踪文件、忽略目录、跳过大文件、跳过大目录。
 * 100 个一批，单个失败忽略（clean 对已消失的文件会报错，不能因此中断整批）。
 */
async function safeClean(
	root: string,
	preexisting: string[],
	skippedFiles: string[],
	skippedDirs: string[],
): Promise<void> {
	const output = await gitOp(root, [
		"ls-files",
		"--others",
		"--exclude-standard",
	]).catch(() => "");
	if (!output) return;
	const current = output.split("\n").filter(Boolean);
	if (current.length === 0) return;

	const preSet = new Set(preexisting);
	const sfSet = new Set(skippedFiles);
	const sdSet = new Set(skippedDirs);

	const toRemove = current.filter((f) => {
		if (preSet.has(f)) return false;
		if (shouldIgnoreForSnapshot(f)) return false;
		if (sfSet.has(f)) return false;
		if (isPathWithinAny(f, sdSet)) return false;
		return true;
	});

	if (toRemove.length === 0) return;

	const BATCH = 100;
	for (let i = 0; i < toRemove.length; i += BATCH) {
		const batch = toRemove.slice(i, i + BATCH);
		await gitOp(root, ["clean", "-f", "--", ...batch]).catch(() => {});
	}
}

// ============================================================================
// 读取 / 列表 / 裁剪
// ============================================================================

/**
 * 从 commit message 解析 checkpoint 元数据（不含 id；id 由 ref 名提供）。
 * 供 loadCheckpointFromRef（单条）与 loadAllCheckpoints（批量）复用。
 */
function parseCheckpointCommit(
	msg: string,
): Omit<CheckpointData, "id"> | null {
	const get = (key: string) =>
		msg.match(new RegExp(`^${key} (.+)$`, "m"))?.[1]?.trim();

	const sid = get("sessionId");
	const turn = get("turn");
	const head = get("head");
	const idx = get("index-tree");
	const wt = get("worktree-tree");
	if (!sid || !turn || !head || !idx || !wt) return null;

	const parseJson = (key: string): string[] | undefined => {
		const raw = get(key);
		if (!raw) return undefined;
		try {
			const arr = JSON.parse(raw) as string[];
			return arr.length > 0 ? arr : undefined;
		} catch {
			return undefined;
		}
	};

	return {
		sessionId: sid,
		trigger: parseTrigger(get("trigger")),
		turnIndex: parseInt(turn, 10),
		toolName: get("toolName") || undefined,
		description: get("description") || undefined,
		branch: get("branch") || "unknown",
		headSha: head,
		indexTreeSha: idx,
		worktreeTreeSha: wt,
		timestamp: get("created") ? new Date(get("created")!).getTime() : 0,
		preexistingUntrackedFiles: parseJson("untracked"),
		skippedLargeFiles: parseJson("largeFiles"),
		skippedLargeDirs: parseJson("largeDirs"),
	};
}

/** 从 git ref 加载 checkpoint 元数据；ref 不存在或元数据不完整返回 null。 */
export async function loadCheckpointFromRef(
	root: string,
	refName: string,
): Promise<CheckpointData | null> {
	try {
		const commitSha = await gitOp(root, [
			"rev-parse",
			"--verify",
			`${REF_BASE}/${refName}`,
		]);
		const msg = await gitOp(root, ["cat-file", "commit", commitSha]);
		const parsed = parseCheckpointCommit(msg);
		return parsed ? { ...parsed, id: refName } : null;
	} catch {
		return null;
	}
}

/** 从 commit message 解析 trigger，非法值回退 "turn"（旧数据兼容，不用 as 强转）。 */
function parseTrigger(
	raw: string | undefined,
): CheckpointData["trigger"] {
	switch (raw) {
		case "tool":
		case "resume":
		case "before-restore":
			return raw;
		default:
			return "turn";
	}
}

/** 列出 REF_BASE 下全部 checkpoint ref 名（不含前缀）。 */
export async function listCheckpointRefs(root: string): Promise<string[]> {
	try {
		const prefix = `${REF_BASE}/`;
		const out = await gitOp(root, [
			"for-each-ref",
			"--format=%(refname)",
			prefix,
		]);
		return out
			.split("\n")
			.filter(Boolean)
			.map((r) => r.replace(prefix, ""));
	} catch {
		return [];
	}
}

/** 加载全部 checkpoint，可按 sessionId 过滤（用于会话列表与 prune）。 */
export async function loadAllCheckpoints(
	root: string,
	sessionId?: string,
): Promise<CheckpointData[]> {
	try {
		const prefix = `${REF_BASE}/`;
		const refOut = await gitOp(root, [
			"for-each-ref",
			"--format=%(refname)%00%(objectname)",
			prefix,
		]);
		const pairs = refOut
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const sep = line.indexOf("\0");
				return {
					ref: line.slice(0, sep).replace(prefix, ""),
					sha: line.slice(sep + 1),
				};
			});
		if (pairs.length === 0) return [];

		// 批量读 commit 内容改为一次 git cat-file --batch：SHA 经 stdin 传入，
		// 不拼命令行参数。原实现把所有 SHA 拼进 `git log --no-walk <shas>` 一次调用——
		// 多会话共享同一仓库时 refs 积累到数百/上千（本仓库实测 1500+），参数串超过
		// Windows 32767 字符上限后 Node spawn 抛 ENAMETOOLONG，整批失败被外层 catch
		// 吞成 []；而 sessionId 过滤是在全量读取之后做的，任何会话都读不到自己的
		// 检查点，表现为「检查点列表永远暂无」。stdin 无这个限制，仍保持单次进程调用
		// 与批量解析的效率。
		const { stdout: catOut } = await runGit(
			["cat-file", "--batch"],
			{ cwd: root, input: `${pairs.map((p) => p.sha).join("\n")}\n` },
		);
		const bySha = new Map<string, Omit<CheckpointData, "id">>();
		// cat-file --batch 输出记录流：`<sha> commit <size>\n<contents>\n`。
		// contents 是 commit 对象全文（tree/author/committer 头 + 空行 + message），
		// message 取首个空行之后的内容，正好还原 parseCheckpointCommit 的输入。
		let pos = 0;
		while (pos < catOut.length) {
			const nl = catOut.indexOf("\n", pos);
			if (nl < 0) break;
			const header = catOut.slice(pos, nl);
			const m = /^([0-9a-f]{40}) commit (\d+)$/.exec(header);
			if (!m) {
				// 对象被并发删除时输出 `<sha> missing`；跳过即可（宽松容忍）。
				pos = nl + 1;
				continue;
			}
			const size = Number(m[2]);
			const content = catOut.slice(nl + 1, nl + 1 + size);
			const message = content.slice(content.indexOf("\n\n") + 2);
			const parsed = parseCheckpointCommit(message);
			if (parsed) bySha.set(m[1], parsed);
			pos = nl + 1 + size + 1;
		}
		const all = pairs
			.map(({ ref, sha }) => {
				const parsed = bySha.get(sha);
				return parsed ? { ...parsed, id: ref } : null;
			})
			.filter((cp): cp is CheckpointData => cp !== null);
		return sessionId ? all.filter((cp) => cp.sessionId === sessionId) : all;
	} catch {
		return [];
	}
}

/** 删除一个 checkpoint ref（不存在时静默成功）。 */
export async function deleteCheckpoint(root: string, id: string): Promise<void> {
	await gitOp(root, ["update-ref", "-d", `${REF_BASE}/${id}`]).catch(() => {});
}

/**
 * 按时间裁剪单会话 checkpoint，最多保留 max 个。
 * before-restore 安全网永不裁剪（它是「回退前兜底」，删了就无法撤销恢复）。
 */
export async function pruneCheckpoints(
	root: string,
	sessionId: string,
	max: number = DEFAULT_MAX_CHECKPOINTS,
): Promise<number> {
	const all = await loadAllCheckpoints(root, sessionId);
	all.sort((a, b) => a.timestamp - b.timestamp);

	const prunable = all.filter((cp) => cp.trigger !== "before-restore");
	if (prunable.length <= max) return 0;

	const toDelete = prunable.slice(0, prunable.length - max);
	for (const cp of toDelete) {
		await deleteCheckpoint(root, cp.id);
	}
	return toDelete.length;
}

/**
 * 清理非当前会话的 checkpoint（每旧会话保留 keepPerOldSession 个，默认全清）。
 * 从 ref 名解析会话 id（ref 名格式 <trigger>-<sessionUuid>-<turn>-<ts>，UUID 本身
 * 含连字符，所以按「第 i 段起连续 5 段拼出合法 UUID」来定位），避免为每个 ref
 * 读 commit 元数据。
 */
export async function pruneOldSessions(
	root: string,
	currentSessionId: string,
	keepPerOldSession: number = 0,
): Promise<number> {
	const refs = await listCheckpointRefs(root);
	let deleted = 0;

	const bySession = new Map<string, string[]>();
	for (const ref of refs) {
		const parts = ref.split("-");
		let sessionId: string | null = null;
		for (let i = 0; i < parts.length - 5; i++) {
			const candidate = parts.slice(i + 1, i + 6).join("-");
			if (SESSION_UUID_RE.test(candidate)) {
				sessionId = candidate;
				break;
			}
		}
		if (!sessionId || sessionId === currentSessionId) continue;

		if (!bySession.has(sessionId)) bySession.set(sessionId, []);
		bySession.get(sessionId)!.push(ref);
	}

	for (const sessionRefs of bySession.values()) {
		// ref 名尾部含时间戳，字典序 ≈ 时间序（旧在前）。
		sessionRefs.sort();
		const toDelete =
			keepPerOldSession > 0
				? sessionRefs.slice(0, Math.max(0, sessionRefs.length - keepPerOldSession))
				: sessionRefs;
		for (const ref of toDelete) {
			await deleteCheckpoint(root, ref).catch(() => {});
			deleted++;
		}
	}

	return deleted;
}

/** 两个 checkpoint 树之间的变更摘要（diff-tree --stat）。 */
export async function diffCheckpoints(
	root: string,
	fromTree: string,
	toTree: string,
): Promise<string> {
	try {
		return await gitOp(root, [
			"diff-tree",
			"--stat",
			"--no-commit-id",
			fromTree,
			toTree,
		]);
	} catch {
		return "(diff unavailable)";
	}
}

/** 当前 index 树 SHA（只读，不落盘）；回退预览时与 checkpoint 的 worktree 树做 diff。 */
export async function currentIndexTree(root: string): Promise<string> {
	return gitOp(root, ["write-tree"]);
}

/** 完整元数据 → IPC/UI 摘要（去掉 git 内部 SHA）。 */
export function toCheckpointSummary(
	cp: CheckpointData,
): RewindCheckpointSummary {
	return {
		id: cp.id,
		sessionId: cp.sessionId,
		trigger: cp.trigger,
		turnIndex: cp.turnIndex,
		toolName: cp.toolName,
		description: cp.description,
		branch: cp.branch,
		timestamp: cp.timestamp,
		skippedLargeFiles: cp.skippedLargeFiles,
		skippedLargeDirs: cp.skippedLargeDirs,
	};
}
