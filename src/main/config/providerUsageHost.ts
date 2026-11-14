/**
 * 用量查询域的宿主适配层（ConfigManager 拆分的公共底座）。
 *
 * 为什么是「同名访问器」而不是逐个改调用点：这一域的 15 个方法是从 ConfigManager 原样搬出的，
 * 函数体、注释、错误文案、超时/重试常量一字不改（宿主 `this.translate` / `this.configDir` /
 * `this.normalizeApiType` 等引用在子类里仍是这些名字）。宿主只注入一个窄端口，
 * 协作者不反向 import ConfigManager。
 *
 * 分层：ProviderUsageCollaborator（本文件）→ Endpoint（端点/配置目录解析）
 * → Probes（逐候选执行）→ Queries（对外编排）。
 *
 * 为什么用继承而非组合：域内方法互相调用（`this.resolveUsageEndpoint(...)` /
 * `this.runUsageProbes(...)`）是原宿主就有的形状，继承让这些调用点一字不改；
 * 组合则要把每个内部调用改成 `this.endpoint.xxx` / `this.probes.xxx`，
 * 与「纯搬迁」相互矛盾。
 */
import type { ConfigFileReadResult } from "../../shared/types";
import type { ConfigCopy, DshUsageLookup, PiAuthFile, PiModelsFile } from "./configModelTypes";

/**
 * Sub2API 面板登录态的续期上下文（仅 sub2api 模板的余额段使用）。
 * persist=true 时续期成功的新 token 对会写回 configDir 下的 usage-probes.json；
 * 弹窗「测试」路径 persist=false（用户还没保存，不能静默改盘上的配置）。
 */
export type Sub2ApiPanelContext = {
	provider: string;
	configDir: string;
	refreshToken?: string;
	persist: boolean;
};

/** ConfigManager 提供给用量域的能力（窄端口；域内不感知 ConfigManager 其余部分）。 */
export type ProviderUsageHostPort = {
	/** 当前 pi 配置目录（WSL 切换后变化，必须现取）。 */
	getConfigDir: () => string;
	translate: ConfigCopy;
	dshUsage?: DshUsageLookup;
	getModelsConfig: () => Promise<ConfigFileReadResult<PiModelsFile>>;
	getAuthConfig: () => Promise<ConfigFileReadResult<PiAuthFile>>;
	normalizeApiType: (apiType?: string) => string;
	ensureVersionPath: (baseUrl: string) => string;
	normalizeRequestHeaders: (headers?: Record<string, string>) => Record<string, string>;
	withOpenAiSdkUserAgent: (headers: Record<string, string>) => Record<string, string>;
	redactSecret: (value: string, apiKey: string) => string;
};

/** 把宿主端口摊成与原方法体完全一致的同名成员（搬迁后方法体不用改）。 */
export abstract class ProviderUsageCollaborator {
	constructor(protected readonly host: ProviderUsageHostPort) {}

	protected get configDir(): string {
		return this.host.getConfigDir();
	}

	protected get translate(): ConfigCopy {
		return this.host.translate;
	}

	protected get dshUsage(): DshUsageLookup | undefined {
		return this.host.dshUsage;
	}

	protected getModelsConfig(): Promise<ConfigFileReadResult<PiModelsFile>> {
		return this.host.getModelsConfig();
	}

	protected getAuthConfig(): Promise<ConfigFileReadResult<PiAuthFile>> {
		return this.host.getAuthConfig();
	}

	protected normalizeApiType(apiType?: string): string {
		return this.host.normalizeApiType(apiType);
	}

	protected ensureVersionPath(baseUrl: string): string {
		return this.host.ensureVersionPath(baseUrl);
	}

	protected normalizeRequestHeaders(headers?: Record<string, string>): Record<string, string> {
		return this.host.normalizeRequestHeaders(headers);
	}

	protected withOpenAiSdkUserAgent(headers: Record<string, string>): Record<string, string> {
		return this.host.withOpenAiSdkUserAgent(headers);
	}

	protected redactSecret(value: string, apiKey: string): string {
		return this.host.redactSecret(value, apiKey);
	}
}
