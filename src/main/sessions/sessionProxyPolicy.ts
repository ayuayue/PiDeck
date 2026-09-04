import type { AppSettings } from "../../shared/types";
import type { SessionProxyMode, SessionProxyOverride } from "../../shared/types/session";

/**
 * 会话级代理策略（纯函数，可单测）。
 *
 * 背景：pi 代理与 DSH host 的代理本质上都是「子进程 spawn 时的环境变量注入」,
 * 但两者粒度不同——pi 每个会话一个子进程，可以按会话覆盖；DSH 是单一共享 host
 * 进程（所有 DSH 会话共用），只能做 host 级聚合（用户确认的降级方案）。
 * 使 DSH 真正生效的关键：host 的 LLM/网络请求用 globalThis.fetch（undici），需要
 * NODE_USE_ENV_PROXY=1 开关才会读注入的 HTTP_PROXY/NO_PROXY env（见常量注释，已实测）。
 * 本模块只输出策略结果，环境变量注入由 PiProcess / DshHost 各自执行。
 */

/** 标准 HTTP(S)/ALL 代理环境变量（大小写双份，覆盖 linux/mac/windows 工具链）。 */
export const PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
] as const;

/** 代理绕过（NO_PROXY）环境变量。 */
export const PROXY_BYPASS_ENV_KEYS = ["NO_PROXY", "no_proxy"] as const;

/**
 * Node 内置 fetch（undici）的 env 代理开关。
 * undici 默认不读 HTTP_PROXY 等环境变量，只有设置 NODE_USE_ENV_PROXY=1（Node 22.21+/24.5+，
 * Electron 43 内置 Node 24.18.1 支持，已实测）后，globalThis.fetch / node:http(s) 才会按
 * HTTP_PROXY/HTTPS_PROXY/NO_PROXY 走代理。DSH host 运行在 utilityProcess（Electron 内置 Node），
 * LLM 客户端用 globalThis.fetch，因此不设此开关时，PiDeck 注入的代理 env 对 DSH 完全无效。
 */
export const NODE_USE_ENV_PROXY = "NODE_USE_ENV_PROXY";

/**
 * DSH host fork env patch：set 为注入键值，unset 为从继承环境剥离的键。
 * set/unset 除了标准代理键，还包括 NODE_USE_ENV_PROXY（undici env 代理开关，见常量注释）。
 */
export type HostProxyEnvPatch = {
	set: Partial<Record<
		(typeof PROXY_ENV_KEYS)[number] | (typeof PROXY_BYPASS_ENV_KEYS)[number] | typeof NODE_USE_ENV_PROXY,
		string
	>>;
	unset: Array<
		(typeof PROXY_ENV_KEYS)[number] | (typeof PROXY_BYPASS_ENV_KEYS)[number] | typeof NODE_USE_ENV_PROXY
	>;
};

export type PiProxyModeSettings = Pick<AppSettings, "piProxyEnabled" | "piProxyUrl">;

/** 按模型/供应商过滤所需的全局设置子集（代理 URL + 两级白名单；供应商名单为旧版兼容字段）。 */
export type PiProxyProviderSettings = Pick<
	AppSettings,
	"piProxyEnabled" | "piProxyUrl" | "piProxyBypass" | "piProxyProviders" | "piProxyModels"
>;

/**
 * 把会话级覆盖应用到 pi 子进程设置。仅调整 piProxyEnabled 开关：
 * on → 强制开启（URL 仍复用全局 piProxyUrl）；off → 强制关闭；follow/缺省 → 原样。
 * 不返回新对象时（follow/无设置），调用方应直接复用原 settings。
 * 泛型保留 settings 的完整类型（如 PiProcessSettings），调用方无需收窄。
 */
export function applyPiProxyMode<T extends PiProxyModeSettings>(
	settings: T | undefined,
	mode: SessionProxyMode | undefined,
): T | undefined {
	if (!settings || mode === undefined || mode === "follow") return settings;
	if (mode === "on") {
		// on 但全局 URL 为空时保留开启位：applyPiProxyEnv 会因空 URL 直接放行（直连），
		// 具体告警由 PiProcess spawn 侧记录（本模块保持纯函数、不写日志）。
		return { ...settings, piProxyEnabled: true };
	}
	return { ...settings, piProxyEnabled: false };
}

/**
 * 按供应商白名单解析会话级代理模式（纯函数，可单测）。
 * 旧版「按供应商走代理」的匹配函数：设置 UI 已移除供应商选项（由模型白名单承接），
 * 但升级前已配置的旧数据仍需兼容读取——名单内 → 强制 on（即使全局关闭也复用全局 URL），
 * 名单外 → 强制 off。返回 undefined 表示无需覆盖（跟随全局）。
 */
