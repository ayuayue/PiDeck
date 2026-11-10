/**
 * 远端 pi 的定位与版本兼容矩阵（`docs/archive/remote/remote-phase4-plan.md` §7 P4.1，只读探测）。
 *
 * 为什么需要这个模块：Phase 4 的远端会话必须由**用户自己装的那个 pi** 来跑（计划的核心边界
 * ——pi 负责 Agent 行为，PiDeck 不复刻）。而远端 pi 只存在于用户的登录 shell 里：真机 `serve`
 * 实测非交互式 `command -v pi` 完全没有命中，登录后才是
 * `~/.nvm/versions/node/v24.11.0/bin/pi`（→ `dist/bundle/cli.js`）。所以定位方式必须与
 * `RemoteNodeDiscovery` 完全同源：**只读登录 shell 的 PATH，自己按确定性规则挑候选**，绝不
 * 让远端 shell 去 `command -v pi`，也绝不退回非交互 PATH（那正是「探不到 pi」的那条路）。
 *
 * 四件事在这里被冻结，改动它们等于改协议面：
 * 1. **候选名与本地 PiLocator 同源**（`PI_CANDIDATE_NAMES`）：远端与本地必须认同一批安装形态，
 *    否则「本机好用、远端说找不到」。
 * 2. **版本比较只在数值层做**（`comparePiVersions` / `classifyRemotePiVersion`）：字符串比较会把
 *    `0.9.0` 判成比 `0.85.1` 新，这正是计划 §6.2 里点名的坑。下限按完整 semver（补丁版也是
 *    真语义变更），上限只按 `major.minor`——协议面按次版本演进，`0.85.999` 与 `0.85.1` 同窗口。
 * 3. **超上限不 fail-closed**：远端 pi 是用户自己的软件，装得比本机还新是最常见情况。高于核验
 *    窗口只回一个 warning（`REMOTE_PI_VERSION_UNVERIFIED`），低于下限才拒绝并给升级指引。
 * 4. **版本命令必须用已解析的 node 当解释器**（`buildRemotePiVersionCommand(piPath, nodePath)`）：
 *    nvm 装出来的 `pi` 是 `#!/usr/bin/env node` shim（`serve` 上是指向 `dist/bundle/cli.js` 的符号链），
 *    而非交互式 SSH 会话的 PATH 里只有系统 node（`serve` = `/usr/bin/node` v12.22.9）⇒ 裸执行
 *    `'<pi>' '--version'` 在 pi bundle 的第一条语句就 `SyntaxError: Unexpected token '?'`、stdout 空、
 *    exit 1，探测只能报 `REMOTE_PI_VERSION_UNREADABLE`（2026-09 真机复现，见下面三条实测）。
 *    改走登录 shell（`/bin/sh -lc '<pi> --version'`）也能拿到 `0.85.1`，但 `~/.bashrc` 的横幅会混进
 *    stdout，而版本解析是 `^` 锚定的 ⇒ 同样退化成 unreadable。用已解析的 node 当解释器两者都避开。
 *    **P4.2 的远端启动必须复用同一形态**（`'<node>' '<pi>' --mode rpc …`）：同一条 shim 会在启动时
 *    死在同一个地方，而那时没有「再换一个候选」可言。
 *
 * 真机实测（`serve`，产品自己的客户端 + 已 pin 路由，全程只读）：
 * - `'/home/…/.nvm/…/bin/pi' '--version'` → exit 1 / stdout "" / stderr 首行
 *   `file:///home/…/pi-coding-agent/dist/bundle/chunks/…`（Node 12 的 SyntaxError）
 * - `/bin/sh -lc '/home/…/bin/pi --version'` → exit 0 / `0.85.1`
 * - `'/home/…/v24.11.0/bin/node' '/home/…/v24.11.0/bin/pi' '--version'` → exit 0 / `0.85.1`
 */

import { quotePosixArgument } from "./RemoteBootstrapContract";
import { REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH } from "./RemoteHelperContract";
import { buildLoginShellPathCommands, listToolCandidatesFromPath, parseLoginShellPathWithCode } from "./RemoteNodeDiscovery";
import type { SshClientRuntime, SshCommandResult } from "./SshClientRuntime";
import { buildPinnedSshInvocation } from "./SshVerifiedConnection";

