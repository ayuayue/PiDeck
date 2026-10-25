import type { AvailableModel } from "../../shared/types";
import type { PiModelCapabilitySnapshot } from "./PiModelCapabilityCache";

/**
 * 会话创建校验（createDraft / createAnonymousSession / sessionsResolveLaunchDefaults）
 * 用的 pi 目录模型视图。
 *
 * 必须与模型选择器的可选范围同源：选择器读 capability 快照（get_available_models，
 * 含 auth.json 官方 provider 与 models-store 目录），校验若只看 CLI 缓存
 * （models.json ∪ pi --list-models），auth 渠道模型会被判为「不存在」并被
 * launchDefaults 静默换成配置默认模型——用户表现为「选好的模型发送后被换渠道」
 * （issue #340）。快照是同步读：创建链路不能为了校验 fork pi，未 hydration 时
 * 退回旧的 CLI 缓存行为。
 */
export function mergeCatalogModels(snapshot: PiModelCapabilitySnapshot | null | undefined, cliModels: AvailableModel[] | null | undefined): AvailableModel[] | undefined {
	if (snapshot && snapshot.models.length > 0) return snapshot.models;
	if (cliModels && cliModels.length > 0) return cliModels;
	return undefined;
}
