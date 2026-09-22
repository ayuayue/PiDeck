/**
 * PiDeck Vision Bridge Extension
 *
 * 给 DeepSeek 等无视觉模型"装上眼睛"：
 * - 用户粘贴/上传的图片：input 事件里直接转成文字描述（否则 pi 会在 provider 层
 *   替换成 "(image omitted...)" 占位符，模型什么都看不到）；
 * - 工具结果（如 read 读图）中的图片：tool_result 事件直接转成文字并写回工具结果；
 *   before_provider_payload 只负责旧会话/其他扩展残留图片的最后兜底。
 *
 * - 工具图片先在 tool_result 阶段转换，避免模型看到图片省略占位符后再调用 read
 *   搜索临时文件；payload 阶段只处理无法提前改写的历史内容。
 *
 * 设计要点：
 * - 自包含单文件：脱离 PiDeck 也能用（复制到 ~/.pi/agent/extensions/ 或 `pi -e` 加载），
 *   只依赖 pi 扩展 API 与 Node 内置模块。
 * - 配置外挂：读取 ~/.pi/agent/pi-deck-vision.json（与 pi 的 models.json/auth.json 同级），
 *   可用 PIDECK_VISION_CONFIG_DIR 环境变量覆盖目录（PiDeck 注入 / 测试用）。
 * - 复用已配置供应商：apiKey/baseUrl 优先从 pi 的模型注册表解析
 *   （ctx.modelRegistry.getProviderAuth），不重复填 key；配置文件里也可显式指定。
 * - 能力优先：当前会话模型明确支持 image 时完全放行原图；只有不支持图片时才启用视觉桥。
 * - 配置容错：绝不伪造转换成功，也不伪造「失败」——视觉桥没开就写清楚「图片未发送给模型」
 *   并给出可执行入口（配置→模型 勾选图片 / 设置→视觉桥 启用），只有真的尝试转换而失败
 *   （端点解析不到、视觉调用出错）才用失败标记。图片一律不留在消息里：pi 对不支持图片的
 *   模型只会用 "(image omitted: model does not support images)" 顶替，写明原因对模型和用户都更有用。
 * - 失败降级：视觉调用失败时替换为错误占位文本，绝不阻断 agent 主流程；
 *   同一图片（base64 哈希）在进程生命周期内只调用一次。
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
// 视觉请求直连：不用全局 fetch。pi 的 http-dispatcher 会把全局 dispatcher 换成
// EnvHttpProxyAgent（读 HTTPS_PROXY 环境变量），用户翻墙代理对商汤/GLM/Qwen
// 这类国内视觉 API 反而导致连接失败；undici 显式 dispatcher 不受影响。
import { Agent, fetch as undiciFetch } from "undici";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

/** 配置文件：~/.pi/agent/pi-deck-vision.json */
const CONFIG_FILE_NAME = "pi-deck-vision.json";
/** 运行日志文件（与配置同目录），PiDeck 设置页读取做诊断；绝不写 apiKey */
const LOG_FILE_NAME = "pi-deck-vision.log";
/** 结构化转换事件文件（JSONL）：会话渲染层据此展示「请求详情」（模型/耗时/每张图结果）。 */
const EVENT_FILE_NAME = "pi-deck-vision-events.jsonl";
/** 事件文件大小上限；超过后截断只保留尾部（保留最近活动）。 */
const MAX_EVENT_FILE_BYTES = 2 * 1024 * 1024;

/** 单张图片的转换结果（index 与消息文本里的「图片 #N」序号一致）。 */
export type VisionEventItem = {
	/** 图片在本次转换中的序号（1 起，与消息文本 #N 同源） */
	index: number;
	/** 图片内容 sha256 前 24 位：渲染层按此把事件匹配到发送中的实时消息（跨会话稳定） */
	imageHash?: string;
	mimeType: string;
	ok: boolean;
	/** 失败原因（ok=false 时） */
	error?: string;
	/** 单图请求耗时 ms（缓存命中为 0） */
	durationMs: number;
	/** 命中描述缓存，未实际请求视觉模型 */
	cached: boolean;
	/** 成功描述（截断，详情展示用；完整描述在消息文本里） */
	description?: string;
	/** 输出 token 数（响应带 usage 时） */
	outputTokens?: number;
};

/** 一次 describeImages 调用的批次事件（一行 JSON）。 */
export type VisionBatchEvent = {
	ts: number;
	/** 转换来源：input=用户发图 / tool_result=工具读图 / request=provider payload 兜底 */
	kind: "input" | "tool_result" | "request";
	model: string;
	/** 提示词模板（截断，展示用） */
	prompt: string;
	/** 本批总耗时 ms */
	totalDurationMs: number;
	items: VisionEventItem[];
};

/** 追加一条批次事件；文件超限时截断保留尾部（异步幂等，失败静默不阻断转换）。 */
export async function writeVisionEvent(configDir: string, event: VisionBatchEvent): Promise<void> {
	try {
		const filePath = join(configDir, EVENT_FILE_NAME);
		await appendFile(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
		// 大小上限：超出后只保留尾部一半，避免无限增长（读端也按尾部读取）
		try {
			const size = (await stat(filePath)).size;
			if (size > MAX_EVENT_FILE_BYTES) {
				const data = await readFile(filePath, "utf8");
				const keep = data.slice(-MAX_EVENT_FILE_BYTES / 2);
				const firstNewline = keep.indexOf("\n");
				await writeFile(filePath, keep.slice(firstNewline + 1), { encoding: "utf8" });
			}
		} catch {
			// stat/read 竞态（文件刚被清空）不处理
		}
	} catch {
		// 事件文件写入失败不阻断视觉转换
	}
}
/** 日志文件超过该大小后轮转（保留尾部 64KB），防止长期运行撑爆磁盘 */
const MAX_LOG_BYTES = 512 * 1024;
const KEEP_LOG_TAIL_BYTES = 64 * 1024;

/** 当前模型明确支持图片时，视觉桥必须让路，避免重复调用和质量下降。 */
function currentModelSupportsImages(ctx: ExtensionContext): boolean {
	return ctx.model?.input.includes("image") === true;
}

/**
 * 视觉桥是否应接管当前图片。
 * `undefined` 不作为支持图片处理：只有 pi 明确声明支持 image 才绕过桥，
 * 这样模型目录缺字段时仍能通过视觉桥兜底。
 */
function shouldUseVisionBridge(ctx: ExtensionContext): boolean {
	return !currentModelSupportsImages(ctx);
}

/**
export function formatVisionLogTimestamp(date = new Date()): string {
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absoluteOffset = Math.abs(offsetMinutes);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

/**
 * 追加一行运行日志（文件日志，失败静默——日志本身绝不能影响主流程）。
 * 内容只允许：事件名、图片数、HTTP 状态码、耗时、解析失败原因；禁止 apiKey/baseUrl。
 */
export async function writeVisionLog(configDir: string, level: "info" | "warn" | "error", message: string): Promise<void> {
	try {
		const filePath = join(configDir, LOG_FILE_NAME);
		try {
			const info = await stat(filePath);
			if (info.size > MAX_LOG_BYTES) {
				// 简单轮转：只保留尾部，避免日志文件无限膨胀
				const data = await readFile(filePath, "utf8");
				await writeFile(filePath, data.slice(-KEEP_LOG_TAIL_BYTES), "utf8");
			}
		} catch {
			// 文件不存在属正常（首次写入），继续追加
		}
		const now = new Date();
		const pad = (value: number, width = 2) => String(value).padStart(width, "0");
		const offsetMinutes = -now.getTimezoneOffset();
		const absoluteOffset = Math.abs(offsetMinutes);
		const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}${offsetMinutes >= 0 ? "+" : "-"}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
		await writeFile(filePath, `[${timestamp}] [${level}] ${message}\n`, { encoding: "utf8", flag: "a" });
	} catch {
		// 日志写入失败（权限/磁盘满）不阻断扩展主流程
	}
}
/** 单轮最多转换的图片数（防止一次读图风暴拖垮响应） */
const MAX_IMAGES_PER_TURN = 12;
/** 单张图片 base64 长度上限（≈15MB），超出跳过并提示，避免请求体过大 */
const MAX_IMAGE_BASE64_LENGTH = 15 * 1024 * 1024;
/** 图片哈希 → 描述结果缓存（含失败，避免同一张图反复调用视觉模型） */
const descriptionCache = new Map<string, { ok: boolean; text: string }>();
/** toolCallId → 未能在 tool_result 阶段改写的图片，供 payload 兜底消费 */
const pendingToolImages = new Map<string, ImageContent[]>();
/** 未消费缓存的硬上限：请求被中断/裁剪时缓存会滞留，超过上限时丢弃最旧的，防止内存膨胀 */
const MAX_PENDING_TOOL_IMAGES = 128;