/** 结构化版本：比较只看这三个数值，原始字符串仅用于展示与诊断。 */
export type PiVersion = { major: number; minor: number; patch: number };

/**
 * POSIX 侧的候选可执行名，与本地 `PiLocator.getCandidates()`
 * （`src/main/pi/PiLocator.ts:1008`）逐字同源：`pi` 是 npm/官方 shim，`pi.js` / `pi.mjs` /
 * `pi.cjs` 覆盖「用户直接 `node /path/pi.js` 跑 JS 源文件」的安装形态（#169）。顺序即优先级，
 * 存在标准 shim 时不会被同名 JS 误拦。
 */
export const PI_CANDIDATE_NAMES = ["pi", "pi.js", "pi.mjs", "pi.cjs"] as const;

/**
 * 最多探测几个候选。与 `RemoteBootstrapSession` 的 `MAX_NODE_CANDIDATES` 同量级、同理：
 * PATH 里可能并排多个 pi 安装，每次探测都是一次真实往返，不设上限就等于让一条 PATH 决定
 * 我们要发多少条远端命令。上限是按**候选**计的硬约束，所以候选按 name-major 排序（见
 * `listPiCandidatesFromPath`）：一个目录优先只贡献一个候选，前三个候选就是前三个 PATH 目录里的
 * 标准 `pi` shim，正是用户交互时会跑的那个。
 */
export const MAX_PI_CANDIDATES = 3;

/** 兼容窗口下限：低于此版本的远端 pi 只给升级指引，不做降级兼容（计划 D4）。 */
export const REMOTE_PI_MIN_SUPPORTED: PiVersion = { major: 0, minor: 85, patch: 0 };

/**
 * 已核验窗口的上限，用 `major.minor` 表达：`patch = 999` 只是把「0.85 整个次版本都核验过」
 * 写全，比较时不看 patch（见 `classifyRemotePiVersion`）。
 */
export const REMOTE_PI_VERIFIED_CEILING: PiVersion = { major: 0, minor: 85, patch: 999 };

/** 高于已核验窗口时的观察值标记：放行，但让调用方知道这不是核验过的组合。 */
export const REMOTE_PI_VERSION_UNVERIFIED = "REMOTE_PI_VERSION_UNVERIFIED";

/**
 * 稳定失败码（消息即码本身，细节挂在 error 属性上）。导出为契约：调用方（P4.2 的启动准备、
 * UI 文案映射）按常量分支，而不是匹配自由文本；本模块对外只报 `REMOTE_PI_` 前缀的码。
 */
export const REMOTE_PI_PATH_INVALID = "REMOTE_PI_PATH_INVALID";
export const REMOTE_PI_NODE_PATH_INVALID = "REMOTE_PI_NODE_PATH_INVALID";
export const REMOTE_PI_SHELL_PATH_UNREADABLE = "REMOTE_PI_SHELL_PATH_UNREADABLE";
export const REMOTE_PI_NOT_FOUND = "REMOTE_PI_NOT_FOUND";
export const REMOTE_PI_TOO_OLD = "REMOTE_PI_TOO_OLD";
export const REMOTE_PI_VERSION_UNREADABLE = "REMOTE_PI_VERSION_UNREADABLE";

/** 本模块对外的码表（与 `REMOTE_HOST_REFERENCE_WRITE_CODES` 同形，便于契约测试与 UI 映射遍历）。 */
export const REMOTE_PI_DISCOVERY_CODES = [REMOTE_PI_PATH_INVALID, REMOTE_PI_NODE_PATH_INVALID, REMOTE_PI_SHELL_PATH_UNREADABLE, REMOTE_PI_NOT_FOUND, REMOTE_PI_TOO_OLD, REMOTE_PI_VERSION_UNREADABLE, REMOTE_PI_VERSION_UNVERIFIED] as const;

/** 单个候选绝对路径的长度上限（与引导契约的 `requireNodeExecutable` 同值）。 */
const MAX_PI_PATH_LENGTH = 4096;
/** 版本输出长度上限：真实输出只有 6~8 字节，更长的输出不是版本号，直接判不解析。 */
const MAX_VERSION_OUTPUT_LENGTH = 64;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
/**
 * `pi --version` 的接受形态：裸 `0.85.1` 或带 `v` 前缀，允许尾随空白（`printf`/换行都会带）。
 * 刻意**不允许前缀文本与前后行**：带横幅的输出说明它不是版本号本身，而 `^` 锚定与相邻 gate
 * （`assertSupportedRemoteNodeVersion`）同一立场——宁可重探下一个候选，也不去猜一行里的数字。
 */
