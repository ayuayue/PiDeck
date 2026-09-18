import type { ImageContent } from "./session";
import type { ImageGenConfigFile } from "../imageGenConfig";

export type { ImageGenConfigFile, ImageGenProviderConfig, ImageGenProviderExtraParams } from "../imageGenConfig";

/**
 * 生图请求：凭据来自独立 imagegen.json，不再读 pi models.json。
 * provider 是生图配置里的供应商 id（不是会话 LLM provider）。
 */
export type ImageGenRequest = {
	/** 生图供应商 id（imagegen.json providers[].id）；空则用上次选中的 */
	provider: string;
	/** 生图模型 id */
	model: string;
	/** 提示词 */
	prompt: string;
	/** 可选：所属会话 id。提供时生图结果会以 user+assistant 消息落盘到该会话的 pi 文件。 */
	sessionId?: string;
	/** 尺寸：官方 size。仅供应商勾选 extraParams.size 时发送 */
	size?: string;
	/** 水印：官方 watermark。仅勾选 extraParams.watermark 时发送 */
	watermark?: boolean;
	/** 文件编码：官方 output_format。仅勾选 extraParams.output_format 时发送 */
	outputFormat?: string;
	/**
	 * 参考图（base64，与聊天附件同构）。是否可用由供应商 referenceMode 决定：
	 * none 时主进程直接拒绝，不发无效 API 请求。
	 */
	referenceImages?: ImageContent[];
};

/**
 * 生图失败错误码（主进程只回结构化错误码，文案由渲染层 i18n 映射，避免跨层硬编码）。
 */
export type ImageGenErrorCode =
	/** 独立生图配置缺少供应商 / baseUrl / apiKey / 模型 */
	| "notConfigured"
	/** API Key 无效（401/403） */
	| "invalidKey"
	/** baseUrl 不对（404/405 等） */
	| "badBaseUrl"
	/** 网络不可达/代理问题 */
	| "network"
	/** 服务端返回其他错误（detail 携带状态码 + 厂商错误正文） */
	| "http"
	/** 响应体超过 32MB 上限（主进程流式读取提前中止，防内存放大） */
	| "responseTooLarge"
	/** 响应里没有图片数据 */
	| "empty"
	/** 供应商声明为不支持参考图（referenceMode=none）却附了参考图 */
	| "referenceUnsupported";

/** 生图结果：ok=true 时 image 为可直接进附件栏的 base64 图片 */
export type ImageGenResult =
	| { ok: true; image: ImageContent }
	| { ok: false; error: ImageGenErrorCode; detail?: string };

/**
 * 生图消息的渲染元数据（存在 ChatMessage.meta.imageGen）：
 * 生图结果以「消息」形式上屏，同一条 assistant 消息随生成进度在
 * generating（点阵动画）→ complete（图片清晰过渡）→ error 之间切换。
 */
export type ImageGenMeta = {
	status: "generating" | "complete" | "error";
	/** 触发生图的提示词（渲染层展示引用） */
	prompt: string;
	/** 实际请求的尺寸；历史消息用它恢复右上角尺寸标记。 */
	size?: string;
	/** 失败时的详细错误文案（已 i18n），status=error 时展示 */
	errorDetail?: string;
};

export type ImageGenSaveResult =
	| { ok: true; config: ImageGenConfigFile }
	| { ok: false; error: string };

/**
 * 按需取回的落盘图片字节（imagegen:read-image-blob）。
 * 历史生图消息只带 ref 引用，展示交给 pideck-img:// 协议流式加载；
 * 只有「复制 / 保存 / 重发带回参考图」这类确需字节的路径才走这个通道。
 */
export type ImageBlobPayload = {
	/** base64 图片数据（不含 data URL 前缀） */
	data: string;
	mimeType: string;
};
