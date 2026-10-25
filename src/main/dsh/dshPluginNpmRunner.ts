/**
 * DSH 插件安装链路的 npm 子进程执行器与包名/spec 校验。
 *
 * 单独成模块的原因：IPC handler 只做形状校验，而「npm spec 是否安全可执行」「npm
 * 怎么跨平台跑起来」是业务逻辑且必须可单测（Windows .cmd 垫片坑与 PiLocator 同源）。
 * 启动规格不自己拼：Windows 的 cmd 层 / node 直启判断在 PiLocator.createInvocation
 * 里已实现并带安全校验，这里以结构子集复用（与 piGlobalInstall 同一适配面）。
 */
import { execFile } from "node:child_process";
import type { ExecFileException, ExecFileOptionsWithStringEncoding } from "node:child_process";

/**
 * 启动规格（PiLocator.createInvocation 的结构子集）：command 必须是
 * CreateProcess 能直接拉起的可执行文件（Windows 下绝不能是 npm.cmd 本身）。
 */
export type DshPluginNpmInvocation = {
	command: string;
	args: string[];
	shell?: boolean;
	pathPrefix?: string;
	windowsVerbatimArguments?: boolean;
};

/** 注入的启动规格解析器 + env 工厂（生产传 PiLocator 的结构适配；测试传假实现）。 */
export type DshPluginNpmLauncher = {
	createInvocation: (command: string, args: string[]) => DshPluginNpmInvocation;
	/** pathPrefix：把便携 node / 垫片目录前置进 PATH，让 npm 找到配套 node。 */
	createProcessEnv: (pathPrefix?: string) => NodeJS.ProcessEnv;
};

export type DshPluginNpmRunResult = {
	/** 进程退出码（spawn 层失败为 null）。 */
	code: number | null;
	stdout: string;
	stderr: string;
};

export type DshPluginNpmRunner = (args: readonly string[], options: { cwd?: string; timeoutMs?: number }) => Promise<DshPluginNpmRunResult>;

/** npm pack / search 的超时上限：registry 慢速（国内镜像）+ 代理场景留足余量。 */
export const DSH_PLUGIN_NPM_TIMEOUT_MS = 120_000;

/** npm 输出截断上限：只关心 JSON 结果，超长输出（进度条/告警）保尾部即可。 */
const MAX_OUTPUT_CHARS = 64_000;

/**
 * npm 包名（可带 @scope）的保守白名单：小写字母/数字/._-，scope 与名字各一段。
 * 拒绝的形态由分段结构天然排除：路径分隔符（../、..\\、/、\\）、裸 . 与 ..、
 * 起始 . 或 _（保留名）、npm 元包语法。
 */
const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/** 精确版本尾（@1.2.3 / @1.2.3-beta.1），不开放 range（^~><= 与 tag 均拒绝）。 */
const NPM_EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * 校验可安全传给 npm 的安装 spec：`name` 或 `name@exact-version`。
 * 这是 IPC 边界的第一道闸（渲染层数据一律不可信）：路径分隔符、range、相对路径
 * 全部拒绝——它们会被 npm 当作目录/git/URL 通道或触发版本漂移。
 */
export function validateNpmSpec(spec: string): { ok: true; name: string; version?: string } | { ok: false; reason: string } {
	const value = spec.trim();
	if (!value || value.length > 214) {
		return { ok: false, reason: "empty or oversized npm spec" };
	}
	const lastAt = value.lastIndexOf("@");
	// name@version 形态：@ 不在首位（首位 @ 是 scope 前缀）
	if (lastAt > 0) {
		const name = value.slice(0, lastAt);
		const version = value.slice(lastAt + 1);
		if (!NPM_EXACT_VERSION_RE.test(version)) {
			return { ok: false, reason: `unsupported version suffix "@${version}" (exact version only)` };
		}
		return NPM_PACKAGE_NAME_RE.test(name) ? { ok: true, name, version } : { ok: false, reason: `invalid npm package name: ${name}` };
	}
	if (!NPM_PACKAGE_NAME_RE.test(value)) {
		return { ok: false, reason: `invalid npm package name: ${value}` };
	}
	return { ok: true, name: value };
}

/** 输出超长时保尾部（JSON 结果在末尾，npm 的进度/告警输出在前面）。 */
function clampOutput(value: string): string {
	return value.length > MAX_OUTPUT_CHARS ? value.slice(value.length - MAX_OUTPUT_CHARS) : value;
}

/** execFile 的最小注入面（测试替身只关心 command/args/options）。 */
type ExecFileLike = (file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => unknown;

/** 取「为什么没跑起来」的文本：spawn 层错误（ENOENT/EACCES）只有 error.message 有信息。 */
function describeSpawnFailure(error: unknown): string {
	if (typeof error === "object" && error !== null && typeof Reflect.get(error, "message") === "string") {
		return String(Reflect.get(error, "message"));
	}
	return error ? String(error) : "";
}

/**
 * 构造 npm 执行器：数组传参、不经 shell 拼接（安全约束），超时 kill，
 * Windows 该有的 cmd 层由 createInvocation 显式补上。
 */
export function createDshPluginNpmRunner(launcher: DshPluginNpmLauncher, npmCommand = "npm", execFileImpl: ExecFileLike = execFile): DshPluginNpmRunner {
	return async (args, options) => {
		const invocation = launcher.createInvocation(npmCommand, [...args]);
		// 兜底闸门：.cmd/.bat 不能直接交给 execFile（CreateProcess 不认，静默 ENOENT）。
		if (/\.(?:cmd|bat)$/i.test(invocation.command.trim())) {
			return { code: null, stdout: "", stderr: `refusing to launch batch shim directly: ${invocation.command}` };
		}
		return new Promise<DshPluginNpmRunResult>((resolve) => {
			execFileImpl(
				invocation.command,
				invocation.args,
				{
					env: launcher.createProcessEnv(invocation.pathPrefix),
					cwd: options.cwd,
					timeout: options.timeoutMs ?? DSH_PLUGIN_NPM_TIMEOUT_MS,
					encoding: "utf8",
					windowsHide: true,
					shell: invocation.shell === true,
					windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
				},
				(error, stdout, stderr) => {
					const execError = error as ExecFileException | null;
					resolve({
						code: typeof execError?.code === "number" ? execError.code : error ? -1 : 0,
						stdout: clampOutput(stdout || ""),
						stderr: clampOutput(stderr || describeSpawnFailure(error)),
					});
				},
			);
		});
	};
}