const PI_VERSION_OUTPUT = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)[ \t\r\n]*$/;

/** 探测结果：命中哪个 pi、它自称的版本、花了多少次探测，以及可选的非致命标记。 */
export type RemotePiObservation = { piPath: string; version: string; versionParsed: PiVersion; probed: number; warning?: typeof REMOTE_PI_VERSION_UNVERIFIED };

/** 稳定码错误的细节载体：消息必须保持是裸码，路径/版本/探测次数只能挂在这里。 */
type RemotePiError = Error & { piPath?: string; observedVersion?: string; probed?: number };

function fail(code: string): never {
	throw new Error(code);
}

/**
 * 在登录 shell 的 PATH 中列出 pi 候选绝对路径。
 *
 * 目录判定收口在 `listToolCandidatesFromPath`（node 探测同一份）：只取 `<绝对目录>/<候选名>`、丢弃
 * 相对/空条目与含 `.`/`..` 的目录、去重、有长度上限。本函数不做文件系统访问，所以能离线单测。
 *
 * 排序是 **name-major**（所有目录的 `pi` 先扫完，再轮到 `pi.js`），因为探测上限按**候选**计：
 * dir-major 会让 PATH 第一个没有 pi 的目录（真机上是 `/usr/local/go/bin`）用完四个名额，
 * 真正装着 pi 的 nvm 目录轮不到（2026-10 实机：`REMOTE_PI_VERSION_UNREADABLE` 且 piPath 报的是
 * `/usr/local/go/bin/pi`）。name-major 下前三个候选就是「前三个 PATH 目录里的标准 `pi` shim」，
 * 也就是用户交互时真正会跑的那个。
 */
export function listPiCandidatesFromPath(pathValue: unknown): string[] {
	return listToolCandidatesFromPath(pathValue, PI_CANDIDATE_NAMES, "name-major");
}

/**
 * 路径的公共形状：绝对、有界、无控制字符、不以 `/` 结尾、不含空/`.`/`..` 段。
 *
 * 与引导契约的 `requireNodeExecutable` 同一立场：远端命令模板里只允许出现形状已核验的绝对路径，
 * shell、项目文件、PATH 查找都没有槽位可以挤进来。空格、引号这类怪字符交给 POSIX 引用处理，而不是
 * 靠放宽这道门。`code` 由调用方给：解释器与 pi 两个位置有不同的对外失败码。
 */
function requireAbsoluteToolPath(value: unknown, code: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_PI_PATH_LENGTH) fail(code);
	if (!value.startsWith("/") || CONTROL_CHARS.test(value) || value.endsWith("/")) fail(code);
	const segments = value.slice(1).split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) fail(code);
	return value;
}

/**
 * 校验远端 pi 路径的形状（绝对、有界、无控制字符、无 `.`/`..`/空段）。
 *
 * 候选名（`pi`/`pi.js`/`pi.mjs`/`pi.cjs`）只约束**按 PATH 自动发现**的候选（`listPiCandidatesFromPath`
 * 仍按 `PI_CANDIDATE_NAMES` 过滤）；这里刻意不要求末段是候选名：用户可以在主机档案里手填
 * 一个自定义文件名或包装脚本，那条路径不是从 PATH 猜出来的，而是用户自己的选择。命令执行面仍只有
 * `--version` 与启动，且路径形状在命令构造前就被核验。
 */
function requirePiExecutable(value: unknown): string {
	return requireAbsoluteToolPath(value, REMOTE_PI_PATH_INVALID);
}

/**
 * 手填 pi 路径的对外校验入口（IPC 边界与探测共用同一份判据）。非法时抛 `REMOTE_PI_PATH_INVALID`。
 *
 * 除路径形状之外还限制字符集（`[A-Za-z0-9._/-]`）：手填值会被**持久化**到主机档案，而档案 codec
 * 对 `remotePiCommand` 用的是同一套 token 规则。放宽这里等于写出一份「本机能存、下次读不出来」
 * 的档案（codec 在读取时校验整份快照，一条非法路径会让整个主机库不可读）。
 */