/** 将工具结果中的图片替换为视觉桥文字，直接写回 pi 会话和 UI。 */
function replaceToolImagesWithDescription(
	content: Array<{ type?: string; text?: string } | ImageContent>,
	description: string,
): Array<{ type: "text"; text: string }> {
	const textContent = content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text);
	return [...textContent, description]
		.filter((text) => text.trim())
		.map((text) => ({ type: "text", text }));
}

/** 登记一条工具结果缓存；超上限时丢最旧的一条（Map 保持插入序）。 */
function cacheToolImages(toolCallId: string, images: ImageContent[]): void {
	while (pendingToolImages.size >= MAX_PENDING_TOOL_IMAGES) {
		const oldest = pendingToolImages.keys().next().value;
		if (oldest === undefined) break;
		pendingToolImages.delete(oldest);
	}
	pendingToolImages.set(toolCallId, images);
}

/** 视觉调用支持的 API 格式；默认 OpenAI 兼容（覆盖 GLM/Qwen/OpenRouter/DeepSeek 等） */
export type VisionApiKind = "openai-completions" | "anthropic-messages" | "google-generative-ai";

/** 响应里没有可用文本时的占位（describeImage 据此触发关闭思考重试） */
const EMPTY_RESPONSE_PLACEHOLDER = "[empty response]";

/** pi-deck-vision.json 的配置结构 */
export type VisionBridgeConfig = {
	/** 总开关；false 时扩展完全放行，保持 pi 原行为 */
	enabled: boolean;
	/** 视觉模型所在供应商名（pi 已配置的 provider id，如 openai/openrouter/glm/qwen） */
	provider: string;
	/** 视觉模型 id（如 gpt-4o-mini / glm-4v-flash / qwen-vl-plus） */
	model: string;
	/** API 格式；省略时优先取 provider 自身 api，再默认 openai-completions */
	api?: VisionApiKind;
	/** 显式 baseUrl（如 https://open.bigmodel.cn/api/paas/v4）；省略时从注册表解析 */
	baseUrl?: string;
	/** 显式 apiKey；省略时从注册表 / auth.json 解析 */
	apiKey?: string;
	/** 描述结果最大 token 数；0 = 不限制（不传该字段，Anthropic 必填则兜底 1024） */
	maxTokens?: number;
	/** 单张图片转换超时（ms），默认 120s（视觉请求常含多图/慢模型，30s 偏紧） */
	timeoutMs?: number;
	/** 单次转换并发数，默认 2（避免瞬时多请求被限流） */
	concurrency?: number;
	/** 发给视觉模型的提示词（图片作为多模态内容附带，无占位符） */
	promptTemplate?: string;
};

/** 解析后的调用端点信息 */
type ResolvedEndpoint = {
	baseUrl: string;
	/** 视觉模型 id（来自配置） */
	model: string;
	apiKey?: string;
	headers?: Record<string, string>;
	api: VisionApiKind;
};

const VISION_GUARDRAIL =
	"只分析当前传入的图片数据，不要调用 read、bash、find 或搜索本地文件来寻找图片，也不要臆测图片来源。鉴伪、识人或判断新闻真伪时，明确区分画面可见证据与无法仅凭图片确认的推测，不要把不确定身份当成事实。";

const DEFAULT_PROMPT =
	"请分析这张图片本身，不要调用 read、bash、find 或搜索本地文件来寻找图片，也不要臆测图片来源。先客观描述可见内容；如果用户要求鉴伪、识人或判断新闻真伪，请明确区分‘画面可见证据’与‘无法仅凭图片确认的推测’，不要把不确定身份当成事实。图片中有文字（代码、报错、UI 文案、文档等）时完整准确转录；如果是图表，说明类型、坐标轴含义和关键数值。输出使用中文。";

const DEFAULT_CONFIG: VisionBridgeConfig = {
	enabled: true,
	provider: "",
	model: "",
	maxTokens: 0,
	timeoutMs: 120_000,
	concurrency: 2,
	promptTemplate: DEFAULT_PROMPT,
};

/**
 * pi 内置 provider 的默认端点（auth.json 里通常只有 key，没有 baseUrl）。
 * 覆盖 OpenAI / OpenRouter / Anthropic / Gemini / DeepSeek / GLM 等；
 * 其余 provider（如 opencode-go、xiaomi、qwen-token-plan）的 baseUrl 挂在模型目录的
 * 每个模型上（model.baseUrl），由 resolveEndpoint 经 modelRegistry.find 解析，无需在此登记。
 */
const DEFAULT_BASE_URLS: Record<string, string> = {
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
	anthropic: "https://api.anthropic.com",
	"google-generative-ai": "https://generativelanguage.googleapis.com",
	gemini: "https://generativelanguage.googleapis.com",
	deepseek: "https://api.deepseek.com/v1",
	zai: "https://open.bigmodel.cn/api/paas/v4",
	"zai-coding-cn": "https://open.bigmodel.cn/api/paas/v4",
	"vercel-ai-gateway": "https://open.bigmodel.cn/api/paas/v4",
	moonshotai: "https://api.moonshot.cn/v1",
	"moonshotai-cn": "https://api.moonshot.cn/v1",
	nvidia: "https://integrate.api.nvidia.com/v1",
	mistral: "https://api.mistral.ai/v1",
	groq: "https://api.groq.com/openai/v1",
	xai: "https://api.x.ai/v1",
	fireworks: "https://api.fireworks.ai/inference/v1",
	together: "https://api.together.xyz/v1",
};

