/**
 * DSH provider 用量查询端点解析（纯函数，可单测）。
 *
 * backend="dsh" 时用量查询应以 DSH 自身配置为准（$DSH_HOME/settings.yaml 的
 * llm-pi-ai.providers / llm-deepseek）：baseURL/api/headers 可能与 pi 侧 models.json
 * 或 pi-ai catalog 默认值不同（自定义 route、大小写不同的同名 provider、代理网关等）。
 * 只从 catalog 兜底会出现「查到别人的网关」或直接判不支持——这正是 DSH 模型页
 * 用量查询时灵时不灵的根因之一。
 *
 * 本模块只读 profile 与 credential ref；密钥取值与最终路由（catalog 兜底、pi 侧
 * auth 回退）由 ConfigManager.resolveUsageEndpoint 组合。
 */
import { readDshSettingsSnapshot } from "../dsh/dshProfileSettings";
import { credentialRefFor } from "../../shared/dshCredentialRef";
import { normalizeDshDeepseekProvider } from "../../shared/dshProviderNames";
import { parseDshSettingsDocument } from "./providerMigration";

export type DshUsageProviderProfile = {
	/** DSH 配置文件命名空间：自定义供应商或官方 DeepSeek。 */
	namespace: "llm-pi-ai" | "llm-deepseek";
	/** profile 里显式声明的 baseURL（可能为空 = 用出厂默认/catalog 兜底）。 */
	baseUrl?: string;
	/** profile 里声明的协议（可能为空 = 用出厂默认/catalog 兜底）。 */
	api?: string;
	/** profile 声明的额外请求头（可能为空对象）。 */
	headers?: Record<string, string>;
	/** DSH 凭据库里的 credential ref（apiKeyEnv 显式值或约定式 <ROUTE>_API_KEY）。 */
	credentialRef: string;
};

/**
 * 读取 DSH provider 的用量查询 profile。
 * settings.yaml 缺失/损坏/无该 route 时返回 undefined（调用方回落既有 pi/catalog 解析）。
 */
export async function loadDshUsageProviderProfile(homeDir: string, provider: string): Promise<DshUsageProviderProfile | undefined> {
	// 官方 DeepSeek 在 llm.models / session.models 里的组 id 是 deepseek-official，
	// 与配置面规范名 deepseek 不一致：先归一化再特判，否则选择器/圆球查不到官方路由。
	const name = normalizeDshDeepseekProvider(provider?.trim() ?? "");
	if (!name) return undefined;

	let doc: ReturnType<typeof parseDshSettingsDocument>;
	try {
		doc = parseDshSettingsDocument(readDshSettingsSnapshot(homeDir));
	} catch {
		return undefined;
	}

	// 官方 DeepSeek 是独立命名空间（llm-deepseek），路由名固定为 deepseek。
	if (name === "deepseek" && doc.deepseek) {
		return {
			namespace: "llm-deepseek",
			baseUrl: doc.deepseek.baseURL?.trim() || undefined,
			api: doc.deepseek.api?.trim() || undefined,
			headers: doc.deepseek.headers,
			credentialRef: credentialRefFor(doc.deepseek, "deepseek"),
		};
	}

	const profile = doc.piAi[name];
	if (!profile) return undefined;
	return {
		namespace: "llm-pi-ai",
		baseUrl: profile.baseURL?.trim() || undefined,
		api: profile.api?.trim() || undefined,
		headers: profile.headers,
		credentialRef: credentialRefFor(profile, name),
	};
}
