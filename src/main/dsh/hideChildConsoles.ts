import { createRequire } from "node:module";
import { join } from "node:path";
import type * as childProcessModule from "node:child_process";

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
 * 背景（2026-08 实测结论，替代旧的"全量注入 windowsHide"方案）：
 * - DSH host 运行在 Electron utilityProcess 里（GUI 子系统、无控制台）。
 * - child_process.spawn 从无控制台父进程拉起控制台子程序时，libuv 自动带
 *   CREATE_NO_WINDOW——子进程无控制台、不弹窗（spawn 矩阵实测：无控制台父进程
 *   + pipe stdio 的四种 windowsHide 组合，子进程全部 console=False）。因此旧方案
 *   注入 windowsHide 对本地路径毫无作用；且把子进程变成"无控制台"后，若子进程
 *   再拉起控制台程序（cmd 内部再执行等），Windows 会为孙进程新建可见控制台。
 * - 真正的黑窗口来源是沙箱 runner：host 以 GUI 二进制（electron.exe）拉起 runner，
 *   GUI 进程不继承父进程控制台（实测）；runner 用 koffi 直接调
 *   CreateProcessAsUserW(dwCreationFlags=0)（绕过 child_process，补丁够不着），
 *   父进程无控制台时 Windows 为命令进程新建可见控制台窗口。runner 源码注释说明
 *   受限 token 下子进程自行创建控制台会 STATUS_DLL_INIT_FAILED(0xC0000142) 崩溃，
 *   因此不能靠 CREATE_NO_WINDOW——正确做法是让 runner 自身持有隐藏控制台，
 *   子进程继承（继承≠创建，实测受限 token 下继承控制台正常运行）。
 *
 * 治理策略（两级，见 installHostHiddenConsole / installHiddenConsolePatch）：
 * 1) host boot 时用 koffi AllocConsole + SW_HIDE 给 host 分配隐藏控制台。
 *    此后所有 console 子系统子进程（pwsh/git/taskkill/cmd…）与孙进程都继承该
 *    隐藏控制台——整棵树零可见窗口。
 * 2) child_process 补丁仅在分配失败时退回旧的 windowsHide 注入（兜底：直接
 *    子进程至少不弹窗）；并对沙箱 runner 的 spawn 注入
 *    NODE_OPTIONS=--require=<runnerConsolePreload>：runner 不继承 host 控制台，
 *    由 preload 在 runner 进程内自建隐藏控制台。
 *
 * 误判边界（2026-09 实测）：`GetConsoleWindow() == NULL` 并不等于「无控制台”——
 * MSDN 明确 NULL = 没有控制台或**不是窗口式控制台**（ConPTY 终端即属后者）。
 * 此时 `AllocConsole()` 会以 ERROR_ACCESS_DENIED(5) 失败；原实现把它当「分配
 * 失败」退回 windowsHide，反而让子进程失去可继承控制台、孙进程（如 pwsh 里再
 * 跑 git/npm/cmd）新建可见控制台。现按错误码 5 判为 inherited-windowless
 * （继承即可，ConPTY 无窗口），并暴露 getHiddenConsoleMode() 供启动日志诊断。
 */

/** koffi 运行时 FFI 接口子集（测试注入假实现，避免依赖真实原生模块）。 */
export interface Win32Ffi {
	load(name: string): {
		func(signature: string): (...args: unknown[]) => unknown;
	};
}

/** host 是否已持有隐藏控制台（installHostHiddenConsole 置位；补丁据此决定是否注入 windowsHide）。 */
let hostHiddenConsoleActive = false;

/** runner spawn 策略日志只打一次（避免沙箱每次调用都刷日志）。 */
let runnerPolicyLogged = false;

/** ERROR_ACCESS_DENIED：AllocConsole 失败码 5 = 进程已附带控制台（见下）。 */
const ERROR_ACCESS_DENIED = 5;