export function resolveProviderProxyMode(
	provider: string | undefined,
	piProxyProviders: ReadonlyArray<string> | undefined,
): SessionProxyMode | undefined {
	if (!piProxyProviders || piProxyProviders.length === 0) return undefined;
	if (!provider || !provider.trim()) return undefined;
	const normalized = provider.trim();
	// 白名单大小写敏感（与 models.json 的 provider key 一致），空白已在 SettingsStore 归一化。
	if (piProxyProviders.includes(normalized)) return "on";
	return "off";
}

/**
 * 按模型白名单解析会话级代理模式（纯函数，可单测）。
 * 条目格式 `provider/modelId`：拼接会话的 provider + modelId 比较，避免不同 provider
 * 下同名模型（如 deepseek-r1 同时在多个网关出现）互相误伤。
 * 名单空或会话无 model 时返回 undefined（不按模型过滤）；命中 → on，未命中 → off。
 */
export function resolveModelProxyMode(
	provider: string | undefined,
	modelId: string | undefined,
	piProxyModels: ReadonlyArray<string> | undefined,
): SessionProxyMode | undefined {
	if (!piProxyModels || piProxyModels.length === 0) return undefined;
	if (!provider || !provider.trim() || !modelId || !modelId.trim()) return undefined;
	const key = `${provider.trim()}/${modelId.trim()}`;
	// 白名单大小写敏感（与 models.json 的 model id 一致），空白已在 SettingsStore 归一化。
	if (piProxyModels.includes(key)) return "on";
	return "off";
}

/**
 * 模型名单 + 供应商名单合并解析（纯函数，可单测）。
 * 语义：任一名单非空即启用“黑白名单过滤”——
 * 1. 模型名单（模型级白名单，设置 UI 唯一入口）优先匹配：命中 → on（即使全局关闭也复用全局 URL）；
 * 2. 模型名单未命中或未启用时看供应商名单（旧版字段，兼容升级前已配置的数据）：命中 → on；
 * 3. 两级名单都启用但均未命中 → off（强制直连，保持与单一供应商名单一致的黑名单外直连语义）；
 * 4. 两级名单都为空 → undefined（不按名单过滤，跟随全局/会话设置）。
 * 兼容性：只配置供应商名单（piProxyModels 为空）时行为与旧版完全一致。
 */
export function resolveListedProxyMode(
	provider: string | undefined,
	modelId: string | undefined,
	piProxyProviders: ReadonlyArray<string> | undefined,
	piProxyModels: ReadonlyArray<string> | undefined,
): SessionProxyMode | undefined {
	const providersEnabled = (piProxyProviders?.length ?? 0) > 0;
	const modelsEnabled = (piProxyModels?.length ?? 0) > 0;
	if (!providersEnabled && !modelsEnabled) return undefined;
	// 模型名单粒度更细，先于供应商名单判定（同模型不同 provider 的场景交给供应商名单兜底）。
	const modelMode = resolveModelProxyMode(provider, modelId, piProxyModels);
	if (modelMode === "on") return "on";
	const providerMode = resolveProviderProxyMode(provider, piProxyProviders);
	if (providerMode === "on") return "on";
	// 名单已启用但两级都未命中：黑白名单语义下强制直连（名单外的明确意图）。
	return "off";
}

/**
 * 结合会话级覆盖 + 按模型/供应商白名单，计算本次 spawn 应注入的 pi 代理设置。
 * 泛型保留 settings 的完整类型，调用方无需收窄。
 * - 会话显式 on/off 优先；
 * - 否则按模型名单（唯一 UI 入口）→ 旧版供应商名单（兼容读取）决定 on/off；
 * - 名单未启用或未命中则返回原 settings（跟随全局）。
 */
export function applyPiProxyModeWithProvider<T extends PiProxyProviderSettings>(
	settings: T | undefined,
	mode: SessionProxyMode | undefined,
	provider: string | undefined,
	modelId: string | undefined,
): T | undefined {
	if (!settings) return settings;
	// 1. 会话显式覆盖最高优（用户手动在会话菜单指定的 on/off）。
	if (mode === "on" || mode === "off") return applyPiProxyMode(settings, mode);
	// 2. 按白名单（模型 → 供应商）：名单命中强制 on，名单未命中强制 off。
	const listedMode = resolveListedProxyMode(
		provider,
		modelId,
		settings.piProxyProviders,
		settings.piProxyModels,
	);
	if (listedMode) return applyPiProxyMode(settings, listedMode);
	// 3. 无覆盖、无白名单启用 → 跟随全局（原样返回，避免创建新对象）。
	return settings;
}

