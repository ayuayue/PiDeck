import type { NpmAvailabilityResult, PiInstallation, PiInstallExecResult, PiRuntimeNodeInstallResult, PiRuntimeNodeStatus } from "../../../shared/types";

/**
 * 「一键安装 pi」的流程编排（纯函数，可单测）。
 *
 * 背景：环境检测弹窗里原本的三步引导要求用户依次点「一键安装便携 Node」→「检测 npm」→
 * 「一键安装 Pi」→「重新检测」。真正没装过 pi 的用户在新机器上根本不知道该点哪几步，
 * 卸载/重装后也常停在「检测 npm」这一步。这里把四步串成一次点击：
 *
 *   ① 检测 Node：系统 node 或便携副本任一可用即通过，都没有才下载便携副本（约 30 MB）；
 *   ② 确认 npm：系统 npm 优先。系统有 Node 但 npm 缺失（精简安装/损坏）时，才回退装一次
 *      内置便携 Node（自带 npm）再重试；这是「不到万不得已不用内置 node/npm」的落点；
 *   ③ 安装 pi：走主进程收紧通道 `pi:runtime-pi-install`（命令由主进程拼接）；
 *   ④ 重新检测：装完立刻重跑环境检测，让弹窗自己切到「检测通过」。
 *
 * 边界（与主进程约定一致）：
 * - 本机已装 pi 时主进程会拦下安装并回传 `alreadyInstalled`，此时不当作失败：
 *   直接重新检测一次，检测得到就切成功态，检测不到交给用户手动指定路径。
 * - 只有 Node 一步允许「跳过」（系统已有 node）；npm / pi / 重新检测失败都必须停下来，
 *   不猜测修复方式，把 detail 原文交给界面展示。
 * - 不吞异常：每个依赖调用都转成结构化失败，调用方（hook）只负责映射文案与状态。
 */

/** 一键安装的四段流程（顺序即执行顺序）。 */
export type PiOneClickStep = "node" | "npm" | "pi" | "recheck";

export type PiOneClickProgress = {
	step: PiOneClickStep;
	/** running = 当前正在执行；done = 该步已完成（含「系统 node 已就绪」这种跳过） */
	status: "running" | "done";
};

/** 失败原因：界面按它选文案，detail 只放原始错误/输出片段。 */
export type PiOneClickFailureReason = "node-unsupported" | "node-prepare" | "npm-missing" | "pi-install" | "pi-undetected";

export type PiOneClickOutcome =
	/** 安装完成且重新检测到可用的 pi */
	| { status: "installed" }
	/** 主进程拦下安装：本机已有 pi。detected = 随后的重新检测是否真的找到了它 */
	| { status: "already-installed"; installations: PiInstallation[]; detected: boolean }
	| { status: "failed"; step: PiOneClickStep; reason: PiOneClickFailureReason; detail?: string };

export type PiOneClickDeps = {
	runtimeNodeCheck: () => Promise<PiRuntimeNodeStatus>;
	runtimeNodeInstall: () => Promise<PiRuntimeNodeInstallResult>;
	checkNpm: () => Promise<NpmAvailabilityResult>;
	runtimePiInstall: (useMirror: boolean) => Promise<PiInstallExecResult>;
	/** 重新检测环境，返回「是否检测到可用的 pi」 */
	recheck: () => Promise<boolean>;
};

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 执行一键安装。
 *
 * @param deps 主进程能力（由 hook 注入，测试里换假实现）
 * @param options.useMirror 是否走国内镜像（只传给主进程的安装通道）
 * @param options.onProgress 进度回调：每步开始/结束时各触发一次
 */