/**
 * host 控制台治理模式（诊断：hostEntry 启动时打印一次，排查黑窗口用）。
 * - inherited-windowless：AllocConsole 失败且错误码 5——已附带控制台但
 *   GetConsoleWindow 为 NULL（ConPTY / 无窗口控制台）。子进程继承即可，
 *   不存在可见窗口需要隐藏；这是 2026-09 实测出的误判分支（原代码把该
 *   情形当「分配失败」退回 windowsHide，反而切断继承、孙进程弹黑窗口）。
 */
export type HiddenConsoleMode =
	| "off" // 非 win32：不治理
	| "inherited-windowed" // GetConsoleWindow 非空：已有控制台，子进程继承
	| "inherited-windowless" // 已附带控制台但无窗口（ConPTY）：继承即可，无需隐藏
	| "allocated" // AllocConsole 成功：host 自建隐藏控制台
	| "failed"; // 分配失败：退回 windowsHide 注入兜底

let hiddenConsoleMode: HiddenConsoleMode = "off";

/** 当前控制台治理模式（hostEntry 诊断日志用）。 */
export function getHiddenConsoleMode(): HiddenConsoleMode {
	return hiddenConsoleMode;
}

/**
 * 给当前进程分配隐藏控制台（win32 only；platform/ffi 可注入以便测试）。
 *
 * utilityProcess 无控制台，分配后所有 console 子系统子进程都会继承它——
 * 这是让整棵进程树（含孙进程）都不弹窗的根本手段。已有控制台（终端拉起等
 * 场景）或分配失败时：已有控制台视为成功（继承即可），分配失败返回 false
 * （调用方退回 windowsHide 注入兜底）。所有异常静默。
 */
export function installHostHiddenConsole(
	platform: NodeJS.Platform = process.platform,
	ffi?: Win32Ffi,
): boolean {
	hostHiddenConsoleActive = false;
	if (platform !== "win32") {
		hiddenConsoleMode = "off";
		return false;
	}
	try {
		const koffi = ffi ?? (createRequire(__filename)("koffi") as Win32Ffi);
		const kernel32 = koffi.load("kernel32.dll");
		const user32 = koffi.load("user32.dll");
		const getConsoleWindow = kernel32.func("void* GetConsoleWindow(void)") as () => unknown;
		const allocConsole = kernel32.func("int AllocConsole(void)") as () => number;
		const showWindow = user32.func("int ShowWindow(void* hWnd, int nCmdShow)") as (
			hWnd: unknown,
			nCmdShow: number,
		) => number;
		if (getConsoleWindow()) {
			// 已有控制台：子进程本就继承它，无需再分配（utilityProcess 不应出现，防御）。
			hostHiddenConsoleActive = true;
			hiddenConsoleMode = "inherited-windowed";
			return true;
		}
		if (allocConsole() === 0) {
			// GetConsoleWindow 为 NULL ≠ 无控制台（MSDN：NULL = 没有控制台或不是窗口式控制台）。
			// AllocConsole 失败且错误码 5（ERROR_ACCESS_DENIED）说明进程已附带控制台
			//（ConPTY 终端/Windows Terminal/VS Code 起到的进程都这样）。此时按「已持有」处理：
			// 子进程继承该控制台即可，不存在可见窗口需要隐藏；若误判为失败退回 windowsHide
			// 注入，反而让子进程失去可继承控制台、孙进程新建可见控制台（黑窗口）。
			let lastError: number | undefined;
			try {
				// GetLastError 必须在紧跟的语句取（期间不能插其它 Win32 调用）。
				lastError = (kernel32.func("uint32 GetLastError(void)") as () => number)();
			} catch {
				lastError = undefined; // ffi 未提供（老测试替身）：按旧行为兜底
			}
			if (lastError === ERROR_ACCESS_DENIED) {
				hostHiddenConsoleActive = true;
				hiddenConsoleMode = "inherited-windowless";
				return true;
			}
			hiddenConsoleMode = "failed";
			return false;
		}
		// conhost 窗口创建是异步的：AllocConsole 返回时 GetConsoleWindow 经常仍是 0，
		// 只在已有句柄时 setInterval 会漏掉随后弹出的窗口（DSH 加载「一闪而过」的框）。
		// 无论首帧有没有句柄都轮询隐藏，覆盖整段创建窗口期。
		const hideConsole = () => {
			const hwnd = getConsoleWindow();
			if (hwnd) showWindow(hwnd, 0); // SW_HIDE = 0
		};
		hideConsole();
		const hideTimer = setInterval(hideConsole, 16);
		setTimeout(() => clearInterval(hideTimer), 1000);
		hideTimer.unref?.();
		hostHiddenConsoleActive = true;
		hiddenConsoleMode = "allocated";
		return true;
	} catch {
		hiddenConsoleMode = "failed";
		return false; // koffi 缺失/调用失败：退回 windowsHide 注入兜底
	}
}