/**
 * 主进程侧统一计算会话最终代理模式（供 AgentManager 的 resolveSessionProxy 复用）。
 * 输入：会话记录的 proxy.mode（可能 follow/缺省）、provider/modelId、全局两级白名单。
 * 输出：本次 spawn 应生效的模式（on/off/follow）。
 * - 会话显式 on/off 直接返回；
 * - 否则按模型名单（UI 唯一入口）→ 旧版供应商名单（兼容读取）映射为 on/off；
 * - 两级白名单都未启用或无 provider/model 时返回 follow（沿用全局）。
 */
export function resolveEffectiveSessionProxyMode(
	sessionMode: SessionProxyMode | undefined,
	provider: string | undefined,
	modelId: string | undefined,
	piProxyProviders: ReadonlyArray<string> | undefined,
	piProxyModels: ReadonlyArray<string> | undefined,
): SessionProxyMode {
	if (sessionMode === "on" || sessionMode === "off") return sessionMode;
	const listedMode = resolveListedProxyMode(provider, modelId, piProxyProviders, piProxyModels);
	if (listedMode) return listedMode;
	return "follow";
}

/**
 * DSH host 级代理模式聚合：共享 host 无法按会话隔离，只能取所有 DSH 会话覆盖的并集。
 * 冲突规则：off（强制直连）优先于 on——直连是安全默认（不会因代理配置错误而全断），
 * 显式「直连」表达了用户的最强意图；任一 off → host 剥离代理 env；无 off 但任一
 * on → host 注入全局代理；全部 follow/无覆盖 → 沿用当前行为（不动）。
 */
export function aggregateDshProxyMode(
	overrides: ReadonlyArray<SessionProxyOverride | undefined>,
): SessionProxyMode {
	let forcedOn = false;
	for (const override of overrides) {
		if (!override) continue;
		// off 是「必须直连」，一票否决（先于 on 判断）。
		if (override.mode === "off") return "off";
		if (override.mode === "on") forcedOn = true;
	}
	return forcedOn ? "on" : "follow";
}

/**
 * DSH host 聚合模式 + 全局开关兜底（纯函数，可单测）。
 * - 会话聚合结果非 follow → 直接返回（显式 on/off 最高优，off 一票否决已在聚合内完成）；
 * - 聚合结果为 follow 时看全局：pr0xy 开关开启且**未启用模型/供应商名单** → host 走代理
 *   （与 pi 会话「名单空时跟随全局」语义一致）；
 * - 名单已启用（piProxyModels/piProxyProviders 非空）时不 fallback：DSH 会话已在
 *   resolveEffectiveSessionProxyMode 层按名单换算成 on/off，follow 即「名单未命中」，
 *   保持直连（同 pi 名单外直连语义），避免全局开关把名单破坏。
 */
export function resolveDshHostProxyMode(
	sessionBasedMode: SessionProxyMode,
	global: { piProxyEnabled: boolean; hasList: boolean },
): SessionProxyMode {
	if (sessionBasedMode !== "follow") return sessionBasedMode;
	if (global.piProxyEnabled && !global.hasList) return "on";
	return "follow";
}

/**
 * 由聚合模式 + 全局代理配置生成 DSH host fork env patch。
 * - on：注入全局 URL（URL 为空时无法代理，返回 undefined 表示不动，等用户先配 URL），
 *   并注入 NODE_USE_ENV_PROXY=1 —— 没有它，DSH 内部的 globalThis.fetch（undici）不会读
 *   代理环境变量，注入的 HTTP_PROXY 等只是摆设（见 NODE_USE_ENV_PROXY 常量注释）；
 * - off：剥离标准代理环境变量（含 NO_PROXY）与 NODE_USE_ENV_PROXY（避免残留配置互相干扰）；
 * - follow：undefined（不动，保持 dsh host 现有行为）。
 */
