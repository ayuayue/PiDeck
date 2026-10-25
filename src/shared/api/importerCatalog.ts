/**
 * 统一接口聚合层 · 外部会话导入器清单（IMPORTER_CATALOG）。
 *
 * 11 个导入器（RESEARCH 域盘点）：scan（列举外部源会话）→ import（导入两段式）；
 * kimi-work 额外 describe、directory-sessions 额外 listSources。导入器不进 DOMAIN_CATALOG
 * （沉默清单 S4：11 导入域不占域清单行，由本表承载），通道走 sessions:import* 入口，
 * handler 统一注册在 ipc/sessionIpc.ts。
 * 守卫测试 tests/unifiedApiDomainCatalog.test.mjs：id 与域清单共用唯一空间、
 * 11 个 *-sessions 前缀由本表认领、命名空间与 DOMAIN_CATALOG 并集恰好覆盖 70 命名空间。
 */
import type { ImporterCatalogEntry } from "./domainTypes";

export const IMPORTER_CATALOG = [
	{ id: "codex", manager: "CodexSessionImporter", ipcFile: ["ipc/sessionIpc.ts"], preloadNamespaces: ["codexSessions"], channelPrefix: ["codex-sessions"], capabilities: ["scan", "import"] },
	{ id: "claude", manager: "ClaudeSessionImporter", ipcFile: ["ipc/sessionIpc.ts"], preloadNamespaces: ["claudeSessions"], channelPrefix: ["claude-sessions"], capabilities: ["scan", "import"] },
	{ id: "qoder", manager: "QoderSessionImporter", ipcFile: ["ipc/sessionIpc.ts"], preloadNamespaces: ["qoderSessions"], channelPrefix: ["qoder-sessions"], capabilities: ["scan", "import"] },
	{ id: "opencode", manager: "OpenCodeSessionImporter", ipcFile: ["ipc/sessionIpc.ts"], preloadNamespaces: ["openCodeSessions"], channelPrefix: ["opencode-sessions"], capabilities: ["scan", "import"] },
	{ id: "zcode", manager: "ZCodeSessionImporter", ipcFile: ["ipc/sessionIpc.ts"], preloadNamespaces: ["zcodeSessions"], channelPrefix: ["zcode-sessions"], capabilities: ["scan", "import"] },
	{ id: "workbuddy", manager: "WorkBuddySessionImporter", ipcFile: ["ipc/sessionIpc.ts"], preloadNamespaces: ["workbuddySessions"], channelPrefix: ["workbuddy-sessions"], capabilities: ["scan", "import"] },
	{ id: "cursor", manager: "CursorSessionImporter", ipcFile: ["ipc/sessionIpc.ts"], preloadNamespaces: ["cursorSessions"], channelPrefix: ["cursor-sessions"], capabilities: ["scan", "import"] },
	{ id: "kimi", manager: "KimiSessionImporter", ipcFile: ["ipc/sessionIpc.ts"], preloadNamespaces: ["kimiSessions"], channelPrefix: ["kimi-sessions"], capabilities: ["scan", "import"] },
	{ id: "kimi-work", manager: "KimiWorkSessionImporter", ipcFile: ["ipc/sessionIpc.ts"], preloadNamespaces: ["kimiWorkSessions"], channelPrefix: ["kimi-work-sessions"], capabilities: ["scan", "import", "describe"] },
	{ id: "minimax", manager: "MiniMaxSessionImporter", ipcFile: ["ipc/sessionIpc.ts"], preloadNamespaces: ["minimaxSessions"], channelPrefix: ["minimax-sessions"], capabilities: ["scan", "import"] },
	{ id: "directory-sessions", manager: "DirectorySessionImporter", ipcFile: ["ipc/sessionIpc.ts"], preloadNamespaces: ["directorySessions"], channelPrefix: ["directory-sessions"], capabilities: ["scan", "import", "listSources"] },
] as const satisfies readonly ImporterCatalogEntry[];

export type ImporterId = (typeof IMPORTER_CATALOG)[number]["id"];

/**
 * 门面视角的导入器方法集（T5 接线用）：统一以 catalog id 为门面键，
 * 值为该导入器暴露给统一接口的 preload 方法名（⊆ 各自命名空间实际方法）。
 */
export const IMPORTER_FACADE_METHODS = {
	codex: ["scan", "import"],
	claude: ["scan", "import"],
	qoder: ["scan", "import"],
	opencode: ["scan", "import"],
	zcode: ["scan", "import"],
	workbuddy: ["scan", "import"],
	cursor: ["scan", "import"],
	kimi: ["scan", "import"],
	"kimi-work": ["scan", "import", "describe"],
	minimax: ["scan", "import"],
	"directory-sessions": ["scan", "import", "listSources"],
} as const satisfies Record<ImporterId, readonly string[]>;

/** catalog id → preload 命名空间名（facadeTypes 的 mapped type 用）。 */
export const IMPORTER_NAMESPACES = {
	codex: "codexSessions",
	claude: "claudeSessions",
	qoder: "qoderSessions",
	opencode: "opencodeSessions",
	zcode: "zcodeSessions",
	workbuddy: "workbuddySessions",
	cursor: "cursorSessions",
	kimi: "kimiSessions",
	"kimi-work": "kimiWorkSessions",
	minimax: "minimaxSessions",
	"directory-sessions": "directorySessions",
} as const satisfies Record<ImporterId, string>;