/** 未显式指定 windowsHide 时注入 true；已指定则尊重原值（Node 默认 false）。 */
export function hiddenConsoleOptions<T extends { windowsHide?: boolean }>(
	options: T | undefined,
): T | undefined {
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
 * pwsh 挂起兜底（实测：host 内普通 pwsh 调用约 8% 概率「命令执行完不退出」，
 * 直到工具超时被回收——用户可见为每次调用慢/超时）：
 * 1. stdin 从 pipe 改 ignore：pwsh 不会等待管道 EOF（已知的挂起形态之一）；
 *    工具命令本就没有 stdin 输入通道，无行为差异。
 * 2. `-Command` 命令末尾追加换行 + `exit $LASTEXITCODE`：无论挂起原因，
 *    命令执行完都强制退出。
 */
function withPwshHangGuard(
	args: readonly string[],
	options: childProcessModule.SpawnOptions | undefined,
): { args: readonly string[]; options: childProcessModule.SpawnOptions | undefined } {
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
function withPwshStartupEnv(
	options: childProcessModule.SpawnOptions | undefined,
	isPwsh: boolean,
): childProcessModule.SpawnOptions | undefined {
	if (!isPwsh || options === undefined || options.env === undefined) return options;
	return { ...options, env: { ...options.env, ...PWSH_STARTUP_ENV } };
}

/**
 * 沙箱 runner 的 spawn 需要注入 NODE_OPTIONS=--require=<preload>：
 * runner 由 GUI 二进制（electron.exe）拉起、不继承 host 控制台，由 preload
 * （runnerConsolePreload）在 runner 进程内自建隐藏控制台，CreateProcessAsUserW
 * 的子进程继承后不再弹窗。env 缺失时跳过（真实链路 spawnSubprocess 恒带 env）。
 */
function withRunnerPreload(
	options: childProcessModule.SpawnOptions | undefined,
	runnerPreloadPath: string,
): childProcessModule.SpawnOptions | undefined {
	if (options === undefined || options.env === undefined) return options;
	const existing = options.env.NODE_OPTIONS;
	// Windows 上 Node 解析 NODE_OPTIONS 时按命令行分词、反斜杠当转义符：
	// `--require="C:\path\a.js"` 会被解析成 `C:patha.js`（MODULE_NOT_FOUND）。
	// 必须把反斜杠翻倍（`\\` → `\`），否则 runner preload 加载失败、沙箱调用全挂。
	const preload = `--require="${runnerPreloadPath.replace(/\\/g, "\\\\")}"`;
	return {
		...options,
		env: {
			...options.env,
			NODE_OPTIONS: existing ? `${existing} ${preload}` : preload,
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
function withRunnerRunAsNode(
	options: childProcessModule.SpawnOptions | undefined,
): childProcessModule.SpawnOptions | undefined {
	if (options === undefined || options.env === undefined) return options;
	if (options.env.ELECTRON_RUN_AS_NODE === "1") return options;
	return { ...options, env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" } };
}

/** 本次 spawn 的 argv 是否指向沙箱 runner（argv 内含 runner.js/runner.ts 路径）。 */
function isRunnerSpawn(command: string, args: readonly string[] | undefined): boolean {
	if (args === undefined) return false;
	return args.some((arg) => typeof arg === "string" && RUNNER_SCRIPT_RE.test(arg));
}

/**
 * 安装补丁（win32 only；platform 可注入以便测试）。返回还原函数。
 * 必须在 DSH 各包动态 import 之前调用：dsh-subprocess-local 等模块加载时会捕获
 * child_process.spawn 的引用，补丁先于加载才覆盖得到。
 *
 * 行为：
 * - host 隐藏控制台生效（installHostHiddenConsole 成功）：不注入 windowsHide，
 *   让子进程继承隐藏控制台（注入 CREATE_NO_WINDOW 反而切断继承、孙进程可能弹窗）。
 * - 分配失败（兜底）：注入 windowsHide（CREATE_NO_WINDOW，直接子进程无窗口）。
 * - 两种模式下都对沙箱 runner 的 spawn 注入 NODE_OPTIONS preload。
 *
 * 注意：Node 24+ 的内置模块 CJS exports 是只读 getter（plain 赋值会抛
 * "Cannot set property ... which has only a getter"），必须用 defineProperty；
 * 该属性 configurable=true，且 ESM 侧 `import { spawn } from "node:child_process"`
 * 是 live binding——defineProperty 替换后，后续动态 import 的 dsh 包读到的就是补丁版。
 */
export function installHiddenConsolePatch(
	platform: NodeJS.Platform = process.platform,
	runnerPreloadPath: string = join(__dirname, "runnerConsolePreload.js"),
): () => void {
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
	function replaceExport<K extends keyof typeof childProcess>(
		name: K,
		value: typeof childProcess[K],
	): void {
		Object.defineProperty(childProcess, name, {
			value,
			writable: true,
			configurable: true,
		});
	}

	/**
	 * 一次 spawn 的 options 决策：runner spawn 恒注入 preload + pwsh 启动环境
	 * （沙箱 pwsh 继承 runner env）；本地 pwsh spawn 注入启动环境；普通 spawn 按
	 * host 隐藏控制台是否生效决定 windowsHide 注入与否。
	 */
	function resolveSpawnOptions(
		command: string,
		args: readonly string[] | undefined,
		options: childProcessModule.SpawnOptions | undefined,
	): childProcessModule.SpawnOptions | undefined {
		if (isRunnerSpawn(command, args)) {
			// 诊断（一次性）：确认沙箱 runner spawn 确实被注入 preload 与
			// ELECTRON_RUN_AS_NODE。这是「沙箱命令不弹黑窗口」的关键：runner 是 GUI
			// 进程、不继承 host 控制台，若注入失效（argv 形态变化 / preload 文件缺失），
			// 沙箱内命令（pwsh/git 等）会新建可见控制台。走 stderr 落主进程日志。
			if (!runnerPolicyLogged) {
				runnerPolicyLogged = true;
				console.error(
					`[dsh-host-entry] runner spawn policy: hostHiddenConsoleActive=${String(hostHiddenConsoleActive)} ` +
						`preload=${runnerPreloadPath}`,
				);
			}
			return withRunnerPreload(
				withRunnerRunAsNode(
					withPwshStartupEnv(hostHiddenConsoleActive ? options : withHiddenOptions(options), true),
				),
				runnerPreloadPath,
			);
		}
		if (isPwshCommand(command)) {
			return withPwshStartupEnv(hostHiddenConsoleActive ? options : withHiddenOptions(options), true);
		}
		return hostHiddenConsoleActive ? options : withHiddenOptions(options);
	}

	// spawn(command[, args][, options])：options 在第 2 位（无 args）或第 3 位。
	replaceExport("spawn", ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, maybeOptions?: SpawnOptions) => {
		if (Array.isArray(argsOrOptions)) {
			// pwsh 挂起兜底：改写 args（追加 exit）与 options（stdin ignore）。
			// 沙箱 runner：-- 尾部的 pwsh -Command 同样追加 exit——沙箱内 pwsh 由
			// runner 用 CreateProcessAsUserW 直接拉起（绕过 child_process，补丁够
			// 不着子进程本身），只能在 runner spawn 边界改写 argv。2026-09-12 实测：
			// 沙箱内 pwsh 输出完成后不退出（4/4 挂满 120s 工具超时，定时任务回合
			// 因此跑满 9 分钟、run 状态一直「运行中」），与 host 本地挂起同根因——
			// 沙箱里 pwsh 的 stdin 是 runner 持有的捕获管道，挂起从偶发变确定性。
			// 注意 stdio 不动：runner 可能用 stdin pipe 向受限命令传数据。
			const guarded = isPwshCommand(command)
				? withPwshHangGuard(argsOrOptions, maybeOptions)
				: isRunnerSpawn(command, argsOrOptions)
					? { args: withPwshExitAppend(argsOrOptions), options: maybeOptions }
					: { args: argsOrOptions, options: maybeOptions };
			const next = resolveSpawnOptions(command, guarded.args, guarded.options);
			return next === undefined
				? originals.spawn(command, guarded.args)
				: originals.spawn(command, guarded.args, next);
		}
		const next = resolveSpawnOptions(command, undefined, argsOrOptions as SpawnOptions | undefined);
		return next === undefined ? originals.spawn(command) : originals.spawn(command, next);
	}) as typeof childProcess.spawn);

	// spawnSync 与 spawn 同形态（沙箱探测 spawnSync 也走 runner 分支，argv 改写无害）。
	replaceExport("spawnSync", ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, maybeOptions?: SpawnOptions) => {
		if (Array.isArray(argsOrOptions)) {
			const guarded = isPwshCommand(command)
				? withPwshHangGuard(argsOrOptions, maybeOptions)
				: isRunnerSpawn(command, argsOrOptions)
					? { args: withPwshExitAppend(argsOrOptions), options: maybeOptions }
					: { args: argsOrOptions, options: maybeOptions };
			const next = resolveSpawnOptions(command, guarded.args, guarded.options);
			return next === undefined
				? originals.spawnSync(command, guarded.args)
				: originals.spawnSync(command, guarded.args, next);
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
			return callback === undefined
				? execFileLike(file, args, next)
				: execFileLike(file, args, next, callback);
		}
		const options = rest[0] as childProcessModule.ExecFileOptions | undefined;
		const next = hostHiddenConsoleActive ? options : withHiddenOptions(options);
		return callback === undefined
			? execFileLike(file, next)
			: execFileLike(file, next, callback);
	}) as typeof childProcess.execFile);

	// execFileSync(file[, args][, options])：与 execFile 同形态（无 callback）。
	replaceExport("execFileSync", ((file: string, argsOrOptions?: readonly string[] | childProcessModule.ExecFileSyncOptions, maybeOptions?: childProcessModule.ExecFileSyncOptions) => {
		if (Array.isArray(argsOrOptions)) {
			const next = hostHiddenConsoleActive ? maybeOptions : withHiddenOptions(maybeOptions);
			return originals.execFileSync(file, argsOrOptions, next);
		}
		const next = hostHiddenConsoleActive ? argsOrOptions as childProcessModule.ExecFileSyncOptions | undefined : withHiddenOptions(argsOrOptions as childProcessModule.ExecFileSyncOptions | undefined);
		return originals.execFileSync(file, next);
	}) as typeof childProcess.execFileSync);

	return () => {
		for (const [name, value] of Object.entries(originals) as Array<[keyof typeof originals, unknown]>) {
			Object.defineProperty(childProcess, name, { value, writable: true, configurable: true });
		}
	};
}
