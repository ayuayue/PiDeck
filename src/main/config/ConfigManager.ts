import { readFile, writeFile, mkdir } from "node:fs/promises";
import { normalize, join, dirname } from "node:path";
import { dirname as posixDirname, normalize as posixNormalize } from "node:path/posix";
import { homedir } from "node:os";
import { net } from "electron";
import type { ConfigFileDiagnostic, ConfigFileReadResult } from "../../shared/types";
import type { WslEnvironment } from "../wsl/WslPaths";

/** pi 全局配置目录：~/.pi/agent/ */
const PI_AGENT_DIR = join(homedir(), ".pi", "agent");

// ── models.json 结构 ──────────────────────────────────
// { providers: { [providerName]: { baseUrl, api, apiKey, models: [...] } } }

// Provider 连接测试面对的是第三方网关和 reasoning 模型，首包可能慢于普通模型；
// 放宽超时并在错误文案中说明“超时不等于兼容模式不支持”，避免误导用户改错配置。
const PROVIDER_TEST_TIMEOUT_MS = 45_000;
const PROVIDER_TEST_TIMEOUT_SECONDS = PROVIDER_TEST_TIMEOUT_MS / 1000;

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
};

type TestRequest = {
	url: string;
	headers: Record<string, string>;
	body?: string;
	method?: "GET" | "POST";
};

/**
 * 管理 pi 全局配置文件（~/.pi/agent/ 下的 models.json、auth.json、settings.json）。
 * 按照 pi 实际文件格式解析：models.json 是嵌套 providers 结构，auth.json 是对象映射。
 */
export class ConfigManager {
	private configDir: string;

	constructor(configDir?: string) {
		this.configDir = configDir ?? PI_AGENT_DIR;
	}

