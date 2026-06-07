import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** pi 全局配置目录：~/.pi/agent/ */
const PI_AGENT_DIR = join(homedir(), ".pi", "agent");

// ── models.json 结构 ──────────────────────────────────
// { providers: { [providerName]: { baseUrl, api, apiKey, models: [...] } } }

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
	private readonly configDir: string;

	constructor(configDir?: string) {
		this.configDir = configDir ?? PI_AGENT_DIR;
	}

	// ── 读取 ──────────────────────────────────────────────

	async getModelsConfig(): Promise<{ raw: string; parsed: PiModelsFile }> {
		return this.readJsonFile<PiModelsFile>("models.json", { providers: {} });
	}

	async getAuthConfig(): Promise<{ raw: string; parsed: PiAuthFile }> {
		return this.readJsonFile<PiAuthFile>("auth.json", {});
	}

	async getSettingsConfig(): Promise<{ raw: string; parsed: PiSettings }> {
		return this.readJsonFile<PiSettings>("settings.json", {});
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

		const allowed = ["models.json", "auth.json", "settings.json"];
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
	): Promise<{ raw: string; parsed: T }> {
		const filePath = join(this.configDir, fileName);
		try {
			const raw = await readFile(filePath, "utf8");
			const parsed = JSON.parse(raw) as T;
			return { raw, parsed };
		} catch {
			return { raw: JSON.stringify(fallback, null, 2), parsed: fallback };
		}
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
	 * 向 OpenAI 兼容的 /models 端点拉取可用模型列表。
	 * 使用 Authorization: Bearer <apiKey> 认证。
	 * 返回 { id, name? } 数组，或失败时返回 error。
	 */
	async fetchProviderModels(
		baseUrl: string,
		apiKey: string,
		apiType?: string,
	): Promise<{ success: boolean; models?: Array<{ id: string; name?: string }>; error?: string }> {
		const request = this.buildModelsRequest(baseUrl, apiKey, apiType);
		try {
			const controller = new AbortController();
			// 10 秒超时，避免网络不通时长时间卡住
			const timeout = setTimeout(() => controller.abort(), 10_000);

			const res = await fetch(request.url, {
				method: request.method ?? "GET",
				headers: request.headers,
				signal: controller.signal,
			});
			clearTimeout(timeout);

			if (!res.ok) {
				return {
					success: false,
					error: `HTTP ${res.status}: ${res.statusText}`,
				};
			}

			const body = (await res.json()) as Record<string, unknown>;
			const models = this.parseModelsResponse(body, apiType);

			if (models.length === 0) {
				return {
					success: false,
					error: "接口返回了空的模型列表",
				};
			}

			return { success: true, models };
		} catch (e) {
			const msg =
				e instanceof Error
					? e.name === "AbortError"
						? "请求超时，请检查网络或 baseUrl"
						: e.message
					: String(e);
			return { success: false, error: this.redactSecret(msg, apiKey) };
		}
	}

	// ── 快速测试连接 ─────────────────────────────────────

	/**
	 * 向 provider 发送一条最小聊天请求验证 baseUrl、apiKey 和模型是否正常。
	 * 返回测试结果，包含模型名、响应摘要、token 用量和延迟。
	 */
	/**
	 * 根据 API 类型构造测试请求的 URL、headers 和 body。
	 * 支持的 api 类型：openai-completions, openai-responses, anthropic-messages, google-generative-ai。
	 * 历史别名 openai-chat-completions 会归一为 pi 官方的 openai-completions。
	 */
	private buildModelsRequest(
		baseUrl: string,
		apiKey: string,
		apiType?: string,
	): TestRequest {
		const u = baseUrl.replace(/\/+$/, "");
		const api = this.normalizeApiType(apiType);

		if (api === "google-generative-ai") {
			return {
				url: `${u}/models?key=${encodeURIComponent(apiKey)}`,
				headers: { "Content-Type": "application/json" },
			};
		}

		if (api === "anthropic-messages") {
			return {
				url: `${u}/models`,
				headers: {
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
					"Content-Type": "application/json",
				},
			};
		}

		return {
			url: `${u}/models`,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
		};
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
		const u = baseUrl.replace(/\/+$/, "");
		const api = this.normalizeApiType(apiType);
		const extraHeaders = this.normalizeRequestHeaders(requestHeaders);

		switch (api) {
			case "openai-responses":
			case "openai-codex-responses":
				return {
					url: `${u}/responses`,
					headers: this.withOpenAiSdkUserAgent({
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						...extraHeaders,
					}),
					body: JSON.stringify({
						model: modelId,
						input: "Use the list_files tool if tool calling is available.",
						max_output_tokens: 10,
						tools: [
							{
								type: "function",
								name: "list_files",
								description: "List files to verify tool calling compatibility.",
								parameters: {
									type: "object",
									properties: {},
									additionalProperties: false,
								},
							},
						],
					}),
				};

			case "anthropic-messages":
				return {
					url: `${u}/messages`,
					headers: {
						"x-api-key": apiKey,
						"anthropic-version": "2023-06-01",
						"Content-Type": "application/json",
						...extraHeaders,
					},
					body: JSON.stringify({
						model: modelId,
						messages: [{ role: "user", content: "Hi" }],
						max_tokens: 10,
					}),
				};

			case "google-generative-ai":
				// Gemini 的 API key 作为查询参数
				return {
					url: `${u}/${this.googleModelPath(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`,
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
						generationConfig: { maxOutputTokens: 10 },
					}),
				};

			case "mistral-conversations":
				return {
					url: `${u}/conversations`,
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
					url: `${u}/chat/completions`,
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						...extraHeaders,
					},
					body: JSON.stringify({
						model: modelId,
						messages: [{ role: "user", content: "Hi" }],
						max_tokens: 10,
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
			const timeout = setTimeout(() => controller.abort(), 15_000);

			const res = await fetch(requestUrl, {
				method: "POST",
				headers,
				body: requestBody,
				signal: controller.signal,
			});
			clearTimeout(timeout);

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
					? "请求超时（15 秒），请检查网络或 baseUrl"
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
			return { valid: false, error: "导入文件缺少 files 字段，请确认是 pi-desktop 导出的配置包" };
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