/** 内置 provider 的已知 API 格式（用于自动推断，避免依赖运行时注册表查询）。 */
const PROVIDER_API_HINTS: Record<string, VisionApiKind> = {
	anthropic: "anthropic-messages",
	"google-generative-ai": "google-generative-ai",
	gemini: "google-generative-ai",
};

/** 读取配置文件；文件不存在/解析失败返回 null（此时扩展静默放行）。 */
export async function loadVisionBridgeConfig(
	configDir = resolveConfigDir(),
): Promise<VisionBridgeConfig | null> {
	try {
		const raw = await readFile(join(configDir, CONFIG_FILE_NAME), "utf8");
		const parsed = JSON.parse(raw) as Partial<VisionBridgeConfig>;
		if (typeof parsed !== "object" || parsed === null) return null;
		// 只合并已知字段，避免配置里混入未知键影响结构
		const config: VisionBridgeConfig = { ...DEFAULT_CONFIG };
		if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
		if (typeof parsed.provider === "string") config.provider = parsed.provider;
		if (typeof parsed.model === "string") config.model = parsed.model;
		if (typeof parsed.api === "string") config.api = parsed.api as VisionApiKind;
		if (typeof parsed.baseUrl === "string") config.baseUrl = parsed.baseUrl;
		if (typeof parsed.apiKey === "string") config.apiKey = parsed.apiKey;
		if (typeof parsed.maxTokens === "number" && parsed.maxTokens >= 0) config.maxTokens = parsed.maxTokens;
		if (typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0) config.timeoutMs = parsed.timeoutMs;
		if (typeof parsed.concurrency === "number" && parsed.concurrency > 0) config.concurrency = parsed.concurrency;
		if (typeof parsed.promptTemplate === "string" && parsed.promptTemplate.trim()) {
			config.promptTemplate = parsed.promptTemplate;
		}
		return config;
	} catch {
		return null;
	}
}

/** 配置文件目录：PIDECK_VISION_CONFIG_DIR 覆盖 → ~/.pi/agent */
export function resolveConfigDir(): string {
	const override = process.env.PIDECK_VISION_CONFIG_DIR;
	if (override && override.trim()) return override.trim();
	return join(homedir(), ".pi", "agent");
}

/**
 * pi 的 agent 目录（models.json / auth.json 所在处）。
 * 与 pi 的 getAgentDir 同源：PI_CODING_AGENT_DIR 优先（pi 探针等场景会把配置指向临时目录），
 * 否则回落到视觉桥配置目录（默认 ~/.pi/agent）。
 */
export function resolveAgentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override && override.trim()) return override.trim();
	return resolveConfigDir();
}

/** 计算图片 base64 的 sha256 前缀，用于缓存去重。 */
export function imageHash(data: string): string {
	return createHash("sha256").update(data).digest("hex").slice(0, 24);
}

/**
 * 从 data URL（data:mimeType;base64,xxx）提取图片内容。
 * 格式不合法返回 null。用于替换 user 消息里的 image_url part。
 */
export function extractImageFromDataUrl(url: string): ImageContent | null {
	const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
	if (!match) return null;
	return { type: "image", data: match[2], mimeType: match[1] };
}

/**
 * 替换 tool 消息 content（字符串）里的"图片省略"note。
 *
 * pi 各版本的省略 note 格式不同，全部要兼容：
 * - 新版（0.7x+）："(tool image omitted: model does not support images)"（圆括号）
 * - 旧版方括号："[Current model does not support images. The image will be omitted...]"
 * - 旧版裸文本："Current model does not support images..."
 *
 * 替换后："Read image file [image/png]\n[图片 #N（视觉桥已查看，以下为图片实际内容）]\n<描述>"
 * note 之后的附加内容（如 ACP 标签）原样保留。无 note 时原样返回。
 */
export function replaceNoteInToolContent(content: string, description: string): string {
	// 新版/旧版占位符统一匹配（行内文本，不含跨行）
	const notePattern =
		/(?:\(tool image omitted:[^\n]*\)|\(image omitted:[^\n]*\)|\[Current model does not support images[^\]]*\]|Current model does not support images[^\n]*)/i;
	if (!notePattern.test(content)) return content;
	const match = content.match(notePattern);
	if (!match || match.index === undefined) return content;
	const head = content.slice(0, match.index).replace(/\n$/, "");
	// note 之后的尾部（通常是空行 + ACP 标签等），只保留一个换行分隔
	const tail = content.slice(match.index + match[0].length).replace(/^\n+/, "\n");
	return `${head}\n${description}${tail}`;
}

/**
 * 解析视觉调用端点：
 * 1. 配置文件显式 apiKey/baseUrl 优先；
 * 2. 否则从 ctx.modelRegistry 解析（复用 pi 已配置的 auth.json / 环境变量）；
 * 3. 兜底内置默认 baseUrl（openai/openrouter）。
 * 返回 null 表示无法解析（扩展应放行原图）。
 */
