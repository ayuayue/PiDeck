import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type * as childProcessModule from "node:child_process";
import { isRunnableRunnerNode } from "./dshRunnerNode";

/**
 * 拿 child_process 的真实 CJS exports 对象。
 * 不能 `import * as childProcess`：tsc 会把命名空间 import 编译成 __importStar 拷贝
 * （拷贝上的 getter 不可配置，defineProperty 替换会抛 "Cannot redefine property"，
 * 且补丁打在拷贝上对真实模块无效）。createRequire 直接返回模块本体，
 * 在测试 vm（__filename 注入）与 electron-vite CJS 产物（__filename 存在）里都成立。
 * 类型用 type-only 别名（childProcess 类型/值双空间不冲突，运行时零开销）。
 */
type childProcess = typeof childProcessModule;
const childProcess = createRequire(__filename)("node:child_process") as typeof childProcessModule;

type SpawnOptions = childProcessModule.SpawnOptions;

/**
 * Windows 控制台窗口治理（win32 only）。
 *
 * 2026-09 链路实测（GUI 父进程 → A(CREATE_NO_WINDOW) → B/C 不带 windowHide，
 * 亚毫秒监视顶层窗口）：
 * - CREATE_NO_WINDOW 子进程 GetConsoleWindow()==NULL，但 CreateFile("CONOUT$")
 *   成功——有控制台、没有窗口，且可被孙进程继承，不会再新建可见 conhost。
 * - 旧注释「CREATE_NO_WINDOW 会让孙进程弹可见窗口」不成立；host 再 AllocConsole
 *   + SW_HIDE 才是闪窗来源：conhost 异步建窗（实测 107–215ms），AllocConsole
 *   返回时句柄常为 NULL，16ms 轮询有一半会露出 5–25ms 黑窗。
 * - CreateProcessAsUserW 受限 token 上**自己** CREATE_NO_WINDOW 仍会
 *   STATUS_DLL_INIT_FAILED；那条必须「继承」父进程已有控制台。父进程用
 *   CREATE_NO_WINDOW 拿到的无窗口控制台可以被继承，不踩这个坑。
 *
 * 现行策略（见 decideDshHostConsolePolicy / installHiddenConsolePatch）：
 * 1) host（utilityProcess）不 AllocConsole，自身不需要控制台。
 * 2) host 所有 child_process 注入 windowsHide（CREATE_NO_WINDOW）。
 * 3) 沙箱 runner 有 CUI node sidecar 时改写成 node.exe + windowsHide：
 *    runner 自建无窗口可继承控制台；第二级 ACL runner 由 host env 的 preload
 *    兜住（它仍是 electron.exe），pwsh 经 CreateProcessAsUserW 继承即可。
 * 4) sidecar 不可用时仍走 electron.exe + runnerConsolePreload AllocConsole
 *    兜底（可能闪一帧；只覆盖老 runtime）。
 */

/** koffi 运行时 FFI 接口子集（测试注入假实现，避免依赖真实原生模块）。 */
export interface Win32Ffi {
	load(name: string): {
		func(signature: string): (...args: unknown[]) => unknown;
	};
}

/**
 * 旧语义：host 已 AllocConsole 成功，子进程应继承、不要再 CREATE_NO_WINDOW。
 * 现行策略不再分配控制台，此标志恒为 false，补丁一律注入 windowsHide。
 */
let hostHiddenConsoleActive = false;

/** runner spawn 策略日志只打一次（避免沙箱每次调用都刷日志）。 */
let runnerPolicyLogged = false;

/**
 * Windows 沙箱 runner 的 CUI node sidecar。配置后，把 `electron.exe runner.js`
 * 改写成 `node.exe runner.js`，用 CREATE_NO_WINDOW 自建无窗口控制台，不再 AllocConsole。
 * 未配置时保持 electron.exe + ELECTRON_RUN_AS_NODE + preload 旧路径。
 */
let dshRunnerNodeSidecarPath: string | undefined;

