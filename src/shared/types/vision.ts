/**
 * 视觉桥（Vision Bridge）共享契约。
 *
 * 用途：给 DeepSeek 等无视觉模型“装眼睛”——pi 收到图片时，由
 * pi-deck-vision 扩展调用用户配置的视觉模型生成文字描述，再替换进上下文。
 *
 * 注意：扩展 resources/extensions/pi-deck-vision.ts 是自包含单文件（打包后
 * 无法 import src/shared），内部同名类型需与此处保持字段一致；改字段时两处同步。
 */

/** 视觉模型 API 格式（与 pi models.json 的 provider.api 约定一致）。 */
export type VisionApiKind = "openai-completions" | "anthropic-messages" | "google-generative-ai";

/** 视觉桥配置（写入 ~/.pi/agent/pi-deck-vision.json，与扩展读取的字段一一对应）。 */
export type VisionBridgeConfig = {
	/** 总开关，false 时扩展放行原图 */
	enabled: boolean;
	/** 视觉模型所属 provider（必须与 pi 已配置的 provider 同名，用于复用 key） */
	provider: string;
	/** 视觉模型 id，如 glm-4v-flash / gpt-4o-mini */
	model: string;
	/** 显式指定 API 格式；缺省按 provider.api 推断，再缺省 openai-completions */
	api?: VisionApiKind;
	/** 覆盖 baseUrl；缺省用 provider auth 或内置默认端点 */
	baseUrl?: string;
	/** 覆盖 apiKey；缺省复用 pi 已配置的 provider key（不落日志） */
	apiKey?: string;
	/** 单次描述最大输出 token；0 = 不限制（不传该字段，输出长度交给模型默认；
	 *  Anthropic 接口该字段必填，不限制时请求自动兜底 1024）。缺省（undefined）同 0。 */
	maxTokens?: number;
	/** 单次视觉请求超时 ms（默认 120000） */
	timeoutMs?: number;
	/** 并发描述数（默认 2） */
	concurrency?: number;
	/** 描述提示词模板，{{instruction}} 为原指令占位 */
	promptTemplate?: string;
};

/** 视觉桥配置保存结果（IPC 边界返回结构化错误，不抛裸异常）。 */
export type VisionSaveResult = {
	ok: boolean;
	error?: string;
};

/** 视觉桥设置页初始数据：当前配置 + 配置文件目录。
 * 可选模型列表由设置页经 projects.listModels 获取（全量：models.json + auth.json + 内置目录）。 */
export type VisionBridgeState = {
	config: VisionBridgeConfig | null;
	/** 配置文件所在目录（~/.pi/agent/ 或环境变量覆盖），UI 展示用 */
	configDir: string;
};

/** 视觉桥运行日志（扩展 pi-deck-vision.ts 写入 pi-deck-vision.log，设置页诊断用）。
 * 日志内容只含事件名/图片数/状态码/耗时，绝不含 apiKey/baseUrl。 */
export type VisionLogInfo = {
	/** 日志文件是否存在（从未转换过图片时可能不存在） */
	exists: boolean;
	/** 文件字节数 */
	size: number;
	/** 日志文本；过大时只返回尾部并标记 truncated */
	content: string;
	truncated: boolean;
};

/** 单张图片的转换结果（扩展事件文件中的条目，字段与扩展侧 VisionEventItem 一致）。 */
export type VisionEventItem = {
	/** 图片在本次转换中的序号（1 起，与消息文本「图片 #N」同源） */
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

/** 一次转换批次事件（事件文件中的一行 JSON）。 */
export type VisionBridgeEvent = {
	ts: number;
	/** 转换来源：input=用户发图 / tool_result=工具读图 / request=provider payload 兜底 */
	kind: "input" | "tool_result" | "request";
	/** provider/model，如 "deepseek/deepseek-chat" */
	model: string;
	/** 提示词模板（截断，展示用） */
	prompt: string;
	/** 本批总耗时 ms */
	totalDurationMs: number;
	items: VisionEventItem[];
};

/** 事件读取结果（IPC 边界返回结构化数据，坏行跳过、超限截尾）。 */
export type VisionEventsInfo = {
	exists: boolean;
	size: number;
	events: VisionBridgeEvent[];
	truncated: boolean;
};
