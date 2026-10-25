// ── Codex Session Import Types ─────────────────────────────────────────

export type CodexImportStatus = "new" | "current" | "outdated";

export type CodexSessionSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	cwd: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: CodexImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
	threadSource?: "user" | "subagent";
	parentThreadId?: string;
	agentRole?: string;
	agentNickname?: string;
};

export type CodexImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type CodexImportReport = {
	results: CodexImportResult[];
	imported: number;
	failed: number;
};

// ── Claude Session Import Types ────────────────────────────────────────

export type ClaudeImportStatus = "new" | "current" | "outdated";

export type ClaudeSessionSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	cwd: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: ClaudeImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
};

export type ClaudeImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type ClaudeImportReport = {
	results: ClaudeImportResult[];
	imported: number;
	failed: number;
};

// ── Qoder Session Import Types ─────────────────────────────────────────
// Qoder 与 Claude 同构（导入器直接复用其管线），汇总结构与 Claude 一致。

export type QoderImportStatus = "new" | "current" | "outdated";

export type QoderSessionSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	cwd: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: QoderImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
};

export type QoderImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type QoderImportReport = {
	results: QoderImportResult[];
	imported: number;
	failed: number;
};

// ── OpenCode Session Import Types ──────────────────────────────────────

export type OpenCodeImportStatus = "new" | "current" | "outdated";

export type OpenCodeSessionSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	cwd: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: OpenCodeImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
};

export type OpenCodeImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type OpenCodeImportReport = {
	results: OpenCodeImportResult[];
	imported: number;
	failed: number;
};

// ── ZCode Session Import Types ────────────────────────────────────────

/** zcode 会话导入状态：未导入 / 已是最新 / 源更新后可覆盖。 */
export type ZCodeImportStatus = "new" | "current" | "outdated";

export type ZCodeSessionSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	cwd: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: ZCodeImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
};

export type ZCodeImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type ZCodeImportReport = {
	results: ZCodeImportResult[];
	imported: number;
	failed: number;
};

// ── WorkBuddy Session Import Types ─────────────────────────────────────

/** WorkBuddy 会话导入状态：未导入 / 已是最新 / 源更新后可覆盖。 */
export type WorkBuddyImportStatus = "new" | "current" | "outdated";

export type WorkBuddySessionSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	cwd: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: WorkBuddyImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
};

export type WorkBuddyImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type WorkBuddyImportReport = {
	results: WorkBuddyImportResult[];
	imported: number;
	failed: number;
};

// ── Cursor Session Import Types ────────────────────────────────────────

/** Cursor 会话导入状态：未导入 / 已是最新 / 源更新后可覆盖。 */
export type CursorImportStatus = "new" | "current" | "outdated";

export type CursorSessionSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	cwd: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: CursorImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
};

export type CursorImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type CursorImportReport = {
	results: CursorImportResult[];
	imported: number;
	failed: number;
};

// ── Kimi Code Session Import Types ─────────────────────────────────────

/** Kimi Code 会话导入状态：未导入 / 已是最新 / 源更新后可覆盖。 */
export type KimiImportStatus = "new" | "current" | "outdated";

export type KimiSessionSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	cwd: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: KimiImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
};

export type KimiImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type KimiImportReport = {
	results: KimiImportResult[];
	imported: number;
	failed: number;
};

// ── Directory (外置目录) Session Import Types ──────────────────────────
// Kimi Work（桌面版）与 Kimi Code（CLI）是两个独立的数据源：
// - 数据目录（daimon-share）位置不固定：默认 %APPDATA%/kimi-desktop/daimon-share，
//   也可能被用户自定义到任意盘符（如 D:\KimiData\daimon-share），实际位置记录在
//   %APPDATA%/kimi-desktop/daimon-storage.json 的 shareDir 字段。
// - 会话索引在 conversations.sqlite（而不是 session_index.jsonl），正文 wire.jsonl
//   的助手输出只存在于 context.append_loop_event 事件流（CLI 版是快照式记录）。

/** Kimi Work 会话导入状态：未导入 / 已是最新 / 源更新后可覆盖。 */
export type KimiWorkImportStatus = "new" | "current" | "outdated";

/** Kimi Work 数据目录的来源：用户在 PiDeck 里显式指定 / Kimi 配置文件里记录的自定义位置 / 默认安装位置。 */
export type KimiWorkShareRootOrigin = "settings" | "app-config" | "default";

