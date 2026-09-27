/**
 * 远端 node 的定位：把「登录 shell 里用户实际能用的 node」解析成一个绝对路径。
 *
 * 为什么需要这个模块（2026-09 实机教训）：
 * 远端探针原先直接跑非交互式 `command -v node`。非交互式 SSH 会话不加载用户
 * shell 初始化（nvm 就是在 `~/.bashrc` 里初始化的），因此探到的是系统那个旧
 * node——实测 `serve` 上为 `/usr/bin/node` v12.22.9，而用户登录后 nvm 提供的是
 * v24.11.0。冻结入口的第一条语句是 `require("node:fs")`，该前缀自 Node 14.18 才
 * 支持，于是旧 node 在首条语句即 MODULE_NOT_FOUND（且位于 try 之外）：stderr 有
 * 堆栈、stdout 零帧、exit 1，与「入口自身坏掉」无法区分。
 *
 * 项目的既有立场（本地已经这么做，见 `src/main/pi/PiLocator.ts:1031`）：
 * 「用户登录后能用哪个就用哪个」，**不要求用户改环境，也不改写用户系统**（曾拟
 * 用软链覆盖 `/usr/bin/node`，已否决）。本模块把同一语义搬到远端。
 *
 * 设计要点：
 * - **只读 PATH，不执行用户命令**：跑 `printf %s "$PATH"` 而不是让 shell 去
 *   `command -v node`。选择用哪个 node 由我们在本地按确定性规则做，远端 shell
 *   只负责回答「你的 PATH 是什么」。
 * - **哨兵包夹**：`~/.bashrc` 可能有 `echo`（欢迎语、conda 提示、版本提醒），这些
 *   会混进 stdout。用唯一哨兵把真正的取值夹在中间提取，噪声无论出现在前后都不会
 *   被当成答案——而 `trim()` 这类做法会把横幅和 PATH 拼在一起。
 * - **解析失败一律失败关闭**：解析不出唯一一条绝对路径就抛稳定错误码，绝不退回
 *   「猜一个」。退回非交互 PATH 等于把旧 node 重新放行。
 */

/** 哨兵：一次性随机值，避免与用户 shell 输出里的任何内容碰撞。 */
const SENTINEL_PREFIX = "PIDECK_PATH_BEGIN_";
const SENTINEL_SUFFIX = "_PIDECK_PATH_END";

/** PATH 与命令行的长度上限：超出即视为畸形，不解析。 */
const MAX_PATH_LENGTH = 32_768;

/** 从远端 stdout 中提取哨兵之间的内容。找不到、重复出现或超长都返回 null（失败关闭）。 */
export function extractSentinelValue(stdout: unknown, sentinel: string): string | null {
	if (typeof stdout !== "string" || stdout.length === 0 || stdout.length > MAX_PATH_LENGTH * 2) return null;
	const begin = `${SENTINEL_PREFIX}${sentinel}`;
	const end = `${SENTINEL_SUFFIX}`;
	const startIndex = stdout.indexOf(begin);
	if (startIndex < 0) return null;
	// 只接受唯一一次出现：重复说明输出不可信（例如被回显了两次）。
	if (stdout.indexOf(begin, startIndex + begin.length) >= 0) return null;
	const valueStart = startIndex + begin.length;
	const endIndex = stdout.indexOf(end, valueStart);
	if (endIndex < 0) return null;
	return stdout.slice(valueStart, endIndex);
}

/**
 * 构造读取登录 shell PATH 的远端命令。
 *
 * `$PATH` 由**远端**在 `-l`（登录 shell）下展开，因此拿到的是用户登录后真实的
 * PATH。命令本身不含任何用户可控文本：哨兵来自本地随机数并按 POSIX 单引号引用，
 * 其余为固定字面量。
 */
export function buildLoginShellPathCommand(sentinel: string): string {
	if (!/^[A-Za-z0-9]{8,64}$/.test(sentinel)) throw new Error("REMOTE_NODE_SENTINEL_INVALID");
	return `/bin/sh -lc 'printf %s "${SENTINEL_PREFIX}${sentinel}"; printf %s "$PATH"; printf %s "${SENTINEL_SUFFIX}"'`;
}

/**
 * 在 PATH 中定位 node 的候选绝对路径。
 *
 * 返回**全部**候选（按 PATH 顺序），由调用方决定是否需要探测版本后再选；本函数
 * 不做文件系统访问，因此可离线单测。只有形如 `<绝对目录>/node` 的条目才会成为
 * 候选——这正是 `requireNodeExecutable` 在引导契约里要求的形状。
 */
export function listNodeCandidatesFromPath(pathValue: unknown): string[] {
	if (typeof pathValue !== "string" || pathValue.length === 0 || pathValue.length > MAX_PATH_LENGTH) return [];
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const rawEntry of pathValue.split(":")) {
		const entry = rawEntry.trim();
		// 只接受绝对目录；相对或空条目在登录 shell 下的语义依赖 cwd，不可复现。
		if (!entry.startsWith("/") || entry.endsWith("/")) continue;
		if (entry.split("/").some((segment) => segment === "." || segment === "..")) continue;
		const candidate = `${entry}/node`;
		if (candidate.length > 4096 || seen.has(candidate)) continue;
		seen.add(candidate);
		candidates.push(candidate);
	}
	return candidates;
}

/**
 * 从一次登录 shell 探测的 stdout 解析出 PATH。
 * 哨兵缺失即失败关闭：拿不到可信 PATH 时绝不退回非交互 PATH（那会把旧 node 放行）。
 */
export function parseLoginShellPath(stdout: unknown, sentinel: string): string {
	const extracted = extractSentinelValue(stdout, sentinel);
	if (extracted === null) throw new Error("REMOTE_NODE_SHELL_PATH_UNREADABLE");
	const pathValue = extracted.trim();
	if (pathValue.length === 0) throw new Error("REMOTE_NODE_SHELL_PATH_EMPTY");
	return pathValue;
}

/** 供调用方生成一次性哨兵（本地随机，不含用户可控内容）。 */
export function createPathSentinel(randomHex: (bytes: number) => string): string {
	const value = randomHex(16);
	if (!/^[A-Za-z0-9]{8,64}$/.test(value)) throw new Error("REMOTE_NODE_SENTINEL_INVALID");
	return value;
}
