import type { PiDesktopApi } from "../../../preload";

/**
 * 外部 CLI 会话来源桩（codex/claude/cursor/kimi 等）：预览环境没有历史文件，一律空列表。
 */
export function createSessionSourcesPreview(): Pick<PiDesktopApi, "codexSessions" | "claudeSessions" | "qoderSessions" | "openCodeSessions" | "zcodeSessions" | "workbuddySessions" | "codebuddySessions" | "cursorSessions" | "kimiSessions" | "kimiWorkSessions" | "minimaxSessions" | "directorySessions"> {
	return {
		codexSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		claudeSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		qoderSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		openCodeSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		zcodeSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		workbuddySessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		codebuddySessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		cursorSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		kimiSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		kimiWorkSessions: {
			describe: async () => ({ root: null, origin: null, sessionsFound: false }),
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		// MinimaxCode 导入预览桩：预览环境无 ~/.minimax 可扫
		minimaxSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		directorySessions: {
			scan: async () => ({ sessions: [], kind: "none" }),
			listSources: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
	};
}