/** 由 hostEntry 在补丁安装前写入（来自 fork env `PIDECK_DSH_RUNNER_NODE`）。 */
export function configureDshRunnerNodeSidecar(path: string | undefined, platform: NodeJS.Platform = process.platform): void {
	const candidate = path?.trim() ?? "";
	// 垫片（mise/scoop/volta/chocolatey…）会再转一次真实 node，把 runner 的 IPC
	// （fd3 ipc + fd4 control）转丢，宿主判 “Windows Job runner exited with exit
	// code 0 before proving its managed range empty”，PTC run_code 全废。
	// 拿不到真二进制时宁可退回 electron.exe + preload 旧路径（最多闪一下窗）。
	const runnable = candidate.length > 0 && isRunnableRunnerNode(candidate, platform);
	if (candidate.length > 0 && !runnable) {
		console.error(`[dsh-sidecar] 忽略不可 spawn 的 runner node（垫片/非 .exe）：${candidate}`);
	}
	dshRunnerNodeSidecarPath = runnable ? candidate : undefined;
	runnerPolicyLogged = false;
}

/** 当前 sidecar 路径（诊断日志 / 测试）。 */
export function getDshRunnerNodeSidecar(): string | undefined {
	return dshRunnerNodeSidecarPath;
}

/**
 * host 控制台治理模式（诊断：hostEntry 启动时打印一次，排查黑窗口用）。
 */
export type HiddenConsoleMode =
	| "off" // 非 win32：不治理
	| "create-no-window"; // win32：不 AllocConsole，子进程走 CREATE_NO_WINDOW

let hiddenConsoleMode: HiddenConsoleMode = "off";

/** 当前控制台治理模式（hostEntry 诊断日志用）。 */
export function getHiddenConsoleMode(): HiddenConsoleMode {
	return hiddenConsoleMode;
}

/** host 控制台策略（纯函数，可单测；禁止再靠 AllocConsole 赛跑藏窗）。 */
export interface DshHostConsolePolicy {
	/** host 是否 AllocConsole。策略上恒 false。 */
	allocHostConsole: boolean;
	/** host 子进程是否注入 CREATE_NO_WINDOW。 */
	injectWindowsHide: boolean;
	/** 是否把 electron.exe runner 改写成 CUI node sidecar。 */
	rewriteRunnerToSidecar: boolean;
}

export function decideDshHostConsolePolicy(input: { platform: NodeJS.Platform; sidecarPath?: string }): DshHostConsolePolicy {
	if (input.platform !== "win32") {
		return { allocHostConsole: false, injectWindowsHide: false, rewriteRunnerToSidecar: false };
	}
	return {
		allocHostConsole: false,
		injectWindowsHide: true,
		rewriteRunnerToSidecar: Boolean(input.sidecarPath?.trim()),
	};
}

/**
 * 安装 host 控制台策略（win32 only；不再 AllocConsole）。
 *
 * ffi 参数保留是为了兼容旧调用/测试签名，现行路径不会加载 koffi。
 * 返回 false：没有「已分配的可继承隐藏控制台」，补丁应注入 windowsHide。
 */
export function installHostHiddenConsole(platform: NodeJS.Platform = process.platform, _ffi?: Win32Ffi): boolean {
	hostHiddenConsoleActive = false;
	if (platform !== "win32") {
		hiddenConsoleMode = "off";
		return false;
	}
	hiddenConsoleMode = "create-no-window";
	return false;
}

/** 未显式指定 windowsHide 时注入 true；已指定则尊重原值（Node 默认 false）。 */
export function hiddenConsoleOptions<T extends { windowsHide?: boolean }>(options: T | undefined): T | undefined {
	if (!options) return undefined;
	return options.windowsHide === undefined ? { ...options, windowsHide: true } : options;
}

/** options 缺失时补一个只含 windowsHide 的对象（insert 语义，与 replace 区分）。 */
function withHiddenOptions<T extends { windowsHide?: boolean }>(options: T | undefined): T {
	if (options === undefined) return { windowsHide: true } as T;
	return hiddenConsoleOptions(options) as T;
}

/** 沙箱 runner 脚本名（lib 产物 runner.js / 开发形态 runner.ts）。 */
const RUNNER_SCRIPT_RE = /runner\.(js|ts)$/i;