export async function resolveEndpoint(
	config: VisionBridgeConfig,
	ctx: Pick<ExtensionContext, "modelRegistry">,
): Promise<ResolvedEndpoint | null> {
	if (!config.provider || !config.model) return null;

	let apiKey: string | undefined = config.apiKey;
	let baseUrl: string | undefined = config.baseUrl;
	let headers: Record<string, string> | undefined;

	// 从 pi 模型注册表解析供应商已配置的 auth（key 不落日志、不落配置）。
	// 注意：pi 0.8x 起 getProviderAuth 返回 AuthResult = { auth: ModelAuth, env?, source? }，
	// key/endpoint 都在 auth 子对象里；按旧扁平结构取值会全部落空导致“配置了没走”。
	try {
		const auth = await ctx.modelRegistry.getProviderAuth(config.provider);
		if (auth?.auth) {
			apiKey = apiKey ?? auth.auth.apiKey;
			baseUrl = baseUrl ?? auth.auth.baseUrl;
			if (auth.auth.headers && Object.keys(auth.auth.headers).length > 0) {
				// ProviderHeaders 允许 null 值（显式清除），只保留字符串值
				headers = Object.fromEntries(
					Object.entries(auth.auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
				);
			}
		}
		if (!apiKey) {
			apiKey = await ctx.modelRegistry.getApiKeyForProvider(config.provider);
		}
	} catch {
		// 注册表解析失败不致命：显式配置仍可用
	}

	// provider 自身 api 类型（如 anthropic-messages）作为默认 API 格式
	let api: VisionApiKind = "openai-completions";
	if (config.api) {
		api = config.api;
	} else {
		// 先查内置 provider 的已知 API 类型（不依赖运行时注册表，注册表可能查不到自定义/未登录 provider）
		const hint = PROVIDER_API_HINTS[config.provider];
		if (hint) {
			api = hint;
		} else {
			try {
				const provider = ctx.modelRegistry.getProvider(config.provider);
				const providerApi = String((provider as { api?: unknown } | undefined)?.api ?? "");
				if (providerApi === "anthropic-messages") api = "anthropic-messages";
				else if (providerApi === "google-generative-ai") api = "google-generative-ai";
			} catch {
				// 保持默认 openai-completions
			}
		}
	}

	if (!baseUrl) {
		// 关键兜底：pi 内置目录模型（opencode-go/xiaomi/qwen 等）的端点挂在模型上
		// （model.baseUrl），不在 auth.json/models.json。查不到就默认放行会"配置了没走"。
		try {
			const model = ctx.modelRegistry.find(config.provider, config.model);
			baseUrl = (model as { baseUrl?: string } | undefined)?.baseUrl;
		} catch {
			// 注册表查询失败不致命
		}
	}
	if (!baseUrl) {
		// 内置 provider 已知端点；其余需要在配置文件显式填写 baseUrl
		baseUrl = DEFAULT_BASE_URLS[config.provider];
		if (!baseUrl) return null;
	}

	// 若 auth 解析到了 headers 且没有 apiKey（如 anthropic 的 x-api-key header），保留 headers 原样
	return { baseUrl: baseUrl.replace(/\/+$/, ""), model: config.model, apiKey, headers, api };
}

/**
 * 调用视觉模型描述单张图片（OpenAI 兼容 / Anthropic / Gemini 三种格式）。
 * 返回 { ok, text }；任何异常都折叠为失败结果，不向外抛。
 *
 * 重试策略：部分 openai 兼容网关的思维链模型（如商汤 6.7）非流式请求里
 * max_tokens 是「思考 + 回答」的总预算，思考会吃掉大部分额度导致回答被
 * length 截断（描述不完整，结构都没写完）。此时用 reasoning_effort:"none"
 * 重试一次强制直接给答案；content 完全为空（纯思考输出）同理。
 */
export async function describeImage(
	endpoint: ResolvedEndpoint,
	image: ImageContent,
	prompt: string,
	options: { maxTokens: number; timeoutMs: number; signal?: AbortSignal },
): Promise<{ ok: boolean; text: string; durationMs?: number; outputTokens?: number }> {
	const first = await doVisionRequest(endpoint, image, prompt, options, { reasoningEffortNone: false });
	const needsRetry =
		endpoint.api === "openai-completions" &&
		first.ok &&
		(first.text === EMPTY_RESPONSE_PLACEHOLDER || first.finishReason === "length");
	if (needsRetry) {
		const retry = await doVisionRequest(endpoint, image, prompt, options, { reasoningEffortNone: true });
		// 重试也可能仍返回空 content：同样要降级，不能把占位文本当成功描述
		if (retry.ok && retry.text !== EMPTY_RESPONSE_PLACEHOLDER) return retry;
	}
	// 空响应降级为失败：HTTP 200 但 content 为空（或重试后仍空）时，
	// 绝不能把 "[empty response]" 占位文本当作成功描述喂给主模型（用户看到的就是"空响应"）
	if (first.ok && first.text === EMPTY_RESPONSE_PLACEHOLDER) {
		return { ok: false, text: "视觉模型返回空响应（可能不支持图片或该模型/Key 无权限），请检查配置或换一个视觉模型" };
	}
	return first;
}

/** 直连 dispatcher（进程级单例）：避免走全局代理，国内视觉 API 才能稳定连通。 */
let directDispatcher: Agent | undefined;
function getDirectDispatcher(): Agent {
	if (!directDispatcher) {
		directDispatcher = new Agent({ connect: { timeout: 15_000 } });
	}
	return directDispatcher;
}

/** 已知 max_tokens 上限低的端点（如智谱 glm-4v-flash 只允许 [1,1024]），
 * 400 自愈成功后记录，后续请求直接不带 max_tokens 字段。 */
const noMaxTokensEndpoints = new Set<string>();
function endpointKey(endpoint: ResolvedEndpoint): string {
	return `${endpoint.baseUrl}|${endpoint.model}`;
}

/** 去掉 body 里的 max_tokens 字段（openai 兼容格式）。force=true 强制去掉，
 * 否则仅当该端点已被标记为低上限时去掉。其他格式（anthropic/google）不动。 */
function trimMaxTokens(endpoint: ResolvedEndpoint, body: unknown, force = false): unknown {
	if (endpoint.api !== "openai-completions" || typeof body !== "object" || body === null) {
		return body;
	}
	if (!force && !noMaxTokensEndpoints.has(endpointKey(endpoint))) {
		return body;
	}
	const next = { ...(body as Record<string, unknown>) };
	delete next.max_tokens;
	return next;
}

/** 单次视觉请求（可指定关闭思考模式重试）。返回结果附 finishReason（openai 格式），
 * 供调用方判断是否被 max_tokens 截断。 */
async function doVisionRequest(
	endpoint: ResolvedEndpoint,
	image: ImageContent,
	prompt: string,
	options: { maxTokens: number; timeoutMs: number; signal?: AbortSignal },
	flags: { reasoningEffortNone: boolean },
): Promise<{ ok: boolean; text: string; finishReason?: string; durationMs?: number; outputTokens?: number }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
	const onOuterAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onOuterAbort, { once: true });
	const startedAt = Date.now();

	try {
		const { url, headers, body } = buildVisionRequest(endpoint, image, prompt, options.maxTokens, flags);
		// 已知低上限端点：直接不带 max_tokens（避免每次先吃一次 400）
		const trimmedBody = trimMaxTokens(endpoint, body);
		let res = await undiciFetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(trimmedBody),
			signal: controller.signal,
			dispatcher: getDirectDispatcher(),
		});
		if (res.status === 400 && endpoint.api === "openai-completions" && !noMaxTokensEndpoints.has(endpointKey(endpoint))) {
			// 兼容性自愈：部分网关（如智谱 glm-4v-flash）max_tokens 上限远低于
			// 配置值，去掉该字段重试一次；成功则记录该端点后续不再传
			const retryBody = trimMaxTokens(endpoint, body, true);
			const retry = await undiciFetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(retryBody),
				signal: controller.signal,
				dispatcher: getDirectDispatcher(),
			});
			if (retry.ok) {
				noMaxTokensEndpoints.add(endpointKey(endpoint));
				res = retry;
			}
		}
		if (!res.ok) {
			// 不打印响应体（可能回显请求中的图片或 key）；只带状态码
			return { ok: false, text: `HTTP ${res.status} ${res.statusText}` };
		}
		const payload = (await res.json()) as Record<string, unknown>;
		const finishReason = (payload.choices as Array<{ finish_reason?: unknown }> | undefined)?.[0]
			?.finish_reason as string | undefined;
		// usage 提取（各 API 格式字段不同，容错缺省）：openai 用 prompt_tokens/completion_tokens，
		// anthropic 用 input_tokens/output_tokens，gemini 在 usageMetadata 里。
		const usage = payload.usage as
			| { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }
			| undefined;
		const usageMeta = payload.usageMetadata as { outputTokenCount?: number } | undefined;
		const outputTokens =
			usage?.completion_tokens ?? usage?.output_tokens ?? usageMeta?.outputTokenCount;
		return {
			ok: true,
			text: extractVisionText(endpoint.api, payload, { fallbackToReasoning: flags.reasoningEffortNone }),
			durationMs: Date.now() - startedAt,
			...(finishReason ? { finishReason } : {}),
			...(typeof outputTokens === "number" ? { outputTokens } : {}),
		};
	} catch (e) {
		const isTimeout = e instanceof Error && e.name === "AbortError";
		return {
			ok: false,
			text: isTimeout ? `timeout(${options.timeoutMs}ms)` : e instanceof Error ? e.message : String(e),
			durationMs: Date.now() - startedAt,
		};
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onOuterAbort);
	}
}

