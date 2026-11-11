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
 * 构造读取登录 shell PATH 的远端命令，按「真实世界里最可能持有用户 PATH 的 shell」排序。
 *
 * 为什么必须是多条命令（2026-10 实机教训）：nvm / conda / asdf 的初始化写在 rc 文件里，而不同
 * shell 读的是不同文件、同一个 shell 交互与非交互读的也不同——Ubuntu 的 `~/.bashrc` 开头对**非交互**
 * shell 直接 return，`/bin/sh`（dash）更是不读 `~/.bashrc`。只发 `/bin/sh -lc` 时，一台 `node -v`
 * 明明是 v24 的主机，探到的仍是系统旧 node，最终报 `REMOTE_NODE_VERSION_UNSUPPORTED`。
 *
 * 优先级按实际使用量（坏了哪一条，用户就“检测不到”）：
 * 1. **bash**——Linux 服务器默认登录 shell，也是 nvm 安装器写初始化的地方；绝大多数 SSH 目标。
 * 2. **zsh**——macOS 自 10.15 起默认登录 shell，Homebrew 的 `brew shellenv` 写在 `~/.zprofile`；
 *    Linux 开发者机器上（oh-my-zsh）也很常见。
 * 3. **sh**——通用兵底（Alpine/busybox 无 bash、或 PATH 只写在 `~/.profile`）。
 *
 * fish 不在列内：它的 `$PATH` 是 list，`printf %s "$PATH"` 会以空格而不是冒号拼接，与 POSIX 侧
 * 的解析共用不了一份命令；远端登录 shell 为 fish 的主机少见，真遇到时用户可在主机档案里手填。
 *
 * `$PATH` 由**远端**在登录 shell 下展开，因此拿到的是用户登录后真实的 PATH；命令本身不含任何用户
 * 可控文本：哨兵来自本地随机数并按 POSIX 单引号引用，其余为固定字面量。交互 shell 的 rc 里一句
 * `read` 就能把探测挂到超时，因此每条命令都把 stdin 接到 `/dev/null`。
 */
export function buildLoginShellPathCommands(sentinel: string): readonly string[] {
	if (!/^[A-Za-z0-9]{8,64}$/.test(sentinel)) throw new Error("REMOTE_NODE_SENTINEL_INVALID");
	const payload = `printf %s "${SENTINEL_PREFIX}${sentinel}"; printf %s "$PATH"; printf %s "${SENTINEL_SUFFIX}"`;
	return [
		// Linux 服务器默认壳：读 /etc/profile、~/.bash_profile|~/.profile 与 ~/.bashrc（nvm/conda 初始化在这里）。
		`/bin/bash -lic '${payload}' </dev/null`,
		// macOS 默认壳（及 Linux 上的 oh-my-zsh）：登录读 ~/.zprofile、交互读 ~/.zshrc（Homebrew shellenv 在这里）。
		`/bin/zsh -lic '${payload}' </dev/null`,
		// 兵底：没有 bash/zsh 的发行版（Alpine 等），以及 PATH 写在 ~/.profile 里的主机。
		`/bin/sh -lc '${payload}' </dev/null`,
	];
}

/**
 * 单个登录 shell PATH 探测命令（`/bin/sh -lc` 那条）。保留导出：调用方与测试按这个符号理解
 * 「一条登录 shell 探测」的语义，多方言选择由 `buildLoginShellPathCommands` 承担。
 */
export function buildLoginShellPathCommand(sentinel: string): string {
	const commands = buildLoginShellPathCommands(sentinel);
	return commands[commands.length - 1];
}

/**
 * 在 PATH 中按顺序列出工具候选的绝对路径（`<绝对目录>/<候选名>`）。
 *
 * 返回**全部**候选，由调用方决定探测到什么程度；不做文件系统访问，因此可离线单测。只有绝对目录会成为
 * 候选——这正是 `requireNodeExecutable` 在引导契约里要求的形状。
 *
 * `order` 决定名字与目录谁在外层：
 * - `dir-major`（默认）：一个目录的四个名字相邻。适合「一个目录只有一个候选名」的 node。
 * - `name-major`：先扫所有目录里的第一个候选名，再扫第二个。pi 走这条——探测次数是按**候选**计的硬上限，
 *   dir-major 会让 PATH 里第一个没有 pi 的目录（如 `/usr/local/go/bin`）就用完四个名字的名额，
 *   真正装着 pi 的 nvm 目录根本轮不到（2026-10 实机：piPath 报的正是 `/usr/local/go/bin/pi`）。
 *
 * 为什么在这里收口：node 探测与 pi 探测共用整套目录判定，两份实现迟早漂移成「同一条 PATH 两条规则」。
 */
