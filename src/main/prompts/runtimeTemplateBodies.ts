import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/**
 * 按 pi 的 `get_commands` 登记路径读回提示词模板正文。
 *
 * 为什么需要：pi 的 `get_commands` 只报模板的名字、描述和 `sourceInfo.path`，不返回正文
 * （`dist/modes/rpc/rpc-mode.js` 的 get_commands 分支）。PiDeck 若要在发送前自己展开这些
 * 模板（从而把 `/<模板名>` 身份写进会话文件、气泡还原成 chip），就得按这个路径把正文读回来。
 *
 * 为什么不由 PiDeck 自己扫目录：pi 的模板来源包括用户目录、项目目录和**已安装 npm 包**
 * 声明的 `pi.prompts`，还有设置里的启用/禁用与重名去重。重扫一遍等于复制 pi 的资源发现
 * 规则，规则一改就错位。这里的输入只认 `get_commands` 报出的路径（provenance 白名单）。
 *
 * 安全与预算：只读绝对路径、只读 `.md`、单份不超过 `RUNTIME_TEMPLATE_MAX_BYTES`，
 * 任一条件不满足就跳过该条（降级为「交给 pi 展开」，即今天的旧行为）。
 */

/** 单份模板正文字节上限：正常提示词远小于此值，超出说明选错了文件。 */
export const RUNTIME_TEMPLATE_MAX_BYTES = 256 * 1024;

/** get_commands 条目的最小可判定投影（其余字段一律忽略）。 */
type RuntimeCommandLike = {
	name: string;
	source?: string;
	description?: string;
	sourceInfo?: { path?: string };
};

export type RuntimePromptTemplate = { name: string; content: string; description?: string };

type ReadDeps = {
	statFile?: (path: string) => Promise<{ size: number; isFile(): boolean }>;
	readTextFile?: (path: string, encoding: "utf8") => Promise<string>;
};

/** 把 RPC 返回的 unknown[] 收窄成可判定投影；非法条目丢弃而不是整体失败。 */
function narrowCommands(raw: unknown): RuntimeCommandLike[] {
	if (!Array.isArray(raw)) return [];
	const commands: RuntimeCommandLike[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name : "";
		if (!name) continue;
		const source = typeof record.source === "string" ? record.source : undefined;
		const sourceInfoRaw = record.sourceInfo;
		const description = typeof record.description === "string" && record.description.trim() ? record.description.trim() : undefined;
		const path = typeof sourceInfoRaw === "object" && sourceInfoRaw !== null && typeof (sourceInfoRaw as Record<string, unknown>).path === "string" ? ((sourceInfoRaw as Record<string, unknown>).path as string) : undefined;
		commands.push({ name, source, ...(description ? { description } : {}), ...(path ? { sourceInfo: { path } } : {}) });
	}
	return commands;
}

/**
 * 读取运行时提示词模板正文。
 * 只处理 `source === "prompt"` 的条目；同名的后来者丢弃（get_commands 已按 pi 的优先级去重）。
 */
export async function readRuntimePromptTemplateBodies(rawCommands: unknown, deps: ReadDeps = {}): Promise<RuntimePromptTemplate[]> {
	const statFile = deps.statFile ?? ((path: string) => stat(path));
	const readTextFile = deps.readTextFile ?? ((path: string, encoding: "utf8") => readFile(path, encoding));
	const byName = new Set<string>();
	const templates: RuntimePromptTemplate[] = [];
	for (const command of narrowCommands(rawCommands)) {
		if (command.source !== "prompt") continue;
		if (byName.has(command.name)) continue;
		const rawPath = command.sourceInfo?.path;
		if (!rawPath || !isAbsolute(rawPath)) continue;
		const filePath = resolve(rawPath);
		if (!filePath.toLowerCase().endsWith(".md")) continue;
		try {
			const info = await statFile(filePath);
			if (!info.isFile() || info.size > RUNTIME_TEMPLATE_MAX_BYTES) continue;
			const content = await readTextFile(filePath, "utf8");
			byName.add(command.name);
			templates.push({ name: command.name, content, ...(command.description ? { description: command.description } : {}) });
		} catch {
			// 文件被删/权限不足/编码异常：跳过该条，调用方退回 pi 展开
		}
	}
	return templates;
}
