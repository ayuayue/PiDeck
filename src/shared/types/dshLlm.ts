/** DSH host llm.discoverModels request passed across the IPC boundary. */
export type DshModelDiscoveryInput = {
	/** DSH settings namespace that owns the provider adapter. */
	settingsNs: string;
	/** Provider route currently being edited; omit for a new/unregistered route. */
	provider?: string;
	/** Draft endpoint/protocol values. */
	baseURL?: string;
	api?: string;
	/** One-shot draft credential; DSH never stores or returns it. */
	apiKey?: string;
};

/** One input modality DSH adapters may declare for a model. */
export type DshModelModality = "text" | "image";

/** Candidate model metadata returned by DSH llm.discoverModels. */
export type DshDiscoveredModel = {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	/**
	 * 适配器目录 / 端点声明的输入模态（dsh-llm 的 `LlmDiscoveredModel.inputModalities`）。
	 * 必须原样带到配置页：丢掉后新增模型会退化成纯文本，DSH 在 prompt 准入阶段直接
	 * 拒绝带图消息（session/attachment-invalid / MODEL_DOES_NOT_SUPPORT_IMAGES）。
	 */
	inputModalities?: readonly DshModelModality[];
};
