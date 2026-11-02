/**
 * 智能体记忆（`pideck-agent-memory`）的设置页契约。
 *
 * 这些类型只描述**宿主进程给渲染层的只读视图**；真正的读写语义在
 * `resources/agent-memory/*.mjs`（MCP 服务器）里，两边共用同一份文件与索引。
 */

export interface AgentMemoryFileStat {
	/** 相对记忆根目录的位置；项目作用域形如 `projects/<key>/MEMORY.md`。 */
	name: string;
	bytes: number;
	entries: number;
	/** 注入预算；`null` 表示这份文件不参与预算（项目/设备作用域只在检索时出现）。 */
	budget: { maxChars: number; maxEntries: number } | null;
}

export interface AgentMemoryStatus {
	/** 记忆根目录（userData/memory）；显示给用户前渲染层负责省略号截断。 */
	root: string;
	/** Markdown 总字节数（不含索引库）。 */
	totalBytes: number;
	indexBytes: number;
	files: AgentMemoryFileStat[];
	index: { entries: number; sessions: number; messages: number } | null;
	/** 索引不可用时的原因码（`node:sqlite` 缺失、库损坏等）。 */
	indexError: string | null;
	/** 本机设备档案：导出包用它标注来源。 */
	device: { id: string; name: string };
	/** 自动学习循环的可见性摘要（设置页「上次学习」行）。 */
	learn: { sessions: number; lastAt: string | null };
}

/** 条目所在作用域：全局四份文件 / `projects/<键>/` / `devices/<键>/`。 */
export type AgentMemoryEntryScope = "global" | "project" | "device";

export interface AgentMemoryEntry {
	/** 文件内序号（1 起）；删除按 `key` 定位。 */
	index: number;
	target: "memory" | "user" | "failure" | "standing";
	scope: AgentMemoryEntryScope;
	/** 作用域 id（全局为空串）；设备作用域形如 `device:<键>`。 */
	projectId: string;
	/** 展示名：项目名、设备短键或空串。 */
	projectName: string;
	/** 规范化内容键（去重/墓碑同口径）。 */
	key: string;
	/** 导出弹窗的勾选键（由 `sync.mjs` 的 `exportEntryId` 按语义内容算出）。 */
	exportId: string;
	content: string;
	chars: number;
	/** `failure` 的分类；其他目标为空串。 */
	category: string;
}

export interface AgentMemoryEntryGroup {
	target: AgentMemoryEntry["target"];
	scope: AgentMemoryEntryScope;
	projectId: string;
	projectName: string;
	/** 相对记忆根目录的文件位置。 */
	file: string;
	bytes: number;
	/** 全局四份文件有注入预算；项目/设备作用域没有。 */
	budget: { maxChars: number; maxEntries: number } | null;
	chars: number;
	entries: AgentMemoryEntry[];
}

export interface AgentMemoryEntryList {
	root: string;
	total: number;
	groups: AgentMemoryEntryGroup[];
}

export interface AgentMemoryExportOutcome {
	canceled: boolean;
	/** 用户取消时没有路径。 */
	path?: string;
	entries?: number;
}

export interface AgentMemoryImportResult {
	canceled?: boolean;
	added: number;
	duplicate: number;
	tombstoned: number;
	rejected: number;
	removed: number;
	/** 同首行冲突被包内版本替换掉的条数（只有 `conflictPolicy: "overwrite"` 会非零）。 */
	replaced: number;
	scopes: string[];
	/** 包内标注的来源设备名（旧包可能为空）。 */
	device: string;
}

/** 包内一条记忆在本机的处境。 */
export type AgentMemoryBundleEntryStatus = "new" | "duplicate" | "conflict" | "tombstoned" | "invalid";

export interface AgentMemoryBundleEntryPreview {
	/** 跨机器身份（由内容算出）；`invalid` 条目为空串。 */
	id: string;
	/** 落盘目标（`memory` / `user` / `failure` / `standing`）；`invalid` 条目为空串。 */
	target: string;
	/** `global` 或 `project`。 */
	scope: string;
	/** 项目作用域键；全局为空串。 */
	projectId: string;
	content: string;
	category: string;
	status: AgentMemoryBundleEntryStatus;
	/** `invalid` 的原因码（`device-scope` / `unsafe-content` / `entry-invalid`）。 */
	reason: string;
	/** 本地对应的那条：`duplicate` 是同一条原文，`conflict` 是待替换的旧版本。 */
	localContent: string;
}

export interface AgentMemoryBundleTombstonePreview {
	target: string;
	projectId: string;
	at: string;
	/** 本地还留着的同一条内容；空串表示本地已经没有了。 */
	localContent: string;
}

export interface AgentMemoryBundlePreview {
	exportedAt: string;
	device: string;
	entries: AgentMemoryBundleEntryPreview[];
	counts: { total: number; new: number; duplicate: number; conflict: number; tombstoned: number; invalid: number };
	tombstones: AgentMemoryBundleTombstonePreview[];
}

/** 选包结果：用户取消时只有 `canceled`。 */
export type AgentMemoryBundlePeekOutcome = { canceled: true } | { canceled: false; filePath: string; preview: AgentMemoryBundlePreview };

export interface AgentMemoryImportOptions {
	/** 已选好的包路径（导入弹窗确认时回传，免二次弹框）。 */
	filePath?: string;
	/** 只导入这些条目 id；`null`/省略 = 全部。 */
	selection?: string[] | null;
	/** 同首行冲突策略：`append` 都留（默认）/ `overwrite` 替换本地那条。 */
	conflictPolicy?: "append" | "overwrite";
	/** 是否按包内墓碑同步删除本地条目（默认 true）。 */
	applyTombstones?: boolean;
}

/** 统一结果信封：错误只以稳定码跨进程，不带本机路径。 */
export type AgentMemoryResult<T> = { ok: true; value: T } | { ok: false; code: string };