	/** 将配置目录切换到统一解析出的 WSL HOME；null 恢复 Windows home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.configDir = environment
			? join(environment.windowsHome, ".pi", "agent")
			: PI_AGENT_DIR;
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
		await this.writeJsonFile("models.json", this.normalizeModelsForPi(data));
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
			return {
				valid: false,
				error: `JSON 格式错误：${e instanceof Error ? e.message : String(e)}`,
			};
		}

		const allowed = ["models.json", "auth.json", "settings.json", "trust.json"];
		if (!allowed.includes(fileName)) {
			return { valid: false, error: `不允许编辑的文件：${fileName}` };
		}

		await this.writeJsonFile(fileName, rawJson);
		return { valid: true };
	}

	// ── 校验 ──────────────────────────────────────────────

	private validateModels(data: PiModelsFile): ConfigValidationResult {
		if (!data.providers || typeof data.providers !== "object") {
			return { valid: false, error: "models.json 缺少 providers 字段" };
		}
		for (const [providerName, config] of Object.entries(data.providers)) {
			if (!config.models || !Array.isArray(config.models)) {
				return {
					valid: false,
					error: `provider "${providerName}" 缺少 models 数组`,
				};
			}
			for (let i = 0; i < config.models.length; i++) {
				const m = config.models[i];
				if (!m.id || typeof m.id !== "string") {
					return {
						valid: false,
						error: `provider "${providerName}" 的模型 #${i + 1} 缺少有效的 id`,
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
	 */
	async fetchProviderModels(
		baseUrl: string,
		apiKey: string,
		apiType?: string,
	): Promise<{ success: boolean; models?: Array<{ id: string; name?: string }>; error?: string }> {
		const requests = this.buildModelsRequest(baseUrl, apiKey, apiType);
		let lastError: string | undefined;

		for (const request of requests) {
			try {
				const controller = new AbortController();
				// 10 秒超时，避免网络不通时长时间卡住
				const timeout = setTimeout(() => controller.abort(), 10_000);

				try {
					// 桌面端配置检测属于 Electron 主进程自身请求；使用 net.fetch 才能走 defaultSession 的代理配置。
					const res = await net.fetch(request.url, {
						method: request.method ?? "GET",
						headers: request.headers,
						signal: controller.signal,
					});

					if (!res.ok) {
						lastError = `HTTP ${res.status}: ${res.statusText}`;
						continue;
					}

					const body = (await res.json()) as Record<string, unknown>;
					const models = this.parseModelsResponse(body, apiType);

					if (models.length === 0) {
						lastError = "接口返回了空的模型列表";
						continue;
					}

					return { success: true, models };
				} finally {
					clearTimeout(timeout);
				}
			} catch (e) {
				const msg =
					e instanceof Error
						? e.name === "AbortError"
							? "请求超时，请检查网络或 baseUrl"
							: e.message
						: String(e);
				lastError = this.redactSecret(msg, apiKey);
			}
		}

		return { success: false, error: lastError ?? "获取模型列表失败" };
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
	): TestRequest[] {
		const api = this.normalizeApiType(apiType);

		if (api === "google-generative-ai") {
			// Google Gemini：使用独立的 v1beta 路径
			const u = baseUrl.replace(/\/+$/, "");
			const needsPrefix = !/[\/]v\d+(alpha|beta)?$/.test(u);
			const versioned = needsPrefix ? `${u}/v1beta` : u;
			return [{
				url: `${versioned}/models?key=${encodeURIComponent(apiKey)}`,
				headers: { "Content-Type": "application/json" },
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
	): Array<{ id: string; name?: string }> {
		const api = this.normalizeApiType(apiType);
		const rawData = Array.isArray(body.data) ? body.data : Array.isArray(body)
			? body
			: body.models && Array.isArray(body.models)
				? body.models
				: [];

		return (rawData as Array<Record<string, unknown>>)
			.map((model) => {
				const rawId =
					typeof model.id === "string"
						? model.id
						: typeof model.name === "string"
							? model.name
							: "";
				const id =
					api === "google-generative-ai"
						? rawId.replace(/^models\//, "")
						: rawId;
				const name =
					typeof model.displayName === "string"
						? model.displayName
						: typeof model.name === "string"
							? model.name.replace(/^models\//, "")
							: id;
				return { id, name };
			})
			.filter((model) => model.id.length > 0);
	}

	private buildTestRequest(
		baseUrl: string,
		apiKey: string,
		modelId: string,
		apiType: string,
		requestHeaders?: Record<string, string>,
	): { url: string; headers: Record<string, string>; body: string } {
		const api = this.normalizeApiType(apiType);
		const extraHeaders = this.normalizeRequestHeaders(requestHeaders);

		switch (api) {
			case "openai-responses":
			case "openai-codex-responses":
				return {
					url: `${this.ensureVersionPath(baseUrl)}/responses`,
					headers: this.withOpenAiSdkUserAgent({
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						...extraHeaders,
					}),
					body: JSON.stringify({
						model: modelId,
						// 连接测试只验证接口是否可调用，不测试推理或工具能力；极短输入能减少
						// reasoning 模型的思考时间，避免把慢响应误判为兼容模式不可用。
						input: "Hi",
						max_output_tokens: 1,
					}),
				};

			case "anthropic-messages":
				// Anthropic Messages API 的聊天端点在 /v1/messages
				// 自动补齐 v1（Anthropic 文档示例：https://api.anthropic.com/v1/messages）
				return {
					url: `${this.ensureVersionPath(baseUrl)}/messages`,
					headers: this.withAnthropicSdkUserAgent({
						"x-api-key": apiKey,
						"anthropic-version": "2023-06-01",
						"Content-Type": "application/json",
						...extraHeaders,
					}),
					body: JSON.stringify({
						model: modelId,
						messages: [{ role: "user", content: "Hi" }],
						// 部分代理与 Claude 模型对 max_tokens 有最低要求，设为 10 避免 400/404。
						max_tokens: 10,
					}),
				};

			case "google-generative-ai":
				// Gemini 的 API key 作为查询参数
				// 自动补齐 v1beta（如果 baseUrl 不包含版本路径）
				// Google 文档示例：https://generativelanguage.googleapis.com/v1beta
				{
					const u = baseUrl.replace(/\/+$/, "");
					const needsPrefix = !/[\/]v\d+(alpha|beta)?$/.test(u);
					const versioned = needsPrefix ? `${u}/v1beta` : u;
					return {
						url: `${versioned}/${this.googleModelPath(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`,
						headers: {
							"Content-Type": "application/json",
							...extraHeaders,
						},
						body: JSON.stringify({
							contents: [
								{
									role: "user",
									parts: [{ text: "Hi" }],
								},
							],
							generationConfig: { maxOutputTokens: 1 },
						}),
					};
				}

			case "mistral-conversations":
				return {
					url: `${baseUrl.replace(/\/+$/, "")}/conversations`,
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						...extraHeaders,
					},
					body: JSON.stringify({
						model: modelId,
						inputs: "Hi",
						store: false,
					}),
				};

			default:
				// openai-completions 是 pi 官方名称，对应 OpenAI Chat Completions 接口。
				return {
					url: `${this.ensureVersionPath(baseUrl)}/chat/completions`,
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						...extraHeaders,
					},
					body: JSON.stringify({
						model: modelId,
						// Chat Completions 兼容网关常接入 reasoning 模型，测试时只要拿到
						// 一个最小响应即可，不要求完整回答，降低超时和 token 消耗。
						messages: [{ role: "user", content: "Hi" }],
						max_tokens: 1,
					}),
				};
		}
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
						models: provider.models.map((model) => ({
							...model,
							api: typeof model.api === "string"
								? this.normalizeApiType(model.api)
								: model.api,
						})),
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
	 * 很多代理/本地模型需要 {baseUrl}/v1/... 格式的请求路径。
	 * 用户配置 baseUrl 时习惯只填到域名字段（如 http://localhost:11434），
	 * 自动补齐 /v1 可以避免常见错误。
	 * 如果 baseUrl 已包含 /v1、/api 等路径段则跳过补齐。
	 */
	private ensureVersionPath(baseUrl: string): string {
		const u = baseUrl.replace(/\/+$/, "");
		const hasVersionPath = /\/v\d+$|\/api$/.test(u);
		return hasVersionPath ? u : `${u}/v1`;
	}

	private googleModelPath(modelId: string) {
		return modelId.startsWith("models/") ? modelId : `models/${modelId}`;
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

	/**
	 * 根据 API 类型从响应中提取模型名、文本片段和 token 用量。
	 */
	private parseTestResponse(
		body: Record<string, unknown>,
		modelId: string,
		apiType: string,
	): { model: string; snippet: string; tokens?: { input?: number; output?: number } } {
		const api = this.normalizeApiType(apiType);
		switch (api) {
			case "openai-completions": {
				const choices = body.choices as Array<Record<string, unknown>> | undefined;
				const text = (choices?.[0]?.text as string) ?? "(空响应)";
				const usage = body.usage as Record<string, unknown> | undefined;
				return {
					model: (body.model as string) ?? modelId,
					snippet: text,
					tokens: {
						input: usage?.prompt_tokens as number | undefined,
						output: usage?.completion_tokens as number | undefined,
					},
				};
			}

			case "openai-responses":
			case "openai-codex-responses": {
				const output = body.output as Array<Record<string, unknown>> | undefined;
				const content = output?.[0]?.content as Array<Record<string, unknown>> | undefined;
				const functionCall = output?.find(
					(item) => item.type === "function_call",
				);
				const text =
					(content?.[0]?.text as string | undefined) ??
					(functionCall
						? `工具调用兼容：${String(functionCall.name ?? "function_call")}`
						: "(空响应)");
				const usage = body.usage as Record<string, unknown> | undefined;
				return {
					model: (body.model as string) ?? modelId,
					snippet: text,
					tokens: {
						input: usage?.input_tokens as number | undefined,
						output: usage?.output_tokens as number | undefined,
					},
				};
			}

			case "anthropic-messages": {
				const content = body.content as Array<Record<string, unknown>> | undefined;
				const text = (content?.[0]?.text as string) ?? "(空响应)";
				const usage = body.usage as Record<string, unknown> | undefined;
				return {
					model: (body.model as string) ?? modelId,
					snippet: text,
					tokens: {
						input: usage?.input_tokens as number | undefined,
						output: usage?.output_tokens as number | undefined,
					},
				};
			}

			case "google-generative-ai": {
				const candidates = body.candidates as Array<Record<string, unknown>> | undefined;
				const parts = candidates?.[0]?.content as Record<string, unknown> | undefined;
				const text = (parts?.parts as Array<Record<string, unknown>>)?.[0]?.text as string ?? "(空响应)";
				const usage = body.usageMetadata as Record<string, unknown> | undefined;
				return {
					model: (body.modelVersion as string) ?? modelId,
					snippet: text,
					tokens: {
						input: usage?.promptTokenCount as number | undefined,
						output: usage?.candidatesTokenCount as number | undefined,
					},
				};
			}

			case "mistral-conversations": {
				const outputs = body.outputs as Array<Record<string, unknown>> | undefined;
				const firstOutput = outputs?.[0];
				const content = firstOutput?.content;
				const text = Array.isArray(content)
					? content
						.map((item) =>
							item && typeof item === "object"
								? String((item as Record<string, unknown>).text ?? "")
								: String(item ?? ""),
						)
						.filter(Boolean)
						.join(" ")
					: typeof content === "string"
						? content
						: (body.response as string | undefined) ?? "(空响应)";
				const usage = body.usage as Record<string, unknown> | undefined;
				return {
					model: (body.model as string) ?? modelId,
					snippet: text,
					tokens: {
						input: usage?.prompt_tokens as number | undefined,
						output: usage?.completion_tokens as number | undefined,
					},
				};
			}

			default:
				// openai-chat-completions
			{
				const choices = body.choices as Array<Record<string, unknown>> | undefined;
				const message = choices?.[0]?.message as Record<string, unknown> | undefined;
				const text = (message?.content as string) ?? "(空响应)";
				const usage = body.usage as Record<string, unknown> | undefined;
				return {
					model: (body.model as string) ?? modelId,
					snippet: text,
					tokens: {
						input: usage?.prompt_tokens as number | undefined,
						output: usage?.completion_tokens as number | undefined,
					},
				};
			}
		}
	}

	async testProviderConnection(
		baseUrl: string,
		apiKey: string,
		modelId: string,
		apiType?: string,
		requestHeaders?: Record<string, string>,
	): Promise<{
		success: boolean;
		model?: string;
		snippet?: string;
		tokens?: { input?: number; output?: number };
		latencyMs?: number;
		error?: string;
		requestUrl?: string;
		requestBody?: string;
	}> {
		const startedAt = Date.now();
		const api = this.normalizeApiType(apiType);
		const { url: requestUrl, headers, body: requestBody } =
			this.buildTestRequest(baseUrl, apiKey, modelId, api, requestHeaders);
		const safeRequestUrl = this.redactSecret(requestUrl, apiKey);
		const safeRequestBody = this.redactSecret(requestBody, apiKey);

		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), PROVIDER_TEST_TIMEOUT_MS);

			let res: Awaited<ReturnType<typeof net.fetch>>;
			try {
				res = await net.fetch(requestUrl, {
					method: "POST",
					headers,
					body: requestBody,
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeout);
			}

			const latencyMs = Date.now() - startedAt;

			if (!res.ok) {
				let detail = `${res.status} ${res.statusText}`;
				try {
					const errBody = (await res.json()) as Record<string, unknown>;
					const errMsg =
						(errBody.error as Record<string, unknown>)?.message ??
						errBody.message ??
						"";
					if (errMsg) detail += ` — ${String(errMsg)}`;
				} catch {
					/* 忽略解析错误 */
				}
				return {
					success: false,
					error: this.redactSecret(detail, apiKey),
					latencyMs,
					requestUrl: safeRequestUrl,
					requestBody: safeRequestBody,
				};
			}

			const body = (await res.json()) as Record<string, unknown>;
			const parsed = this.parseTestResponse(body, modelId, api);

			return {
				success: true,
				...parsed,
				latencyMs,
				requestUrl: safeRequestUrl,
				requestBody: safeRequestBody,
			};
		} catch (e) {
			const latencyMs = Date.now() - startedAt;
			const msg =
				e instanceof Error
					? e.name === "AbortError"
					? `请求超时（${PROVIDER_TEST_TIMEOUT_SECONDS} 秒）。这不一定代表兼容模式不支持或配置错误，可能是模型首包较慢、上游排队、代理/网络波动，或 reasoning 模型仍在内部思考。请稍后重试，或换用更轻量模型测试；如果模型列表可正常拉取，也可以保存配置后直接启动会话验证。`
					: e.message
					: String(e);
			return {
				success: false,
				error: this.redactSecret(msg, apiKey),
				latencyMs,
				requestUrl: safeRequestUrl,
				requestBody: safeRequestBody,
			};
		}
	}

	// ── 导出 / 导入 ───────────────────────────────────────

	/** 将三个配置文件打包为单个 JSON 对象，便于用户备份和迁移。 */
	async exportConfig(): Promise<string> {
		const [models, auth, settings] = await Promise.all([
			this.readJsonFile<PiModelsFile>("models.json", { providers: {} }),
			this.readJsonFile<PiAuthFile>("auth.json", {}),
			this.readJsonFile<PiSettings>("settings.json", {}),
		]);
		return JSON.stringify(
			{
				version: 1,
				exportedAt: new Date().toISOString(),
				files: {
					"models.json": models.parsed,
					"auth.json": auth.parsed,
					"settings.json": settings.parsed,
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
			return {
				valid: false,
				error: `JSON 格式错误：${e instanceof Error ? e.message : String(e)}`,
			};
		}
		const data = pkg as Record<string, unknown>;
		const files = data.files as Record<string, unknown> | undefined;
		if (!files || typeof files !== "object") {
			return { valid: false, error: "导入文件缺少 files 字段，请确认是 PiDeck 导出的配置包" };
		}

		// 按需写入，只处理三个已知文件名，忽略其他 key
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
		return { valid: true };
	}
}