/**
 * pwsh 冷启动加速环境变量（实测：405ms → 286ms，省约 30%）。
 * PowerShell 7 启动时检查遥测/更新/首次运行体验，这些检查是启动路径上的真实开销；
 * 本机单用户桌面场景全部无意义，显式关闭。对本地 spawn（pwsh.exe）直接注入，
 * 对沙箱 runner 的 spawn 也注入（CreateProcessAsUserW 的子进程继承 runner 的 env）。
 */
const PWSH_STARTUP_ENV: Record<string, string> = {
	POWERSHELL_TELEMETRY_OPTOUT: "1",
	POWERSHELL_UPDATECHECK: "Off",
	DOTNET_NOLOGO: "1",
	DOTNET_CLI_TELEMETRY_OPTOUT: "1",
	DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
};

/** command 是否为 pwsh/powershell（本地路径解析与 PATH 裸名都覆盖）。 */
function isPwshCommand(command: string): boolean {
	return /(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(command);
}

/**
 * -Command 命令末尾追加换行 + exit 的纯 args 改写（不含 stdio 调整）。
 * 换行拼接：命令以 # 注释结尾时 exit 也不会被注释吞掉；命令内已有 exit 时
 * 追加项不生效，无害。
 */
function withPwshExitAppend(args: readonly string[]): readonly string[] {
	const cmdIndex = args.findIndex((arg) => arg === "-Command");
	if (cmdIndex < 0 || cmdIndex + 1 >= args.length) return args;
	const nextArgs = [...args];
	nextArgs[cmdIndex + 1] = `${args[cmdIndex + 1]}\nexit $LASTEXITCODE`;
	return nextArgs;
}

/**
 * 让沙箱 runner 以 Node 模式启动（win32）。
 *
 * 为什么必须改 host 自己的 `process.env`，而不是只在 spawn 边界注入：
 * 「runner 以 electron.exe 形态运行」在沙箱链路上有两层，spawn 补丁只够得着第一层——
 *   1) host --spawn()--> @deepseek-ai/dsh-subprocess-local/lib/runner  → 补丁能改 options.env ✅
 *   2) 该 runner --CreateProcessAsUserW--> @deepseek-ai/dsh-sandbox-windows-acl/lib/runner
 *      第二层的命令行/环境由第一层按 IPC 传来的 request.env 设置，补丁完全够不着 ❌
 * 而第二层的 env 源自 dsh-subprocess-local 的 targetEnvironment() → scrubbedParentEnv()，
 * 读的就是 **host 进程的 process.env**（只过滤 /KEY|PASSWORD|SECRET|TOKEN/ 与 DSH_*，
 * ELECTRON_RUN_AS_NODE 会原样带下去）。因此唯一能从外部影响第二层的杠杆是 host 的
 * process.env：在这里置 ELECTRON_RUN_AS_NODE=1，第二层 runner 才会以 Node 模式启动。
 *
 * 2026-09-12 进程树实证（沙箱 pwsh 调用恒挂满 120s 工具超时、run 恒「运行中」）：
 *   electron.exe …/dsh-subprocess-local/lib/runner.js -- electron.exe …/dsh-sandbox-windows-acl/lib/runner.js
 *     --workspace … --mode workspace-write … -- pwsh.exe -NoLogo -NoProfile -NonInteractive -Command "…\nexit $LASTEXITCODE"
 * 两个观察点：
 * - ACL runner 进程下挂着 Chromium 子进程（`--type=gpu-process`、
 *   `--type=utility --utility-sub-type=network.mojom.NetworkService`、
 *   `--user-data-dir=…\AppData\Roaming\Electron`）——即它以 GUI 模式运行：
 *   runner.js 业务逻辑照跑（受限命令正常执行、输出正常），但 Electron GUI 主进程
 *   事件循环永不退出，于是「直连子进程」= 外层 runner 永远等不到 ACL runner 退出。
 * - pwsh 命令行里 `exit $LASTEXITCODE` 已送达，且挂起瞬间进程表里**没有 pwsh**——
 *   可证前一轮「沙箱内 pwsh 不退出」的诊断不是主因（见 withPwshExitAppend 注释）。
 *
 * 副作用（已知、可接受）：沙箱内命令的 env 也会带上该变量，即模型在沙箱里直接跑
 * electron.exe（GUI 应用）会退化成 Node 模式。沙箱的用途是跑命令行工具，
 * 相较「每条命令挂满 120s、定时任务回合跑满数分钟」的代价，这个副作用可以接受。
 *
 * @returns 还原函数（测试用；生产调用方不还原）。
 */
export function installRunnerNodeModeEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): () => void {
	if (platform !== "win32") return () => undefined;
	const previous = env.ELECTRON_RUN_AS_NODE;
	env.ELECTRON_RUN_AS_NODE = "1";
	return () => {
		if (previous === undefined) Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		else env.ELECTRON_RUN_AS_NODE = previous;
	};
}