export function normalizeRemotePiPath(value: unknown): string {
	const path = requireAbsoluteToolPath(value, REMOTE_PI_PATH_INVALID);
	if (!/^\/[A-Za-z0-9._/-]+$/.test(path)) fail(REMOTE_PI_PATH_INVALID);
	return path;
}

/**
 * 校验「用来解释 pi 的 node」路径的形状。
 *
 * 这里只要求它是一条可引用的绝对路径，**不**重复 node 侧的门（版本、以 `node` 结尾）：解释器是谁由
 * 调用方先用 `resolveRemoteNodeExecutable` 解析（登录 shell PATH + ≥22.3 版本门），本模块不把那份
 * 判断再写一遍——两份判断迟早漂移成「探测用这个 node、启动用那个 node」。
 *
 * `code` 由调用方给：探测入口在发任何帧之前拒掉它（`REMOTE_PI_NODE_PATH_INVALID`），命令构造则与
 * 它的 pi 路径参数共用 `REMOTE_PI_PATH_INVALID`。
 */
function requireNodeInterpreter(value: unknown, code: string): string {
	return requireAbsoluteToolPath(value, code);
}

/**
 * 远端模型目录探测的 argv 形态。
 *
 * 与本机 `MODEL_LIST_FAST_ARGS` 同源：offline 跳过网络目录刷新，no-extensions/skills/themes 跳过发现加载。
 * 远端跑这两个的好处都是真实的：不为一次模型列表去加载用户全部 npm 扩展（真机量级：带扩展 5s+，
 * 快速档 1–3s），而且结果就是 pi 自己对远端 auth.json/models.json 的解析视图。
 *
 * `compat` 只给不认识这些旗标的老版本 pi 用（与本机 `MODEL_LIST_COMPAT_ARGS` 同一个降级概念）。
 */
export const REMOTE_PI_MODEL_LIST_ARGS: { readonly full: readonly string[]; readonly fast: readonly string[]; readonly compat: readonly string[] } = {
	// full = 本机「带扩展」第一档：扩展可以 registerProvider 贡献模型（issue #181）。
	// 代价是远端要加载用户全部扩展（真机量级 5s+），所以只在手动刷新时用。
	full: ["--list-models", "--offline", "--no-skills", "--no-themes"],
	fast: ["--list-models", "--offline", "--no-extensions", "--no-skills", "--no-themes"],
	compat: ["--list-models"],
};

/** 远端模型目录命令的三档形态；顺序由调用方决定（默认快速档，手动刷新从 full 起步）。 */
export type RemotePiListModelsMode = keyof typeof REMOTE_PI_MODEL_LIST_ARGS;

/**
 * 远端模型目录命令：`'<node>' '<pi>' '--list-models' …`。
 *
 * 与 `buildRemotePiVersionCommand` 同构、共用同一条 pinned ssh 通道：解释器必须是已解析的 node
 * （远端 pi 是 `#!/usr/bin/env node` shim，非交互式 PATH 里只有系统 node），参数全部是这里的字面量，
 * 没有任何用户输入进命令行。这样「远端模型列表」不需要新增 helper 方法、不需要活着的会话 runtime。
 */
export function buildRemotePiListModelsCommand(piPath: string, nodePath: string, mode: RemotePiListModelsMode = "fast"): string {
	const args = REMOTE_PI_MODEL_LIST_ARGS[mode];
	const command = [quotePosixArgument(requireNodeInterpreter(nodePath, REMOTE_PI_PATH_INVALID)), quotePosixArgument(requirePiExecutable(piPath)), ...args.map((arg) => quotePosixArgument(arg))].join(" ");
	if (command.length > REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH) fail(REMOTE_PI_PATH_INVALID);
	return command;
}

