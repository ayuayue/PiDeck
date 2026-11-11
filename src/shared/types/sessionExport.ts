/** 安全分享只处理 PiDeck 的本地 pi / DSH 投影视图，不表示官方完整导出已脱敏。 */
export type SessionShareOptions = {
	excludeThinking: boolean;
	excludeToolArguments: boolean;
	excludeToolResults: boolean;
	excludeImages: boolean;
	excludeSystemMessages: boolean;
	excludeWorkspace: boolean;
	redactSecrets: boolean;
	redactPaths: boolean;
};

export const DEFAULT_SESSION_SHARE_OPTIONS: Readonly<SessionShareOptions> = {
	excludeThinking: true,
	excludeToolArguments: true,
	excludeToolResults: true,
	excludeImages: true,
	excludeSystemMessages: true,
	excludeWorkspace: true,
	redactSecrets: true,
	redactPaths: true,
};

/** 只传计数，不把被排除的原文送入预览或诊断日志。 */
export type SessionShareInventory = {
	messages: number;
	thinking: number;
	toolArguments: number;
	toolResults: number;
	images: number;
	systemMessages: number;
	workspace: boolean;
};

export type SessionSharePreview = {
	previewId: string;
	backend: "pi" | "dsh";
	html: string;
	inventory: SessionShareInventory;
	redactedFields: number;
	truncated: boolean;
};

export type SessionSharePrepareInput = { sessionId: string; options: SessionShareOptions };
export type SessionShareResult<T> = { ok: true; value: T } | { ok: false; error: string };