/** 构造视觉请求（不同 API 格式的图片编码方式不同）。
 * baseUrl 允许带 API 版本路径（pi models.json 中 google-generative-ai 常带 /v1beta、
 * anthropic 偶见 /v1），拼接时去掉尾部版本段避免 /v1beta/v1beta 双写。 */
export function buildVisionRequest(
	endpoint: ResolvedEndpoint,
	image: ImageContent,
	prompt: string,
	maxTokens: number,
	flags: { reasoningEffortNone: boolean },
): { url: string; headers: Record<string, string>; body: unknown } {
	// 去掉 baseUrl 尾部的版本路径段（/v1、/v1beta），再按 API 格式拼回标准路径
	const apiBase = endpoint.baseUrl.replace(/\/(?:v1|v1beta)\/?$/, "");
	if (endpoint.api === "anthropic-messages") {
		return {
			url: `${apiBase}/v1/messages`,
			headers: {
				"content-type": "application/json",
				"x-api-key": endpoint.apiKey ?? "",
				"anthropic-version": "2023-06-01",
				...(endpoint.headers ?? {}),
			},
			body: {
				model: endpoint.model,
				// Anthropic 必填该字段，无默认值：不限制（0）时兜底 1024
				max_tokens: maxTokens > 0 ? maxTokens : 1024,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: prompt },
							{
								type: "image",
								source: {
									type: "base64",
									media_type: image.mimeType,
									data: image.data,
								},
							},
						],
					},
				],
			},
		};
	}
	if (endpoint.api === "google-generative-ai") {
		return {
			url: `${apiBase}/v1beta/models/${endpoint.model}:generateContent?key=${encodeURIComponent(endpoint.apiKey ?? "")}`,
			headers: { "content-type": "application/json", ...(endpoint.headers ?? {}) },
			body: {
				contents: [
					{
						role: "user",
						parts: [
							{ text: prompt },
							{ inline_data: { mime_type: image.mimeType, data: image.data } },
						],
					},
				],
				// 不限制（0）时不传 maxOutputTokens，交给模型默认输出上限
				...(maxTokens > 0 ? { generationConfig: { maxOutputTokens: maxTokens } } : {}),
			},
		};
	}
	// openai-completions（默认）：OpenAI / GLM / Qwen / OpenRouter / DeepSeek 兼容
	// 思维链模型（如商汤 6.7）非流式请求默认输出 reasoning 不输出 content，
	// 重试时用 reasoning_effort: "none" 强制直接给答案
	return {
		url: `${endpoint.baseUrl}/chat/completions`,
		headers: {
			"content-type": "application/json",
			...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
			...(endpoint.headers ?? {}),
		},
		body: {
			model: endpoint.model,
			// 不限制（0）时不传 max_tokens，输出长度交给模型默认上限
			...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
			...(flags.reasoningEffortNone ? { reasoning_effort: "none" } : {}),
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: prompt },
						{
							type: "image_url",
							image_url: { url: `data:${image.mimeType};base64,${image.data}` },
						},
					],
				},
			],
		},
	};
}

/** 从各 API 格式的响应里提取描述文本。
 * fallbackToReasoning：content 为空时回退到 message.reasoning
 * （重试后仍无 content 的兜底，避免整个桥接失败）。 */
export function extractVisionText(
	api: VisionApiKind,
	payload: Record<string, unknown>,
	options?: { fallbackToReasoning?: boolean },
): string {
	if (api === "anthropic-messages") {
		const content = payload.content as Array<Record<string, unknown>> | undefined;
		const text = content?.filter((part) => part.type === "text")
			.map((part) => String(part.text ?? ""))
			.join("\n");
		return text || "[empty response]";
	}
	if (api === "google-generative-ai") {
		const candidates = payload.candidates as Array<Record<string, unknown>> | undefined;
		const parts = candidates?.[0]?.content as Record<string, unknown> | undefined;
		const texts = (parts?.parts as Array<Record<string, unknown>> | undefined)
			?.map((part) => String(part.text ?? ""))
			.filter(Boolean);
		return texts?.join("\n") || "[empty response]";
	}
	// openai-completions
	const choices = payload.choices as Array<Record<string, unknown>> | undefined;
	const message = choices?.[0]?.message as Record<string, unknown> | undefined;
	const text = message?.content;
	if (typeof text === "string" && text.trim()) return text;
	// 部分兼容网关返回 content 数组（如 reasoning + text 混合）
	if (Array.isArray(text)) {
		const joined = text
			.map((part) => String((part as Record<string, unknown>)?.text ?? ""))
			.filter(Boolean)
			.join("\n");
		if (joined) return joined;
	}
	// 思维链模型：content 为空但 reasoning 里有观察结果，作最后兜底
	if (options?.fallbackToReasoning && typeof message?.reasoning === "string" && message.reasoning) {
		return message.reasoning;
	}
	return "[empty response]";
}

/** 简单并发池：把任务分批执行，每批最多 concurrency 个。 */
async function runWithConcurrency<T>(
	tasks: Array<() => Promise<T>>,
	concurrency: number,
): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let cursor = 0;
	async function worker() {
		while (true) {
			const index = cursor++;
			if (index >= tasks.length) return;
			results[index] = await tasks[index]();
		}
	}
	const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), tasks.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

/** 截断文本到上限字符数（按 code point，避免截断代理对）。 */
function truncateText(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${[...text].slice(0, max).join("")}…`;
}

/**
 * 描述一组图片（带哈希缓存 + 并发），返回拼好的描述文本块。
 * 全部失败或没有图片时返回 null。单轮图片超过上限时只处理前 N 张。
 * log 可选：转换统计回调（写文件日志用，绝不传图片内容）。
 * onBatch 可选：本批转换的结构化事件（写事件文件，会话渲染层展示请求详情）。
 */
/** 并发描述多张图片并汇总批次事件。
 * 导出仅用于测试覆盖（批次事件与 per-image 计时逻辑）；运行时入口是 default export 的 hooks。 */
/**
 * 生成转换失败标记文本（渲染层据此渲染红卡，原因直出到消息里）。
 *
 * 只用于「确实尝试转换但失败了」：接口地址解析不到、视觉调用报错/超时。
 * 注意（2026-09 修正）：pi 自己会在 transformMessages 阶段替不支持图片的模型
 * 把图片降级成 "(image omitted: model does not support images)"，原图不会进 provider、
 * 更不会 400。所以「视觉桥未配置」不是失败，不该套用本函数（见 buildSkippedImagesText）。
 */
export function buildOmittedImagesText(images: ImageContent[], reason: string): string {
	return images
		.slice(0, MAX_IMAGES_PER_TURN)
		.map((_, i) => {
			const n = i + 1;
			return `[图片 #${n} 视觉桥转换失败：${reason}。请检查视觉桥设置（模型/接口地址/API Key）后重试，此图片内容不可见]`;
		})
		.join("\n\n");
}

