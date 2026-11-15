/**
 * 用量查询：配置目录选择与 provider 端点解析（从 ConfigManager 原样搬出，方法体未改）。
 *
 * pi 侧落 ~/.pi/agent；DSH 侧落 $DSH_HOME/.pideck，端点以 DSH 自身 profile 为准。
 * 依赖见 providerUsageHost.ts 的宿主端口。
 */
import { credentialRefFor } from "../../shared/dshCredentialRef";
import { normalizeDshDeepseekProvider } from "../../shared/dshProviderNames";
import type { UsageProbeBackend } from "../../shared/types/providerUsage";
import { pideckUsageProbesDir } from "../dsh/pideckDshHome";
import { getPiAiCatalogIndex } from "../pi/piAiBuiltinCatalog";
import { loadDshUsageProviderProfile } from "./dshUsageEndpoint";
import { ProviderUsageCollaborator } from "./providerUsageHost";
import { piBuiltinSnapshotFromCatalog, resolvePiApiKey } from "./providerMigration";
import { resolveProviderUsageEndpoint } from "./providerUsageResolver";
import { loadUsageProbeSettings } from "./userUsageProbes";
import type { UsageProbeSettingsLoadResult } from "./userUsageProbes";

/** 用量查询编排的底座：配置目录 + 端点解析。 */
export class ProviderUsageEndpoint extends ProviderUsageCollaborator {
	/**
	 * 用量查询配置目录：pi = ~/.pi/agent；dsh = $DSH_HOME（与 DSH 自己的配置/凭据同目录，
	 * 文件名仍为 usage-probes.json，与 pi 侧同构）。
	 */
	protected usageProbeSettingsDir(backend: UsageProbeBackend): string {
		if (backend === "dsh") {
			// DSH 链路配置统一落 $DSH_HOME/.pideck/（PiDeck 特有文件收拢目录）。
			const dshHome = this.dshUsage?.getHomeDir() ?? this.configDir;
			return pideckUsageProbesDir(dshHome);
		}
		return this.configDir;
	}

	/** 供 IPC 保存路径使用：backend 对应的用量查询配置目录。 */
	getUsageProbeConfigDir(backend: UsageProbeBackend = "pi"): string {
		return this.usageProbeSettingsDir(backend);
	}

	/**
	 * 解析 provider 端点，供主进程内其它链路复用（TokenDance 充值取 baseUrl/apiKey）。
	 * 只在本进程内使用，API Key 不回传渲染层；未命中返回 matched=false。
	 */
	async resolveProviderEndpoint(provider: string, backend: UsageProbeBackend = "pi") {
		return this.resolveUsageEndpoint(provider, backend);
	}

	/**
	 * 读单 provider 用量配置；backend="dsh" 且 DSH 侧未配置时回退 Pi 侧同名 provider 配置。
	 *
	 * 显示对齐（display parity）规则：Pi 里已配置并显示用量 → DSH 卡片同一 provider 默认也显示，
	 * 无需在 DSH 侧重复配置；DSH 一旦显式保存过（含 enabled=false 关闭）即接管、不再回退。
	 * 回退取「配置 + 旧版 probes 数组」（effectiveDir 指向 Pi 目录），端点与凭据仍走 DSH 链路
	 * （DSH profile / 凭据库），不会拿 Pi 的 key 去查 DSH 端点。provider 名按两侧一致匹配
	 * （deepseek 已由 normalizeDshDeepseekProvider 统一为规范名）。
	 */
	protected async loadUsageSettingsWithFallback(backend: UsageProbeBackend, provider: string, settingsDir: string): Promise<{ settings: UsageProbeSettingsLoadResult; effectiveDir: string }> {
		const settings = await loadUsageProbeSettings(settingsDir, provider);
		if (backend !== "dsh" || settings.config) {
			return { settings, effectiveDir: settingsDir };
		}
		// DSH 无配置：尝试 Pi 侧同名 provider（仅配置级回退，凭据复用 DSH 链路解析）。
		const piSettings = await loadUsageProbeSettings(this.configDir, provider);
		if (!piSettings.config) return { settings, effectiveDir: settingsDir };
		return {
			settings: { config: piSettings.config, errors: [...settings.errors, ...piSettings.errors] },
			effectiveDir: this.configDir,
		};
	}

	/**
	 * 解析 provider 端点（models.json 精确命中 → pi-ai catalog 兜底；API key 不出主进程）。
	 * backend="dsh" 时以 DSH 自身 profile（settings.yaml 的 llm-pi-ai.providers / llm-deepseek）
	 * 为准——自定义 route 的 baseURL/api/headers 与 pi 侧或 catalog 默认可能不同，只靠兜底
	 * 会出现「时而查得对、时而判不支持」；凭据优先 DSH 凭据库（.credentials.yaml，
	 * ref = profile.apiKeyEnv 或 <ROUTE>_API_KEY），缺省回退 pi auth（迁移/同步场景兼容）。
	 * 无 DSH profile（文件缺失/无该 route）时回落 models.json → pi-ai catalog 兜底。
	 */
	protected async resolveUsageEndpoint(provider: string, backend: UsageProbeBackend = "pi") {
		// DSH 官方 DeepSeek 统一用规范名 deepseek：llm.models 组 id（deepseek-official）
		// 只能命中 pi/catalog 兜底，loadDshUsageProviderProfile 的特判会漏掉它。
		if (backend === "dsh") provider = normalizeDshDeepseekProvider(provider);
		const catalog = getPiAiCatalogIndex();
		if (backend === "dsh") {
			const home = this.dshUsage?.getHomeDir();
			if (home) {
				const profile = await loadDshUsageProviderProfile(home, provider);
				if (profile) {
					const catalogSnapshot = piBuiltinSnapshotFromCatalog(provider, undefined, catalog);
					const [modelsRes, authRes] = await Promise.all([this.getModelsConfig(), this.getAuthConfig()]);
					const fromDsh = this.dshUsage ? await this.dshUsage.readCredential(profile.credentialRef) : undefined;
					const baseUrl = profile.baseUrl ?? catalogSnapshot?.baseUrl;
					const piKey = resolvePiApiKey(modelsRes.parsed?.providers?.[provider], authRes.parsed?.[provider]);
					return {
						provider,
						// profile 缺 baseURL/api（如 opencode route 未写）时由 pi-ai catalog 兜底。
						...(baseUrl ? { baseUrl } : {}),
						...((fromDsh ?? piKey) ? { apiKey: fromDsh ?? piKey } : {}),
						apiType: profile.api ?? catalogSnapshot?.api ?? "openai-completions",
						headers: profile.headers,
						matched: baseUrl != null,
					};
				}
			}
		}
		const lookup = {
			getModelsConfig: () => this.getModelsConfig(),
			getAuthConfig: () => this.getAuthConfig(),
			catalogProvider: (name: string) => piBuiltinSnapshotFromCatalog(name, undefined, catalog),
		};
		const resolved = await resolveProviderUsageEndpoint(lookup, provider);
		// DSH 兜底路径（settings.yaml 无该 route）：DSH 凭据库仍然是本链路的优先密钥来源
		// （路由的 key 状态点以它为准，pi auth 只是迁移/同步场景的回退）。
		if (backend === "dsh" && this.dshUsage) {
			const fromDsh = await this.dshUsage.readCredential(credentialRefFor({}, provider));
			if (fromDsh) resolved.apiKey = fromDsh;
		}
		return resolved;
	}
}