export async function runPiOneClickInstall(deps: PiOneClickDeps, options: { useMirror: boolean; onProgress?: (progress: PiOneClickProgress) => void }): Promise<PiOneClickOutcome> {
	const report = (step: PiOneClickStep, status: PiOneClickProgress["status"]) => options.onProgress?.({ step, status });

	/** npm 探测：失败转成结构化结果，避免在降级逻辑里反复 try/catch。 */
	const checkNpm = async (): Promise<NpmAvailabilityResult> => {
		try {
			return await deps.checkNpm();
		} catch (error) {
			return { available: false, error: errorDetail(error) };
		}
	};

	// ① Node：已有系统 node 就不动用户环境；只有完全没有时才装便携副本。
	report("node", "running");
	let nodeStatus: PiRuntimeNodeStatus;
	try {
		nodeStatus = await deps.runtimeNodeCheck();
	} catch (error) {
		return { status: "failed", step: "node", reason: "node-prepare", detail: errorDetail(error) };
	}
	// 便携 Node 当前是否可用（已有副本或本次刚装上）。npm 回退只补「系统有 node 但没 npm」
	// 这一种情形；刚装完便携 Node 仍然没 npm 再装一遍是重复下载，不做事。
	let portableReady = Boolean(nodeStatus.installed);
	if (!nodeStatus.installed && !nodeStatus.systemNodeAvailable) {
		if (nodeStatus.installSupported === false) {
			return { status: "failed", step: "node", reason: "node-unsupported", detail: nodeStatus.error };
		}
		let nodeInstall: PiRuntimeNodeInstallResult;
		try {
			nodeInstall = await deps.runtimeNodeInstall();
		} catch (error) {
			return { status: "failed", step: "node", reason: "node-prepare", detail: errorDetail(error) };
		}
		if (!nodeInstall.ok) {
			return { status: "failed", step: "node", reason: "node-prepare", detail: nodeInstall.error };
		}
		portableReady = true;
	}
	report("node", "done");

	// ② npm：系统 npm 优先（主进程的搜索目录已把系统目录排在便携目录之前）。
	// 只有系统有 Node 但 npm 缺失（精简安装/损坏）时才补装一次便携 Node，否则不去碰内置副本。
	report("npm", "running");
	let npm = await checkNpm();
	if (!npm.available && !portableReady && nodeStatus.installSupported !== false) {
		let fallbackInstall: PiRuntimeNodeInstallResult;
		try {
			fallbackInstall = await deps.runtimeNodeInstall();
		} catch (error) {
			return { status: "failed", step: "npm", reason: "npm-missing", detail: errorDetail(error) };
		}
		if (!fallbackInstall.ok) {
			return { status: "failed", step: "npm", reason: "npm-missing", detail: fallbackInstall.error };
		}
		portableReady = true;
		npm = await checkNpm();
	}
	if (!npm.available) {
		return { status: "failed", step: "npm", reason: "npm-missing", detail: npm.error };
	}
	report("npm", "done");

	// ③ 安装 pi（主进程会先挡「本机已有 pi」，命中时 alreadyInstalled 非空）。
	report("pi", "running");
	let install: PiInstallExecResult;
	try {
		install = await deps.runtimePiInstall(options.useMirror);
	} catch (error) {
		return { status: "failed", step: "pi", reason: "pi-install", detail: errorDetail(error) };
	}
	if (install.alreadyInstalled && install.alreadyInstalled.length > 0) {
		// 不是失败：本机已经有一份能跑的 pi，只是初始检测没找到（PATH/版本管理器/GUI 环境差异）。
		// 重新检测一次，让弹窗自己切到成功态；检测不到再把列表交回界面。
		const detected = await safeRecheck(deps.recheck);
		return { status: "already-installed", installations: install.alreadyInstalled, detected };
	}
	if (!install.success || install.exitCode !== 0) {
		return { status: "failed", step: "pi", reason: "pi-install", detail: (install.stderr || install.stdout || "").trim() || undefined };
	}
	report("pi", "done");

	// ④ 装完立刻重新检测：用户不需要再点「重新检测」。
	report("recheck", "running");
	const detected = await safeRecheck(deps.recheck);
	if (!detected) {
		return { status: "failed", step: "recheck", reason: "pi-undetected" };
	}
	report("recheck", "done");
	return { status: "installed" };
}

/** 重新检测失败（IPC 抛错）按「没检测到」处理：安装本身已经成功，不把异常升级成安装失败。 */
async function safeRecheck(recheck: () => Promise<boolean>): Promise<boolean> {
	try {
		return await recheck();
	} catch {
		return false;
	}
}