/**
 * 生成「图片未发送给模型」说明标记（渲染层渲染为中性提示卡）。
 *
 * 与失败标记的关键区别：这里根本没有人尝试转换（视觉桥没开、没选模型），
 * 属于「配置事实」而非「故障」。旧版复用失败文案，用户明明没开视觉桥也会看到
 * 红色「视觉桥转换失败」并被引导去检查 Key/接口地址，排查方向被带偏。
 * 标记里必须带可执行入口，否则用户只知道图没发出去、不知道去哪儿开。
 */
export function buildSkippedImagesText(images: ImageContent[], reason: string): string {
	return images
		.slice(0, MAX_IMAGES_PER_TURN)
		.map((_, i) => `[图片 #${i + 1} 未发送给模型：${reason}]`)
		.join("\n\n");
}

export async function describeImages(
	endpoint: ResolvedEndpoint,
	images: ImageContent[],
	prompt: string,
	config: VisionBridgeConfig,
	signal: AbortSignal | undefined,
	log?: (level: "info" | "warn" | "error", message: string) => void,
	onBatch?: (batch: Omit<VisionBatchEvent, "kind" | "model" | "prompt">) => void,
): Promise<string | null> {
	const selected = images.slice(0, MAX_IMAGES_PER_TURN);
	if (selected.length === 0) return null;

	const requestPrompt = `${prompt}\n\n${VISION_GUARDRAIL}`;

	// 第一遍：去重 + 跳过超大图（结果按出现顺序编号，保证多图时模型能对号入座）
	const jobs: Array<{ hash: string; image: ImageContent }> = [];
	const results = new Map<string, { ok: boolean; text: string }>();
	for (const image of selected) {
		const hash = imageHash(image.data);
		if (results.has(hash)) continue;
		if (image.data.length > MAX_IMAGE_BASE64_LENGTH) {
			results.set(hash, { ok: false, text: `图片超过 ${MAX_IMAGE_BASE64_LENGTH} 字节上限` });
			continue;
		}
		jobs.push({ hash, image });
	}

	// 第二遍：并发调用视觉模型（命中缓存直接复用）
	const itemTimings = new Map<string, { durationMs: number; cached: boolean }>();
	await runWithConcurrency(
		jobs.map(({ hash, image }) => async () => {
			const cached = descriptionCache.get(hash);
			if (cached) {
				results.set(hash, cached);
				itemTimings.set(hash, { durationMs: 0, cached: true });
				return;
			}
			const outcome = await describeImage(endpoint, image, requestPrompt, {
				maxTokens: config.maxTokens ?? 0,
				timeoutMs: config.timeoutMs ?? 30_000,
				signal,
			});
			descriptionCache.set(hash, outcome);
			results.set(hash, outcome);
			itemTimings.set(hash, { durationMs: outcome.durationMs ?? 0, cached: false });
		}),
		config.concurrency ?? 2,
	);

	// 第三遍：按原顺序拼装（含失败占位，模型仍能知道每张图的存在与顺序）
	// 汇总日志：失败时附带首条失败原因（如「视觉模型返回空响应」「HTTP 429」），设置页运行记录可直接定位
	let firstFailReason = "";
	let counter = 0;
	const parts: string[] = [];
	const seen = new Set<string>();
	let successCount = 0;
	let failCount = 0;
	for (const image of selected) {
		const hash = imageHash(image.data);
		if (results.get(hash) === undefined) continue;
		if (seen.has(hash)) continue;
		seen.add(hash);
		counter++;
		const result = results.get(hash);
		if (result?.ok) {
			successCount++;
			parts.push(`[图片 #${counter}（视觉桥已查看，以下为图片实际内容）]\n${result.text}`);
		} else {
			failCount++;
			if (!firstFailReason) {
				// 首次失败的具体原因（与失败占位文本同源，截断保护日志大小）
				firstFailReason = result?.text ? truncateText(result.text, 120) : "未配置视觉模型";
			}
			// 失败占位带原因 + 修复方向，让主模型和用户都能定位问题
			const reason = result ? truncateText(result.text, 200) : "未配置视觉模型";
			parts.push(
				`[图片 #${counter} 视觉桥转换失败：${reason}。请检查视觉桥设置（模型/接口地址/API Key）后重试，此图片内容不可见]`,
			);
		}
	}
	log?.(
		failCount > 0 ? "warn" : "info",
		`converted ${successCount} image(s)${failCount > 0 ? `, ${failCount} failed` : ""}${firstFailReason ? `；首个失败原因：${firstFailReason}` : ""}`,
	);
	// 汇总批次事件：每张图的 index/耗时/结果（与消息文本 #N 序号一致），供详情展示。
	// 遍历顺序 = 图片出现顺序，与上方 counter 编号规则完全一致（去重后递增）。
	const batchItems: VisionEventItem[] = [];
	let totalDurationMs = 0;
	{
		const seen2 = new Set<string>();
		let itemCounter = 0;
		for (const image of selected) {
			const hash = imageHash(image.data);
			if (results.get(hash) === undefined) continue;
			if (seen2.has(hash)) continue;
			seen2.add(hash);
			itemCounter++;
			const result = results.get(hash);
			const timing = itemTimings.get(hash) ?? { durationMs: 0, cached: false };
			totalDurationMs = Math.max(totalDurationMs, timing.durationMs);
			batchItems.push({
				index: itemCounter,
				imageHash: hash,
				mimeType: image.mimeType,
				ok: result?.ok === true,
				...(result && !result.ok ? { error: truncateText(result.text, 200) } : {}),
				durationMs: timing.durationMs,
				cached: timing.cached,
				...(result?.ok && result.text ? { description: truncateText(result.text, 400) } : {}),
				...(typeof result?.outputTokens === "number" ? { outputTokens: result.outputTokens } : {}),
			});
		}
	}
	onBatch?.({
		ts: Date.now(),
		totalDurationMs,
		items: batchItems,
	});
	return parts.length > 0 ? parts.join("\n\n") : null;
}

/** models.json 单模型条目中参与图片能力判定的字段（其余字段原样忽略） */
type ModelsJsonModelEntry = { id?: string; input?: string[]; images?: boolean };
/** models.json providers 映射（只取判定所需字段） */
type ModelsJsonProviders = Record<string, { models?: ModelsJsonModelEntry[] }>;

/** models.json 解析缓存：按「路径 + mtime」失效，避免每条带图消息重复解析大文件。
 * 必须带路径：不同 agent 目录下的文件可能撞上同一毫秒 mtime（测试/临时目录场景），
 * 只按 mtime 判等会把 A 目录的解析结果当 B 目录的用。 */
let modelsJsonProvidersCache: { filePath: string; mtimeMs: number; providers: ModelsJsonProviders | null } | null = null;

