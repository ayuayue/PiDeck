import { readFile, writeFile, mkdir } from "node:fs/promises";
import { normalize, join, dirname } from "node:path";
import { dirname as posixDirname, normalize as posixNormalize } from "node:path/posix";
import { homedir } from "node:os";
import { net, session } from "electron";
import type { Session } from "electron";
import type { ConfigFileDiagnostic, ConfigFileReadResult } from "../../shared/types";
import type { McpConfigFile, McpConfigSnapshot, McpProbeResult, McpServerDefinition } from "../../shared/types/mcp";
import {
	loadMcpConfigSnapshot,
	mcpDocsUrl,
	probeMcpServer,
	validateMcpConfigFile,
} from "./mcpConfig";
import {
	ensureOpenAiVersionPath,
	needsSessionBaseUrlVersionHint,
	suggestNormalizedBaseUrl,
} from "./baseUrlPath";
import type { WslEnvironment } from "../wsl/WslPaths";
import {
	mainProcessT,
	type MainProcessTranslationKey,
} from "../../shared/i18n/mainProcessCopy";
import type { FetchedModel } from "../../shared/types/fetchedModel";
import type {
	ProviderUsageResult,
	UsageProbeBackend,
	UsageProbeProviderConfig,
	UsageProbeRecognition,
	UsageProbeSettingsResult,
	UsageProbeTestInput,
} from "../../shared/types/providerUsage";
import { credentialRefFor } from "../../shared/dshCredentialRef";
import { normalizeDshDeepseekProvider } from "../../shared/dshProviderNames";
import { parseProviderModelsResponse } from "./parseProviderModels";
import { isSafeProviderName, piBuiltinSnapshotFromCatalog, resolvePiApiKey } from "./providerMigration";
import { ensureTokendanceAttribution } from "./tokendanceAttribution";
import {
	buildProbeFailureDetail,
	buildProbeHeaders,
	candidateApplies,
	getByPath,
	parseUsageResponseBody,
	USAGE_PROBE_CANDIDATES,
	usageProbeUrls,
} from "./providerUsageProbe";
import type { UsageProbeAttempt, UsageProbeCandidate } from "./providerUsageProbe";
import { resolveProviderUsageEndpoint } from "./providerUsageResolver";
import {
	buildDeclarativeUsageProbeTemplate,
	USAGE_PROBE_CATEGORY_BY_TEMPLATE_ID,
} from "./usageProbeTemplates";
import { loadUsageProbeSettings, loadUserUsageProbes, loadUserUsageProbesDetailed } from "./userUsageProbes";
import type { UserUsageProbe, UsageProbeSettingsLoadResult } from "./userUsageProbes";
import { usageProbeRequest } from "./usageProbeTransport";
import { pideckUsageProbesDir } from "../dsh/pideckDshHome";
import { getPiAiCatalogIndex } from "../pi/piAiBuiltinCatalog";
import { loadDshUsageProviderProfile } from "./dshUsageEndpoint";
import type { ConfigProxyTarget } from "../sessions/sessionProxyPolicy";

/** pi 全局配置目录：~/.pi/agent/ */
const PI_AGENT_DIR = join(homedir(), ".pi", "agent");

/** DSH 用量链路的外部读取能力（装配层注入；见 ConfigManager 构造注释）。 */
export type DshUsageLookup = {
	/** 生效 DSH_HOME（设置覆盖 > ~/.dsh > 应用私有目录，与 DshHost/resolveDshHomeDir 同一解析）。 */
	getHomeDir: () => string;
	/** 按 credential ref 读 DSH 凭据（$DSH_HOME/.credentials.yaml，环境层兜底）；无值返回 undefined。 */
	readCredential: (ref: string) => Promise<string | undefined>;
};

// ── models.json 结构 ──────────────────────────────────
// { providers: { [providerName]: { baseUrl, api, apiKey, models: [...] } } }

// Provider 用量/连接探测面对的是第三方网关，首包可能慢于普通模型；放宽超时避免误判。
const PROVIDER_TEST_TIMEOUT_MS = 45_000;

// 模型列表拉取的"显式代理"专用 session。
// 为什么不用 defaultSession + session.setProxy 全局改：桌面代理全局开关是用户
// 手动控制的（D:\桌面代理），这里按单个拉取请求临时开启/关闭代理，改全局会
// 影响用户在跑的会话流量；所以用独立内存 partition（非 persist 前缀=不落盘），
// 代理规则只影响本模块的请求。
let modelListProxySession: Session | null = null;
async function getModelListProxySession(): Promise<Session> {
	if (!modelListProxySession) {
		modelListProxySession = session.fromPartition("pideck-config-proxy", { cache: false });
	}
	return modelListProxySession;
}

// 根据代理目标挑出用于拉取模型列表的 fetch 实现：
// - follow/undefined → net.fetch（走默认 session，受桌面代理全局开关影响，现状行为）；
// - on/off → 独立 session，临时 setProxy 为 fixed_servers / direct 后 fetch。
// 返回 null 表示跟随全局（调用方继续用 net.fetch）。
async function modelListFetch(
	url: string,
	init: { method?: string; headers?: Record<string, string>; signal: AbortSignal },
	proxyTarget?: ConfigProxyTarget,
): Promise<Response | null> {
	if (proxyTarget?.mode !== "on" && proxyTarget?.mode !== "off") {
		return null;
	}
	const proxySession = await getModelListProxySession();
	const proxyMode = proxyTarget.mode === "on"
		? ({
			mode: "fixed_servers" as const,
			proxyRules: proxyTarget.url,
			proxyBypassRules: proxyTarget.bypass,
		})
		: ({ mode: "direct" as const });
	await proxySession.setProxy(proxyMode);
	return proxySession.fetch(url, init);
}
// 用量查询默认超时（学 cc-switch：10 秒；可被 per-provider 配置覆盖）。
const USAGE_PROBE_DEFAULT_TIMEOUT_MS = 10_000;

// 用量查询默认自动间隔（学 cc-switch：5 分钟；可被 per-provider 配置覆盖，0 = 不自动）。
const USAGE_PROBE_DEFAULT_INTERVAL_MINUTES = 5;

// Provider 用量探针响应体上限：用量接口返回 JSON，正常远小于此值；超限截断
// （而非整体丢弃），防止恶意/异常网关用超大响应体拖垮内存，同时保留诊断信息。
const MAX_USAGE_RESPONSE_BYTES = 64 * 1024;



// 模型 id 长度上限：过长 id 往往是误填，且可能撑爆某些网关/日志。
const MODEL_ID_MAX_LENGTH = 256;

/** 判断字符串是否含控制字符（换行/tab 等），防止配置被注入换行破坏 JSON 语义。 */
function hasControlChar(value: string): boolean {
	// eslint-disable-next-line no-control-regex
	return /[\x00-\x1f\x7f]/.test(value);
}

