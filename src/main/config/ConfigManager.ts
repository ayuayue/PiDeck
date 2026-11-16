import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { normalize, join, dirname } from "node:path";
import { dirname as posixDirname, normalize as posixNormalize } from "node:path/posix";
import { homedir } from "node:os";
import type { ConfigFileDiagnostic, ConfigFileReadResult } from "../../shared/types";
import type { McpConfigFile, McpConfigSnapshot, McpProbeResult, McpServerDefinition } from "../../shared/types/mcp";
import { loadMcpConfigSnapshot, mcpDocsUrl, probeMcpServer, saveMcpConfigFile, validateMcpConfigFile } from "./mcpConfig";
import { ensureOpenAiVersionPath, needsSessionBaseUrlVersionHint, suggestNormalizedBaseUrl } from "./baseUrlPath";
import { mainProcessT, type MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { FetchedModel } from "../../shared/types/fetchedModel";
import type { ProviderUsageResult, UsageProbeBackend, UsageProbeRecognition, UsageProbeSettingsResult, UsageProbeStatesResult, UsageProbeTestInput } from "../../shared/types/providerUsage";
import { parseProviderModelsResponse } from "./parseProviderModels";
import { isSafeProviderName } from "./providerMigration";
import { stripBom, writePiConfigFile } from "./piConfigFileStore";
import { mergeSettingsFormPayload } from "./settingsFormPayload";
import { ensureTokendanceAttribution } from "./tokendanceAttribution";
import { getAppLogger } from "../logging/sharedLogger";
import { modelHttpRequest } from "../modelHttp/request";
import { getPiAiCatalogIndex, lookupPiAiCatalogProviderApi } from "../pi/piAiBuiltinCatalog";
import type { ConfigProxyTarget } from "../sessions/sessionProxyPolicy";
import type { WslEnvironment } from "../wsl/WslPaths";
import { ProviderUsageQueries } from "./providerUsageQueries";

import type { ConfigCopy, ConfigValidationResult, DshUsageLookup, PiAuthFile, PiModelsFile, PiProviderConfig, PiModelItem, PiSettings, TestRequest } from "./configModelTypes";

// 结构类型与公共契约搬到 configModelTypes.ts；此处保留原路径转发，既有 import 方无需改动。
export type { ConfigValidationResult, DshUsageLookup, PiAuthFile, PiAuthItem, PiModelItem, PiModelsFile, PiProviderConfig, PiSettings } from "./configModelTypes";

/** pi 全局配置目录：~/.pi/agent/ */
const PI_AGENT_DIR = join(homedir(), ".pi", "agent");

// Provider 用量/连接探测面对的是第三方网关，首包可能慢于普通模型；放宽超时避免误判。
const PROVIDER_TEST_TIMEOUT_MS = 45_000;

// 模型列表请求超时：网络不通时避免长时间卡住。
const MODEL_LIST_TIMEOUT_MS = 10_000;
// 模型列表响应体上界：正常 listing 远小于此值，超限按异常响应处理而不是整段进内存。
const MODEL_LIST_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// 用量查询默认超时（10 秒；可被 per-provider 配置覆盖）。
const USAGE_PROBE_DEFAULT_TIMEOUT_MS = 10_000;

// 模型 id 长度上限：过长 id 往往是误填，且可能撑爆某些网关/日志。
const MODEL_ID_MAX_LENGTH = 256;

/**
 * 没有通用「列举模型/部署」端点的协议：它们的模型清单只能从各自控制台或文档手填。
 *
 * 为什么必须显式拦：这些协议在 pi 里是合法的聊天协议（所以能出现在 API 类型下拉），
 * 但它们的 baseUrl 不是 OpenAI 兼容根（如 Bedrock 是 bedrock-runtime.<region>.amazonaws.com）。
 * 若继续用 openai-completions 的形状发 /v1/models，用户看到的是 404 / TLS 类的误导性
 * 报错，而正确动作是「手填模型 ID」。
 */
const NO_MODEL_LIST_APIS = new Set(["azure-openai-responses", "google-vertex", "bedrock-converse-stream", "pi-messages"]);

/** 判断字符串是否含控制字符（换行/tab 等），防止配置被注入换行破坏 JSON 语义。 */
function hasControlChar(value: string): boolean {
	// eslint-disable-next-line no-control-regex
	return /[\x00-\x1f\x7f]/.test(value);
}

/**
 * 网络层失败文本 → 可操作提示。
 *
 * 为什么要按错误码分类，而不是统一报「获取模型失败」：
 *  - `ERR_SSL_*` / `ERR_CERT_*` 说明链路被中间设备（防火墙 / 代理 / 运营商）改动过，
 *    直连必然失败但**开代理能通**——实测 anyrouter.top 在国内直连就报
 *    ERR_SSL_VERSION_OR_CIPHER_MISMATCH，经代理正常。
 *  - `ERR_CONNECTION_*` / `ENOTFOUND` 是压根连不上，提示检查网络与代理开关。
 * 这两类都不是「配置写错」，笼统文案会把用户引到改 baseUrl / API Key 的错方向。
 * 没有命中已知模式时返回 undefined，由调用方用默认文案兜底。
 */
function describeNetworkFailure(detail: string, translate: (key: MainProcessTranslationKey) => string): string | undefined {
	if (/ERR_SSL|ERR_CERT|SSL_ERROR/i.test(detail)) {
		return translate("mainConfig.fetchTlsBlocked");
	}
	if (/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ETIMEDOUT|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i.test(detail)) {
		return translate("mainConfig.fetchUnreachable");
	}
	return undefined;
}

/**
 * 保存路径的 cost 归一化（#458）：pi ModelCostSchema 要求 input/output/cacheRead/cacheWrite
 * 四键全备（Number 非 Optional），部分对象（如只有 input）会让 pi 整文件 schema 校验失败。
 * 语义：缺的费率补 0（与计费弹框「打开即补 0」一致）；四键全无的空对象 → undefined（删键，
 * 缺省合法）；tiers 是数组则逐档同样补齐（每档还需 inputTokensAbove，缺失则丢档）。
 * 非对象输入由调用方规避（cost !== undefined 才进入）。纯函数便于 vm 测试替身直接调用。
 */
function normalizeModelCostForPi(cost: NonNullable<PiModelItem["cost"]> & { tiers?: unknown }): NonNullable<PiModelItem["cost"]> | undefined {
	const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
	if (!RATE_KEYS.some((key) => typeof cost[key] === "number")) return undefined;
	const rates = Object.fromEntries(RATE_KEYS.map((key) => [key, typeof cost[key] === "number" ? (cost[key] as number) : 0])) as Record<(typeof RATE_KEYS)[number], number>;
	const normalized: NonNullable<PiModelItem["cost"]> & { tiers?: unknown } = { ...rates };
	if (Array.isArray(cost.tiers)) {
		const tiers = cost.tiers
			.filter((tier): tier is Record<string, unknown> => typeof tier === "object" && tier !== null)
			.map((tier) => {
				// pi ModelCostTierSchema 每档需 inputTokensAbove + 四费率全备；缺费率补 0
				// （与计费弹框 applyTiers 的「打开即补 0」同一语义，保留用户分档意图）；
				// inputTokensAbove 缺失/非数则无法定义档位，只能丢档。
				if (typeof tier.inputTokensAbove !== "number") return null;
				const tierRates = Object.fromEntries(RATE_KEYS.map((key) => [key, typeof tier[key] === "number" ? tier[key] : 0])) as Record<(typeof RATE_KEYS)[number], number>;
				return { inputTokensAbove: tier.inputTokensAbove, ...tierRates };
			})
			.filter((tier): tier is { inputTokensAbove: number } & Record<(typeof RATE_KEYS)[number], number> => tier !== null);
		if (tiers.length > 0) normalized.tiers = tiers;
	}
	return normalized;
}

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
		this.configDir = environment ? join(environment.windowsHome, ".pi", "agent") : PI_AGENT_DIR;
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
	 * 合并 pi 原生 MCP 两层配置（全局 agentDir + 可选项目 .pi/mcp.json）。
	 * 默认可写层是全局 mcp.json；项目页传 writableScope:"project-pi" 让项目层成为可写目标。
	 */
	async getMcpConfig(projectPath?: string, options: { writableScope?: "pi-agent" | "project-pi"; projectTrusted?: boolean } = {}): Promise<McpConfigSnapshot> {
		return loadMcpConfigSnapshot(this.configDir, projectPath, undefined, options);
	}

	async saveMcpConfig(file: McpConfigFile, options: { expectedRevision?: string } = {}): Promise<ConfigValidationResult> {
		const error = validateMcpConfigFile(file);
		if (error) return { valid: false, error };
		// 锁内重读 + revision 乐观锁：外部（pi/手改/其它实例）改过则拒绝覆盖，只替换 mcpServers 键。
		const result = await saveMcpConfigFile(join(this.configDir, "mcp.json"), file, { expectedRevision: options.expectedRevision });
		return result.ok ? { valid: true, revision: result.revision } : { valid: false, error: result.error, conflict: result.conflict };
	}
	async probeMcpServer(definition: McpServerDefinition): Promise<McpProbeResult> {
		return probeMcpServer(definition);
	}

	async ensureTrustedDirectory(directoryPath: string): Promise<void> {
		const normalizedPath = this.normalizeTrustPath(directoryPath);
		const trustConfig = await this.getTrustConfig();
		if (trustConfig.diagnostic) return;

		const existingEntry = Object.entries(trustConfig.parsed).find(([path]) => this.normalizeTrustPathKey(path) === this.normalizeTrustPathKey(normalizedPath));
		if (existingEntry) return;

		// 若用户已用不同大小写/分隔符写过同一路径，或显式设为 false，则不覆盖，尊重用户的 trust.json 决策。
		await this.writeJsonFile("trust.json", {
			...trustConfig.parsed,
			[normalizedPath]: true,
		});
		// 自动信任目录改变 pi 的工具执行边界，属安全相关决策，单独留痕以便审计
		getAppLogger()?.info("config", "Directory auto-trusted (trust.json)", { path: normalizedPath });
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
		return process.platform === "win32" && !normalized.startsWith("/") ? normalized.toLowerCase() : normalized;
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

	/**
	 * 可视化设置表单保存。
	 *
	 * 不再整份覆盖：资源类键（packages/extensions/skills/prompts/themes）的真值由
	 * PiResourceConfigService 与 pi 原生规则并发维护，页面快照整份写回会静默回退它们
	 * （实测：安装/启用扩展后被设置页保存盖回停用形态）。这里走 writePiConfigFile
	 * （文件锁内重读 → 只按表单归属合并 → 原子替换），资源键一律以磁盘为准。
	 * 归属规则与原因见 settingsFormPayload.ts。
	 */
	async saveSettingsConfig(settings: PiSettings): Promise<ConfigValidationResult> {
		const filePath = join(this.configDir, "settings.json");
		const result = await writePiConfigFile(filePath, (current) => mergeSettingsFormPayload(current, settings));
		if (!result.ok) return { valid: false, error: result.error };
		getAppLogger()?.info("config", "Config file written", { file: filePath, bytes: JSON.stringify(result.data, null, 2).length });
		return { valid: true };
	}

	// ── 保存（源文件编辑） ────────────────────────────────

	async saveRawConfig(fileName: string, rawJson: string): Promise<ConfigValidationResult> {
		try {
			JSON.parse(rawJson);
		} catch (e) {
			const debugDetails = e instanceof Error ? e.message : String(e);
			void getAppLogger()?.error("config", "Invalid JSON input", { error: e instanceof Error ? e.message : String(e) });
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
			// baseUrl 若填写则禁止控制字符（换行等），防止配置被注入换行破坏 JSON 语义。
			// tab 属于控制字符但不是注入向量，且是「空串清洗」的前置形态（normalizeModelsForPi
			// 会把 trim 后为空的 baseUrl 删键）；这里放行 tab/空串，只拦真正的换行注入，
			// 避免空 baseUrl 在清洗前就被拒（#458：清洗的职责是「回缺省合法态」而非报错）。
			if (typeof config.baseUrl === "string" && /[^\t]/.test(config.baseUrl) && hasControlChar(config.baseUrl)) {
				return {
					valid: false,
					error: this.translate("mainConfig.baseUrlInvalid", { provider: providerName }),
				};
			}
			const providerApi = typeof config.api === "string" ? config.api.trim() : "";
			// 内置 provider 允许省略 api：pi 会从内置 base 模型继承默认协议。
			// 自定义 provider 没有这层兜底，provider/models 都没写 api 时 pi 会丢掉整个 provider，
			// 模型列表里直接看不到它（pi 的 provider-composer modelFromJson 在 api 为空时抛错）。
			const defaultApi = providerApi || lookupPiAiCatalogProviderApi(getPiAiCatalogIndex(), providerName);
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
				const modelApi = typeof m.api === "string" ? m.api.trim() : "";
				if (!modelApi && !defaultApi) {
					return {
						valid: false,
						error: this.translate("mainConfig.modelApiRequired", { provider: providerName, model: m.id }),
					};
				}
			}
		}
		return { valid: true };
	}

	// ── 文件 IO ───────────────────────────────────────────

	private async readJsonFile<T>(fileName: string, fallback: T): Promise<ConfigFileReadResult<T>> {
		const filePath = join(this.configDir, fileName);
		try {
			const raw = await readFile(filePath, "utf8");
			try {
				// UTF-8 BOM 必须先剥：Windows PowerShell 5.1 保存会写 BOM，裸 JSON.parse 直接失败。
				// 失败后 parsed 是空对象兜底，页面会显示「配置是空的」，用户一旦点保存就把真配置写没。
				const parsed = JSON.parse(stripBom(raw)) as T;
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

	private createJsonDiagnostic(fileName: string, raw: string, error: unknown): ConfigFileDiagnostic {
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

	private async writeJsonFile(fileName: string, content: unknown): Promise<void> {
		await mkdir(this.configDir, { recursive: true });
		const filePath = join(this.configDir, fileName);
		const json = typeof content === "string" ? content : JSON.stringify(content, null, 2);
		await writeFile(filePath, json, "utf8");
		// 配置写盘统一留痕（只记路径与字节数，绝不落内容——auth.json 含凭据）
		getAppLogger()?.info("config", "Config file written", { file: filePath, bytes: json.length });
	}

	/** Write a validated configuration with a sibling temporary file and atomic replacement. */
	private async writeJsonFileAtomic(fileName: string, content: unknown): Promise<void> {
		await mkdir(this.configDir, { recursive: true });
		const filePath = join(this.configDir, fileName);
		const temporaryPath = join(this.configDir, `.${fileName}.${randomUUID()}.tmp`);
		const json = typeof content === "string" ? content : JSON.stringify(content, null, 2);
		try {
			await writeFile(temporaryPath, json, { encoding: "utf8", flag: "wx" });
			await rename(temporaryPath, filePath);
			getAppLogger()?.info("config", "Config file written (atomic)", { file: filePath, bytes: json.length });
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
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
		// 没有通用模型列表接口的协议：Azure 部署列表只能从门户复制，Bedrock / Vertex /
		// Pi Messages 都没有公开的「列举全部部署/模型」端点。这里直接给出可操作提示，
		// 不用 openai-completions 的形状去试探：那会把请求打到错误路径并掩盖真实原因。
		const requestedApi = typeof apiType === "string" ? apiType.trim() : "";
		if (NO_MODEL_LIST_APIS.has(requestedApi)) {
			return {
				success: false,
				error: this.translate("mainConfig.fetchModelsUnsupportedApi", { api: requestedApi }),
				debugDetails: `api "${requestedApi}" has no generic model listing endpoint`,
			};
		}
		const requests = this.buildModelsRequest(baseUrl, apiKey, apiType, headers);
		let lastError: string | undefined;
		let lastDebugDetails: string | undefined;
		let lastRequestUrl: string | undefined;

		for (const request of requests) {
			lastRequestUrl = this.redactSecret(request.url, apiKey);
			// 桌面端配置检测属于 Electron 主进程自身请求：走 net（Chromium 网络栈）才会跟随
			// defaultSession 的代理配置。显式选择了代理时由 proxyTarget 走独立 session，
			// 避免动全局代理开关（见 src/main/modelHttp/request.ts）。
			const result = await modelHttpRequest(request.url, {
				method: request.method ?? "GET",
				headers: request.headers,
				timeoutMs: MODEL_LIST_TIMEOUT_MS,
				maxBytes: MODEL_LIST_MAX_RESPONSE_BYTES,
				...(proxyTarget ? { proxyTarget } : {}),
			});
			if ("error" in result) {
				if (result.error === "timeout") {
					lastError = this.translate("mainConfig.fetchTimeout");
					continue;
				}
				// 网络层异常需分类提示：这些站点常见失败形态是 TLS 被中间设备干扰
				// （ERR_SSL_VERSION_OR_CIPHER_MISMATCH）或连不上（ERR_CONNECTION_TIMED_OUT /
				// ENOTFOUND），分类后给出「开代理 / 换域名」的可操作文案。
				// 注意：原始异常文本只进日志，**不得**回传渲染层——异常 message 可能裹挟
				// 请求 URL（Gemini 的 key 在 query 上）或网关回显的正文，返回值会跨 IPC
				// 序列化到渲染进程；可操作指引已由下面的专用文案承载，无需原始文本。
				const detail = result.detail ?? "";
				void getAppLogger()?.error("config", "Provider model list request failed", { error: detail });
				lastError = describeNetworkFailure(detail, (key) => this.translate(key)) ?? this.translate("mainConfig.fetchModelsFailed");
				continue;
			}
			if (result.status < 200 || result.status >= 300) {
				lastDebugDetails = `HTTP ${result.status}: ${result.statusText}`;
				void getAppLogger()?.warn("config", "Provider model list request failed", { status: result.status, requestUrl: lastRequestUrl });
				lastError = this.translate("mainConfig.fetchModelsFailed");
				continue;
			}

			// WAF / 反爬拦截：网关（如 Cloudflare / 阿里云 WAF）会返回 HTTP 200，
			// 但正文是 JS 挑战页 HTML 而非 JSON。若不识别，`JSON.parse` 报出的是
			// `Unexpected token '<'` 这类无关堆栈，用户只会看到笼统的「获取失败」。
			// 这里先看 content-type，再拿正文做判定，给出可操作的提示：
			// 切换代理 / 配置能过白名单的 User-Agent（如 claude-cli/...）。
			const contentType = result.header("content-type") ?? "";
			if (/text\/html/i.test(contentType)) {
				lastDebugDetails = `HTTP ${result.status} text/html (WAF/anti-bot page)`;
				void getAppLogger()?.warn("config", "Provider returned an HTML page instead of JSON", { requestUrl: lastRequestUrl, contentType });
				lastError = this.translate("mainConfig.fetchBlockedByHtml");
				continue;
			}

			// 正文超过上界：截断的 JSON 无法解析，按异常响应处理（不去猜是不是被拦截）。
			if (result.truncated) {
				lastDebugDetails = `HTTP ${result.status} body exceeds ${MODEL_LIST_MAX_RESPONSE_BYTES} bytes`;
				void getAppLogger()?.warn("config", "Provider model list response exceeds cap", { requestUrl: lastRequestUrl });
				lastError = this.translate("mainConfig.fetchModelsFailed");
				continue;
			}

			let body: Record<string, unknown>;
			try {
				body = JSON.parse(result.raw) as Record<string, unknown>;
			} catch {
				// content-type 撒谎（声称 JSON 实则 HTML）或返回截断/非 JSON 正文：
				// 同样归入「被拦截」而非笼统失败，引导用户排查网络出口与 UA。
				lastDebugDetails = `HTTP ${result.status} non-JSON body`;
				lastError = this.translate("mainConfig.fetchBlockedByHtml");
				continue;
			}
			// listing 有容量就用；缺的再按 pi-ai 内置目录精确匹配，仍缺则空着
			const models = this.parseModelsResponse(body, apiType);

			if (models.length === 0) {
				lastError = this.translate("mainConfig.emptyModelList");
				continue;
			}

			// 成功路径若依赖检测侧自动补 /v1，而用户配置仍是根路径，
			// 会话侧会原样用 baseUrl → 返回建议 baseUrl 供 UI 自动改写。
			// apiType 必须传：Anthropic 系探测走 /v1/models 但会话侧 SDK 自拼 /v1/messages，
			// 这种协议补版本段反而会让会话 404（issue #337）。
			const sessionBaseUrlNeedsVersion = needsSessionBaseUrlVersionHint(baseUrl, request.url, apiType);
			const suggestedBaseUrl = suggestNormalizedBaseUrl(baseUrl, request.url, apiType) ?? undefined;
			return {
				success: true,
				models,
				requestUrl: lastRequestUrl,
				sessionBaseUrlNeedsVersion,
				suggestedBaseUrl,
			};
		}

		return {
			success: false,
			error: lastError ?? this.translate("mainConfig.fetchModelsFailed"),
			...(lastDebugDetails ? { debugDetails: lastDebugDetails } : {}),
			requestUrl: lastRequestUrl,
			sessionBaseUrlNeedsVersion: needsSessionBaseUrlVersionHint(baseUrl, lastRequestUrl, apiType),
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
	 * | Azure / Vertex / Bedrock / Pi Messages | 无（调用方已提前拦截，见 NO_MODEL_LIST_APIS）| - |
	 *
	 * OpenAI 生态（Chat Completions / Responses / Codex / Mistral）统一通过
	 * GET /v1/models 获取模型列表。
	 * 虽然 Anthropic 官方未公开 models 端点，但大部分兼容 Anthropic 协议的
	 * 第三方网关同样支持 /v1/models。优先尝试 /v1/models，再回退到 /models。
	 * Google Gemini 使用独立的 /v1beta/models。
	 */
	private buildModelsRequest(baseUrl: string, apiKey: string, apiType?: string, requestHeaders?: Record<string, string>): TestRequest[] {
		const api = this.normalizeApiType(apiType);
		// 与真实会话一致：允许 provider 配置的自定义 headers（含 User-Agent）
		// 覆盖 SDK 默认 UA，保证「获取模型」与「真实会话」走同一套网络形象。
		const extraHeaders = this.normalizeRequestHeaders(requestHeaders);
		if (api === "google-generative-ai") {
			// Google Gemini：使用独立的 v1beta 路径
			const u = baseUrl.replace(/\/+$/, "");
			const needsPrefix = !/[\/]v\d+(alpha|beta)?$/.test(u);
			const versioned = needsPrefix ? `${u}/v1beta` : u;
			return [
				{
					url: `${versioned}/models?key=${encodeURIComponent(apiKey)}`,
					headers: { "Content-Type": "application/json", ...extraHeaders },
				},
			];
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

	private parseModelsResponse(body: Record<string, unknown>, apiType?: string): FetchedModel[] {
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
				Object.entries(data.providers).map(([name, provider]) => {
					const normalizedProvider: PiProviderConfig = { ...provider };
					// 空/纯空白 api 会让 pi 整文件校验失败（schema minLength 1），删键即回到
					// 「继承默认」的合法形态；不发明 openai-completions，见 normalizeApiForSave。
					const providerApi = this.normalizeApiForSave(provider.api);
					if (providerApi !== undefined) normalizedProvider.api = providerApi;
					else delete normalizedProvider.api;
					// pi schema 对 name/baseUrl/apiKey 同样要求 minLength:1（可选但非空）。
					// 展开卡片/编辑页对这三个字段的内联编辑是「清空输入框 = 写空串」
					// （不经 addProviderDraft 的 trim/删键路径），一旦落盘 pi 就整文件拒绝
					// （所有自定义供应商从列表消失，#458 的形态）。空串一律删键回到缺省合法态；
					// 纯空白字符串 trim 后为空，同罪处理。
					for (const field of ["name", "baseUrl", "apiKey"] as const) {
						const value = normalizedProvider[field];
						if (typeof value === "string" && value.trim().length === 0) {
							delete normalizedProvider[field];
						}
					}
					normalizedProvider.models = provider.models.map((model) => {
						const normalized: PiModelItem = { ...model };
						const modelApi = this.normalizeApiForSave(model.api);
						if (modelApi !== undefined) normalized.api = modelApi;
						else delete normalized.api;
						// pi schema 中 name 可选但需 minLength:1，空 name 会让 pi 整文件拒绝。
						// 与拉取供应商列表的 parseProviderModelsResponse 行为对齐：name 为空
						// 就删掉该键（可选字段缺省反而合法），避免手动新增模型留空时写坏文件。
						if (typeof normalized.name === "string" && normalized.name.length === 0) {
							delete normalized.name;
						}
						// contextWindow/maxTokens 是 exclusiveMinimum:0（pi 默认 128e3/16384）。
						// 数字输入框可输负数/0（UI 未设 min），输入瞬间 onChange 就把负值写进草稿，
						// 一旦保存 pi 整文件拒绝。非正数删键 = 交给 pi 默认，与「清空输入框 =
						// undefined = 缺省」同一语义，不会静默丢弃用户配置（正数值原样保留）。
						for (const field of ["contextWindow", "maxTokens"] as const) {
							const value = normalized[field];
							if (typeof value === "number" && (!Number.isFinite(value) || value <= 0)) {
								delete normalized[field];
							}
						}
						// pi ModelCostSchema 要求 input/output/cacheRead/cacheWrite 四键全备才算合法 cost；
						// 部分对象（如只有 input）会让 pi 整文件拒绝。补齐缺失费率为 0（与计费弹框
						// 「打开即补 0」的行为一致）；四键全无的空对象删键（缺省合法）。tiers 同规则逐档补齐。
						if (normalized.cost !== undefined) {
							normalized.cost = normalizeModelCostForPi(normalized.cost);
						}
						// input 枚举只认 "text"/"image"（pi ModelDefinitionSchema Enum）。目录/启发式
						// 补全只写合法值，但手改 JSON 或旧版本写入的非法值（如 "audio"）会让 pi 整文件
						// 拒绝；过滤非法项，全过滤后删键（缺省 = text-only，pi 默认行为）。
						if (Array.isArray(normalized.input)) {
							const legalInput = normalized.input.filter((item): item is "text" | "image" => item === "text" || item === "image");
							if (legalInput.length === 0) delete normalized.input;
							else if (legalInput.length !== normalized.input.length) normalized.input = legalInput;
						}
						return normalized;
					});
					return [name, normalizedProvider];
				}),
			),
		};
	}

	/**
	 * 保存路径的 api 归一化：只把已知历史别名改写成 pi 官方 registry 名称，
	 * **不**发明默认值。
	 *
	 * 为什么不能复用 normalizeApiType：那个函数服务「拉取模型列表 / 用量探针」的
	 * 网络路径，未知值兜底成 openai-completions 是为了「用最通用的协议试一试」；
	 * 一旦用在写盘路径，就等于把用户的 azure-openai-responses / google-vertex /
	 * bedrock-converse-stream / pi-messages 静默改写成 openai-completions，保存一次
	 * 即损坏配置（pi 1.0.4 registry 里这些 id 都真实存在）。
	 *
	 * 保留未知值的理由：pi 允许自定义 provider 扩展注册任意 api id（schema 只要求
	 * 非空字符串），PiDeck 无法穷举；宁可原样保留，也不篡改用户配置。
	 * 返回 undefined 表示「没有可写值」（缺省或空白），调用方据此删键。
	 * 入参是 unknown：PiModelItem 的 api 只能经索引签名取到 unknown，在函数内一次收窄，
	 * 避免调用方各自写 typeof 判断而漏掉一处。
	 */
	private normalizeApiForSave(apiType: unknown): string | undefined {
		if (typeof apiType !== "string") return undefined;
		const trimmed = apiType.trim();
		if (!trimmed) return undefined;
		switch (trimmed) {
			case "anthropic":
				return "anthropic-messages";
			case "openai-chat-completions":
				// 兼容早期 pi-desktop 暴露过的别名；pi 官方 registry 名称是 openai-completions。
				return "openai-completions";
			default:
				return trimmed;
		}
	}

	/**
	 * 网络探测路径的 api 归一化：未知值兜底成 openai-completions（最通用的 /models 形状）。
	 * 保存路径必须用 normalizeApiForSave，见其注释。
	 */
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
		return Object.fromEntries(Object.entries(headers).filter(([key, value]) => key.trim().length > 0 && typeof value === "string"));
	}

	private withOpenAiSdkUserAgent(headers: Record<string, string>) {
		const hasUserAgent = Object.keys(headers).some((key) => key.toLowerCase() === "user-agent");
		// pi 的 openai-responses provider 走 OpenAI JS SDK。部分代理会按 SDK
		// 默认 User-Agent 拦截请求，所以配置检测需要模拟该默认值，避免“检测通过、会话 403”。
		return hasUserAgent ? headers : { ...headers, "User-Agent": "OpenAI/JS 6.26.0" };
	}

	private withAnthropicSdkUserAgent(headers: Record<string, string>) {
		const hasUserAgent = Object.keys(headers).some((key) => key.toLowerCase() === "user-agent");
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
		const [models, auth, settings, mcp] = await Promise.all([this.readJsonFile<PiModelsFile>("models.json", { providers: {} }), this.readJsonFile<PiAuthFile>("auth.json", {}), this.readJsonFile<PiSettings>("settings.json", {}), this.readJsonFile<McpConfigFile>("mcp.json", { mcpServers: {} })]);
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
	async importConfig(packageJson: string): Promise<ConfigValidationResult> {
		let pkg: unknown;
		try {
			pkg = JSON.parse(packageJson);
		} catch (e) {
			const debugDetails = e instanceof Error ? e.message : String(e);
			void getAppLogger()?.error("config", "Invalid configuration import JSON", { error: e instanceof Error ? e.message : String(e) });
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

	// ── 用量查询 / 探测 ────────────────────────────────────
	// 域实现在 providerUsage* 协作者（端点解析 / 探测执行 / 对外编排）；此处只留同名薄包装。

	/** 用量查询协作者：注入窄端口；configDir 每次现取（WSL 切换后仍指向正确目录）。 */
	private providerUsage(): ProviderUsageQueries {
		return new ProviderUsageQueries({
			getConfigDir: () => this.configDir,
			translate: this.translate,
			dshUsage: this.dshUsage,
			getModelsConfig: () => this.getModelsConfig(),
			getAuthConfig: () => this.getAuthConfig(),
			normalizeApiType: (apiType) => this.normalizeApiType(apiType),
			ensureVersionPath: (baseUrl) => this.ensureVersionPath(baseUrl),
			normalizeRequestHeaders: (headers) => this.normalizeRequestHeaders(headers),
			withOpenAiSdkUserAgent: (headers) => this.withOpenAiSdkUserAgent(headers),
			redactSecret: (value, apiKey) => this.redactSecret(value, apiKey),
		});
	}

	/**
	 * 解析 provider 端点，供主进程内其它链路复用（TokenDance 充值取 baseUrl/apiKey）。
	 * 只在本进程内使用，API Key 不回传渲染层；未命中返回 matched=false。
	 */
	async resolveProviderEndpoint(provider: string, backend: UsageProbeBackend = "pi") {
		return this.providerUsage().resolveProviderEndpoint(provider, backend);
	}

	/** 查询 provider 用量/余额（实现在 providerUsageQueries.ts）。 */
	async fetchProviderUsage(provider: string, backend: UsageProbeBackend = "pi"): Promise<ProviderUsageResult> {
		return this.providerUsage().fetchProviderUsage(provider, backend);
	}

	/** 打开探针配置弹窗时的数据（实现在 providerUsageQueries.ts）。 */
	async getUsageProbeSettings(provider: string, backend: UsageProbeBackend = "pi"): Promise<UsageProbeSettingsResult> {
		return this.providerUsage().getUsageProbeSettings(provider, backend);
	}

	/** 内置模板自动识别（实现在 providerUsageQueries.ts）。 */
	async recognizeUsageTemplate(provider: string, backend: UsageProbeBackend = "pi"): Promise<UsageProbeRecognition | null> {
		return this.providerUsage().recognizeUsageTemplate(provider, backend);
	}

	/** 批量读取用量查询状态表（实现在 providerUsageQueries.ts）。 */
	async listUsageProbeStates(backend: UsageProbeBackend = "pi", providers: string[] = []): Promise<UsageProbeStatesResult> {
		return this.providerUsage().listUsageProbeStates(backend, providers);
	}

	/** 单条模板测试（实现在 providerUsageQueries.ts）。 */
	async testUsageProbe(input: UsageProbeTestInput): Promise<ProviderUsageResult> {
		return this.providerUsage().testUsageProbe(input);
	}

	/** 供 IPC 保存路径使用：backend 对应的用量查询配置目录（实现在 providerUsageEndpoint.ts）。 */
	getUsageProbeConfigDir(backend: UsageProbeBackend = "pi"): string {
		return this.providerUsage().getUsageProbeConfigDir(backend);
	}
}
