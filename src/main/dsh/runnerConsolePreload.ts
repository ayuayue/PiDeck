import { createRequire, syncBuiltinESMExports } from "node:module";
import { DSH_RUNNER_NODE_ENV } from "./dshRunnerNodeSidecar";
import { allocHiddenConsole } from "./allocHiddenConsole";

/**
 * 沙箱 runner 进程内的控制台治理（win32）。
 *
 * 两条路径：
 * 1) CUI node sidecar：第一级已是 node.exe + CREATE_NO_WINDOW（无窗口可继承
 *    控制台）。此 preload 不再 AllocConsole。嵌套 ACL runner 若仍是 electron.exe，
 *    改写成同一 sidecar，并保持 windowsHide——第二级自建无窗口控制台，
 *    CreateProcessAsUserW 的 pwsh 继承即可。
 * 2) 旧路径（无 sidecar 的 electron.exe + ELECTRON_RUN_AS_NODE）：GUI 进程
 *    没有可继承控制台，经 allocHiddenConsole 在私有窗口站上分配（不闪窗）；
 *    建站失败才退回 AllocConsole + SW_HIDE。
 *
 * 由 host 补丁通过 NODE_OPTIONS=--require 注入。失败路径静默。
 */
interface KoffiLike {
	load(name: string): {
		func(signature: string): (...args: unknown[]) => unknown;
	};
}

const RUNNER_SCRIPT_RE = /runner\.(js|ts)$/i;

function resolveKoffi(): KoffiLike | undefined {
	const envModulePath = process.env.PIDECK_KOFFI_MODULE;
	if (envModulePath) {
		try {
			return createRequire(__filename)(envModulePath) as KoffiLike;
		} catch {
			// env 指向的模块不可用（runtime 被卸载/升级窗口期）：继续常规解析
		}
	}
	try {
		return createRequire(__filename)("koffi") as KoffiLike;
	} catch {
		return undefined;
	}
}

function isElectronExec(): boolean {
	return /(^|[\\/])electron(\.exe)?$/i.test(process.execPath);
}

function isRunnerArgs(args: unknown): args is readonly string[] {
	return Array.isArray(args) && args.some((arg) => typeof arg === "string" && RUNNER_SCRIPT_RE.test(arg));
}

function isElectronCommand(command: unknown): command is string {
	return typeof command === "string" && /(^|[\\/])electron(\.exe)?$/i.test(command);
}

/**
 * 第一级 runner 再 spawn 第二级 ACL runner：有 sidecar 时改写成 node.exe，
 * 并带 CREATE_NO_WINDOW。无 sidecar 的 electron 嵌套保持 windowsHide:false，
 * 以便继承本进程 AllocConsole 出的隐藏控制台。
 */
function patchNestedRunnerWindowsHide(): void {
	if (process.platform !== "win32") return;
	try {
		const childProcess = createRequire(__filename)("node:child_process") as {
			spawn: (...args: unknown[]) => unknown;
			spawnSync: (...args: unknown[]) => unknown;
		};
		const originals = {
			spawn: childProcess.spawn,
			spawnSync: childProcess.spawnSync,
		};
		const sidecar = process.env[DSH_RUNNER_NODE_ENV]?.trim();
		const wrap = (orig: (...args: unknown[]) => unknown) => (command: unknown, argsOrOptions?: unknown, maybeOptions?: unknown) => {
			if (isRunnerArgs(argsOrOptions)) {
				const nextCommand = sidecar && isElectronCommand(command) ? sidecar : command;
				const useSidecarConsole = Boolean(sidecar) && !isElectronCommand(nextCommand);
				const nextOptions = {
					...((maybeOptions && typeof maybeOptions === "object" ? maybeOptions : {}) as object),
					windowsHide: useSidecarConsole ? true : false,
				};
				return orig(nextCommand, argsOrOptions, nextOptions);
			}
			return orig(command, argsOrOptions, maybeOptions);
		};
		Object.defineProperty(childProcess, "spawn", {
			value: wrap(originals.spawn),
			writable: true,
			configurable: true,
		});
		Object.defineProperty(childProcess, "spawnSync", {
			value: wrap(originals.spawnSync),
			writable: true,
			configurable: true,
		});
		// 嵌套 runner 使用 ESM 的 child_process，CJS 补丁必须同步到 builtin binding。
		syncBuiltinESMExports();
	} catch {
		// 补丁失败时保持 runner 原有行为
	}
}

function installRunnerHiddenConsole(): void {
	if (process.platform !== "win32") return;
	// sidecar / 已是 node.exe：已有无窗口控制台，AllocConsole 会再闪一帧。
	if (!isElectronExec()) return;
	allocHiddenConsole(process.platform, resolveKoffi());
}

patchNestedRunnerWindowsHide();
installRunnerHiddenConsole();