export type PiModelItem = {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	[key: string]: unknown;
};

export type PiProviderConfig = {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models: PiModelItem[];
	[key: string]: unknown;
};

export type PiModelsFile = {
	providers: Record<string, PiProviderConfig>;
};

// ── auth.json 结构 ────────────────────────────────────
// { [providerName]: { type: "api_key", key: "..." } }

export type PiAuthItem = {
	type?: string;
	key?: string;
	[key: string]: unknown;
};

export type PiAuthFile = Record<string, PiAuthItem>;

// ── settings.json ─────────────────────────────────────

export type PiSettings = Record<string, unknown>;

export type ConfigValidationResult = {
	valid: boolean;
	error?: string;
	debugDetails?: string;
};

type ConfigCopy = (
	key: MainProcessTranslationKey,
	params?: Record<string, string | number>,
) => string;

type TestRequest = {
	url: string;
	headers: Record<string, string>;
	body?: string;
	method?: "GET" | "POST";
};

/**
 * 管理 pi 全局配置文件（~/.pi/agent/ 下的 models.json、auth.json、settings.json、mcp.json）。
 * 按照 pi 实际文件格式解析：models.json 是嵌套 providers 结构，auth.json 是对象映射。
 */
export class ConfigManager {
	private configDir: string;

	constructor(
		configDir?: string,
		private readonly translate: ConfigCopy = (key, params) => mainProcessT("zh-CN", key, params),
		/**
		 * DSH 用量链路注入（backend="dsh" 时使用）：
		 * - 配置落盘在 $DSH_HOME/usage-probes.json（与 pi 侧 ~/.pi/agent/usage-probes.json 同构）；
		 * - 凭据从 $DSH_HOME/.credentials.yaml 按 credential ref 读取（与 DshHost 同一解析规则）。
		 * 不注入时 DSH backend 请求按「无凭据」回落（提示未配置 key），不影响 pi 链路。
		 */
		private readonly dshUsage?: DshUsageLookup,
	) {
		this.configDir = configDir ?? PI_AGENT_DIR;
	}

	/** 将配置目录切换到统一解析出的 WSL HOME；null 恢复 Windows home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.configDir = environment
			? join(environment.windowsHome, ".pi", "agent")
			: PI_AGENT_DIR;
	}

	/** 当前 pi 全局配置目录（WSL 环境为 windowsHome 映射），供渲染层展示源文件实际编辑位置。 */
	getConfigDir(): string {
		return this.configDir;
	}

	// ── 读取 ──────────────────────────────────────────────

	async getModelsConfig(): Promise<ConfigFileReadResult<PiModelsFile>> {
		return this.readJsonFile<PiModelsFile>("models.json", { providers: {} });
	}

	async getAuthConfig(): Promise<ConfigFileReadResult<PiAuthFile>> {
		return this.readJsonFile<PiAuthFile>("auth.json", {});
	}

	async getSettingsConfig(): Promise<ConfigFileReadResult<PiSettings>> {
		return this.readJsonFile<PiSettings>("settings.json", {});
	}

	async getTrustConfig(): Promise<ConfigFileReadResult<Record<string, boolean>>> {
		return this.readJsonFile<Record<string, boolean>>("trust.json", {});
	}

	/**
	 * 合并 pi-mcp-adapter 各层 mcp.json；可写层固定为当前 configDir/mcp.json。
	 * projectPath 有值时额外合并项目 `.mcp.json` / `.pi/mcp.json`（只读）。
	 */
	async getMcpConfig(projectPath?: string): Promise<McpConfigSnapshot> {
		return loadMcpConfigSnapshot(this.configDir, projectPath);
	}

	async saveMcpConfig(file: McpConfigFile): Promise<ConfigValidationResult> {
		const error = validateMcpConfigFile(file);
		if (error) return { valid: false, error };
		await this.writeJsonFile("mcp.json", file);
		return { valid: true };
	}

	async probeMcpServer(definition: McpServerDefinition): Promise<McpProbeResult> {
		return probeMcpServer(definition);
	}

	async ensureTrustedDirectory(directoryPath: string): Promise<void> {
		const normalizedPath = this.normalizeTrustPath(directoryPath);
		const trustConfig = await this.getTrustConfig();
		if (trustConfig.diagnostic) return;

		const existingEntry = Object.entries(trustConfig.parsed).find(
			([path]) => this.normalizeTrustPathKey(path) === this.normalizeTrustPathKey(normalizedPath),
		);
		if (existingEntry) return;

		// 若用户已用不同大小写/分隔符写过同一路径，或显式设为 false，则不覆盖，尊重用户的 trust.json 决策。
		await this.writeJsonFile("trust.json", {
			...trustConfig.parsed,
			[normalizedPath]: true,
		});
	}

	/**
	 * 查询某项目目录的信任决策，沿父目录链查找最近记录（复刻 pi 的 findNearestTrustEntry 语义）。
	 * pi 的信任语义是父目录决策继承到子目录，例如 trust.json 记录 "C:\\Users": true，
	 * 则 C:\\Users\\14012\\project 同样视为已信任。返回 true/false；未记录返回 null。
	 */
	async getProjectTrustDecision(cwd: string): Promise<boolean | null> {
		const trustConfig = await this.getTrustConfig();
		if (trustConfig.diagnostic) return null;
		return this.findNearestTrustEntry(trustConfig.parsed, cwd);
	}

	/**
	 * 写入某项目目录的信任决策（覆盖该路径既有值）。
	 * 用户在信任弹窗选择“信任并记住”或“不信任”后调用，持久化决策避免重复打扰。
	 */
	async setProjectTrustDecision(cwd: string, decision: boolean): Promise<void> {
		const trustConfig = await this.getTrustConfig();
		if (trustConfig.diagnostic) return;
		const key = this.normalizeTrustPath(cwd);
		await this.writeJsonFile("trust.json", {
			...trustConfig.parsed,
			[key]: decision,
		});
	}

