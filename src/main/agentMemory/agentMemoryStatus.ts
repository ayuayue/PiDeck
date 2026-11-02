/**
 * 设置页「智能体记忆」状态区的数据源。
 *
 * 主进程直接复用 MCP 服务器自己的模块（`resources/agent-memory/*.mjs`）来读状态，
 * 而不是再实现一遍统计口径——两边算出的「预算占用 / 索引规模」必须逐字一致，
 * 否则用户在设置页看到的和 Agent 用 `memory_status` 看到的会互相矛盾。
 *
 * 这里只做**只读**统计与索引清空；记忆的写入永远只由 MCP 服务器在会话里发生。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { clearIndex, indexStats } from "../../../resources/agent-memory/db.mjs";
import { FILE_BUDGETS, TARGET_FILES } from "../../../resources/agent-memory/paths.mjs";
import { parseEntries } from "../../../resources/agent-memory/format.mjs";
import { readRaw } from "../../../resources/agent-memory/files.mjs";
import { readDeviceProfile } from "../../../resources/agent-memory/sync.mjs";
import { readLearnState } from "./autoLearn";

export interface AgentMemoryFileStat {
	/** 相对根目录的位置；项目作用域形如 `projects/<key>/MEMORY.md`。 */
	name: string;
	bytes: number;
	entries: number;
	/** `null` 表示这份文件不参与注入预算（例如项目作用域目前不进系统提示）。 */
	budget: { maxChars: number; maxEntries: number } | null;
}

export interface AgentMemoryStatus {
	root: string;
	/** 记忆文件总字节数（只统计 Markdown，不含索引库）。 */
	totalBytes: number;
	indexBytes: number;
	files: AgentMemoryFileStat[];
	/** 本机设备档案（导出包据此标注来源）。 */
	device: { id: string; name: string };
	index: { entries: number; sessions: number; messages: number } | null;
	/** 索引不可用时的原因码（`node:sqlite` 缺失、库损坏等），供 UI 提示降级。 */
	indexError: string | null;
	/** 自动学习循环的可见性摘要：学过的会话数与最近一次学习时间（没学过为 null）。 */
	learn: { sessions: number; lastAt: string | null };
}

/**
 * 枚举根目录下的记忆文件。
 *
 * 只认 `TARGET_FILES` 里的四个文件名 + `projects/<key>/` 下同样的四个，
 * 别的文件（用户自己放的笔记、备份）不参与统计，避免把无关文件算成记忆体积。
 */
function collectFiles(root: string): AgentMemoryFileStat[] {
	const result: AgentMemoryFileStat[] = [];
	const push = (relative: string, absolute: string) => {
		try {
			const info = statSync(absolute);
			if (!info.isFile()) return;
			const fileName = relative.split("/").pop() ?? "";
			const target = (Object.keys(TARGET_FILES) as (keyof typeof TARGET_FILES)[]).find((key) => TARGET_FILES[key] === fileName) ?? null;
			// 条目数按文件内容数节：与预算裁剪的口径一致，也不受索引是否可用影响。
			const entries = parseEntries(readRaw(absolute)).length;
			// 项目作用域目前不进系统提示（只有 memory_search 能查到），所以不给预算。
			const budget = target ? (FILE_BUDGETS[target as keyof typeof FILE_BUDGETS] ?? null) : null;
			result.push({ name: relative, bytes: info.size, entries, budget: relative.includes("/") ? null : budget });
		} catch {
			// 并发删除/无权限：跳过这份文件，状态区不该因此报错
		}
	};
	for (const fileName of Object.values(TARGET_FILES)) push(fileName, join(root, fileName));
	const projectsDir = join(root, "projects");
	if (existsSync(projectsDir)) {
		for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			for (const fileName of Object.values(TARGET_FILES)) push(`projects/${entry.name}/${fileName}`, join(projectsDir, entry.name, fileName));
		}
	}
	return result;
}

/** 读一份状态快照。任何异常都收敛成 `indexError`，不让设置页整页崩。 */
export function readAgentMemoryStatus(root: string): AgentMemoryStatus {
	const files = collectFiles(root);
	const stats = indexStats(root);
	const learnSessions = Object.values(readLearnState(root).sessions);
	const learnLastAt =
		learnSessions
			.map((session) => session.learnedAt)
			.filter(Boolean)
			.sort()
			.at(-1) ?? null;
	const dbPath = join(root, "agent-memory.db");
	return {
		root,
		totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
		indexBytes: existsSync(dbPath) ? statSync(dbPath).size : 0,
		files,
		device: readDeviceProfile(root),
		index: stats.ok ? { entries: stats.entries, sessions: stats.sessions, messages: stats.messages } : null,
		indexError: stats.ok ? null : (stats.reason ?? "index-unavailable"),
		learn: { sessions: learnSessions.length, lastAt: learnLastAt },
	};
}

/** 清空索引（保留 Markdown），返回被清掉的条目数。 */
export function clearAgentMemoryIndex(root: string): { removed: number } {
	const result = clearIndex(root);
	if (!result.ok) throw new Error(result.reason ?? "index-unavailable");
	return { removed: result.removed ?? 0 };
}
