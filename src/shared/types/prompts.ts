// ── pi Prompt Templates ─────────────────────────────────────────────────

/** pi Prompt Template，对应 ~/.pi/agent/prompts/<name>.md */
export type PiPromptTemplateSummary = {
	name: string;
	path: string;
	description: string;
	content: string;
	userCreated: boolean;
	/** 模板范围：global (~/.pi/agent/prompts/) 或 project (.pi/prompts/) */
	scope?: "global" | "project";
	/** 是否启用（未在 PiDeck settings 的 disabledPrompts 列表中）；缺省视为启用 */
	enabled?: boolean;
};

/**
 * 运行时提示词模板正文（来自 pi 的 `get_commands` 登记路径）。
 *
 * 与 `PiPromptTemplateSummary` 的区别：这条通道覆盖 **pi 实际加载的全部模板**——用户目录、
 * 项目目录以及已安装 npm 包声明的 `pi.prompts`；PiDeck 的 prompts:list 只看前两者。
 * 渲染层把两者合并后，`/<模板名>` 才能在发送前本地展开、把模板名写进会话文件。
 */
export type RuntimePromptTemplate = { name: string; content: string; description?: string };

export type PiPromptTemplateListResult = {
	templates: PiPromptTemplateSummary[];
	globalDir: string;
};

export type CreatePiPromptTemplateInput = {
	name: string;
	description: string;
};

// ── Prompt Store (prompts.chat) ─────────────────────────────────────────

/** prompts.chat API 返回的原始 prompt 条目（完整字段） */
export interface PromptStoreRawItem {
	id: string;
	title: string;
	slug: string;
	description: string;
	content: string;
	type: string;
	author: { id: string; name: string; username: string; avatar?: string; verified?: boolean };
	category: { id: string; name: string; slug: string } | null;
	tags: Array<{ promptId: string; tagId: string; tag: { id: string; name: string; slug: string; color?: string } }>;
	voteCount: number;
	viewCount: number;
	createdAt: string;
}

/** UI 消费的扁平化 prompt 条目 */
export interface PromptStoreItem {
	id: string;
	title: string;
	description: string;
	content: string;
	type: string;
	author: string;
	category: string;
	tags: string[];
	votes: number;
	createdAt: string;
}

/** prompts.chat REST API 搜索响应（/api/prompts?q=...） */
export interface PromptStoreSearchResponse {
	prompts: PromptStoreRawItem[];
	total: number;
	page: number;
	perPage: number;
	totalPages: number;
}

/** IPC 返回给渲染进程的搜索结果 */
export interface PromptStoreSearchResult {
	query: string;
	count: number;
	prompts: PromptStoreItem[];
}

export type PromptStoreSearchType = "TEXT" | "STRUCTURED" | "IMAGE" | "VIDEO" | "AUDIO";

// ── Yao Open Prompts（中文提示词精选） ─────────────────────────────────

export type YaoPromptCategory = {
	slug: string;
	name: string;
	count: number;
};

export type YaoPromptItem = {
	/** 文件名（不含 .md） */
	slug: string;
	title: string;
	category: string;
	subcategory: string;
	tags: string[];
	description: string;
	/** 文件绝对路径 */
	path: string;
};

/**
 * 提示词库 db 的就绪状态（安装包不再内置 db，首次使用需远程拉取）。
 * ready=本地有库（缓存或仓库副本）；其余仅出现在 list 结果里，prompts 为空，
 * 渲染层据此显示下载进度/重试引导。
 */
export type YaoPromptDbState = "ready" | "missing" | "downloading" | "failed";

/** db 就绪状态推送负载（main→renderer 事件与重试返回值共用；见 XuePromptDbStore）。 */
export type YaoPromptDbSnapshot = { state: "ready"; path: string; sha256: string | null; source: "cache" | "repo" } | { state: "downloading"; receivedBytes: number; totalBytes: number | null } | { state: "failed"; message: string } | { state: "missing" };

/**
 * 商店列表查询参数（主/渲染共用）。
 * categoriesOnly：只要分类栏数据。商店首次打开只为渲染分类 chip，却按「无参 = 全量」
 * 把整库条目（实测 4012 条 ≈0.9MB JSON）拉一遍，主进程还要逐条 gunzip 描述——见
 * XuePromptManager.list 的分类快路径。
 */
export type YaoPromptListOptions = {
	category?: string;
	search?: string;
	page?: number;
	pageSize?: number;
	categoriesOnly?: boolean;
};

export type YaoPromptListResult = {
	categories: YaoPromptCategory[];
	prompts: YaoPromptItem[];
	repoPath: string;
	total?: number;
	page?: number;
	pageSize?: number;
	/** db 就绪状态；缺省视为 ready（旧客户端兼容：不认识该字段时行为不变） */
	dbState?: YaoPromptDbState;
};

export type YaoPromptDetailResult = {
	title: string;
	description: string;
	promptContent: string;
	fullContent: string;
};
