/**
 * `paths.mjs` 的类型声明。
 *
 * 只声明宿主进程（TypeScript）实际用到的那部分：完整接口由 `server.mjs` 侧的 JSDoc 描述。
 * 声明文件与实现放在同一目录，是为了让 `import ... from "../../../resources/agent-memory/paths.mjs"`
 * 在 `tsc --noEmit` 下有类型，同时保持运行时形态不变（服务器不依赖任何构建产物）。
 */

export const ENTRY_DELIMITER: string;
export const TARGET_FILES: { memory: "MEMORY.md"; user: "USER.md"; standing: "STANDING.md"; failure: "failures.md" };
export const MEMORY_TARGETS: readonly string[];
export const FAILURE_CATEGORIES: readonly string[];
export const FILE_BUDGETS: Record<"memory" | "user" | "standing" | "failure", { maxChars: number; maxEntries: number }>;
export const MAX_ENTRY_CHARS: number;
export const MAX_INDEXED_MESSAGE_CHARS: number;

export function projectKeyFromPath(cwd: string): string;
export function defaultProjectKey(env?: NodeJS.ProcessEnv): string;
export function resolveMemoryRoot(env?: NodeJS.ProcessEnv): string;
export function resolveProjectDir(root: string, projectId: string): string;
export function databasePath(root: string): string;
export function targetFilePath(root: string, target: string, projectId?: string): string;