/**
 * 构造探测远端 pi 版本的唯一命令：`'<nodePath>' '<piPath>' '--version'`。
 *
 * 三个 token 各自经 `quotePosixArgument` 单引号引用（与 `buildRemoteNodeVersionCommand` 同款，不另造
 * 转义），因此命令里除引号化产物外没有任何用户可控文本，`$PATH`、反引号、空格都只是字面量。版本号
 * **不**参与这里：版本只在结果回来之后用于分类。
 *
 * `nodePath` 是**必填**的：pi 的入口是 `#!/usr/bin/env node` shim，裸执行会落到非交互式 PATH 里的
 * 系统 node 上（真机 v12.22.9，见文件头实测）。P4.2 的远端启动（`'<node>' '<pi>' --mode rpc …`）复用
 * 同一形态，所以解释器在探测阶段就必须是这条命令的一部分。不做可选参数：可选会把「靠 PATH 裸执行」
 * 这条死路重新引回来。
 */
export function buildRemotePiVersionCommand(piPath: string, nodePath: string): string {
	const command = [quotePosixArgument(requireNodeInterpreter(nodePath, REMOTE_PI_PATH_INVALID)), quotePosixArgument(requirePiExecutable(piPath)), quotePosixArgument("--version")].join(" ");
	// 两段路径各自的 4096 上限之和加上引用开销可以超过 pinned ssh 的 remoteCommand 帧上限（8192）。
	// 越界在真实装配里会变成 `SSH_REMOTE_COMMAND_INVALID`——那是另一个域的码，而归因是「探测命令形状
	// 非法」，所以在构造点就用本模块自己的码拒掉，别把两个域混在一起。
	if (command.length > REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH) fail(REMOTE_PI_PATH_INVALID);
	return command;
}

/**
 * 解析 `pi --version` 的 stdout。
 *
 * 只接受裸 semver（可选 `v` 前缀 + 尾随空白）；其余一切（空输出、横幅、`pi 0.85.1`、`1.0`、
 * `1.0.4.5`、非字符串）返回 null 而不是抛错——调用方的语义是「这个候选不可用，试下一个」，
 * 只有全部候选耗尽才是稳定码。
 */
export function parsePiVersionOutput(stdout: unknown): PiVersion | null {
	if (typeof stdout !== "string" || stdout.length === 0 || stdout.length > MAX_VERSION_OUTPUT_LENGTH) return null;
	const match = PI_VERSION_OUTPUT.exec(stdout);
	if (!match) return null;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
	return { major, minor, patch };
}

/** 三段数值比较；负数表示 left 更旧。字符串比较在这里是被明确禁止的（`"0.9.0" > "0.85.1"`）。 */
export function comparePiVersions(left: PiVersion, right: PiVersion): number {
	if (left.major !== right.major) return left.major < right.major ? -1 : 1;
	if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
	if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
	return 0;
}

/**
 * 把观察到的版本放进兼容矩阵。
 *
 * - `below-minimum`：完整 semver 比下限还旧 ⇒ 调用方 fail-closed 并给升级指引。
 * - `above-verified`：`major.minor` 超过已核验上限 ⇒ **放行**，只带一个 warning。远端 pi 是用户
 *   自己的软件，比本机新是最常见情况，把它挡在门外等于让用户为了 PiDeck 降级自己的工具。
 * - `supported`：窗口内（含 0.85 的任意补丁版）。
 */
export function classifyRemotePiVersion(version: PiVersion): "supported" | "below-minimum" | "above-verified" {
	if (comparePiVersions(version, REMOTE_PI_MIN_SUPPORTED) < 0) return "below-minimum";
	// 上限只比 major.minor：补丁版不改协议面，因此 ceiling 的 patch 不参与比较。
	if (version.major > REMOTE_PI_VERIFIED_CEILING.major) return "above-verified";
	if (version.major === REMOTE_PI_VERIFIED_CEILING.major && version.minor > REMOTE_PI_VERIFIED_CEILING.minor) return "above-verified";
	return "supported";
}

/** 保留可诊断的首段版本文本，长度有界（原文可能带尾随空白的整段 stdout）。 */
function boundedVersionText(stdout: unknown): string {
	return typeof stdout === "string" ? stdout.trim().slice(0, 32) : "";
}

/**
 * 用户手填路径的探测：一条 `--version` 命令，版本门与自动发现完全同一条。
 *
 * 失败只有两个码：跑不起来/输出不可解析 ⇒ `REMOTE_PI_VERSION_UNREADABLE`；可读但低于下限 ⇒
 * `REMOTE_PI_TOO_OLD`。不给「换个候选再试」的余地：这条路径是用户指定的，换目标就是猜。
 */
