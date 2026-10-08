/**
 * DSH runtime 安装态契约（AgentRuntimeProvider，docs/dsh-runtime-optional-plan.md）。
 *
 * 官方安装包默认 lite：不随 runtime。dev 与打包版统一先探测外部
 * userData/runtimes/dsh/<version>；仅依赖分区前的存量 full 包可额外回退随包资源，
 * 都没有才是 notInstalled（引导从 latest 应用 Release 按需下载）。dev 不把项目
 * node_modules 的 @deepseek-ai 当作已发布 runtime。UI 按本契约门控，不直接绑分发形态。
 *
 * 本文件保持纯类型 + 纯函数（无任何运行时层依赖），主/渲染两侧与 node 单测共享。
 */
import type { AgentBackend } from "./agent";
import { compareSemver } from "./dshRuntimeManifest";

/** DSH runtime 安装态。 */
export type DshRuntimeState =
	/** runtime 可用（内置 node_modules 可解析 / 外部 runtime manifest 兼容且版本匹配）。 */
	| "installed"
	/** runtime 未安装（阶段 2 的 lite 分发形态；引导下载/手动导入）。 */
	| "notInstalled"
	/** 初值：渲染层尚未拿到主进程探测结果。 */
	| "checking"
	/** 已安装但不可用（manifest 版本区间不兼容 / payload 校验失败）。 */
	| "broken"
	/** 版本不一致（已装 runtime ≠ 本版本 app 声明的配套版本）。硬门控：桥协议/插件
	 *  表可能已变，旧 runtime「能启动」不代表「能工作」，禁止启动 host 并强制重装。 */
	| "outdated";

/** runtime 来源：内置存量包回退，或 userData 下的外部安装。 */
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
	/** 是否显示在线下载安装 runtime。dev 与打包版统一走 Release 索引，均为 true；
	 *  该字段保留用于旧版/受限宿主兼容，不再按 app.isPackaged 隐藏下载入口。 */
	installEnabled?: boolean;
	/** 当前 app 声明的配套 dsh 版本（package.json → @deepseek-ai/dsh）；读不到时缺省。 */
	declaredRuntimeVersion?: string;
};

/**
 * 已装 runtime 与声明版本是否不一致（纯函数，单测覆盖）。
 *
 * 为什么是硬门控而不是提示：runtime manifest 的 maxAppVersion 为空 = 对任何 app
 * 版本都「兼容」，resolveActive 会一直选旧版——旧 runtime「能启动」不代表「能工作」
 * （真实事故：0.1.1-rc.1 runtime 配 0.1.5-rc.1 声明 → cordis loader entries failed，
 * plugin tree 加载即崩）。桥协议/插件表随版本演进，跨版本混用不可信，所以版本
 * 不一致直接判 outdated：不启动 host、新建会话被拒、发送被拦截，强制重装配套版本。
 * 用 semver 不等而不是字符串不等：0.1.5-rc.1 与 0.1.5-rc.1+build 元数据视为一致，
 * 而 0.1.5-rc.1 与 0.1.5-rc.2 是真不一致。
 * 任一版本缺失（未装 / 声明读不到）返回 false：没有可比对象不能判定不一致，
 * 宁可放行（保持旧行为）也不误杀。
 */
export function isDshRuntimeVersionMismatch(declaredVersion: string | undefined, installedVersion: string | undefined): boolean {
	if (!declaredVersion || !installedVersion) return false;
	return compareSemver(declaredVersion, installedVersion) !== 0;
}

/**
 * 是否弹「runtime 不在 + 存量 dsh 会话」的一次性迁移提示（纯函数，单测覆盖）。
 *
 * 判定与展示解耦：渲染层只负责收集三个入参（status/catalog/settings），
 * 产品规则集中在这里。规则：
 * - alreadyShown 优先：闩已置位就永不重弹（否则每次重启都骚扰，#317 的原始抱怨）；
 * - checking/installed 不弹：状态未定拿中间态会误报；runtime 好好的无迁移可言；
 * - 没有 dsh 会话不弹：新装用户在安装引导页自然看到 DSH 入口，不需要额外交互。
 */
export type DshRuntimeMigrationNoticeInput = {
	state: DshRuntimeState;
	/** session catalog（含已扫描的存量会话）里是否存在 dsh 后端的会话。 */
	hasDshSessions: boolean;
	/** 设置里的已提示闩（settings.dshRuntimeMigrationNoticeShown === true）。 */
	alreadyShown: boolean;
};

export function shouldShowDshRuntimeMigrationNotice(input: DshRuntimeMigrationNoticeInput): boolean {
	if (input.alreadyShown) return false;
	if (input.state === "checking" || input.state === "installed") return false;
	if (!input.hasDshSessions) return false;
	return true;
}

/** 状态 → DSH UI 可见性矩阵（纯函数，单测覆盖见 tests/dshRuntimeStatus.test.mjs）。 */
export type DshUiVisibility = {
	/** 允许新建 DSH 会话 / 把默认后端选为 dsh（仅 installed）。 */
	canCreateDshSession: boolean;
	/** 渲染 DSH 配置表单（供应商/模型/插件/凭据）；非 installed 整体替换为安装引导。 */
	showDshConfigForms: boolean;
	/** 显示「安装 DSH 后端」引导卡。 */
	showInstallGuide: boolean;
	/** 是否显示「在线下载安装/重装」按钮（dev 与打包版统一为 true）。 */
	showRuntimeDownload: boolean;
};

export function dshUiVisibilityFor(state: DshRuntimeState, installEnabled = true): DshUiVisibility {
	// outdated 与 notInstalled/broken 同走安装引导：版本不一致时不启动 host，唯一
	// 出口是重装配套版本——保留表单只会让用户在坏 runtime 上继续操作。
	const needsGuide = state !== "installed" && state !== "checking";
	const installed = state === "installed";
	return {
		canCreateDshSession: installed,
		showDshConfigForms: installed,
		showInstallGuide: needsGuide,
		showRuntimeDownload: installEnabled,
	};
}

/** 安装/更新 runtime 的阶段（UI 进度条与文案据此切换）。 */
export type DshRuntimeInstallPhase = "downloading" | "verifying" | "extracting" | "finalizing" | "done" | "error";

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
export type DshSendBlockReason = "notInstalled" | "broken" | "outdated";

export function dshSendBlockReason(state: DshRuntimeState): DshSendBlockReason | null {
	if (state === "notInstalled") return "notInstalled";
	if (state === "broken") return "broken";
	// 版本不一致 = 旧 runtime 不保证能工作，发送同样拦截（强制先重装）。
	if (state === "outdated") return "outdated";
	return null;
}

/**
 * 设置项 defaultAgentBackend 的有效值（纯函数）：
 * runtime 非 installed 时 dsh 强制回落 pi——防御「设置残留 dsh 但 runtime 已不可用」
 * （阶段 2 升级/卸载场景），新建会话链路不会因后端不可用而裸报错。
 * "imagegen" 后端不受 DSH runtime 影响，原样透传。
 */
export function resolveEffectiveAgentBackend(backend: AgentBackend, dshState: DshRuntimeState): AgentBackend {
	if (backend === "dsh" && dshState !== "installed") return "pi";
	return backend;
}
