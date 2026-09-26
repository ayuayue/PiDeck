// 数据导入管线（规格 §6 导入 + 附录迁移清单）：清单展开 / 体积预估 / 逐项复制 / 进度 / 取消。
// 纯函数 + hooks 注入，tests/channelDataImport.test.mjs 直接单测；IPC 接线在 ipc/dataEnvIpc.ts。
import { cp } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ImportItem, ImportProgress } from "../../shared/types/dataEnv";
// R7：prompts overlay 目录名取自现有路径常量（不硬编码猜测），.bak 备份目录随清单整目录带走。
import { PROMPT_OVERLAY_BACKUP_DIR_NAME, PROMPT_OVERLAY_DIR_NAME } from "../prompts/promptStoreUpdater";

// 类型定稿于 shared/types/dataEnv.ts（R5 同规：preload 禁止 import main）。
export type { ImportItem, ImportProgress } from "../../shared/types/dataEnv";

/** 需迁移清单（规格 §6 附录逐项）。目录以 / 结尾标记递归复制；`*` 仅在前缀目录的文件名段。 */
export const IMPORT_PATHS: readonly string[] = [
	"settings.json",
	"projects.json",
	"chat-path.json",
	"dismissed-project-paths.json",
	"chat-workspace/",
	"external-sessions/",
	"session-catalog.json",
	"automation.json",
	"quick-messages.json",
	"voice-transcription.json",
	"imagegen.json",
	"security-policy.json",
	"pet-position.json",
	"pi-desktop/feishu*.json", // feishu 全套：受限 glob 展开（feishu.json / feishu-bindings-*.json 等）
	"imagegen/sessions/",
	"imagegen/blobs/",
	"builtin-extensions/",
	"skills-overlay/",
	`${PROMPT_OVERLAY_DIR_NAME}/`,
	`${PROMPT_OVERLAY_BACKUP_DIR_NAME}/`,
];

/** 明确跳过（规格附录：可重建 / 勿迁）。IMPORT_PATHS 是白名单语义（未列出即天然排除），本表是双保险。 */
export const IMPORT_SKIP_PATHS: readonly string[] = ["instance-locks/", "runtimes/", "pi-runtime/", "session-summary-cache.json", "announcements-cache.json", "changelog-cache/", "tokendance-models.json", "last-window-bounds.json", "logs/", "memory-profile/", "diagnostics/", "drafts/", "sounds/", "backgrounds/"];

/** 取消导入的专用错误：IPC 层捕获后推送 phase:"cancelled"，不与真实失败混淆。 */
export class ImportCancelledError extends Error {
	constructor() {
		super("import-cancelled");
	}
}

/** runImport / copyImportItems 共用的进度与取消钩子。 */
export interface ImportRunHooks {
	onProgress: (progress: ImportProgress) => void;
	isCancelled: () => boolean;
}

/** 正则元字符转义（受限 glob 的文件名模式段用）。 */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 受限 glob 展开：仅支持「前缀目录/文件名模式」一层形态（如 pi-desktop/feishu*.json），
 * 模式段只允许 `*` 通配；其余条目原样返回（清单自己保证格式）。
 */
function expandGlob(root: string, rel: string): string[] {
	const slashIndex = rel.indexOf("/");
	if (slashIndex === -1 || !rel.includes("*")) return [rel];
	const dirPart = rel.slice(0, slashIndex);
	const pattern = rel.slice(slashIndex + 1);
	if (pattern.includes("/")) return [rel];
	const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
	const dir = join(root, dirPart);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => regex.test(name))
		.map((name) => `${dirPart}/${name}`);
}

/** 命中跳过清单：带 / 的条目按目录前缀匹配，其余精确匹配。 */
function isSkipped(rel: string): boolean {
	return IMPORT_SKIP_PATHS.some((skip) => (skip.endsWith("/") ? rel === skip.slice(0, -1) || rel.startsWith(skip) : rel === skip));
}

/** 目录字节数递归求和（预估用；只 stat 不读内容）。 */
function statDirBytes(dir: string): number {
	let total = 0;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		total += stat.isDirectory() ? statDirBytes(full) : stat.size;
	}
	return total;
}

/** 规划迁移清单：展开 glob → 跳过清单排除 → 存在性过滤 → 求每项字节数。 */
export function planImportItems(sourceRoot: string): ImportItem[] {
	const items: ImportItem[] = [];
	for (const expanded of IMPORT_PATHS.flatMap((entry) => expandGlob(sourceRoot, entry))) {
		// 清单目录条目以 / 结尾，仅作递归标记；item.relPath 归一为无尾斜杠（进度展示与路径拼接都更干净）
		const rel = expanded.replace(/\/+$/, "");
		if (isSkipped(rel)) continue;
		const full = join(sourceRoot, rel);
		if (!existsSync(full)) continue;
		const stat = statSync(full);
		const isDir = stat.isDirectory();
		items.push({ relPath: rel, isDir, bytes: isDir ? statDirBytes(full) : stat.size });
	}
	return items;
}

/** 汇总清单项字节数（导入预览的 totalBytes）。 */
export function estimateImportBytes(items: readonly ImportItem[]): number {
	return items.reduce((sum, item) => sum + item.bytes, 0);
}

/**
 * 逐项复制：每项前查取消（抛 ImportCancelledError，已复制内容保留——规格 §6），
 * 每项 await cp 让出事件循环，GB 级 blobs 之间进度事件可冲刷、IPC 保持响应。
 */
export async function copyImportItems(sourceRoot: string, targetRoot: string, items: readonly ImportItem[], hooks: ImportRunHooks & { totalBytes: number }): Promise<void> {
	let copied = 0;
	for (const item of items) {
		if (hooks.isCancelled()) throw new ImportCancelledError();
		hooks.onProgress({ phase: "copying", currentItem: item.relPath, copiedBytes: copied, totalBytes: hooks.totalBytes });
		// cp 递归复制目录时按需创建目标父目录；force 覆盖已有同名目标（可重复导入）
		await cp(join(sourceRoot, item.relPath), join(targetRoot, item.relPath), { recursive: true, force: true });
		copied += item.bytes;
	}
	hooks.onProgress({ phase: "done", currentItem: null, copiedBytes: hooks.totalBytes, totalBytes: hooks.totalBytes });
}

/** 导入总入口：规划清单（体积预估经 get-import-preview 单独提供）→ 逐项复制 → done。 */
export async function runImport(sourceRoot: string, targetRoot: string, hooks: ImportRunHooks): Promise<void> {
	const items = planImportItems(sourceRoot);
	await copyImportItems(sourceRoot, targetRoot, items, { ...hooks, totalBytes: estimateImportBytes(items) });
}