/**
 * 把 runner preload 的 NODE_OPTIONS 写进 host 自己的 `process.env`（黑窗口根治）。
 *
 * 两级论证与 installRunnerNodeModeEnv 完全同构：spawn 补丁的 withRunnerPreload
 * 只够得着 host 直接 spawn 的【第一级】runner（options.env）；第二级 ACL runner
 * 的 env 来自 host 进程环境经 scrubbedParentEnv → IPC request.env 下发，补丁够不着。
 * 第二级 runner 拿不到 preload 就没有可继承的控制台，而它拉起 pwsh 用的是 koffi
 * CreateProcessAsUserW（dsh-win32-process spawnInheritedJobProcess，
 * dwCreationFlags=4 仅 CREATE_SUSPENDED，无 CREATE_NO_WINDOW；受限 token 下
 * CREATE_NO_WINDOW 会 STATUS_DLL_INIT_FAILED，不能加）——父进程无控制台时
 * Windows 为 pwsh 新建【可见】控制台窗口。2026-09-12 用户实测：ELECTRON_RUN_AS_NODE
 * 修复后命令秒回，但每条命令弹一个 pwsh 黑窗口，即此缺口。
 *
 * 写进 host env 后：第二级 runner 启动时由 preload 自建隐藏控制台（runnerConsole
 * Preload），pwsh 继承之，不再弹窗。
 *
 * 合并语义：与已有 NODE_OPTIONS append；已含同一 preload（路径归一化后比较）则
 * 幂等跳过——host env 带 preload 后，第一级 runner 的 options.env（由 host env
 * 派生）也会带上它，不能在 withRunnerPreload 里再叠一份。
 *
 * 副作用（已知、可接受）：沙箱内命令的 env 也带 NODE_OPTIONS——pwsh/cmd 等非
 * Node 程序忽略它；模型在沙箱里跑的 node 进程会加载 preload（自建隐藏控制台，
 * 行为与 runner 一致，无可见窗口）。preload 文件缺失时 node 子进程会启动失败，
 * 与第一级 runner 的既有注入共享同一前提（preload 随 out/main 分发）。
 *
 * @returns 还原函数（测试用；生产调用方不还原）。
 */
export function installRunnerPreloadEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, runnerPreloadPath: string = join(__dirname, "runnerConsolePreload.js")): () => void {
	if (platform !== "win32") return () => undefined;
	const previous = env.NODE_OPTIONS;
	if (!includesRunnerPreload(previous, runnerPreloadPath)) {
		const preload = runnerPreloadFlag(runnerPreloadPath);
		env.NODE_OPTIONS = previous ? `${previous} ${preload}` : preload;
	}
	return () => {
		if (previous === undefined) Reflect.deleteProperty(env, "NODE_OPTIONS");
		else env.NODE_OPTIONS = previous;
	};
}

/**
 * pwsh 挂起兜底（本地实测：host 内普通 pwsh 调用约 8% 概率「命令执行完不退出」，
 * 直到工具超时被回收——用户可见为每次调用慢/超时）：
 * 1. stdin 从 pipe 改 ignore：pwsh 不会等待管道 EOF（已知的挂起形态之一）；
 *    工具命令本就没有 stdin 输入通道，无行为差异。
 * 2. `-Command` 命令末尾追加换行 + `exit $LASTEXITCODE`：无论挂起原因，
 *    命令执行完都强制退出。
 */
