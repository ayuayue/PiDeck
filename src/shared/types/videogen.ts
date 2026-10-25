import type { VideoGenConfigFile } from "../videoGenConfig";

export type { VideoGenConfigFile, VideoGenProviderConfig, VideoGenProtocolFamily } from "../videoGenConfig";

/**
 * 视频生成提交请求。与生图（同步等待结果）不同：视频是「提交-轮询-下载」异步协议，
 * submit 只拿到 jobId，产物经 pideck-video:// 协议流式加载，永远不把视频字节搬进 IPC。
 */
export type VideoGenRequest = {
	/** 生视频供应商 id（videogen.json providers[].id）；空则用上次选中的 */
	provider: string;
	/** 生视频模型 id */
	model: string;
	/** 提示词 */
	prompt: string;
	/** 渲染层预先上屏的占位消息 id：传入时主进程快照/落盘沿用它，事件才能原地命中同一条消息 */
	messageId?: string;
	/** 可选：所属会话 id。提供时占位/结果消息会落盘到该会话的 VideoSessionStore。 */
	sessionId?: string;
	/** 分辨率（如 480P / 720p），按协议族方言原样透传 */
	resolution?: string;
	/** 时长秒数（字符串形态进配置，提交体按协议转数字） */
	duration?: string;
	/** 画幅比例（如 16:9 / adaptive） */
	ratio?: string;
};

/** 提交结果：ok=true 只代表任务已受理，产物要等轮询事件。 */
export type VideoGenSubmitResult = { ok: true; jobId: string; messageId: string } | { ok: false; error: VideoGenErrorCode; detail?: string };

/**
 * 生视频失败错误码（主进程只回结构化错误码，文案由渲染层 i18n 映射）。
 * 与 ImageGenErrorCode 同构，多出轮询/下载两段特有失败。
 */
export type VideoGenErrorCode =
	/** 独立生视频配置缺少供应商 / baseUrl / apiKey / 模型 */
	| "notConfigured"
	/** API Key 无效（401/403） */
	| "invalidKey"
	/** baseUrl 不对（404/405 等） */
	| "badBaseUrl"
	/** 网络不可达/代理问题 */
	| "network"
	/** 服务端返回其他错误（detail 携带状态码 + 厂商错误正文） */
	| "http"
	/** 提交响应里没有 task_id */
	| "empty"
	/** 轮询超时（超过硬上限仍未成功） */
	| "timeout"
	/** 任务成功但产物下载/落盘失败 */
	| "downloadFailed"
	/** 任务被上游标记失败（detail 带厂商原因） */
	| "generationFailed"
	/** 任务被本地取消（停止轮询；上游可能继续执行与计费） */
	| "cancelled";

/** 轮询统一的任务状态（各协议族方言在适配器里归一到这里）。 */
export type VideoGenJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timeout";

/** 主进程推给渲染层的任务快照（videogen:on-job 事件 / list-jobs 返回）。 */
export type VideoGenJobSnapshot = {
	jobId: string;
	sessionId: string;
	provider: string;
	providerName: string;
	model: string;
	prompt: string;
	resolution?: string;
	duration?: string;
	ratio?: string;
	status: VideoGenJobStatus;
	/** 成功后视频 blob 引用名（<sha256>.mp4/.webm）；失败/进行中无 */
	videoRef?: string;
	/** 失败原因（已脱敏截断的厂商正文，渲染层直接展示） */
	errorDetail?: string;
	/** 提交时间戳（ms） */
	createdAt: number;
	/** 终态时间戳（ms） */
	finishedAt?: number;
	/** 关联的 assistant 占位消息 id（渲染层按它原地更新时间线） */
	messageId: string;
};

/**
 * 生视频消息的渲染元数据（存在 ChatMessage.meta.videoGen）：
 * 与 ImageGenMeta 同构，多出 jobId（事件回流时按它对账）。
 */
export type VideoGenMeta = {
	status: "queued" | "generating" | "complete" | "error";
	/** 触发生视频的提示词（渲染层展示引用） */
	prompt: string;
	/** 任务 id：事件/重启对账的身份 */
	jobId?: string;
	/** 实际请求的分辨率；历史消息用它恢复徽标 */
	resolution?: string;
	/** 实际请求的时长（秒） */
	duration?: string;
	/** 实际请求的画幅 */
	ratio?: string;
	/** 失败时的详细错误文案（已 i18n），status=error 时展示 */
	errorDetail?: string;
	/** 成功时视频引用名；渲染层经 pideck-video:// 解析成 <video src> */
	videoRef?: string;
};

export type VideoGenSaveResult = { ok: true; config: VideoGenConfigFile } | { ok: false; error: string };

/**
 * 会话消息里的视频内容（ChatMessage.videos）。与 ImageContent 的差别：
 * 视频从下载起就只以落盘 ref 形态存在，没有 base64 内联形态——「base64 不进
 * IPC/JSONL」在生视频域是构造性保证，不是事后约束。
 */
export type VideoContent = {
	type: "video";
	/** userData/videogen/blobs 下的内容寻址文件名 */
	ref: string;
	mimeType: string;
	/** 展示时长（秒，可选；下载阶段尽力探测） */
	seconds?: number;
};
