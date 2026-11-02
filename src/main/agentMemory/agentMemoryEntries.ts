/**
 * 设置页「记忆」tab 的条目视图：把 Markdown 真值读成可浏览的列表，并支持删除单条。
 *
 * 三件事必须与别处一致，所以直接复用 MCP 服务器的模块，不另写一套口径：
 * - 分节（`ENTRY_DELIMITER`）：`parseEntries`；
 * - 去重键（墓碑与 `memory_replace` 定位同一份）：`normalizeKey`；
 * - 文件布局（`projects/<key>/`、`devices/<key>/`）：`targetFilePath`。
 *
 * 这里只做列举、删除与 STANDING 的设置页编辑；其余新增/修改永远只由 Agent 在会话里
 * 经工具发生。删除写一条墓碑，让「删掉的条目被旧导出包导回来」不可能发生。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { entryCategory, normalizeKey, parseEntries, parseFailureEntry, renderEntries } from "../../../resources/agent-memory/format.mjs";
import { readRaw, writeAtomic } from "../../../resources/agent-memory/files.mjs";
import { FILE_BUDGETS, TARGET_FILES, projectKeyFromPath, resolveMemoryRoot, targetFilePath } from "../../../resources/agent-memory/paths.mjs";
import { addTombstone, exportEntryId, removeTombstone } from "../../../resources/agent-memory/sync.mjs";
import { addMemory, syncTarget } from "../../../resources/agent-memory/tools.mjs";

export type AgentMemoryTarget = keyof typeof TARGET_FILES;
export type AgentMemoryScope = "global" | "project" | "device";

export interface AgentMemoryEntryView {
	/** 文件内序号（1 起）。删除按 `key` 定位，序号只用于展示顺序。 */
	index: number;
	target: AgentMemoryTarget;
	file: string;
	scope: AgentMemoryScope;
	projectId: string;
	/** 展示用名字：项目名（能匹配到 PiDeck 项目时）、设备短键，全局留空。 */
	projectName: string;
	/** 规范化内容键：与去重/墓碑同一个哈希口径，删除用它定位。 */
	key: string;
	/**
	 * 导出弹窗的勾选键。**必须由 `sync.mjs` 的 `exportEntryId` 算**：
	 * `failure` 条目在包里是「纯内容」（去掉 `[category]` 前缀），与 `key`（整块哈希）不同，
	 * 渲染层自己拼 id 会让失败教训类的勾选错位。
	 */
	exportId: string;
	content: string;
	chars: number;
	/** `failure` 的分类；其他目标为空串。 */
	category: string;
}

export interface AgentMemoryEntryGroup {
	target: AgentMemoryTarget;
	scope: AgentMemoryScope;
	projectId: string;
	projectName: string;
	/** 相对根目录的路径，作为「这条记忆存在哪个文件」给用户看的凭据。 */
	file: string;
	bytes: number;
	/** 全局四份文件有注入预算；项目/设备作用域只在检索时出现，没有预算。 */
	budget: { maxChars: number; maxEntries: number } | null;
	chars: number;
	entries: AgentMemoryEntryView[];
}

export interface AgentMemoryEntryList {
	root: string;
	total: number;
	groups: AgentMemoryEntryGroup[];
}

/** 作用域顺序：全局 → 项目 → 设备；同一作用域内按「记忆 / 用户 / 教训 / 常驻」排。 */
const TARGET_ORDER: readonly AgentMemoryTarget[] = ["memory", "user", "failure", "standing"];

function readDirKeys(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((item) => item.isDirectory())
			.map((item) => item.name)
			.sort();
	} catch {
		return [];
	}
}

