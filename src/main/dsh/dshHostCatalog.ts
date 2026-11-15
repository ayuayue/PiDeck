import type { AvailableModel, DshModelDiscoveryInput, FetchedModel } from "../../shared/types";
import { getAppLogger } from "../logging/sharedLogger";
import type { DshRemoteClient } from "./dshRemoteClient";
import { toDshAvailableModels, toDshFetchedModels, unwrapDshDiscoveryModels } from "./dshModels";

/**
 * DSH host 的目录类查询（模型 / 提供方 / agent 预设）协作者：纯读写宿主目录数据，
 * 不碰进程与生命周期——启动兜底与领域客户端由宿主经接口透传。
 */
export type DshCatalogHost = {
	ensureStarted(): Promise<void>;
	getClient(): DshRemoteClient | null;
};

/**
 * Host 级模型目录（llm.models），不依赖已创建的 DSH 会话。
 * 给草稿/未启动会话的模型下拉用；首次调用会懒 boot。
 * 与会话级 session.models 同一目录数据，透传每模型支持的思考档位
 * （reasoningEfforts），思考选择器按当前模型过滤档位。
 */
export async function listDshModels(host: DshCatalogHost): Promise<AvailableModel[]> {
	await host.ensureStarted();
	const client = host.getClient();
	if (!client) return [];
	const listed = await client.sessionsModelCatalog();
	if (!listed.result.ok) return [];
	return toDshAvailableModels(listed.result.value.groups ?? []);
}

/**
 * DSH 原生模型发现：配置页传入仍在编辑的草稿，结果只作为候选返回。
 * apiKey 仅在调用方有未保存草稿时出现；已保存凭证由 DSH 的 adapter/credentials
 * seam 自己解析，避免 PiDeck 读取并转运密钥。settingsNs 是 adapter 选择的必要契约。
 */
export async function discoverDshModels(host: DshCatalogHost, input: DshModelDiscoveryInput): Promise<FetchedModel[]> {
	await host.ensureStarted();
	const client = host.getClient();
	if (!client) throw new Error("DSH host is not started");
	const settingsNs = input.settingsNs.trim();
	if (!settingsNs) throw new Error("DSH model discovery requires settingsNs");
	const discovered = await client.llmDiscoverModels({
		settingsNs,
		...(input.provider?.trim() ? { provider: input.provider.trim() } : {}),
		...(input.baseURL?.trim() ? { baseURL: input.baseURL.trim() } : {}),
		...(input.api?.trim() ? { api: input.api.trim() } : {}),
		...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
	});
	if (!discovered.result.ok) {
		throw new Error(`dsh llm.discoverModels failed: ${discovered.result.error.code}: ${discovered.result.error.message}`);
	}
	// 线上结果 schema 是纯数组（dsh-llm typert：z.array(z.object({ id, ... }))）；
	// 之前写成 value.models ?? []，对数组取 .models 恒 undefined → 配置页永远
	// 「已获取 0 个模型」。unwrapDshDiscoveryModels 做数组/包装双形态解包。
	return toDshFetchedModels(unwrapDshDiscoveryModels(discovered.result.value));
}

/**
 * 可配置提供方目录（llm.providers）：内置 catalog（declared，未配置）+
 * 已注册路由（active）。模型页「添加提供方」从 declared 未激活行中选择，
 * 与 dsh-web 的休眠目录选择同源。首次调用会懒 boot。
 */
export async function listDshProviders(host: DshCatalogHost): Promise<
	Array<{
		provider: string;
		displayName: string;
		active: boolean;
		declared?: boolean;
	}>
> {
	await host.ensureStarted();
	const client = host.getClient();
	if (!client) return [];
	const listed = await client.llmProviders();
	if (!listed.result.ok) return [];
	return (listed.result.value.providers ?? []).map((entry) => ({
		provider: entry.provider,
		displayName: entry.displayName,
		active: entry.active,
		...(entry.declared === true ? { declared: true } : {}),
	}));
}

/**
 * DSH agent 预设目录（agentPresets/list）：会话 agent 的组合预设（standard/ptc/…）。
 * 只读展示（id/isDefault/名称/描述），配置页「预设设置」分区用。
 */
export async function listDshAgentPresets(host: DshCatalogHost): Promise<
	Array<{
		id: string;
		isDefault: boolean;
		name?: string;
		description?: string;
		broken?: string;
	}>
> {
	await host.ensureStarted();
	const client = host.getClient();
	if (!client) return [];
	const listed = await client.agentPresetsList();
	if (!listed.result.ok) {
		// 目录拉取失败/为空时记日志：会话头模式胶囊与配置页「预设设置」都依赖这份名单，
		// 空名单 = 部署未装配 agent-presets 组合行（此时胶囊按设计隐藏）。
		getAppLogger()?.warn("dsh-host", "agentPreset.list failed", {
			error: JSON.stringify(listed.result.error),
		});
		return [];
	}
	const presets = listed.result.value.presets ?? [];
	if (presets.length === 0) {
		getAppLogger()?.warn("dsh-host", "agentPreset.list returned an empty roster", {
			hint: "agent-presets 组合行未装配时 PiDeck 隐藏会话头模式胶囊（与 dsh-web 一致）",
		});
	}
	return presets.map((preset: { id: string; isDefault: boolean; name?: string; description?: string; broken?: string }) => ({
		id: preset.id,
		isDefault: preset.isDefault,
		...(typeof preset.name === "string" && preset.name ? { name: preset.name } : {}),
		...(typeof preset.description === "string" && preset.description ? { description: preset.description } : {}),
		...(typeof preset.broken === "string" && preset.broken ? { broken: preset.broken } : {}),
	}));
}