export function listToolCandidatesFromPath(pathValue: unknown, names: readonly string[], order: "dir-major" | "name-major" = "dir-major"): string[] {
	if (typeof pathValue !== "string" || pathValue.length === 0 || pathValue.length > MAX_PATH_LENGTH) return [];
	if (!Array.isArray(names) || names.length === 0) return [];
	const seenDirs = new Set<string>();
	const dirs: string[] = [];
	for (const rawEntry of pathValue.split(":")) {
		const entry = rawEntry.trim();
		// 只接受绝对目录；相对或空条目在登录 shell 下的语义依赖 cwd，不可复现。
		if (!entry.startsWith("/") || entry.endsWith("/")) continue;
		if (entry.split("/").some((segment) => segment === "." || segment === "..")) continue;
		if (seenDirs.has(entry)) continue;
		seenDirs.add(entry);
		dirs.push(entry);
	}
	const candidates: string[] = [];
	const seen = new Set<string>();
	const push = (dir: string, name: string): void => {
		const candidate = `${dir}/${name}`;
		if (candidate.length > MAX_TOOL_CANDIDATE_LENGTH || seen.has(candidate)) return;
		seen.add(candidate);
		candidates.push(candidate);
	};
	if (order === "name-major") {
		for (const name of names) for (const dir of dirs) push(dir, name);
	} else {
		for (const dir of dirs) for (const name of names) push(dir, name);
	}
	return candidates;
}

/** 单个候选路径的长度上限（与引导契约的 `requireNodeExecutable` 同值）。 */
const MAX_TOOL_CANDIDATE_LENGTH = 4096;

/**
 * 在 PATH 中定位 node 的候选绝对路径。
 *
 * 只有形如 `<绝对目录>/node` 的条目才会成为候选——这正是 `requireNodeExecutable` 在引导契约里
 * 要求的形状。保留本导出名：调用方与测试按这个符号理解语义。
 */
export function listNodeCandidatesFromPath(pathValue: unknown): string[] {
	return listToolCandidatesFromPath(pathValue, ["node"]);
}

/**
 * 从一次登录 shell 探测的 stdout 解析出 PATH，哨兵读不出来或 PATH 为空时抛调用方指定的稳定码。
 *
 * 泛化的原因：pi 定位（`RemotePiDiscovery`）复用同一套「登录 shell 只读 PATH + 哨兵包夹 +
 * 失败关闭」范式——解析规则完全一致——但它必须以 `REMOTE_PI_` 前缀的码对外报告，否则「这台机器
 * 读不到可信 PATH」会被误报成 node 的问题。空 PATH 与哨兵缺失是两个不同的失败，故各有一个码。
 * 解析规则本身不因调用方而变：哨兵缺失/重复仍失败关闭，绝不退回非交互 PATH。
 */
export function parseLoginShellPathWithCode(stdout: unknown, sentinel: string, code: string, emptyCode: string = "REMOTE_NODE_SHELL_PATH_EMPTY"): string {
	const extracted = extractSentinelValue(stdout, sentinel);
	if (extracted === null) throw new Error(code);
	const pathValue = extracted.trim();
	if (pathValue.length === 0) throw new Error(emptyCode);
	return pathValue;
}

/**
 * 从一次登录 shell 探测的 stdout 解析出 PATH。
 * 哨兵缺失即失败关闭：拿不到可信 PATH 时绝不退回非交互 PATH（那会把旧 node 放行）。
 */
export function parseLoginShellPath(stdout: unknown, sentinel: string): string {
	return parseLoginShellPathWithCode(stdout, sentinel, "REMOTE_NODE_SHELL_PATH_UNREADABLE");
}

/** 供调用方生成一次性哨兵（本地随机，不含用户可控内容）。 */
export function createPathSentinel(randomHex: (bytes: number) => string): string {
	const value = randomHex(16);
	if (!/^[A-Za-z0-9]{8,64}$/.test(value)) throw new Error("REMOTE_NODE_SENTINEL_INVALID");
	return value;
}
