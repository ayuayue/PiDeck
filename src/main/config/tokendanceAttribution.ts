/**
 * TokenDance 应用归因兜底（请求维度 X-App-URL）。
 *
 * 官方归因规则（https://tokendance.space/docs/app-attribution.md）：
 * - X-App-URL 请求头是请求维度归因，存在时优先于 API Key 上的 app_url；
 * - Key 非 OAuth 创建时没有 Key 维度归因，但只要请求带 X-App-URL 即可归因到应用，
 *   且 App URL 不要求可访问，只要求 URL 形式 + 对同一应用唯一稳定。
 *
 * 一键安装（tokendanceInstaller）已把 X-App-URL 写进 provider 配置，但用户手动添加
 * tokendance provider（ModelsTab 手动加 / 配置文件手写）不会带，导致调用归因不到
 * PiDeck。此函数在 models.json 保存路径做规范化兜底：baseUrl 命中 tokendance.space
 * 的 provider 自动补 X-App-URL。
 *
 * 边界条件：
 * - 只补缺失，不覆盖用户显式值（用户可能想归因到自己的站点，显式写过就尊重）；
 * - HTTP 头大小写不敏感：已有任意大小写的 x-app-url 均视为已配置，不再注入；
 * - headers 字段非对象（异常数据）时保持原样不动，避免破坏用户数据；
 * - 纯函数、无副作用，便于单测。
 */
import { TOKENDANCE_APP_URL, TOKENDANCE_APP_URL_HEADER } from "../../shared/tokendance";
import type { PiModelsFile, PiProviderConfig } from "./ConfigManager";

/** TokenDance 网关 host（与 shared 常量同源，防拼写漂移）。 */
const TOKENDANCE_HOST = "tokendance.space";

/**
 * 判断 provider baseUrl 是否指向 TokenDance 网关。
 * 只按 hostname 精确匹配（含端口比较），路径/协议差异不影响判定；
 * 非字符串 / 无法解析的 baseUrl 一律视为不命中（不猜、不误伤其他供应商）。
 */
export function isTokendanceBaseUrl(baseUrl: unknown): boolean {
	if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) return false;
	try {
		return new URL(baseUrl.trim()).hostname === TOKENDANCE_HOST;
	} catch {
		return false;
	}
}

/** 从 provider 配置中读取 headers 对象（非对象时返回 undefined，保持调用方零假设）。 */
function readHeaders(provider: PiProviderConfig): Record<string, string> | undefined {
	const raw = provider.headers;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		// 只收窄字符串值；空键/非字符串（异常数据）丢弃，避免把坏配置写进请求
		if (key.trim().length > 0 && typeof value === "string") out[key] = value;
	}
	return out;
}

/**
 * 规范化 models.json：命中 TokenDance 的 provider 自动补 X-App-URL（只补缺失）。
 * 返回新对象，不修改入参。非 TokenDance provider 原样保留。
 */
export function ensureTokendanceAttribution(models: PiModelsFile): PiModelsFile {
	let changed = false;
	const providers: Record<string, PiProviderConfig> = {};
	for (const [name, provider] of Object.entries(models.providers)) {
		if (!isTokendanceBaseUrl(provider.baseUrl)) {
			providers[name] = provider;
			continue;
		}
		const raw = provider.headers;
		// headers 存在但非对象（异常数据）：保持原样不动，避免覆盖用户手写的坏数据
		if (raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) {
			providers[name] = provider;
			continue;
		}
		const headers = readHeaders(provider);
		// 大小写不敏感检查：HTTP 头语义不区分大小写，用户写 x-app-url 也算已配置
		const hasAppUrl = headers
			? Object.keys(headers).some((key) => key.toLowerCase() === TOKENDANCE_APP_URL_HEADER.toLowerCase())
			: false;
		if (hasAppUrl) {
			providers[name] = provider;
			continue;
		}
		providers[name] = {
			...provider,
			headers: { ...(headers ?? {}), [TOKENDANCE_APP_URL_HEADER]: TOKENDANCE_APP_URL },
		};
		changed = true;
	}
	return changed ? { ...models, providers } : models;
}
