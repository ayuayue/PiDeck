/**
 * DSH runtime 安装态契约（AgentRuntimeProvider 阶段 1，docs/dsh-runtime-optional-plan.md）。
 *
 * 阶段 1：dsh runtime 仍随包分发，探测恒为 installed；本契约先把「runtime 是否可用」
 * 做成一等状态并据此门控 UI。阶段 2 把状态源换成真实的外部 runtime 探测
 * （userData/runtimes/dsh/<version>/manifest.json），UI 消费方零改动。
 *
 * 本文件保持纯类型 + 纯函数（无任何运行时层依赖），主/渲染两侧与 node 单测共享。
 */
import type { AgentBackend } from "./agent";

/** DSH runtime 安装态。 */
export type DshRuntimeState =
	/** runtime 可用（内置 node_modules 可解析 / 外部 runtime manifest 兼容）。 */
	| "installed"
	/** runtime 未安装（阶段 2 的 lite 分发形态；引导下载/手动导入）。 */
	| "notInstalled"
	/** 初值：渲染层尚未拿到主进程探测结果。 */
	| "checking"
	/** 已安装但不可用（manifest 版本区间不兼容 / payload 校验失败）。 */
	| "broken";

/** runtime 来源：内置（随包分发，阶段 1 形态）还是外部安装（阶段 2 形态）。 */
export type DshRuntimeSource = "builtin" | "managed";

/** DSH runtime 状态快照（IPC：dsh-runtime:get-status / dsh-runtime:status-changed）。 */
export type DshRuntimeStatus = {
	state: DshRuntimeState;
	/** 外部 runtime 版本（manifest.runtimeVersion）；内置分发为 app 内置 dsh 版本。 */
	runtimeVersion?: string;
	/** runtime 来源；notInstalled 时缺省。 */
	source?: DshRuntimeSource;
	/** broken 的原因，供 UI 展示（版本不兼容 / 校验失败 / 清单不可读）。 */
	reason?: string;
	/** 已安装 runtime 的落盘目录（外部 managed 时 = runtimesRoot/<version>；内置/builtin 或未安装时缺省）。 */
	installDir?: string;
	/** 是否允许在线下载安装 runtime（app.isPackaged）：dev 模式禁止下载——runtime 随
	 *  打包分发，开发环境不提供在线安装，避免用户误下 dev 不配套的产物。 */
	installEnabled?: boolean;
};

/** 状态 → DSH UI 可见性矩阵（纯函数，单测覆盖见 tests/dshRuntimeStatus.test.mjs）。 */
export type DshUiVisibility = {
	/** 允许新建 DSH 会话 / 把默认后端选为 dsh（仅 installed）。 */
	canCreateDshSession: boolean;
	/** 渲染 DSH 配置表单（供应商/模型/插件/凭据）；非 installed 整体替换为安装引导。 */
	showDshConfigForms: boolean;
	/** 显示「安装 DSH 后端」引导卡。 */
	showInstallGuide: boolean;
	/** 是否显示「在线下载安装/重装」按钮（dev 模式为 false：runtime 随打包分发，开发环境不下载）。 */
	showRuntimeDownload: boolean;
};

export function dshUiVisibilityFor(state: DshRuntimeState, installEnabled = true): DshUiVisibility {
	const installed = state === "installed";
	return {
		canCreateDshSession: installed,
		showDshConfigForms: installed,
		showInstallGuide: !installed && state !== "checking",
		showRuntimeDownload: installEnabled,
	};
}

/** 安装/更新 runtime 的阶段（UI 进度条与文案据此切换）。 */
export type DshRuntimeInstallPhase =
	| "downloading"
	| "verifying"
	| "extracting"
	| "finalizing"
	| "done"
	| "error";

/** 安装进度事件（IPC dsh-runtime:install-progress 推送）。 */
export type DshRuntimeInstallProgress = {
	phase: DshRuntimeInstallPhase;
	/** 0-100：downloading 按已收字节占比，其余阶段取阶段内离散值。 */
	percent: number;
	/** 正在安装的版本（downloading 起即可知）。 */
	runtimeVersion?: string;
	/** phase=error 时的用户可见原因（已 i18n 处理后的文案由主进程填）。 */
	error?: string;
};

/**
 * dsh 会话发送/重启的拦截原因（纯函数，单测覆盖见 tests/dshRuntimeStatus.test.mjs）。
 *
 * 为什么需要：DSH host fork 依赖 @deepseek-ai/dsh-base 产物，runtime 缺失/损坏时
 * 主进程只会抛模块解析的裸报错（Cannot find module …）。渲染层在发送/激活前据此
 * 拦截并给出「去安装」友好提示，而不是把底层错误直接甩给用户。
 * checking（状态未定）不算拦截：避免启动首帧把正常发送误拦。
 */
export type DshSendBlockReason = "notInstalled" | "broken";

export function dshSendBlockReason(
	state: DshRuntimeState,
): DshSendBlockReason | null {
	if (state === "notInstalled") return "notInstalled";
	if (state === "broken") return "broken";
	return null;
}

/**
 * 设置项 defaultAgentBackend 的有效值（纯函数）：
 * runtime 非 installed 时 dsh 强制回落 pi——防御「设置残留 dsh 但 runtime 已不可用」
 * （阶段 2 升级/卸载场景），新建会话链路不会因后端不可用而裸报错。
 * "imagegen" 后端不受 DSH runtime 影响，原样透传。
 */
export function resolveEffectiveAgentBackend(
	backend: AgentBackend,
	dshState: DshRuntimeState,
): AgentBackend {
	if (backend === "dsh" && dshState !== "installed") return "pi";
	return backend;
}