async function probeExplicitPi(input: { userDataDir: string; hostId: string; client: SshClientRuntime; nodePath: string; piPath: string }): Promise<RemotePiObservation> {
	const piPath = normalizeRemotePiPath(input.piPath);
	const versionCommand = buildRemotePiVersionCommand(piPath, input.nodePath);
	const invocation = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, remoteCommand: versionCommand });
	let result: SshCommandResult;
	try {
		result = await input.client.run(invocation.executable, invocation.args);
	} catch {
		fail(REMOTE_PI_VERSION_UNREADABLE);
	}
	if (result.exitCode !== 0) fail(REMOTE_PI_VERSION_UNREADABLE);
	const parsed = parsePiVersionOutput(result.stdout);
	if (parsed === null) fail(REMOTE_PI_VERSION_UNREADABLE);
	const classification = classifyRemotePiVersion(parsed);
	if (classification === "below-minimum") {
		const tooOld = new Error(REMOTE_PI_TOO_OLD) as RemotePiError;
		tooOld.piPath = piPath;
		tooOld.observedVersion = boundedVersionText(result.stdout);
		tooOld.probed = 1;
		throw tooOld;
	}
	const observation: RemotePiObservation = { piPath, version: boundedVersionText(result.stdout), versionParsed: parsed, probed: 1 };
	return classification === "above-verified" ? { ...observation, warning: REMOTE_PI_VERSION_UNVERIFIED } : observation;
}

/**
 * 解析「这台主机上用户自己会用的那个 pi」。
 *
 * `nodePath` 由调用方先用 `RemoteBootstrapSession.resolveRemoteNodeExecutable` 解析（登录 shell PATH +
 * ≥22.3 版本门）后传进来，本模块不再自己解析一次：版本探测与将来的远端启动（`'<node>' '<pi>' --mode rpc …`）
 * 必须用**同一个** node，两处各解析一次迟早漂移成「探测用这个 node、启动用那个 node」。
 *
 * 流程与 `resolveRemoteNodeExecutable` 同构，但失败分类按 pi 的语义分开：
 *
 * 0. `nodePath` 形状不合法 ⇒ `REMOTE_PI_NODE_PATH_INVALID`，**在发任何帧之前**（解释器不合法时后面
 *    每一步都会是错的，没必要花一次往返去发现）。
 * 1. 跑 `buildLoginShellPathCommands` 依次读各 shell 方言的登录 PATH（bash → zsh → sh，理由见
 *    `RemoteNodeDiscovery`；nvm 写在 `~/.bashrc`、Homebrew 写在 `~/.zprofile`）。**第一个能给出
 *    候选的方言就是答案来源**：它与 node 侧的「第一个合格候选就是答案」同一个立场，不把多个方言的
 *    候选拼成一张表。命令本身发不出去、退出非 0，或哨兵读不出来 ⇒ 换下一个方言；全部方言都拿不到
 *    可信 PATH ⇒ `REMOTE_PI_SHELL_PATH_UNREADABLE`。
 * 2. 按 PATH 顺序列出候选；一个都没有 ⇒ `REMOTE_PI_NOT_FOUND`。
 * 3. 逐候选跑 `pi --version`（命令只由 `buildRemotePiVersionCommand` 构造，每个候选都用同一个
 *    `nodePath` 当解释器）。执行失败或退出非 0 或输出不可解析 ⇒ 试下一个；**可读但低于下限**例外：
 *    PATH 里第一个 pi 就是用户交互时会跑的那个，它太旧是明确结论（该升级），继续往后挑只会在别人
 *    的 PATH 里另找一个 pi 来掩盖它。
 * 4. 候选耗尽 ⇒ `REMOTE_PI_VERSION_UNREADABLE`，已探次数挂在 `probed` 上。
 *
 * `piPath` 是**用户手填的覆盖值**（主机档案里的 `remotePiCommand`）：给了它就不再扫登录 shell 的
 * PATH，直接对这条路径跑同一条 `--version` 命令、走同一道版本门。手填路径是用户对「我的 pi 装在
 * 哪」的明确声明，重新扫 PATH 只会拿别人目录里的 pi 去掩盖它。
 *
 * 上限 `MAX_PI_CANDIDATES` 是硬约束：超过的候选一个命令都不会发出。
 */