/**
 * 读取磁盘上的 models.json providers（按 mtime 缓存）；任何异常返回 null。
 * 只服务于「这张图为什么没被转换」的诊断文案，失败必须静默降级，绝不影响主流程。
 */
export async function loadModelsJsonProviders(): Promise<ModelsJsonProviders | null> {
	try {
		const filePath = join(resolveAgentDir(), "models.json");
		const info = await stat(filePath);
		if (modelsJsonProvidersCache && modelsJsonProvidersCache.filePath === filePath && modelsJsonProvidersCache.mtimeMs === info.mtimeMs) {
			return modelsJsonProvidersCache.providers;
		}
		const parsed = JSON.parse(await readFile(filePath, "utf8")) as { providers?: unknown };
		const providers = parsed && typeof parsed.providers === "object" && parsed.providers !== null ? (parsed.providers as ModelsJsonProviders) : null;
		modelsJsonProvidersCache = { filePath, mtimeMs: info.mtimeMs, providers };
		return providers;
	} catch {
		return null;
	}
}

/**
 * 磁盘配置是否为当前会话模型声明了图片输入能力。
 *
 * 存在的意义：模型目录是 pi 进程启动时读入的，改完 models.json 对已在跑的会话不生效。
 * 「明明勾了图片输入还是提示不支持」的真实原因就是模型目录过期（用户实测：同一模型
 * 改配置前启动的会话一直失败，改配置后新开的会话正常），此时该提示重启会话，
 * 而不是让用户继续在配置里找问题。
 */
export async function modelsJsonDeclaresImageInput(ctx: ExtensionContext): Promise<boolean> {
	const model = ctx.model;
	if (!model) return false;
	const providers = await loadModelsJsonProviders();
	const entry = providers?.[model.provider]?.models?.find((item) => item?.id === model.id);
	if (!entry) return false;
	// input 是 pi 的完整模态声明（["text","image"]）；兼容只写 images 布尔的手写配置
	if (Array.isArray(entry.input)) return entry.input.includes("image");
	return entry.images === true;
}

/**
 * 组装「图片未发送给模型」的原因文案（用户可读 + 可执行）。
 *
 * 为什么不用「视觉桥转换失败」措辞：这种情形下图片压根没进转换流程（桥没开），
 * 说「失败」会把用户引去检查视觉桥的 Key/接口地址，而真正该做的是二选一：
 * 给模型声明图片输入能力，或开启视觉桥。指错排查方向比不提示更糟。
 */
export async function buildNotConvertedReason(ctx: ExtensionContext, config: VisionBridgeConfig | null | undefined): Promise<string> {
	const label = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "当前模型";
	if (!config?.enabled) {
		if (await modelsJsonDeclaresImageInput(ctx)) {
			return `视觉桥未启用，且本会话仍按启动时的模型目录处理图片（${label} 未声明图片输入）。models.json 里该模型已勾选「图片」，重启会话后重新发送图片即可`;
		}
		return `视觉桥未启用，且 ${label} 未声明图片输入能力。可在「配置 → 模型」中为该模型勾选「图片」，或在「设置 → 视觉桥」中启用视觉桥后重新发送图片`;
	}
	return "视觉桥已启用但没有选择视觉模型，请在「设置 → 视觉桥」中选择模型后重新发送图片";
}