function withPwshHangGuard(args: readonly string[], options: childProcessModule.SpawnOptions | undefined): { args: readonly string[]; options: childProcessModule.SpawnOptions | undefined } {
	const nextArgs = withPwshExitAppend(args);
	let nextOptions = options;
	if (options !== undefined && Array.isArray(options.stdio) && options.stdio[0] === "pipe") {
		const stdio = options.stdio.map((entry) => entry);
		stdio[0] = "ignore";
		nextOptions = { ...options, stdio };
	}
	return { args: nextArgs ?? args, options: nextOptions };
}

/** 给 pwsh 相关 spawn 注入启动优化环境变量（env 缺失时跳过：真实链路恒带 env）。 */
function withPwshStartupEnv(options: childProcessModule.SpawnOptions | undefined, isPwsh: boolean): childProcessModule.SpawnOptions | undefined {
	if (!isPwsh || options === undefined || options.env === undefined) return options;
	return { ...options, env: { ...options.env, ...PWSH_STARTUP_ENV } };
}

/** NODE_OPTIONS 的 --require preload 片段（反斜杠翻倍，Windows 分词语义见下）。 */
function runnerPreloadFlag(runnerPreloadPath: string): string {
	return `--require="${runnerPreloadPath.replace(/\\/g, "\\\\")}"`;
}

/** existing NODE_OPTIONS 是否已含该 preload（把翻倍的反斜杠还原后做子串比较）。 */
function includesRunnerPreload(existing: string | undefined, runnerPreloadPath: string): boolean {
	if (!existing) return false;
	return existing.replace(/\\\\/g, "\\").includes(runnerPreloadPath);
}

/**
 * 沙箱 runner 的 spawn 需要注入 NODE_OPTIONS=--require=<preload>：
 * runner 由 GUI 二进制（electron.exe）拉起、不继承 host 控制台，由 preload
 * （runnerConsolePreload）在 runner 进程内自建隐藏控制台，CreateProcessAsUserW
 * 的子进程继承后不再弹窗。env 缺失时跳过（真实链路 spawnSubprocess 恒带 env）。
 * 幂等：env 里已有同一 preload（如 installRunnerPreloadEnv 写进 host env 后，
 * options.env 由 host env 派生）则不重复 append，避免 Node 加载两遍。
 */
function withRunnerPreload(options: childProcessModule.SpawnOptions | undefined, runnerPreloadPath: string): childProcessModule.SpawnOptions | undefined {
	if (options === undefined || options.env === undefined) return options;
	const existing = options.env.NODE_OPTIONS;
	if (includesRunnerPreload(existing, runnerPreloadPath)) return options;
	// Windows 上 Node 解析 NODE_OPTIONS 时按命令行分词、反斜杠当转义符：
	// `--require="C:\path\a.js"` 会被解析成 `C:patha.js`（MODULE_NOT_FOUND）。
	// 必须把反斜杠翻倍（`\\` → `\`），否则 runner preload 加载失败、沙箱调用全挂。
	return {
		...options,
		env: {
			...options.env,
			NODE_OPTIONS: existing ? `${existing} ${runnerPreloadFlag(runnerPreloadPath)}` : runnerPreloadFlag(runnerPreloadPath),
		},
	};
}

/**
 * 沙箱 runner 的 spawn 必须注入 ELECTRON_RUN_AS_NODE=1（挂起根治，实测确认）：
 * runner.js 是 Node 脚本，靠该环境变量让 electron.exe 以 Node 模式执行。
 * DSH host 跑在 utilityProcess（NodeService）里——NodeService 是 Electron 内部
 * 机制、进程环境里【没有】ELECTRON_RUN_AS_NODE；dsh-subprocess 的
 * scrubbedParentEnv 只按父进程 env 过滤（KEY/DSH_*），也不会补它。缺失时
 * electron.exe 会以 GUI 主进程模式加载 runner.js：业务逻辑照常执行（pwsh 被
 * 拉起、输出正常、TSF 输入法 DLL 注入产生日志），但 Electron 主进程事件循环
 * 永不退出（app 未 quit）——host 等 runner 退出等到工具超时（实测 120s，
 * 会话里表现为「PID 打印后挂起」）。注入后 runner 按 Node 模式跑，业务完成后
 * 事件循环清空正常退出（复现实验：缺变量 3/3 挂、注入后 2/2 正常）。
 * env 缺失时跳过（真实链路恒带 env）。
 */