export function buildHostProxyEnvPatch(
	mode: SessionProxyMode,
	global: { url: string; bypass: string },
): HostProxyEnvPatch | undefined {
	if (mode === "off") {
		return {
			set: {},
			unset: [...PROXY_ENV_KEYS, ...PROXY_BYPASS_ENV_KEYS, NODE_USE_ENV_PROXY],
		};
	}
	if (mode === "on") {
		const url = global.url.trim();
		if (!url) return undefined;
		const set: HostProxyEnvPatch["set"] = {};
		for (const key of PROXY_ENV_KEYS) set[key] = url;
		const bypass = global.bypass.trim();
		if (bypass) {
			for (const key of PROXY_BYPASS_ENV_KEYS) set[key] = bypass;
		}
		// Node 22.21+/24.5+ 的 undici fetch 需要显式开启 env 代理；同键还需从继承环境
		// 剥离旧值，避免场景：上次 session off 清掉了键，但用户系统环境本身带 HTTP_PROXY，
		// 这里 set 覆盖即可，无需 unset。
		set[NODE_USE_ENV_PROXY] = "1";
		return { set, unset: [] };
	}
	return undefined;
}

/**
 * 把 patch 应用到已构建的 fork env（原地修改）：先剥离后注入，顺序固定。 */
export function applyProxyEnvPatch(
	env: Record<string, string>,
	patch: HostProxyEnvPatch,
): void {
	for (const key of patch.unset) delete env[key];
	for (const [key, value] of Object.entries(patch.set)) {
		if (value !== undefined) env[key] = value;
	}
}

// ── 配置页「拉取模型 / 测试连接」的代理选择 ───────────────

import type { ConfigProxyMode } from "../../shared/types/fetchedModel";

/**
 * 配置检测代理目标（纯数据，供 ConfigManager 临时 session 与 PiModelProber 环境注入共用）：
 * - follow：不覆盖（主进程 net.fetch 默认走桌面代理全局；pi 进程跟随 pi 代理全局开关）；
 * - on：强制走 url（bypass 为同源代理配置的绕过列表）；
 * - off：强制直连。
 */
export type ConfigProxyTarget =
	| { mode: "follow" }
	| { mode: "on"; url: string; bypass: string }
	| { mode: "off" };

/**
 * 把渲染层代理选择解析成主进程可执行的代理目标（纯函数，可单测）。
 * 复用设置中的代理地址：pi / desktop 两个模式各自取对应 URL 字段；
 * 所选代理 URL 为空时降级为 off（与全局开关注释一致：没配地址就无法代理）。
 */
export function resolveConfigProxyTarget(
	settings: { piProxyUrl: string; piProxyBypass: string; desktopProxyUrl: string; desktopProxyBypass: string },
	proxyMode: ConfigProxyMode | undefined,
): ConfigProxyTarget {
	switch (proxyMode) {
		case "pi": {
			const url = settings.piProxyUrl.trim();
			if (!url) return { mode: "off" };
			return { mode: "on", url, bypass: settings.piProxyBypass.trim() };
		}
		case "desktop": {
			const url = settings.desktopProxyUrl.trim();
			if (!url) return { mode: "off" };
			return { mode: "on", url, bypass: settings.desktopProxyBypass.trim() };
		}
		case "off":
			return { mode: "off" };
		case "follow":
		default:
			return { mode: "follow" };
	}
}

/**
 * 轻量生成进程（git 摘要等）的代理指纹：序列化「本次调用实际生效的 pi 代理状态」。
 * 持久化进程的 HTTP_PROXY 等环境变量在 spawn 时定格，代理设置或名单命中变化后
 * 必须依据指纹判断是否需要重建进程（否则旧进程永远沿用旧代理状态）。
 */
export function computeGenProxyKey(
	settings: PiProxyProviderSettings,
	provider: string | undefined,
	modelId: string | undefined,
): string {
	const effective = applyPiProxyModeWithProvider(settings, undefined, provider, modelId);
	if (effective?.piProxyEnabled !== true) return "off";
	// 开启时 URL/绕过列表参与指纹：改地址或 bypass 需要重建持久化进程
	// （HTTP_PROXY 等环境变量在 spawn 时定格，不重建会沿用旧代理）。
	return ["on", effective.piProxyUrl.trim(), effective.piProxyBypass.trim()].join("|");
}

/**
 * 把配置检测的代理目标落到 pi 子进程设置（探针走 applyPiProxyEnv 的环境变量注入）：
 * on → 强制开启并覆盖 URL（即使全局 piProxyEnabled 为关）；off → 强制关闭（含名单外剥离）。
 * follow 返回原对象（调用方沿用引用，不产生新对象开销）。
 */
export function applyConfigProxyTarget<T extends { piProxyEnabled: boolean; piProxyUrl: string; piProxyBypass: string }>(
	settings: T,
	target: ConfigProxyTarget | undefined,
): T {
	if (!target || target.mode === "follow") return settings;
	if (target.mode === "off") return { ...settings, piProxyEnabled: false };
	return { ...settings, piProxyEnabled: true, piProxyUrl: target.url, piProxyBypass: target.bypass };
}