export async function resolveRemotePiExecutable(input: { userDataDir: string; hostId: string; client: SshClientRuntime; sentinel: string; nodePath: string; piPath?: string }): Promise<RemotePiObservation> {
	const nodePath = requireNodeInterpreter(input?.nodePath, REMOTE_PI_NODE_PATH_INVALID);
	if (input.piPath !== undefined) return probeExplicitPi({ userDataDir: input.userDataDir, hostId: input.hostId, client: input.client, nodePath, piPath: input.piPath });
	// 与 node 侧同口径：每个 shell 方言都是一份独立的 PATH 答案，按序探测（交互登录 bash 能读到
	// nvm/conda 写在 `~/.bashrc` 里的 PATH，`/bin/sh -lc` 读不到）。全部方言都拿不到可信 PATH 才报错。
	let candidates: string[] | undefined;
	// 至少一个方言给过可解析的 PATH：那就不是「读不到」，而是「这份 PATH 里没有 pi」。
	let sawParsedPath = false;
	for (const remoteCommand of buildLoginShellPathCommands(input.sentinel)) {
		const pathInvocation = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, remoteCommand });
		let pathResult: SshCommandResult;
		try {
			pathResult = await input.client.run(pathInvocation.executable, pathInvocation.args);
		} catch {
			continue;
		}
		// 退出非 0 与哨兵缺失归入同一个结果：两者都意味着「这个方言拿不到可信 PATH」。
		if (pathResult.exitCode !== 0) continue;
		// 解析失败同样失败关闭，绝不退回非交互 PATH。错误码由这里指定，解析规则与 node 侧共用一份。
		try {
			const parsed = listPiCandidatesFromPath(parseLoginShellPathWithCode(pathResult.stdout, input.sentinel, REMOTE_PI_SHELL_PATH_UNREADABLE, REMOTE_PI_SHELL_PATH_UNREADABLE));
			sawParsedPath = true;
			if (parsed.length > 0) {
				candidates = parsed;
				break;
			}
		} catch {
			continue;
		}
	}
	// 一份可信 PATH 都没拿到：这一阶段我们连「用户在哪个 PATH 里」都不知道，任何猜测都等于退回非交互语义。
	if (candidates === undefined) fail(sawParsedPath ? REMOTE_PI_NOT_FOUND : REMOTE_PI_SHELL_PATH_UNREADABLE);
	let probed = 0;
	let lastVersion = "";
	for (const candidate of candidates.slice(0, MAX_PI_CANDIDATES)) {
		const versionCommand = buildRemotePiVersionCommand(candidate, nodePath);
		const invocation = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, remoteCommand: versionCommand });
		let result: SshCommandResult;
		probed += 1;
		try {
			result = await input.client.run(invocation.executable, invocation.args);
		} catch {
			continue; // 跑不起来的候选不是答案，试下一个。
		}
		if (result.exitCode !== 0) continue;
		const parsed = parsePiVersionOutput(result.stdout);
		if (parsed === null) {
			lastVersion = boundedVersionText(result.stdout);
			continue;
		}
		const classification = classifyRemotePiVersion(parsed);
		if (classification === "below-minimum") {
			// 消息必须**就是**稳定码：诊断层只承认「消息即码」，把路径与版本拼进消息会让这个
			// 最该被用户看懂的失败退化成笼统错误。细节随属性携带。
			const tooOld = new Error(REMOTE_PI_TOO_OLD) as RemotePiError;
			tooOld.piPath = candidate;
			tooOld.observedVersion = boundedVersionText(result.stdout);
			tooOld.probed = probed;
			throw tooOld;
		}
		const observation: RemotePiObservation = { piPath: candidate, version: boundedVersionText(result.stdout), versionParsed: parsed, probed };
		// 高于核验窗口不是失败：放行并标记，由调用方决定怎么提示（不改命令、不改路径）。
		return classification === "above-verified" ? { ...observation, warning: REMOTE_PI_VERSION_UNVERIFIED } : observation;
	}
	const unreadable = new Error(REMOTE_PI_VERSION_UNREADABLE) as RemotePiError;
	unreadable.probed = probed;
	unreadable.piPath = candidates[0];
	unreadable.observedVersion = lastVersion || "unprobed";
	throw unreadable;
}