function withRunnerRunAsNode(options: childProcessModule.SpawnOptions | undefined): childProcessModule.SpawnOptions | undefined {
	if (options === undefined || options.env === undefined) return options;
	if (options.env.ELECTRON_RUN_AS_NODE === "1") return options;
	return { ...options, env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" } };
}

/** 本次 spawn 的 argv 是否指向沙箱 runner（argv 内含 runner.js/runner.ts 路径）。 */
function isRunnerSpawn(command: string, args: readonly string[] | undefined): boolean {
	if (args === undefined) return false;
	return args.some((arg) => typeof arg === "string" && RUNNER_SCRIPT_RE.test(arg));
}

/** command 是否为 Electron GUI 可执行文件（含 utilityProcess 的 process.execPath）。 */
function isElectronLikeExec(command: string): boolean {
	if (/(^|[\\/])electron(\.exe)?$/i.test(command)) return true;
	return command === process.execPath;
}

/**
 * 沙箱 runner 若仍由 electron.exe 拉起，改写成 CUI node sidecar。
 * sidecar 未配置或 command 已经是 node 时原样返回。
 */
function rewriteRunnerExecutable(command: string, args: readonly string[]): { command: string; args: readonly string[] } {
	if (!decideDshHostConsolePolicy({ platform: "win32", sidecarPath: dshRunnerNodeSidecarPath }).rewriteRunnerToSidecar) {
		return { command, args };
	}
	if (!isRunnerSpawn(command, args)) return { command, args };
	if (!isElectronLikeExec(command)) return { command, args };
	return { command: dshRunnerNodeSidecarPath as string, args };
}

/**
 * 安装补丁（win32 only；platform 可注入以便测试）。返回还原函数。
 * 在 DSH 各包动态 import 前安装，并同步内置模块 ESM 导出：其他宿主依赖可能
 * 已提前加载 node:child_process，只改 CJS 会让 DSH 的 ESM spawn 继续绕过补丁。
 *
 * 行为：
 * - win32 一律注入 windowsHide（CREATE_NO_WINDOW：无窗口、可继承）。
 * - sidecar 可用时把 electron.exe runner 改写成 node.exe，同样带 windowsHide。
 * - 沙箱 runner spawn 注入 NODE_OPTIONS preload（无 sidecar 的 electron 兜底路径）。
 *
 * 注意：Node 24+ 的内置模块 CJS exports 是只读 getter（plain 赋值会抛
 * "Cannot set property ... which has only a getter"），必须用 defineProperty；
 * 该属性 configurable=true；ESM 命名导出需显式 syncBuiltinESMExports 才更新，
 * 不能依赖 defineProperty 自动同步已加载的 builtin binding。
 */
export function installHiddenConsolePatch(platform: NodeJS.Platform = process.platform, runnerPreloadPath: string = join(__dirname, "runnerConsolePreload.js")): () => void {
	if (platform !== "win32") return () => undefined;
	const originals = {
		spawn: childProcess.spawn,
		spawnSync: childProcess.spawnSync,
		execFile: childProcess.execFile,
		execFileSync: childProcess.execFileSync,
		exec: childProcess.exec,
		execSync: childProcess.execSync,
	};

	/** 用 defineProperty 替换导出（兼容 Node 24 只读 getter 语义）。 */
	function replaceExport<K extends keyof typeof childProcess>(name: K, value: (typeof childProcess)[K]): void {
		Object.defineProperty(childProcess, name, {
			value,
			writable: true,
			configurable: true,
		});
	}

	/**
	 * 一次 spawn 的 options 决策：runner spawn 在无 sidecar 时注入 preload，pwsh 恒注入
	 * 启动环境；win32 子进程一律 windowsHide。
	 */
	function resolveSpawnOptions(command: string, args: readonly string[] | undefined, options: childProcessModule.SpawnOptions | undefined): childProcessModule.SpawnOptions | undefined {
		if (isRunnerSpawn(command, args)) {
			// 诊断（一次性）：确认沙箱 runner spawn 的可执行文件与控制台策略。
			if (!runnerPolicyLogged) {
				runnerPolicyLogged = true;
				console.error(`[dsh-host-entry] runner spawn policy: hostHiddenConsoleActive=${String(hostHiddenConsoleActive)} ` + `sidecar=${dshRunnerNodeSidecarPath ?? "none"} ` + `command=${command} preload=${runnerPreloadPath}`);
			}
			// CUI node sidecar：CREATE_NO_WINDOW 自建无窗口可继承控制台，不再依赖 host AllocConsole。
			// 也不注入 preload：sidecar 是真 node.exe，没有 Electron 的 asar 读取能力，
			// 打包后 preload 落在 app.asar 内 → --require 直接 MODULE_NOT_FOUND，第一级
			// runner 启动即 exit 1（2026-10 线上实证：PTC run_code 与全部沙箱命令 6/6 失败，
			// 报 `Windows Job runner exited with exit code 1 before proving its managed
			// range empty`）。隐藏控制台由 host env 里的 preload（installRunnerPreloadEnv）
			// 兜第二级 ACL runner —— 它仍是 electron.exe，能读 asar。
			if (dshRunnerNodeSidecarPath) {
				return withPwshStartupEnv({ ...(options ?? {}), windowsHide: true }, true);
			}
			return withRunnerPreload(withRunnerRunAsNode(withPwshStartupEnv(hostHiddenConsoleActive ? options : withHiddenOptions(options), true)), runnerPreloadPath);
		}
		if (isPwshCommand(command)) {
			return withPwshStartupEnv(hostHiddenConsoleActive ? options : withHiddenOptions(options), true);
		}
		return hostHiddenConsoleActive ? options : withHiddenOptions(options);
	}

	// spawn(command[, args][, options])：options 在第 2 位（无 args）或第 3 位。
	replaceExport("spawn", ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, maybeOptions?: SpawnOptions) => {
		if (Array.isArray(argsOrOptions)) {
			// 仅直连 pwsh 保留旧挂起兜底；runner 自己负责超时与进程回收，必须原样
			// 传递命令和管道。追加 exit 会截断 Get-Location 等命令的延迟格式化输出。
			const rewritten = rewriteRunnerExecutable(command, argsOrOptions);
			const guarded = isPwshCommand(rewritten.command) ? withPwshHangGuard(rewritten.args, maybeOptions) : { args: rewritten.args, options: maybeOptions };
			const next = resolveSpawnOptions(rewritten.command, guarded.args, guarded.options);
			return next === undefined ? originals.spawn(rewritten.command, guarded.args) : originals.spawn(rewritten.command, guarded.args, next);
		}
		const next = resolveSpawnOptions(command, undefined, argsOrOptions as SpawnOptions | undefined);
		return next === undefined ? originals.spawn(command) : originals.spawn(command, next);
	}) as typeof childProcess.spawn);

	// spawnSync 与 spawn 同形态：runner argv 原样透传。
	replaceExport("spawnSync", ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, maybeOptions?: SpawnOptions) => {
		if (Array.isArray(argsOrOptions)) {
			const rewritten = rewriteRunnerExecutable(command, argsOrOptions);
			const guarded = isPwshCommand(rewritten.command) ? withPwshHangGuard(rewritten.args, maybeOptions) : { args: rewritten.args, options: maybeOptions };
			const next = resolveSpawnOptions(rewritten.command, guarded.args, guarded.options);
			return next === undefined ? originals.spawnSync(rewritten.command, guarded.args) : originals.spawnSync(rewritten.command, guarded.args, next);
		}
		const next = resolveSpawnOptions(command, undefined, argsOrOptions as SpawnOptions | undefined);
		return next === undefined ? originals.spawnSync(command) : originals.spawnSync(command, next);
	}) as typeof childProcess.spawnSync);

	// exec(command[, options][, callback])：options 恒在第 2 位（callback 在第 3 位）。
	// 运行期重载收窄不了（callback 可选），用 unknown 接住按位判断。
	replaceExport("exec", ((command: string, ...rest: unknown[]) => {
		const maybeCallback = rest[1];
		const options = rest[0] as childProcessModule.ExecOptions | undefined;
		const nextOptions = hostHiddenConsoleActive ? options : withHiddenOptions(options);
		if (typeof maybeCallback === "function") {
			return originals.exec(command, nextOptions, maybeCallback as Parameters<typeof originals.exec>[2]);
		}
		return originals.exec(command, nextOptions);
	}) as typeof childProcess.exec);

	// execSync(command[, options])：options 在第 2 位。
	replaceExport("execSync", ((command: string, options?: childProcessModule.ExecSyncOptions) => {
		const next = hostHiddenConsoleActive ? options : withHiddenOptions(options);
		return originals.execSync(command, next);
	}) as typeof childProcess.execSync);

	// execFile(file[, args][, options][, callback])：callback 恒在末位，options 在
	// args 之后的那个参数位（无 args 时在第 2 位）。Node 的重载带编码变体
	// （ExecFileOptions vs ExecFileOptionsWithStringEncoding），在补丁边界用一个
	// 简化签名收窄（运行期透传原参数，仅调整 windowsHide——边界收窄的正当理由）。
	type ExecFileLike = (
		file: string,
		argsOrOptions: readonly string[] | childProcessModule.ExecFileOptions | undefined,
		optionsOrCallback?: childProcessModule.ExecFileOptions | ((error: unknown, stdout: unknown, stderr: unknown) => void),
		callback?: (error: unknown, stdout: unknown, stderr: unknown) => void,
	) => ReturnType<typeof childProcessModule.execFile>;
	const execFileLike = originals.execFile as ExecFileLike;
	replaceExport("execFile", ((file: string, ...rest: unknown[]) => {
		const hasCallback = typeof rest[rest.length - 1] === "function";
		const callback = hasCallback ? (rest.pop() as (error: unknown, stdout: unknown, stderr: unknown) => void) : undefined;
		if (Array.isArray(rest[0])) {
			const args = rest[0] as readonly string[];
			const options = rest[1] as childProcessModule.ExecFileOptions | undefined;
			const next = hostHiddenConsoleActive ? options : withHiddenOptions(options);
			return callback === undefined ? execFileLike(file, args, next) : execFileLike(file, args, next, callback);
		}
		const options = rest[0] as childProcessModule.ExecFileOptions | undefined;
		const next = hostHiddenConsoleActive ? options : withHiddenOptions(options);
		return callback === undefined ? execFileLike(file, next) : execFileLike(file, next, callback);
	}) as typeof childProcess.execFile);

	// execFileSync(file[, args][, options])：与 execFile 同形态（无 callback）。
	replaceExport("execFileSync", ((file: string, argsOrOptions?: readonly string[] | childProcessModule.ExecFileSyncOptions, maybeOptions?: childProcessModule.ExecFileSyncOptions) => {
		if (Array.isArray(argsOrOptions)) {
			const next = hostHiddenConsoleActive ? maybeOptions : withHiddenOptions(maybeOptions);
			return originals.execFileSync(file, argsOrOptions, next);
		}
		const next = hostHiddenConsoleActive ? (argsOrOptions as childProcessModule.ExecFileSyncOptions | undefined) : withHiddenOptions(argsOrOptions as childProcessModule.ExecFileSyncOptions | undefined);
		return originals.execFileSync(file, next);
	}) as typeof childProcess.execFileSync);

	// builtin ESM 可能在补丁前已实例化；否则 runner 会漏掉 sidecar/preload 设置。
	syncBuiltinESMExports();
	return () => {
		for (const [name, value] of Object.entries(originals) as Array<[keyof typeof originals, unknown]>) {
			Object.defineProperty(childProcess, name, { value, writable: true, configurable: true });
		}
		syncBuiltinESMExports();
	};
}