	/**
	 * 沿父目录链查找最近的信任记录。key 比较统一走 normalizeTrustPathKey，
	 * 与 ensureTrustedDirectory 的去重逻辑保持一致，避免大小写/分隔符差异导致漏查。
	 */
	private findNearestTrustEntry(data: Record<string, boolean>, cwd: string): boolean | null {
		const normalized = new Map<string, boolean>();
		for (const [key, value] of Object.entries(data)) {
			normalized.set(this.normalizeTrustPathKey(key), value);
		}
		let current = this.normalizeTrustPathKey(cwd);
		while (true) {
			const value = normalized.get(current);
			if (value === true || value === false) return value;
			const parent = current.startsWith("/") ? posixDirname(current) : dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}

	private normalizeTrustPathKey(path: string) {
		const normalized = this.normalizeTrustPath(path).replace(/[\\/]+$/, "");
		return process.platform === "win32" && !normalized.startsWith("/")
			? normalized.toLowerCase()
			: normalized;
	}

	private normalizeTrustPath(path: string) {
		if (!path.startsWith("/")) return normalize(path);
		const normalized = posixNormalize(path);
		return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
	}

	// ── 保存（可视化表单） ────────────────────────────────

	async saveModelsConfig(data: PiModelsFile): Promise<ConfigValidationResult> {
		const validation = this.validateModels(data);
		if (!validation.valid) return validation;
		// 保存前统一迁移历史别名，确保写入 models.json 的 api 名称能被 pi 官方 registry 识别。
		// 随后做 TokenDance 归因兜底：用户手动添加的 tokendance provider 若没带 X-App-URL，
		// 调用在平台上归因不到本应用（见 tokendanceAttribution.ts 头注释的官方归因规则）。
		await this.writeJsonFile("models.json", ensureTokendanceAttribution(this.normalizeModelsForPi(data)));
		return { valid: true };
	}

	async saveAuthConfig(data: PiAuthFile): Promise<ConfigValidationResult> {
		await this.writeJsonFile("auth.json", data);
		return { valid: true };
	}

	async saveSettingsConfig(
		settings: PiSettings,
	): Promise<ConfigValidationResult> {
		await this.writeJsonFile("settings.json", settings);
		return { valid: true };
	}

	// ── 保存（源文件编辑） ────────────────────────────────

	async saveRawConfig(
		fileName: string,
		rawJson: string,
	): Promise<ConfigValidationResult> {
		try {
			JSON.parse(rawJson);
		} catch (e) {
			const debugDetails = e instanceof Error ? e.message : String(e);
			console.error("[ConfigManager] Invalid JSON input", e);
			return {
				valid: false,
				error: this.translate("mainConfig.invalidJson"),
				debugDetails,
			};
		}

		const allowed = ["models.json", "auth.json", "settings.json", "trust.json", "mcp.json"];
		if (fileName === "mcp.json") {
			const parsed = JSON.parse(rawJson) as McpConfigFile;
			const mcpError = validateMcpConfigFile(parsed);
			if (mcpError) return { valid: false, error: mcpError };
		}
		if (!allowed.includes(fileName)) {
			return {
				valid: false,
				error: this.translate("mainConfig.fileNotEditable", { fileName }),
			};
		}

		await this.writeJsonFile(fileName, rawJson);
		return { valid: true };
	}

	// ── 校验 ──────────────────────────────────────────────

	private validateModels(data: PiModelsFile): ConfigValidationResult {
		if (!data.providers || typeof data.providers !== "object") {
			return { valid: false, error: this.translate("mainConfig.modelsProvidersRequired") };
		}
		for (const [providerName, config] of Object.entries(data.providers)) {
			// provider 名做宽松安全校验（防路径穿越/控制字符/超长）；严格白名单
			// （字母开头、无空格特殊字符）只用于前端新增/重命名入口，避免卡历史数据。
			if (!isSafeProviderName(providerName) || hasControlChar(providerName)) {
				return {
					valid: false,
					error: this.translate("mainConfig.providerNameInvalid", { provider: providerName }),
				};
			}
			if (!config.models || !Array.isArray(config.models)) {
				return {
					valid: false,
					error: this.translate("mainConfig.providerModelsRequired", { provider: providerName }),
				};
			}
			// baseUrl 若填写则禁止控制字符（换行等），防止配置被篡改破坏 JSON 语义。
			if (typeof config.baseUrl === "string" && hasControlChar(config.baseUrl)) {
				return {
					valid: false,
					error: this.translate("mainConfig.baseUrlInvalid", { provider: providerName }),
				};
			}
			for (let i = 0; i < config.models.length; i++) {
				const m = config.models[i];
				if (!m.id || typeof m.id !== "string") {
					return {
						valid: false,
						error: this.translate("mainConfig.modelIdRequired", { provider: providerName, index: i + 1 }),
					};
				}
				// 模型 id 允许 / . - _ 等（如 deepseek-ai/DeepSeek-V3.2），仅拒绝控制字符与超长。
				if (hasControlChar(m.id) || m.id.length > MODEL_ID_MAX_LENGTH) {
					return {
						valid: false,
						error: this.translate("mainConfig.modelIdInvalid", { provider: providerName, index: i + 1 }),
					};
				}
			}
		}
		return { valid: true };
	}

	// ── 文件 IO ───────────────────────────────────────────

	private async readJsonFile<T>(
		fileName: string,
		fallback: T,
	): Promise<ConfigFileReadResult<T>> {
		const filePath = join(this.configDir, fileName);
		try {
			const raw = await readFile(filePath, "utf8");
			try {
				const parsed = JSON.parse(raw) as T;
				return { raw, parsed };
			} catch (error) {
				// 配置 JSON 写错时，配置弹窗仍要能打开 Raw 页让用户修复；同时返回精确诊断用于 UI 提示。
				return {
					raw,
					parsed: fallback,
					diagnostic: this.createJsonDiagnostic(fileName, raw, error),
				};
			}
		} catch {
			return { raw: JSON.stringify(fallback, null, 2), parsed: fallback };
		}
	}

	private createJsonDiagnostic(
		fileName: string,
		raw: string,
		error: unknown,
	): ConfigFileDiagnostic {
		const message = error instanceof Error ? error.message : String(error);
		const positionMatch = message.match(/position\s+(\d+)/i);
		const position = positionMatch ? Number(positionMatch[1]) : undefined;
		let line: number | undefined;
		let column: number | undefined;
		let snippet: string | undefined;
		if (Number.isFinite(position)) {
			const before = raw.slice(0, position);
			const lines = before.split(/\r?\n/);
			line = lines.length;
			column = lines[lines.length - 1].length + 1;
			const rawLines = raw.split(/\r?\n/);
			const start = Math.max(0, line - 2);
			const end = Math.min(rawLines.length, line + 1);
			snippet = rawLines
				.slice(start, end)
				.map((text, index) => `${start + index + 1}: ${text}`)
				.join("\n");
		}
		return {
			fileName,
			message,
			line,
			column,
			snippet,
			docsUrl: this.docsUrlForFile(fileName),
		};
	}

	private docsUrlForFile(fileName: string) {
		if (fileName === "models.json") return "https://pi.dev/docs/latest/models";
		if (fileName === "settings.json") return "https://pi.dev/docs/latest/settings";
		if (fileName === "mcp.json") return mcpDocsUrl();
		return "https://pi.dev/docs/latest/providers";
	}

	private async writeJsonFile(
		fileName: string,
		content: unknown,
	): Promise<void> {
		await mkdir(this.configDir, { recursive: true });
		const filePath = join(this.configDir, fileName);
		const json =
			typeof content === "string" ? content : JSON.stringify(content, null, 2);
		await writeFile(filePath, json, "utf8");
	}

	// ── 远程拉取模型列表 ─────────────────────────────────

	/**
	 * 向 provider 拉取可用模型列表。
	 * 对优先路径尝试失败后自动回退到备选路径，提升对各厂商端点格式差异的容错。
	 * proxyTarget 显式指定代理策略（on/off），可覆盖桌面代理全局开关；不传则跟随全局。
	 */
	async fetchProviderModels(
		baseUrl: string,
		apiKey: string,
		apiType?: string,
		headers?: Record<string, string>,
		proxyTarget?: ConfigProxyTarget,
	): Promise<{
		success: boolean;
		models?: FetchedModel[];
		error?: string;
		debugDetails?: string;
		/** 实际成功/最后一次请求的 URL（脱敏），用于 UI 对比会话侧路径 */
		requestUrl?: string;
		/** 检测侧补了版本路径，而配置 baseUrl 仍是根路径 → 会话可能 404 */
		sessionBaseUrlNeedsVersion?: boolean;
		/** 建议写入配置的 baseUrl（含 /v1 等）；UI 可自动改写 */
		suggestedBaseUrl?: string;
	}> {
		const requests = this.buildModelsRequest(baseUrl, apiKey, apiType, headers);
		let lastError: string | undefined;
		let lastDebugDetails: string | undefined;
		let lastRequestUrl: string | undefined;

		for (const request of requests) {
			lastRequestUrl = this.redactSecret(request.url, apiKey);
			try {
				const controller = new AbortController();
				// 10 秒超时，避免网络不通时长时间卡住
				const timeout = setTimeout(() => controller.abort(), 10_000);

				try {
					// 桌面端配置检测属于 Electron 主进程自身请求；net.fetch 才走 defaultSession 的代理配置。
					// 显式选择了代理时改用独立 session（见 modelListFetch），避免动全局代理开关。
					const response = await modelListFetch(
						request.url,
						{
							method: request.method ?? "GET",
							headers: request.headers,
							signal: controller.signal,
						},
						proxyTarget,
					);
					const res = response ?? (await net.fetch(request.url, {
						method: request.method ?? "GET",
						headers: request.headers,
						signal: controller.signal,
					}));

					if (!res.ok) {
						lastDebugDetails = `HTTP ${res.status}: ${res.statusText}`;
						console.warn("[ConfigManager] Provider model list request failed", {
							status: res.status,
							requestUrl: lastRequestUrl,
						});
						lastError = this.translate("mainConfig.fetchModelsFailed");
						continue;
					}

					const body = (await res.json()) as Record<string, unknown>;
					// listing 有容量就用；缺的再按 pi-ai 内置目录精确匹配，仍缺则空着
					const models = this.parseModelsResponse(body, apiType);

					if (models.length === 0) {
						lastError = this.translate("mainConfig.emptyModelList");
						continue;
					}

					// 成功路径若依赖检测侧自动补 /v1，而用户配置仍是根路径，
					// 会话侧会原样用 baseUrl → 返回建议 baseUrl 供 UI 自动改写。
					const sessionBaseUrlNeedsVersion = needsSessionBaseUrlVersionHint(
						baseUrl,
						request.url,
					);
					const suggestedBaseUrl =
						suggestNormalizedBaseUrl(baseUrl, request.url, apiType) ?? undefined;
					return {
						success: true,
						models,
						requestUrl: lastRequestUrl,
						sessionBaseUrlNeedsVersion,
						suggestedBaseUrl,
					};
				} finally {
					clearTimeout(timeout);
				}
			} catch (e) {
				if (e instanceof Error && e.name === "AbortError") {
					lastError = this.translate("mainConfig.fetchTimeout");
				} else {
					console.error("[ConfigManager] Provider model list request failed", e);
					lastError = this.translate("mainConfig.fetchModelsFailed");
				}
			}
		}

		return {
			success: false,
			error: lastError ?? this.translate("mainConfig.fetchModelsFailed"),
			...(lastDebugDetails ? { debugDetails: lastDebugDetails } : {}),
			requestUrl: lastRequestUrl,
			sessionBaseUrlNeedsVersion: needsSessionBaseUrlVersionHint(
				baseUrl,
				lastRequestUrl,
			),
		};
	}


	// ── 快速测试连接 ─────────────────────────────────────

	/**
	 * 向 provider 发送一条最小聊天请求验证 baseUrl、apiKey 和模型是否正常。
	 * 返回测试结果，包含模型名、响应摘要、token 用量和延迟。
	 */
	/**
	 * 根据 API 类型构造获取模型列表的 URL 列表（含优先路径和回退路径）。
	 * fetchProviderModels 会逐条尝试直到成功或全部失败。
	 *
	 * 各厂商获取模型列表的支持情况：
	 *
	 * | API 类型 | 优先路径 | 回退路径 |
	 * |----------|---------|---------|
	 * | OpenAI Chat Completions | /v1/models | /models |
	 * | OpenAI Responses / Codex | /v1/models | /models |
	 * | Anthropic Messages | /v1/models | /models |
	 * | Google Gemini | /v1beta/models | - |
	 * | Mistral Conversations | /v1/models | /models |
	 *
	 * OpenAI 生态（Chat Completions / Responses / Codex / Mistral）统一通过
	 * GET /v1/models 获取模型列表。
	 * 虽然 Anthropic 官方未公开 models 端点，但大部分兼容 Anthropic 协议的
	 * 第三方网关同样支持 /v1/models。优先尝试 /v1/models，再回退到 /models。
	 * Google Gemini 使用独立的 /v1beta/models。
	 */
	private buildModelsRequest(
		baseUrl: string,
		apiKey: string,
		apiType?: string,
		requestHeaders?: Record<string, string>,
	): TestRequest[] {
		const api = this.normalizeApiType(apiType);
		// 与真实会话一致：允许 provider 配置的自定义 headers（含 User-Agent）
		// 覆盖 SDK 默认 UA，保证「获取模型」与「真实会话」走同一套网络形象。
		const extraHeaders = this.normalizeRequestHeaders(requestHeaders);

		if (api === "google-generative-ai") {
			// Google Gemini：使用独立的 v1beta 路径
			const u = baseUrl.replace(/\/+$/, "");
			const needsPrefix = !/[\/]v\d+(alpha|beta)?$/.test(u);
			const versioned = needsPrefix ? `${u}/v1beta` : u;
			return [{
				url: `${versioned}/models?key=${encodeURIComponent(apiKey)}`,
				headers: { "Content-Type": "application/json", ...extraHeaders },
			}];
		}

		if (api === "anthropic-messages") {
			// Anthropic：优先尝试 /v1/models（兼容大部分第三方网关），
			// 再回退到 /models（原生 Anthropic API 或旧实现）
			const u = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
			const headers = this.withAnthropicSdkUserAgent({
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"Content-Type": "application/json",
				...extraHeaders,
			});
			const primaryUrl = `${u}/v1/models`;
			const fallbackUrl = `${u}/models`;
			return primaryUrl === fallbackUrl
				? [{ url: primaryUrl, headers }]
				: [
					{ url: primaryUrl, headers },
					{ url: fallbackUrl, headers },
				];
		}

		// OpenAI 兼容 API（Chat Completions / Responses / Codex / Mistral）：
		// 优先尝试 ensureVersionPath 补齐后的路径，再回退到原始 baseUrl + /models
		const headers = this.withOpenAiSdkUserAgent({
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			...extraHeaders,
		});
		const u = baseUrl.replace(/\/+$/, "");
		const primaryUrl = `${this.ensureVersionPath(baseUrl)}/models`;
		const fallbackUrl = `${u}/models`;

		return primaryUrl === fallbackUrl
			? [{ url: primaryUrl, headers }]
			: [
				{ url: primaryUrl, headers },
				{ url: fallbackUrl, headers },
			];
	}


	private parseModelsResponse(
		body: Record<string, unknown>,
		apiType?: string,
	): FetchedModel[] {
		const listing = parseProviderModelsResponse(body, this.normalizeApiType(apiType));
		// 只返回 endpoint 实报字段，不做 bundled catalog 预填：
		// 预填会让「拉取后新增」与「手动新增」走两套模板优先级，且用户手改字段难以区分来源。
		// catalog 补空统一由渲染层保存/重置流程经 projects:get-model-spec 完成（endpoint 实报优先）。
		return listing;
	}

	private normalizeModelsForPi(data: PiModelsFile): PiModelsFile {
		return {
			...data,
			providers: Object.fromEntries(
				Object.entries(data.providers).map(([name, provider]) => [
					name,
					{
						...provider,
						api: this.normalizeApiType(provider.api),
						models: provider.models.map((model) => {
							const normalized: PiModelItem = {
								...model,
								api: typeof model.api === "string"
									? this.normalizeApiType(model.api)
									: model.api,
							};
							// pi schema 中 name 可选但需 minLength:1，空 name 会让 pi 整文件拒绝。
							// 与拉取供应商列表的 parseProviderModelsResponse 行为对齐：name 为空
							// 就删掉该键（可选字段缺省反而合法），避免手动新增模型留空时写坏文件。
							if (typeof normalized.name === "string" && normalized.name.length === 0) {
								delete normalized.name;
							}
							return normalized;
						}),
					},
				]),
			),
		};
	}

	private normalizeApiType(apiType?: string) {
		switch (apiType) {
			case "anthropic":
			case "anthropic-messages":
				return "anthropic-messages";
			case "openai-codex-responses":
				return "openai-codex-responses";
			case "openai-chat-completions":
				// 兼容早期 pi-desktop 暴露过的别名；pi 官方 registry 名称是 openai-completions。
				return "openai-completions";
			case "openai-completions":
			case "openai-responses":
			case "google-generative-ai":
			case "mistral-conversations":
				return apiType;
			default:
				return "openai-completions";
		}
	}

	/**
	 * 确保 OpenAI 兼容 API 的基础 URL 包含 /v1 版本路径。
	 * 仅用于「获取模型列表 / 用量探测」；真实会话走 pi，不会用此补齐。
	 */
	private ensureVersionPath(baseUrl: string): string {
		return ensureOpenAiVersionPath(baseUrl);
	}

	private normalizeRequestHeaders(headers?: Record<string, string>) {
		if (!headers) return {};
		return Object.fromEntries(
			Object.entries(headers).filter(
				([key, value]) =>
					key.trim().length > 0 && typeof value === "string",
			),
		);
	}

	private withOpenAiSdkUserAgent(headers: Record<string, string>) {
		const hasUserAgent = Object.keys(headers).some(
			(key) => key.toLowerCase() === "user-agent",
		);
		// pi 的 openai-responses provider 走 OpenAI JS SDK。部分代理会按 SDK
		// 默认 User-Agent 拦截请求，所以配置检测需要模拟该默认值，避免“检测通过、会话 403”。
		return hasUserAgent ? headers : { ...headers, "User-Agent": "OpenAI/JS 6.26.0" };
	}

	private withAnthropicSdkUserAgent(headers: Record<string, string>) {
		const hasUserAgent = Object.keys(headers).some(
			(key) => key.toLowerCase() === "user-agent",
		);
		// pi 的 anthropic-messages provider 走 Anthropic SDK。部分服务会验证
		// User-Agent 避免非官方客户端，所以需要模拟 SDK 的默认值。
		return hasUserAgent ? headers : { ...headers, "User-Agent": "anthropic-sdk-typescript/0.27.3" };
	}

	private redactSecret(value: string, apiKey: string) {
		if (!apiKey) return value;
		return value.split(apiKey).join("***");
	}

	// ── 导出 / 导入 ───────────────────────────────────────

	/** 将 pi 配置文件打包为单个 JSON 对象，便于用户备份和迁移。 */
	async exportConfig(): Promise<string> {
		const [models, auth, settings, mcp] = await Promise.all([
			this.readJsonFile<PiModelsFile>("models.json", { providers: {} }),
			this.readJsonFile<PiAuthFile>("auth.json", {}),
			this.readJsonFile<PiSettings>("settings.json", {}),
			this.readJsonFile<McpConfigFile>("mcp.json", { mcpServers: {} }),
		]);
		return JSON.stringify(
			{
				version: 1,
				exportedAt: new Date().toISOString(),
				files: {
					"models.json": models.parsed,
					"auth.json": auth.parsed,
					"settings.json": settings.parsed,
					"mcp.json": mcp.parsed,
				},
			},
			null,
			2,
		);
	}

	/** 从导出的 JSON 包恢复配置文件，返回导入结果。 */
	async importConfig(
		packageJson: string,
	): Promise<ConfigValidationResult> {
		let pkg: unknown;
		try {
			pkg = JSON.parse(packageJson);
		} catch (e) {
			const debugDetails = e instanceof Error ? e.message : String(e);
			console.error("[ConfigManager] Invalid configuration import JSON", e);
			return {
				valid: false,
				error: this.translate("mainConfig.invalidJson"),
				debugDetails,
			};
		}
		const data = pkg as Record<string, unknown>;
		const files = data.files as Record<string, unknown> | undefined;
		if (!files || typeof files !== "object") {
			return { valid: false, error: this.translate("mainConfig.importFilesRequired") };
		}

		// 按需写入已知文件；mcp.json 走 adapter 校验，避免脏包覆盖可写层。
		const allowed: Array<[string, string]> = [
			["models.json", "models.json"],
			["auth.json", "auth.json"],
			["settings.json", "settings.json"],
		];
		for (const [key, fileName] of allowed) {
			if (files[key] != null) {
				await this.writeJsonFile(fileName, files[key]);
			}
		}
		if (files["mcp.json"] != null) {
			const mcpFile = files["mcp.json"] as McpConfigFile;
			const mcpError = validateMcpConfigFile(mcpFile);
			if (mcpError) return { valid: false, error: mcpError };
			await this.writeJsonFile("mcp.json", mcpFile);
		}
		return { valid: true };
	}

	/**
	 * 查询 provider 用量/余额（学 cc-switch 的三层模型，全部按 provider 名路由）：
	 * 1. 门控：providers[name].enabled === false → 不查（返回「未启用」结构化结果，
	 *    UI 据此显示小按钮引导配置）；
	 * 2. 模板路由：配置了声明式模板（general/newapi）→ 用模板构建候选（覆盖字段生效）；
	 *    未配置 → 内置候选表 + 旧 probes 数组按 baseUrl/apiType 自动匹配（内置默认开）；
	 * 3. 超时：per-provider timeoutSecs（默认 10s，学 cc-switch）。
	 * backend="dsh" 时配置/凭据走 DSH 链路（$DSH_HOME）：DSH 侧已配置则该配置为准；
	 * 未配置时回退 Pi 侧同 provider 配置（display parity，见 loadUsageSettingsWithFallback）。
	 * 全部失败时返回结构化错误，并对响应做密钥脱敏，避免把 token 回传给渲染层。
	 */
	async fetchProviderUsage(provider: string, backend: UsageProbeBackend = "pi"): Promise<ProviderUsageResult> {
		// DSH 官方 DeepSeek 的 provider 名归一化：llm.models 组 id（deepseek-official）与
		// 配置面规范名（deepseek）不一致，不归一就读不到 DSH 卡片保存的探针配置/端点。
		if (backend === "dsh") provider = normalizeDshDeepseekProvider(provider);
		const settingsDir = this.usageProbeSettingsDir(backend);
		// 1) 门控：用户显式关闭（enabled=false）→ 快速返回，不发请求。
		// DSH 未单独配置时回退 Pi 同 provider 配置（display parity：Pi 已配置并显示 → DSH 卡片默认也显示）。
		const { settings, effectiveDir } = await this.loadUsageSettingsWithFallback(backend, provider, settingsDir);
		for (const error of settings.errors) {
			console.warn("[ConfigManager] 用量探针配置被忽略：", error);
		}
		if (settings.config?.enabled === false) {
			return {
				success: false,
				disabled: true,
				error: this.translate("mainConfig.providerUsageDisabled"),
			};
		}

		// 2) 解析 provider 端点（models.json → catalog 兜底；DSH backend 额外读 DSH 凭据库）。
		const resolved = await this.resolveUsageEndpoint(provider, backend);
		if (!resolved.matched || !resolved.baseUrl) {
			return { success: false, error: this.translate("mainConfig.providerUsageUnsupported") };
		}
		// 属性收窄在 await 后失效：立即取局部 const 供后续模板路由使用。
		const resolvedBaseUrl = resolved.baseUrl;
		const resolvedApiKey = resolved.apiKey ?? "";
		const api = this.normalizeApiType(resolved.apiType);
		const timeoutMs = (settings.config?.timeoutSecs ?? 10) * 1000;
		const intervalMinutes = settings.config?.intervalMinutes ?? USAGE_PROBE_DEFAULT_INTERVAL_MINUTES;

		// 3) 模板路由：声明式模板优先（用户显式选择），否则内置 + 旧探针自动匹配。
		const template = settings.config?.template;
		if (template === "general" || template === "newapi" || template === "cookie") {
			const built = buildDeclarativeUsageProbeTemplate(template, settings.config ?? {}, {
				baseUrl: resolvedBaseUrl,
				apiKey: resolvedApiKey,
			});
			if ("error" in built) {
				return { success: false, error: built.error };
			}
			return this.runProviderUsageProbes(
				built.baseUrl,
				built.apiKey,
				resolved.headers,
				[built.candidate],
				timeoutMs,
				intervalMinutes,
			);
		}

		const userProbes = await loadUserUsageProbes(effectiveDir);
		for (const error of userProbes.errors) {
			console.warn("[ConfigManager] 用户用量探针配置被忽略：", error);
		}
		const applicable = [...USAGE_PROBE_CANDIDATES, ...userProbes.candidates].filter((c) =>
			candidateApplies(c, resolvedBaseUrl, api),
		);
		if (applicable.length === 0) {
			return { success: false, error: this.translate("mainConfig.providerUsageUnsupported") };
		}
		return this.runProviderUsageProbes(
			resolvedBaseUrl,
			resolvedApiKey,
			resolved.headers,
			applicable,
			timeoutMs,
			intervalMinutes,
		);
	}

	/**
	 * 打开探针配置弹窗时的数据：该 provider 已保存配置 + 内置模板自动识别结果。
	 * 识别 = 解析端点后按 baseUrl/apiType 匹配内置候选（带 templateId 的），
	 * 未命中返回 null（弹窗回落到声明式模板选择）。backend 决定配置目录（pi/dsh）。
	 */
	async getUsageProbeSettings(
		provider: string,
		backend: UsageProbeBackend = "pi",
	): Promise<UsageProbeSettingsResult> {
		// 同 fetchProviderUsage：DSH 组 id 别名先归一，才能读回以规范名保存的配置。
		if (backend === "dsh") provider = normalizeDshDeepseekProvider(provider);
		const { settings: loaded, effectiveDir } = await this.loadUsageSettingsWithFallback(
			backend,
			provider,
			this.usageProbeSettingsDir(backend),
		);
		// 旧版 probes 数组命中回显：手写/历史探针没有声明式配置，弹窗据此预填 Cookie 模板字段迁移。
		// 回退语义下旧版 probes 也来自 effectiveDir（Pi 目录），弹窗看到的迁移源与实际查询一致。
		const legacyProbes = await this.matchLegacyProbesForProvider(provider, backend, effectiveDir);
		return {
			...(loaded.config ? { config: loaded.config } : {}),
			recognized: await this.recognizeUsageTemplate(provider, backend),
			templates: [],
			errors: loaded.errors,
			...(legacyProbes.length > 0 ? { legacyProbes } : {}),
		};
	}

	/**
	 * 按 provider 查找命中的旧版探针（usage-probes.json 的 probes 数组）。
	 * 匹配规则与运行时合并探测一致（candidateApplies：baseUrlContains / apiTypes），
	 * 保证「弹窗看到的迁移源」与「实际查询时生效的探针」是同一批。
	 */
	private async matchLegacyProbesForProvider(
		provider: string,
		backend: UsageProbeBackend = "pi",
		dir = this.usageProbeSettingsDir(backend),
	): Promise<UserUsageProbe[]> {
		const resolved = await this.resolveUsageEndpoint(provider, backend);
		if (!resolved.matched || !resolved.baseUrl) return [];
		const api = this.normalizeApiType(resolved.apiType);
		const loaded = await loadUserUsageProbesDetailed(dir);
		const hits: UserUsageProbe[] = [];
		for (let index = 0; index < loaded.candidates.length; index += 1) {
			const probe = loaded.probes[index];
			const candidate = loaded.candidates[index];
			if (probe && candidate && candidateApplies(candidate, resolved.baseUrl, api)) {
				hits.push(probe);
			}
		}
		return hits;
	}

	/** 内置模板自动识别（零配置生效路径）：命中返回 templateId + 面向用户的类别。 */
	async recognizeUsageTemplate(
		provider: string,
		backend: UsageProbeBackend = "pi",
	): Promise<UsageProbeRecognition | null> {
		const resolved = await this.resolveUsageEndpoint(provider, backend);
		if (!resolved.matched || !resolved.baseUrl) return null;
		const api = this.normalizeApiType(resolved.apiType);
		for (const candidate of USAGE_PROBE_CANDIDATES) {
			if (!candidate.templateId) continue;
			if (candidateApplies(candidate, resolved.baseUrl, api)) {
				const category = USAGE_PROBE_CATEGORY_BY_TEMPLATE_ID[candidate.templateId];
				return { templateId: candidate.templateId, category: category ?? "balance" };
			}
		}
		return null;
	}

	/**
	 * 单条模板测试（配置弹窗「测试」按钮）：按模板 id 构建候选后直接探测。
	 * template 省略 = 自动识别内置模板；无内置且未给模板时返回错误。
	 * 密钥只在主进程发请求（配置覆盖字段经 buildDeclarativeUsageProbeTemplate 合并）。
	 */
	async testUsageProbe(input: UsageProbeTestInput): Promise<ProviderUsageResult> {
		const backend = input.backend ?? "pi";
		const resolved = await this.resolveUsageEndpoint(input.provider, backend);
		if (!resolved.matched || !resolved.baseUrl) {
			return { success: false, error: this.translate("mainConfig.providerUsageUnsupported") };
		}
		// 属性收窄在 await 后失效：立即取局部 const。
		const resolvedBaseUrl = resolved.baseUrl;
		const resolvedApiKey = resolved.apiKey ?? "";
		const timeoutMs = (input.timeoutSecs ?? 10) * 1000;

		// 显式模板优先；否则走内置自动识别（测「识别命中」这条零配置路径）。
		// 注意 backend 必须透传：DSH 弹窗测的是 DSH 链路的识别结果。
		const template =
			input.template?.trim() ||
			(await this.recognizeUsageTemplate(input.provider, backend))?.templateId;
		if (!template) {
			return { success: false, error: this.translate("mainConfig.providerUsageUnsupported") };
		}

		// 声明式模板（general/newapi/cookie）：构建候选时可携带覆盖字段。
		if (template === "general" || template === "newapi" || template === "cookie") {
			const built = buildDeclarativeUsageProbeTemplate(
				template,
				{
					apiKey: input.apiKey,
					baseUrl: input.baseUrl,
					accessToken: input.accessToken,
					userId: input.userId,
					cookie: input.cookie,
					cookiePath: input.cookiePath,
					valuePath: input.valuePath,
					currencyPath: input.currencyPath,
				},
				{ baseUrl: resolvedBaseUrl, apiKey: resolvedApiKey },
			);
			if ("error" in built) {
				return { success: false, error: built.error };
			}
			return this.runProviderUsageProbes(
				built.baseUrl,
				built.apiKey,
				resolved.headers,
				[built.candidate],
				timeoutMs,
				0,
			);
		}

		// 内置模板：按 templateId 找候选（不可改写结构，测的是零配置路径本身）。
		const candidate = USAGE_PROBE_CANDIDATES.find((c) => c.templateId === template);
		if (!candidate) {
			return { success: false, error: this.translate("mainConfig.providerUsageUnsupported") };
		}
		return this.runProviderUsageProbes(
			resolvedBaseUrl,
			resolvedApiKey,
			resolved.headers,
			[candidate],
			timeoutMs,
			0,
		);
	}

	/**
	 * 用量查询配置目录：pi = ~/.pi/agent；dsh = $DSH_HOME（与 DSH 自己的配置/凭据同目录，
	 * 文件名仍为 usage-probes.json，与 pi 侧同构）。
	 */
	private usageProbeSettingsDir(backend: UsageProbeBackend): string {
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
	 * 读单 provider 用量配置；backend="dsh" 且 DSH 侧未配置时回退 Pi 侧同名 provider 配置。
	 *
	 * 显示对齐（display parity）规则：Pi 里已配置并显示用量 → DSH 卡片同一 provider 默认也显示，
	 * 无需在 DSH 侧重复配置；DSH 一旦显式保存过（含 enabled=false 关闭）即接管、不再回退。
	 * 回退取「配置 + 旧版 probes 数组」（effectiveDir 指向 Pi 目录），端点与凭据仍走 DSH 链路
	 * （DSH profile / 凭据库），不会拿 Pi 的 key 去查 DSH 端点。provider 名按两侧一致匹配
	 * （deepseek 已由 normalizeDshDeepseekProvider 统一为规范名）。
	 */
	private async loadUsageSettingsWithFallback(
		backend: UsageProbeBackend,
		provider: string,
		settingsDir: string,
	): Promise<{ settings: UsageProbeSettingsLoadResult; effectiveDir: string }> {
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
	private async resolveUsageEndpoint(provider: string, backend: UsageProbeBackend = "pi") {
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
					const [modelsRes, authRes] = await Promise.all([
						this.getModelsConfig(),
						this.getAuthConfig(),
					]);
					const fromDsh = this.dshUsage
						? await this.dshUsage.readCredential(profile.credentialRef)
						: undefined;
					const baseUrl = profile.baseUrl ?? catalogSnapshot?.baseUrl;
					const piKey = resolvePiApiKey(modelsRes.parsed?.providers?.[provider], authRes.parsed?.[provider]);
					return {
						provider,
						// profile 缺 baseURL/api（如 opencode route 未写）时由 pi-ai catalog 兜底。
						...(baseUrl ? { baseUrl } : {}),
						...(fromDsh ?? piKey ? { apiKey: fromDsh ?? piKey } : {}),
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

	/** 带统一错误包装的探测执行：无 key 快速失败，其余走 runUsageProbes；成功时带上生效间隔。 */
	private async runProviderUsageProbes(
		baseUrl: string,
		apiKey: string,
		requestHeaders: Record<string, string> | undefined,
		candidates: UsageProbeCandidate[],
		timeoutMs: number,
		intervalMinutes: number,
	): Promise<ProviderUsageResult> {
		// 无 key 时只可能 401，快速失败并给出提示。
		if (!apiKey) {
			return { success: false, error: this.translate("mainConfig.providerUsageNoKey") };
		}
		const result =
			(await this.runUsageProbes(
				baseUrl,
				apiKey,
				this.normalizeRequestHeaders(requestHeaders),
				candidates,
				timeoutMs,
			)) ?? {
				success: false,
				error: this.translate("mainConfig.providerUsageFailed"),
			};
		return result.success ? { ...result, intervalMinutes } : result;
	}

	/**
	 * 逐候选、逐 URL 尝试探测；命中的首个成功结果即返回，全部未命中返回 undefined
	 * （文案由调用方决定：整体查询 vs 单条测试）。链式 preflight、64KB 响应截断、
	 * redirect:"error" fail-closed 与单候选异常捕获都在此层，探测行为对两条入口完全一致。
	 * timeoutMs 由 per-provider 配置（默认 10s）传入：用量查询首包超时按用户设定收紧，
	 * 不再固定 45s（那只对模型连接探测合理）。
	 */
	private async runUsageProbes(
		baseUrl: string,
		apiKey: string,
		extraHeaders: Record<string, string>,
		candidates: UsageProbeCandidate[],
		timeoutMs: number,
	): Promise<ProviderUsageResult | undefined> {
		const startedAt = Date.now();
		// 收集每次失败尝试，全部未命中时拼进 detail（URL + 状态码 + 摘要 + 归纳提示），
		// 让用户在弹窗里能直接排查（地址对不对 / 鉴权失效 / 接口变更）。
		const attempts: UsageProbeAttempt[] = [];
		// 逐候选、逐 URL 尝试；命中的首个成功即返回。
		for (const candidate of candidates) {
			// 链式预检（如 xAI 需先查 identity 拿 userId）：先请求预检端点，把响应里
			// 的字段注入主请求头（x-userid）。预检失败（不可达/非 JSON/无字段）则整个候选跳过。
			const preflightHeaders: Record<string, string> = {};
			if (candidate.preflight) {
				const preflightUrls = usageProbeUrls(
					{ path: candidate.preflight.path, absoluteUrl: candidate.preflight.absoluteUrl, rootPath: false },
					baseUrl,
					(url) => this.ensureVersionPath(url),
				);
				let captured: unknown;
				for (const preflightUrl of preflightUrls) {
					const preflightResult = await usageProbeRequest(preflightUrl, {
						method: "GET",
						headers: this.withOpenAiSdkUserAgent(
							buildProbeHeaders(candidate.preflight.headers, apiKey),
						),
						timeoutMs,
						maxBytes: MAX_USAGE_RESPONSE_BYTES,
					});
					if ("error" in preflightResult) continue;
					if (preflightResult.status < 200 || preflightResult.status >= 300) continue;
					let preflightBody: unknown = null;
					try {
						preflightBody = JSON.parse(preflightResult.raw);
					} catch {
						// 非 JSON：不是预期的预检端点，换下一个 URL。
					}
					captured = getByPath(preflightBody, candidate.preflight.capture.path);
					if (typeof captured === "string" && captured.trim() !== "") break;
				}
				if (typeof captured !== "string" || captured.trim() === "") continue;
				preflightHeaders[candidate.preflight.capture.header] = captured.trim();
			}

			const urls = usageProbeUrls(candidate, baseUrl, (url) =>
				this.ensureVersionPath(url),
			);
			for (const requestUrl of urls) {
				const result = await usageProbeRequest(requestUrl, {
					method: candidate.method ?? "GET",
					headers: this.withOpenAiSdkUserAgent({
						...buildProbeHeaders(candidate.headers, apiKey, {
							// 候选自带 Cookie 等独立鉴权时不能自动补 Bearer（双凭证可能被服务端拒绝，
							// 如 Token Rhythm 的 AMBIGUOUS_CREDENTIALS 400），由候选/用户探针显式声明。
							noBearer: candidate.noBearer === true,
						}),
						...preflightHeaders,
						...extraHeaders,
					}),
					...(candidate.method === "POST" && candidate.body !== undefined
						? { body: JSON.stringify(candidate.body) }
						: {}),
					timeoutMs,
					maxBytes: MAX_USAGE_RESPONSE_BYTES,
				});
				if ("error" in result) {
					// 网络错误/超时/重定向拒绝：单个候选失败不阻断其它候选，记录后继续。
					// usageProbeRequest 已按 AbortError/TimeoutError 归一为 timeout，其余为 network。
					attempts.push({
						url: requestUrl,
						method: candidate.method ?? "GET",
						error: result.error,
					});
					continue;
				}
				const safeRaw = this.redactSecret(result.raw, apiKey);
				if (result.status < 200 || result.status >= 300) {
					// 非 2xx：可能是端点不存在，换下一个 URL/候选继续；记一笔尝试明细供失败时归因。
					attempts.push({
						url: requestUrl,
						method: candidate.method ?? "GET",
						status: result.status,
						// 只留前 240 字符的脱敏响应摘要，足够定位「路径不对/非法请求」类问题。
						...(safeRaw ? { body: safeRaw.slice(0, 240) } : {}),
					});
					continue;
				}
				let body: unknown;
				try {
					body = JSON.parse(result.raw);
				} catch {
					body = null;
				}
				const parsed = parseUsageResponseBody(body, safeRaw, candidate.parse);
				if (parsed.matched) {
					return {
						success: true,
						kind: parsed.kind,
						periods: parsed.periods,
						balance: parsed.balance,
						credits: parsed.credits,
						booster: parsed.booster,
						at: startedAt,
					};
				}
				// 2xx 但结构不匹配：不是预期的 usage 端点，继续探测；记一笔供失败归因（接口变更信号）。
				attempts.push({ url: requestUrl, method: candidate.method ?? "GET", kind: "shape" });
			}
		}

		// 全部候选未命中：拼上尝试明细返回失败结果（比通用文案多给「试了哪些 URL、为什么失败」），
		// 无任何尝试（如 preflight 全部失败）时仍返回 undefined 交由调用方决定最终文案。
		if (attempts.length === 0) {
			return undefined;
		}
		return {
			success: false,
			error: this.translate("mainConfig.providerUsageFailed"),
			detail: buildProbeFailureDetail(attempts, (key) => this.translate(key)),
		};
	}
}
