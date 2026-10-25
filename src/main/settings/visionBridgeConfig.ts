/**
 * 视觉桥配置管理（主进程侧）。
 *
 * 配置文件 ~/.pi/agent/pi-deck-vision.json 与 resources/extensions/pi-deck-vision.ts
 * 扩展读取的是同一份文件：PiDeck 只负责「界面化编辑」，扩展负责「运行时消费」，
 * 所以脱离 PiDeck 单独使用 pi + 该扩展时，手动编辑同一配置文件即可生效。
 *
 * 安全约束：IPC 入参不可信，saveConfig 逐字段白名单校验后再落盘；
 * apiKey 允许写入配置文件（与 auth.json 同级信任域），但不进日志。
 */
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAppLogger } from "../logging/sharedLogger";
import type { VisionBridgeConfig, VisionBridgeEvent, VisionBridgeState, VisionEventsInfo, VisionLogInfo, VisionSaveResult } from "../../shared/types";
import type { ConfigManager } from "../config/ConfigManager";

const CONFIG_FILE_NAME = "pi-deck-vision.json";
/** 运行日志文件名（与扩展 LOG_FILE_NAME 保持一致） */
const LOG_FILE_NAME = "pi-deck-vision.log";
/** 单次 IPC 返回的日志上限：超过只返回尾部（扩展已做 512KB 轮转，这里双保险） */
const MAX_LOG_RETURN_BYTES = 256 * 1024;
/** 结构化转换事件文件名（与扩展 EVENT_FILE_NAME 保持一致） */
const EVENT_FILE_NAME = "pi-deck-vision-events.jsonl";
/** 单次 IPC 返回的事件原文上限（事件文件可能被扩展截断，这里再兜底） */
const MAX_EVENT_RETURN_BYTES = 1024 * 1024;

/** 与扩展 DEFAULT_BASE_URLS 对应的已知端点提示（仅 UI 展示用，解析以扩展为准）。 */
export const KNOWN_PROVIDER_BASE_URLS: Record<string, string> = {
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
	anthropic: "https://api.anthropic.com",
	"google-generative-ai": "https://generativelanguage.googleapis.com",
	gemini: "https://generativelanguage.googleapis.com",
};

/** 视觉桥默认值（与扩展 DEFAULT_CONFIG 保持一致）。 */
/** 与扩展 pi-deck-vision.ts 的 DEFAULT_PROMPT 完全一致；
 *  保存配置时若无自定义模板则写入此默认值，保证配置文件里永远有模板（用户可直接改文件）。 */
export const VISION_DEFAULT_PROMPT = "请详细描述这张图片的内容。如果图片中有文字（代码、报错、UI 文案、文档等），请完整准确地转录所有可见文字；如果是图表，请说明类型、坐标轴含义和关键数值；如果涉及界面，请描述布局与元素。输出使用中文。";

export const VISION_DEFAULT_CONFIG: VisionBridgeConfig = {
	enabled: true,
	provider: "",
	model: "",
	// 0 = 不限制：请求不传 max_tokens，输出长度交给模型默认（Anthropic 必填，请求侧兜底 1024）
	maxTokens: 0,
	// 单张图片转换请求超时（默认 2 分钟：视觉请求常含多图/慢模型，30s 偏紧）
	timeoutMs: 120_000,
	concurrency: 2,
	promptTemplate: VISION_DEFAULT_PROMPT,
};