function buildGroup(root: string, target: AgentMemoryTarget, scope: AgentMemoryScope, projectId: string, projectName: string): AgentMemoryEntryGroup | null {
	const absolute = targetFilePath(root, target, projectId);
	if (!existsSync(absolute)) return null;
	let bytes = 0;
	try {
		bytes = statSync(absolute).size;
	} catch {
		return null;
	}
	const entries = parseEntries(readRaw(absolute)).map((content, index) => {
		// 包的条目身份按「语义内容」算（failure 去掉分类前缀），这里必须用同一口径。
		const semantic = target === "failure" ? parseFailureEntry(content).content : content;
		return {
			index: index + 1,
			target,
			exportId: exportEntryId({ target, scope, projectKey: projectId, content: semantic }),
			file: scope === "global" ? TARGET_FILES[target] : `${scope === "device" ? "devices" : "projects"}/${projectId}/${TARGET_FILES[target]}`,
			scope,
			projectId,
			projectName,
			key: normalizeKey(content),
			content,
			chars: content.length,
			category: target === "failure" ? entryCategory(content) : "",
		};
	});
	if (entries.length === 0) return null;
	return {
		target,
		scope,
		projectId,
		projectName,
		file: entries[0].file,
		bytes,
		budget: scope === "global" ? (FILE_BUDGETS[target] ?? null) : null,
		chars: entries.reduce((sum, entry) => sum + entry.chars, 0),
		entries,
	};
}

/**
 * 读全部记忆条目。
 *
 * `projects` 只用于把目录键翻译成用户认得的项目名（记忆键由会话 cwd 派生，
 * 与 PiDeck 项目 id 不是一回事，所以要按路径反查一次）；匹配不到就显示键本身。
 */
export function readAgentMemoryEntries(input: { root?: string; projects?: () => { name: string; path: string }[] }): AgentMemoryEntryList {
	const root = input.root ?? resolveMemoryRoot();
	const nameByKey = new Map<string, string>();
	// 惰性求值：设置页每次刷新都读一次项目表，但记忆 tab 打开时项目可能已经变了。
	for (const project of input.projects?.() ?? []) {
		const key = projectKeyFromPath(project.path);
		if (key && !nameByKey.has(key)) nameByKey.set(key, project.name);
	}
	const groups: AgentMemoryEntryGroup[] = [];
	const push = (target: AgentMemoryTarget, scope: AgentMemoryScope, projectId: string, projectName: string) => {
		const group = buildGroup(root, target, scope, projectId, projectName);
		if (group) groups.push(group);
	};

	for (const target of TARGET_ORDER) push(target, "global", "", "");
	for (const key of readDirKeys(join(root, "projects"))) {
		for (const target of TARGET_ORDER) push(target, "project", key, nameByKey.get(key) ?? key);
	}
	for (const key of readDirKeys(join(root, "devices"))) {
		for (const target of TARGET_ORDER) push(target, "device", key, key.slice(0, 8));
	}

	return { root, total: groups.reduce((sum, group) => sum + group.entries.length, 0), groups };
}

/**
 * 删除一条记忆。
 *
 * 全局/项目作用域写墓碑（导出包里的旧条目不会再导入回来）；设备作用域的条目本来就
 * 不参与导出导入，写墓碑只会让 tombstones.json 长出一条永不命中的记录，所以跳过。
 */
export function deleteAgentMemoryEntry(root: string | undefined, input: { target: string; projectId?: string; key?: string }): { removed: number } {
	const target = input.target as AgentMemoryTarget;
	if (!(target in TARGET_FILES)) throw new Error("target-invalid");
	const key = typeof input.key === "string" ? input.key.trim() : "";
	if (!key) throw new Error("entry-key-required");
	const projectId = typeof input.projectId === "string" ? input.projectId : "";
	const absolute = targetFilePath(root ?? resolveMemoryRoot(), target, projectId);
	const before = parseEntries(readRaw(absolute));
	const removed = before.filter((content) => normalizeKey(content) === key);
	if (removed.length === 0) return { removed: 0 };
	writeAtomic(absolute, renderEntries(before.filter((content) => normalizeKey(content) !== key)));
	if (!projectId.startsWith("device:")) {
		// 墓碑存「语义内容」：导入时的拦截比较的是包内条目的语义内容（failure 已去掉 `[category]` 前缀），
		// 存原始块会让 failure 的墓碑永远拦不住同一条。
		addTombstone(root ?? resolveMemoryRoot(), {
			target,
			scope: projectId ? "project" : "global",
			projectKey: projectId,
			content: target === "failure" ? parseFailureEntry(removed[0]).content : removed[0],
		});
	}
	return { removed: removed.length };
}