/** Kimi Work 数据目录探测结果（导入弹窗展示 + 导入器共用）。 */
export type KimiWorkShareRootInfo = {
	/** daimon-share 根目录（探测失败为 null，渲染层提示「未找到 Kimi Work」）。 */
	root: string | null;
	origin: KimiWorkShareRootOrigin | null;
	/** 会话索引目录是否存在（root 找到但 sessions 缺失 = 装了但还没有会话）。 */
	sessionsFound: boolean;
};

export type KimiWorkSessionSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: KimiWorkImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
};

export type KimiWorkImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type KimiWorkImportReport = {
	results: KimiWorkImportResult[];
	imported: number;
	failed: number;
};

// ── Minimax Code Session Import Types ────────────────────────────────
// MinimaxCode（CLI 编码助手）：会话落在 ~/.minimax/v2/sessions/
// YYYY/MM/DD/<HH-mm-ss-sid>-session_<id>/ 目录，内含 manifest.json（sessionId/
// createdAtMs/title 等）、messages.jsonl（anthropic 风格 role+content blocks）与
// llm-call.json（systemPrompt 内含 working directory，作为 cwd 来源）。

/** Minimax Code 会话导入状态：未导入 / 已是最新 / 源更新后可覆盖。 */
export type MinimaxImportStatus = "new" | "current" | "outdated";

export type MinimaxSessionSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	cwd: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: MinimaxImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
};

export type MinimaxImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type MinimaxImportReport = {
	results: MinimaxImportResult[];
	imported: number;
	failed: number;
};
//
// 场景：项目目录被移动/改名后，pi 会话仍按「旧 cwd 的 encoded 分组目录」留在
// ~/.pi/agent/sessions 下，与新项目的路径不再匹配 → 侧栏看不到历史。
// 该导入源让用户从一个「现有会话目录」列表里点选（旧项目目录 / 某个 encoded 分组目录），
// 把其中的会话挂到当前项目下（只建 catalog 引用，不复制、不改写原文件）。
// 也可以手动选任意目录：目录本身是项目路径时按原工作目录匹配。

/** 目录会话导入状态：未入册 / 已在 catalog（导入 = 把归属改到当前项目）。 */
export type DirectoryImportStatus = "new" | "current";

export type DirectorySessionSummary = {
	id: string;
	/** 会话 JSONL 绝对路径（导入后即 catalog 的 filePath，原文件保持原地） */
	sourcePath: string;
	title: string;
	preview: string;
	/** 会话记录里的原工作目录（由 encoded 目录名还原；可能已被移动/改名/删除） */
	projectPath?: string;
	/** 原工作目录当前是否仍在磁盘上（false = 目录失效，正是要找回的历史） */
	projectPathExists: boolean;
	updatedAt: number;
	messageCount: number;
	/** 文件字节数（弹窗展示用；扫描失败时为 0） */
	sourceSize?: number;
	status: DirectoryImportStatus;
};

export type DirectoryImportResult = {
	id: string;
	sourcePath: string;
	success: boolean;
	title?: string;
	error?: string;
};

export type DirectoryImportReport = {
	results: DirectoryImportResult[];
	imported: number;
	failed: number;
};

/**
 * 选定目录的形态（决定弹窗是列出会话，还是提示「你选的是 pi 主目录」）。
 * - sessions-root：pi sessions 根（列出树内全部会话）
 * - group：某个 encoded 分组目录（列出该目录内的会话）
 * - project：项目目录本身（按会话记录里的原工作目录命中）
 * - ancestor：sessions 树的祖先目录（~/.pi / ~/.pi/agent 等），命中必为 0，需要提示改选
 * - none：以上都不是且没有命中
 */
export type DirectorySourceKind = "sessions-root" | "group" | "project" | "ancestor" | "none";

/** 扫描结果：会话行 + 目录形态（形态供渲染层区分「该目录确实没有会话」与「选错了层级」）。 */
export type DirectorySessionScanResult = {
	sessions: DirectorySessionSummary[];
	kind: DirectorySourceKind;
};

/**
 * 「现有会话目录」列表项（弹窗首屏让用户点选，避免手选到 ~/.pi 这类没有意义的层级）。
 * 列表只包含真的有会话的分组目录，选中即必有结果。
 */
export type DirectorySessionSourceDir = {
	/** pi 会话分组目录（`~/.pi/agent/sessions/<encoded-cwd>`，或 settings 里配置的 sessionDir） */
	dir: string;
	/** 分组目录名还原出的原工作目录（扫描器给出；拿不到时缺省） */
	projectPath?: string;
	/** 该目录下的会话数 */
	sessionCount: number;
	/** 该目录下最近一次会话的更新时间 */
	lastUsedAt: number;
	/** 原工作目录当前是否仍在磁盘上（false = 目录已移动/删除，正是要找回的历史） */
	projectPathExists: boolean;
};