/** 配置文件所在目录：环境变量覆盖优先（测试/自定义），否则 ~/.pi/agent/。 */
export function visionConfigDir(): string {
	return process.env.PIDECK_VISION_CONFIG_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * 输入白名单校验：只允许写入已知字段，长度/枚举/范围限制。
 *
 * requireModel 区分两条路径：
 * - 保存（saveConfig，默认 true）：开启状态必须有模型；关闭状态（enabled:false）
 *   允许空 provider/model——「关掉视觉桥」本身就是要保存的目标，拒绝会导致用户
 *   关不掉（2026-08 反馈「存不了，强制开启的」）。
 * - 读取（getConfig，传 false）：只解析不要求模型。否则关闭状态的文件（enabled:false
 *   无模型）会被当成非法返回 null，UI 回退默认草稿（enabled:true）→ 显示成强制开启。
 */
function sanitizeConfig(input: unknown, requireModel = true): VisionBridgeConfig | null {
	if (typeof input !== "object" || input === null) return null;
	const raw = input as Record<string, unknown>;

	const provider = typeof raw.provider === "string" ? raw.provider.trim().slice(0, 128) : "";
	const model = typeof raw.model === "string" ? raw.model.trim().slice(0, 128) : "";
	const enabled = raw.enabled === false ? false : true;
	// 开启状态必须有模型（无模型视觉桥无法工作）；关闭状态允许空模型
	if (enabled && requireModel && (!provider || !model)) return null;

	const next: VisionBridgeConfig = {
		enabled,
		provider,
		model,
	};

	// api 枚举白名单，非法值忽略（由扩展按 provider 推断）
	if (raw.api === "openai-completions" || raw.api === "anthropic-messages" || raw.api === "google-generative-ai") {
		next.api = raw.api;
	}
	// baseUrl 必须 http(s)，防止写入任意协议路径
	if (typeof raw.baseUrl === "string" && /^https?:\/\/[^\s]+$/i.test(raw.baseUrl.trim())) {
		next.baseUrl = raw.baseUrl.trim().slice(0, 512);
	}
	// apiKey 允许留空（复用 pi auth）；有值则限长防爆文件
	if (typeof raw.apiKey === "string" && raw.apiKey.trim()) {
		next.apiKey = raw.apiKey.trim().slice(0, 512);
	}

	// 数值字段：合法值直接采用；缺失/非法时落盘默认值。
	// 配置文件是扩展运行时唯一来源（用户可脱离 UI 手改文件），必须自解释——
	// 否则文件里看不到 maxTokens/concurrency，用户会误以为没保存（与 promptTemplate 永远落盘同一理由）。
	// maxTokens 允许 0（不限制，请求不传该字段），上限 32768；其余数值字段最小 1。
	const intField = (value: unknown, max: number, allowZero = false): number | undefined => {
		if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
		const n = Math.trunc(value);
		return (allowZero ? n >= 0 : n > 0) && n <= max ? n : undefined;
	};
	const maxTokens = intField(raw.maxTokens, 32_768, true);
	next.maxTokens = maxTokens ?? VISION_DEFAULT_CONFIG.maxTokens;
	const timeoutMs = intField(raw.timeoutMs, 300_000);
	next.timeoutMs = timeoutMs ?? VISION_DEFAULT_CONFIG.timeoutMs;
	const concurrency = intField(raw.concurrency, 16);
	next.concurrency = concurrency ?? VISION_DEFAULT_CONFIG.concurrency;

	if (typeof raw.promptTemplate === "string" && raw.promptTemplate.trim()) {
		// 去首尾空白后截断，避免误存换行噪音/超长模板
		next.promptTemplate = raw.promptTemplate.trim().slice(0, 4_000);
	}
	// 模板永远落盘：用户没填时写默认模板，之后直接编辑配置文件即可生效（不依赖扩展代码）
	next.promptTemplate = next.promptTemplate ?? VISION_DEFAULT_PROMPT;
	return next;
}

export class VisionBridgeConfigManager {
	constructor(private readonly configManager: ConfigManager) {}

	/** 读取当前配置；文件缺失或非法返回 null（与扩展的静默放行语义一致）。
	 * 读取不要求模型（requireModel=false）：关闭状态（enabled:false 无模型）是
	 * 合法配置，必须原样读回，否则 UI 会回退默认开启（「强制开启」假象）。 */
	async getConfig(): Promise<VisionBridgeConfig | null> {
		try {
			const filePath = join(visionConfigDir(), CONFIG_FILE_NAME);
			const raw = await readFile(filePath, "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null) return null;
			// 直接返回文件内容（已由保存路径校验过），不做二次裁剪，避免 UI 显示与文件不一致
			return sanitizeConfig(parsed, false);
		} catch {
			return null;
		}
	}

	/** 保存配置：白名单校验后写回 ~/.pi/agent/pi-deck-vision.json。
	 * 用户未显式填 apiKey/baseUrl 时，从 pi models.json 解析该 provider 的 inline 配置
	 * （PiDeck「配置模型」页把 key 存在 models.json 的 provider.apiKey，auth.json 里没有），
	 * 保证扩展脱离 PiDeck 单独跑也能直接读取，无需用户重复填写。
	 */
	async saveConfig(input: unknown): Promise<VisionSaveResult> {
		const next = sanitizeConfig(input);
		if (!next) {
			return { ok: false, error: "provider/model 必填，或字段非法" };
		}
		// 未显式填写的 key/baseUrl 从 models.json 的 provider 配置补齐（仅当缺失时）；
		// provider 本身是 URL（如 https://open.mwy.asia 这类网关）时直接作为 baseUrl，
		// 保证扩展脱离 PiDeck 单独跑也能解析端点。
		if (!next.apiKey || !next.baseUrl) {
			try {
				const modelsResult = await this.configManager.getModelsConfig();
				const provider = (modelsResult.parsed as { providers?: Record<string, { apiKey?: string; baseUrl?: string }> } | undefined)?.providers?.[next.provider];
				if (provider) {
					if (!next.apiKey && provider.apiKey) next.apiKey = provider.apiKey;
					if (!next.baseUrl && provider.baseUrl) next.baseUrl = provider.baseUrl;
				}
			} catch {
				// models.json 解析失败不影响保存：用户手动填的字段仍会写入
			}
			if (!next.baseUrl && /^https?:\/\/[^\s]+$/i.test(next.provider)) {
				next.baseUrl = next.provider.replace(/\/+$/, "");
			}
		}
		try {
			const dir = visionConfigDir();
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify(next, null, 2), "utf8");
			// 视觉桥配置含 apiKey 敏感写：只记 provider 与是否携带 key，不记 key 值
			void getAppLogger()?.info("vision", "Vision config saved", {
				provider: (next as { provider?: string }).provider,
				hasApiKey: Boolean((next as { apiKey?: string }).apiKey),
			});
			return { ok: true };
		} catch (error) {
			void getAppLogger()?.error("vision", "Vision config save failed", {
				provider: (next as { provider?: string }).provider,
				error: error instanceof Error ? error.message : String(error),
			});
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** 组装设置页初始数据：当前配置 + 配置文件目录（模型列表由 UI 经 listModels 拉全量）。 */
	async getState(): Promise<VisionBridgeState> {
		return {
			config: await this.getConfig(),
			configDir: visionConfigDir(),
		};
	}

	/** 读取扩展运行日志（诊断用）：文件不存在返回空记录，超限只取尾部。 */
	async getLog(): Promise<VisionLogInfo> {
		const filePath = join(visionConfigDir(), LOG_FILE_NAME);
		try {
			const info = await stat(filePath);
			const data = await readFile(filePath, "utf8");
			const truncated = data.length > MAX_LOG_RETURN_BYTES;
			return {
				exists: true,
				size: info.size,
				content: truncated ? data.slice(-MAX_LOG_RETURN_BYTES) : data,
				truncated,
			};
		} catch {
			// 文件不存在或不可读：返回空记录，UI 显示“暂无运行记录”
			return { exists: false, size: 0, content: "", truncated: false };
		}
	}

	/** 清空运行日志（删除文件，下次写入自动重建）。 */
	async clearLog(): Promise<{ ok: boolean }> {
		try {
			await rm(join(visionConfigDir(), LOG_FILE_NAME), { force: true });
			getAppLogger()?.info("vision", "Vision run log cleared", {});
			return { ok: true };
		} catch {
			return { ok: false };
		}
	}

	/** 读取结构化转换事件（JSONL 尾部，坏行跳过）：会话渲染层展开「请求详情」用。
	 * 事件不含 apiKey/baseUrl，只有模型名/耗时/token/描述截断。 */
	async getEvents(limit = 200): Promise<VisionEventsInfo> {
		const filePath = join(visionConfigDir(), EVENT_FILE_NAME);
		try {
			const info = await stat(filePath);
			const data = await readFile(filePath, "utf8");
			// 只解析尾部行：文件可能被扩展截断过，也可能单行超大（描述截断 400 字符，可控）
			const lines = data.split("\n").filter(Boolean).slice(-limit);
			const events: VisionBridgeEvent[] = [];
			for (const line of lines) {
				try {
					const parsed = JSON.parse(line) as VisionBridgeEvent;
					if (parsed && typeof parsed.ts === "number" && Array.isArray(parsed.items)) {
						events.push(parsed);
					}
				} catch {
					// 半截行/坏行跳过（扩展截断文件时可能产生）
				}
			}
			return {
				exists: true,
				size: info.size,
				events,
				truncated: data.length > MAX_EVENT_RETURN_BYTES,
			};
		} catch {
			// 文件不存在或不可读：从未转换过图片
			return { exists: false, size: 0, events: [], truncated: false };
		}
	}

	/** 清空事件文件（删除文件，下次写入自动重建）。 */
	async clearEvents(): Promise<{ ok: boolean }> {
		try {
			await rm(join(visionConfigDir(), EVENT_FILE_NAME), { force: true });
			getAppLogger()?.info("vision", "Vision events cleared", {});
			return { ok: true };
		} catch {
			return { ok: false };
		}
	}
}