/**
 * 撤销删除：把刚删的条目写回去，并回收对应的墓碑。
 *
 * 走主进程而不是渲染层分两步调：addMemory 与回收墓碑必须一起成怨，拆开会在中途失败时留下
 * 「内容回来了但墓碑还在」（下次导入旧包会被误拦）或反过来。重复内容直接返回 restored:false
 * （addMemory 的 duplicate 语义不报错，但那不是一次有效恢复）。
 */
export function restoreAgentMemoryEntry(root: string | undefined, input: { target: string; projectId?: string; content?: string; category?: string }): { restored: boolean } {
	const target = input.target as AgentMemoryTarget;
	if (!(target in TARGET_FILES)) throw new Error("target-invalid");
	const content = typeof input.content === "string" ? input.content.trim() : "";
	if (!content) throw new Error("entry-content-required");
	const projectId = typeof input.projectId === "string" ? input.projectId : "";
	const absolute = targetFilePath(root ?? resolveMemoryRoot(), target, projectId);
	// 与 addMemory 的去重同一口径：failure 比较语义内容（去掉 `[category]` 前缀）。
	const semanticOf = (block: string) => (target === "failure" ? parseFailureEntry(block).content : block);
	const normalized = normalizeKey(semanticOf(content));
	if (parseEntries(readRaw(absolute)).some((block) => normalizeKey(semanticOf(block)) === normalized)) return { restored: false };
	if (target === "standing") {
		// standing 不是模型写入目标（MEMORY_TARGETS 不含它），文件侧直接追加。
		writeAtomic(absolute, renderEntries([...parseEntries(readRaw(absolute)), content]));
		return { restored: true };
	}
	const isDevice = projectId.startsWith("device:");
	// deleteEntry 的定位键视角（target + projectId）映射回 addMemory 的写入视角：
	// 项目作用域的 memory → target=project；设备作用域 → target=device（键由机器档案派生，不传 projectId）。
	const toolTarget = isDevice ? "device" : target === "memory" && projectId ? "project" : target;
	const failure = target === "failure" ? parseFailureEntry(content) : undefined;
	addMemory(root ?? resolveMemoryRoot(), {
		target: toolTarget,
		content: failure ? failure.content : content,
		...(target === "failure" ? { category: failure?.category ?? (typeof input.category === "string" && input.category ? input.category : undefined) } : {}),
		projectId: isDevice || target !== "memory" ? "" : projectId,
	});
	if (!isDevice) {
		removeTombstone(root ?? resolveMemoryRoot(), {
			target,
			scope: projectId ? "project" : "global",
			projectKey: projectId,
			content: failure ? failure.content : content,
		});
	}
	return { restored: true };
}

/* ───────────────────────── STANDING.md 的设置页编辑入口 ───────────────────────── */

/**
 * 读常驻指令原文。STANDING 不是工具写入 target（语义是「用户显式同意的常驻指令」，
 * 不能让模型自己往里写），所以入口只开在设置页；这里读的就是文件本身。
 */
export function readStandingEntry(root: string | undefined): string {
	if (!root) throw new Error("memory-disabled");
	// writeStandingEntry 会在尾部补一个换行（文件格式），读回给编辑器时去掉，避免每次打开都「看似有改动」。
	return readRaw(targetFilePath(root, "standing", "")).trimEnd();
}

/** 保存常驻指令原文：整文件替换 + 强制重同步索引。空串 = 清空。 */
export function writeStandingEntry(root: string | undefined, content: string): { chars: number } {
	if (!root) throw new Error("memory-disabled");
	const normalized = content.replace(/\r\n/g, "\n").trim();
	// 预算内的两倍余量交给裁剪逻辑没有必要——设置页是人工编辑，直接给硬上限挡手滑。
	if (normalized.length > FILE_BUDGETS.standing.maxChars) throw new Error("standing-too-long");
	if (normalized)
		writeAtomic(
			targetFilePath(root, "standing", ""),
			`${normalized}
`,
		);
	else writeAtomic(targetFilePath(root, "standing", ""), "");
	// 写路径绕过了 mutateEntries，mtime 短路必须强制穿透，否则索引还停在旧内容。
	syncTarget(root, "standing", "", { force: true });
	return { chars: normalized.length };
}