export default function (pi: ExtensionAPI) {
	// 用户输入事件：粘贴/上传的图片在进入 agent 前直接转成描述文本。
	// 不这么做的话，pi 会在 provider 层把图片替换成
	// "(image omitted: model does not support images)" 占位符，模型什么都看不到。
	pi.on("input", async (event, ctx) => {
		const configDir = resolveConfigDir();
		const log = (level: "info" | "warn" | "error", message: string) =>
			writeVisionLog(configDir, level, `input: ${message}`);
		try {
			const config = await loadVisionBridgeConfig();
			const typed = event as { text?: string; images?: ImageContent[] };
			const images = typed.images;
			if (!images || images.length === 0) return undefined;
			if (!shouldUseVisionBridge(ctx)) {
				log("info", `${images.length} image(s) bypassed: current model declares image input support`);
				return undefined;
			}
			if (!config?.enabled || !config.provider || !config.model) {
				// 桥未就绪（未启用 / 没选视觉模型）：这张图没有被转换，用中性的「未发送给模型」标记，
				// 不能复用转换失败文案——否则用户明明没开视觉桥也被告知「视觉桥转换失败」，
				// 排查方向被带偏（2026-09 用户反馈）。
				const reason = await buildNotConvertedReason(ctx, config);
				log("warn", `${images.length} image(s) not converted（vision bridge not ready）: ${reason}`);
				const placeholder = buildSkippedImagesText(images, reason);
				const text = typed.text ? `${typed.text}\n\n${placeholder}` : placeholder;
				return { action: "transform", text, images: [] };
			}
			const endpoint = await resolveEndpoint(config, ctx);
			if (!endpoint) {
				// 端点解析失败：同上，替换占位文本，避免原图进 provider 导致会话失败
				log("error", `endpoint resolve failed for ${config.provider}/${config.model}：解析不到接口地址，请在设置页填写"接口地址"或改用 pi 内置供应商`);
				const placeholder = buildOmittedImagesText(images, "视觉桥接口地址解析失败");
				const text = typed.text ? `${typed.text}\n\n${placeholder}` : placeholder;
				return { action: "transform", text, images: [] };
			}
			const desc = await describeImages(
				endpoint,
				images,
				config.promptTemplate ?? DEFAULT_PROMPT,
				config,
				ctx.signal,
				log,
				// 批次事件：input 阶段转换，会话渲染层按「图片 #N」序号对应展示请求详情
				(batch) =>
					writeVisionEvent(configDir, {
						...batch,
						kind: "input",
						model: `${config.provider}/${config.model}`,
						prompt: truncateText(config.promptTemplate ?? DEFAULT_PROMPT, 300),
					}),
			);
			if (!desc) {
				// describeImages 在 images 非空时正常不返回 null；防御：同样替换占位，不放行原图
				const placeholder = buildOmittedImagesText(images, "视觉桥转换失败");
				const text = typed.text ? `${typed.text}\n\n${placeholder}` : placeholder;
				return { action: "transform", text, images: [] };
			}
			// 描述文本附到消息文本后，图片清空（已转为文字）
			const text = typed.text ? `${typed.text}\n\n${desc}` : desc;
			return { action: "transform", text, images: [] };
		} catch (error) {
			log("error", `unhandled: ${error instanceof Error ? error.message : String(error)}`);
			return undefined; // 保持原样，不阻断
		}
	});

	// 工具结果事件：在 pi 把结果写入会话前直接转成文字。
	// 这样 UI 与模型拿到同一份描述，也避免后续 read 再去寻找临时图片文件。
	pi.on("tool_result", async (event, ctx) => {
		const configDir = resolveConfigDir();
		const log = (level: "info" | "warn" | "error", message: string) =>
			writeVisionLog(configDir, level, `tool_result: ${message}`);
		try {
			const typed = event as { toolCallId?: string; content?: unknown };
			if (!typed.toolCallId || !Array.isArray(typed.content)) return undefined;
			const images = typed.content.filter(
				(part): part is ImageContent =>
					!!part && typeof part === "object" && (part as { type?: unknown }).type === "image" &&
					typeof (part as ImageContent).data === "string",
			);
			if (images.length === 0) return undefined;
			if (!shouldUseVisionBridge(ctx)) {
				log("info", `${images.length} image(s) bypassed: current model declares image input support`);
				return undefined;
			}

			const config = await loadVisionBridgeConfig();
			if (!config?.enabled || !config.provider || !config.model) {
				log("warn", `${images.length} image(s) but vision bridge not configured; tool result kept unchanged`);
				cacheToolImages(typed.toolCallId, images);
				return undefined;
			}
			const endpoint = await resolveEndpoint(config, ctx);
			if (!endpoint) {
				log("error", `endpoint resolve failed for ${config.provider}/${config.model}`);
				cacheToolImages(typed.toolCallId, images);
				return undefined;
			}
			const description = await describeImages(
				endpoint,
				images,
				config.promptTemplate ?? DEFAULT_PROMPT,
				config,
				ctx.signal,
				log,
				(batch) =>
					writeVisionEvent(configDir, {
						...batch,
						kind: "tool_result",
						model: `${config.provider}/${config.model}`,
						prompt: truncateText(config.promptTemplate ?? DEFAULT_PROMPT, 300),
					}),
			);
			if (!description) return undefined;
			pendingToolImages.delete(typed.toolCallId);
			return { content: replaceToolImagesWithDescription(typed.content, description) };
		} catch (error) {
			log("error", `unhandled: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	});

	// 旧会话/其他扩展仍可能把图片带到 provider payload；这里做最后兜底。
	// 使用 before_provider_payload，而不是 before_provider_request：只有前者携带真正的 payload。
	pi.on("before_provider_payload", async (event, ctx) => {
		const configDir = resolveConfigDir();
		const log = (level: "info" | "warn" | "error", message: string) =>
			writeVisionLog(configDir, level, `request: ${message}`);
		try {
			// 当前模型能原生接收图片时，不能再改写 payload；原生视觉通常比
			// 二次转述保留更多细节，也避免用户配置了桥后仍被重复调用。
			if (!shouldUseVisionBridge(ctx)) return undefined;

			// 任何配置缺失都直接放行，保持 pi 原行为
			const config = await loadVisionBridgeConfig();
			if (!config?.enabled || !config.provider || !config.model) return undefined;

			const payload = (event as { payload?: { messages?: unknown[] } }).payload;
			if (!payload || !Array.isArray(payload.messages)) return undefined;

			const prompt = config.promptTemplate ?? DEFAULT_PROMPT;
			let changed = false;

			// 第一遍：收集需要替换的位置（tool 消息按 toolCallId 匹配缓存的图片，
			// user 消息就地提取 data URL 图片；无视觉模型下 pi 已把图片换成占位符，
			// 所以这里的 user 图片通常来自支持视觉的会话，仍按原路径处理）
			const replacements: Array<{
				msgIndex: number;
				kind: "tool" | "user";
				images: ImageContent[];
			}> = [];
			payload.messages.forEach((msg, msgIndex) => {
				const typed = msg as { role?: string; content?: unknown; tool_call_id?: string } | null;
				if (!typed || typeof typed !== "object") return;
				if (typed.role === "tool" && typeof typed.content === "string") {
					const images = pendingToolImages.get(String(typed.tool_call_id ?? ""));
					if (images?.length) {
						replacements.push({ msgIndex, kind: "tool", images });
						pendingToolImages.delete(String(typed.tool_call_id ?? ""));
					}
				} else if (typed.role === "user" && Array.isArray(typed.content)) {
					const images: ImageContent[] = [];
					for (const part of typed.content as Array<{ type?: string; image_url?: { url?: string } }>) {
						if (part?.type === "image_url" && typeof part.image_url?.url === "string") {
							const image = extractImageFromDataUrl(part.image_url.url);
							if (image) images.push(image);
						}
					}
					if (images.length > 0) {
						replacements.push({ msgIndex, kind: "user", images });
					}
				}
			});
			if (replacements.length === 0) return undefined;

			const endpoint = await resolveEndpoint(config, ctx);
			if (!endpoint) {
				// 有图片要处理但端点解析失败：留痕（“配置了没走”的直接原因）
				log("error", `endpoint resolve failed for ${config.provider}/${config.model}：解析不到接口地址，请在设置页填写“接口地址”或改用 pi 内置供应商`);
				return undefined;
			}

			// 第二遍：并发描述（不同消息的图片可并行）
			const descriptions = await Promise.all(
				replacements.map(({ images }) =>
					describeImages(endpoint, images, prompt, config, ctx.signal, log, (batch) =>
						writeVisionEvent(configDir, {
							...batch,
							kind: "request",
							model: `${config.provider}/${config.model}`,
							prompt: truncateText(config.promptTemplate ?? DEFAULT_PROMPT, 300),
						}),
					),
				),
			);

			// 第三遍：写回 payload（浅拷贝消息对象，避免污染原 payload）
			const messages = payload.messages.map((msg, msgIndex) => {
				const replacement = replacements.find((r) => r.msgIndex === msgIndex);
				if (!replacement) return msg;
				const desc = descriptions[replacements.indexOf(replacement)];
				if (!desc) return msg;
				changed = true;
				if (replacement.kind === "tool") {
					const typed = msg as { content?: unknown };
					return { ...(msg as object), content: replaceNoteInToolContent(String(typed.content), desc) };
				}
				// user 消息：image_url part 全部替换为描述文本。
				// 配对规则：同一张图（base64 相同）共享同一描述块，按去重后的出现顺序取块，
				// 避免“描述块数 < part 数”时错位或产生 text:undefined 的坏 part。
				const typed = msg as { content?: Array<{ type?: string; image_url?: { url?: string } }> };
				// 第一遍收集时已确认 Array.isArray，这里再防御一次让 TS 收窄
				if (!typed.content) return msg;
				const texts = desc.split("\n\n");
				const uniqueImages: ImageContent[] = [];
				for (const part of typed.content) {
					if (part?.type !== "image_url") continue;
					const image = extractImageFromDataUrl(part.image_url?.url ?? "");
					if (image && !uniqueImages.some((im) => im.data === image.data)) uniqueImages.push(image);
				}
				const nextContent = typed.content.map((part) => {
					if (part?.type !== "image_url") return part;
					const image = extractImageFromDataUrl(part.image_url?.url ?? "");
					if (!image) return part;
					const idx = uniqueImages.findIndex((im) => im.data === image.data);
					if (idx === -1 || idx >= texts.length) return part;
					return { type: "text", text: texts[idx] };
				});
				return { ...(msg as object), content: nextContent };
			});

			return changed ? { ...payload, messages } : undefined;
		} catch (error) {
			// 任何异常都不能阻断请求：返回 undefined 保持原 payload
			log("error", `unhandled: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	});
}
