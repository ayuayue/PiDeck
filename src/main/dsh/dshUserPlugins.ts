/**
 * DSH 用户自装插件的识别与卸载（纯函数 + 文件操作，可单测）。
 *
 * 来源判定：host 的插件组合来自多层 patch（base / 随包预设 / PiDeck 自有行 /
 * home 用户补丁层）。其中 **$DSH_HOME/cordis.patch.yml** 是官方约定的用户自装层
 * （`dsh plugin add` 与手动安装都写这里，PiDeck 的安装脚本同样写这里）——
 * 出现在该文件里的条目即「用户安装」，其余为「自带」。
 *
 * 卸载 = 从该文件移除对应行（其余层不归用户管，禁止触碰）。采用**行级手术**而不是
 * YAML round-trip：用户补丁文件可能带注释/自定义格式，round-trip 会把注释全部抹掉；
 * 行级移除只删目标行，其余字节保持原样。无法识别的形状（手写折叠/锚点等）明确报
 * 「请手动编辑」，宁可不做也不猜。
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYamlRaw } from "js-yaml";

/** 用户补丁层文件名（dsh-app-boot.PROFILE_PATCH_FILENAME 的官方约定值；主进程
 *  不能 import runtime 包，这里按官方文档固化为常量）。 */
export const USER_PATCH_FILENAME = "cordis.patch.yml";

/** 用户补丁层里的一条 insert 行（只取分类/卸载关心的字段）。 */
export type UserPatchRow = {
	id?: string;
	name?: string;
};

export type UserPatchRowsResult = {
	rows: UserPatchRow[];
	/** 文件是否存在（不存在 = 无用户自装插件，合法状态）。 */
	exists: boolean;
	/** 文件存在但解析失败的原因（此时 rows 为空，宁可判成 builtin 也不误标）。 */
	error?: string;
};

/** js-yaml load 的窄封装（与 dshCredentials 同款依赖；d.ts 只声明了 load）。 */
function loadYaml(text: string): unknown {
	return loadYamlRaw(text);
}

/**
 * 归一化用于比对的模块名：file: URL 转真实路径、统一斜杠。
 * loader 会把绝对路径行归一化成 file:///…（inventory 里看到的moduleName），而用户
 * 补丁层里写的可能是裸路径或 file URL——两侧都过这里，保证同一文件归一化结果一致。
 */
export function normalizeModuleName(name: string): string {
	let value = name.trim();
	if (/^file:/i.test(value)) {
		try {
			value = fileURLToPath(value);
		} catch {
			value = value.replace(/^file:\/\//, "");
		}
	}
	return value.replace(/\\/g, "/");
}

/** 解析用户补丁层的 insert 行；文件缺失 = 空名单，解析失败 = 空名单 + error。 */
export function readUserPatchRows(patchPath: string): UserPatchRowsResult {
	if (!existsSync(patchPath)) {
		return { rows: [], exists: false };
	}
	try {
		const parsed = loadYaml(readFileSync(patchPath, "utf8")) as unknown;
		const rows: UserPatchRow[] = [];
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (entry === null || typeof entry !== "object") continue;
				const insert = (entry as { insert?: unknown }).insert;
				if (!Array.isArray(insert)) continue;
				for (const row of insert) {
					if (row === null || typeof row !== "object") continue;
					const record = row as Record<string, unknown>;
					const id = typeof record.id === "string" && record.id ? record.id : undefined;
					const name = typeof record.name === "string" && record.name ? record.name : undefined;
					if (id !== undefined || name !== undefined) rows.push({ id, name });
				}
			}
		}
		return { rows, exists: true };
	} catch (error) {
		return {
			rows: [],
			exists: true,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** 一条静态清单行是否命中用户补丁层的某个 insert 行（id 或 name 任一命中）。 */
export function isUserPluginEntry(
	view: { entryId: string; moduleName: string },
	rows: readonly UserPatchRow[],
): boolean {
	// loader 的条目 id 形如 `include:<rowId>`，剥掉来源前缀后与行 id 对照
	const bareEntryId = view.entryId.replace(/^include:/, "");
	const normalizedModule = normalizeModuleName(view.moduleName);
	return rows.some((row) => {
		if (row.id !== undefined && (row.id === view.entryId || row.id === bareEntryId)) return true;
		if (row.name === undefined) return false;
		return normalizeModuleName(row.name) === normalizedModule;
	});
}

/** 给静态清单标注来源（user = 用户补丁层声明；其余 builtin）。 */
export function classifyStaticPlugins<T extends { entryId: string; moduleName: string }>(
	views: readonly T[],
	rows: readonly UserPatchRow[],
): Array<T & { origin: "builtin" | "user" }> {
	return views.map((view) => ({ ...view, origin: isUserPluginEntry(view, rows) ? ("user" as const) : ("builtin" as const) }));
}

export type RemoveRowTarget = {
	id?: string;
	/** 传插件列表行里的 entryId（含 include: 前缀也可，内部会剥） */
	entryId?: string;
	moduleName?: string;
	/** 归一化后的插件名（与 moduleName 二选一可选；匹配走 normalizeModuleName） */
	name?: string;
};

export type RemoveRowResult = {
	/** 移除成功后的完整文件文本（未移除时返回原文）。 */
	text: string;
	removed: boolean;
	reason?: string;
};

const INSERT_LINE = /^- insert:\s*$/;
const ROW_START = /^(\s*)- (?!insert:)(.*)$/;
const ID_LINE = /^\s*(?:-\s*)?id:\s*(.+?)\s*$/;
const NAME_LINE = /^\s*name:\s*(.+?)\s*$/;

/** 行内提取 id/name 值；不是 id/name 行返回 undefined。 */
function extractField(line: string, re: RegExp): string | undefined {
	const match = re.exec(line);
	return match ? match[1] : undefined;
}

/**
 * 从用户补丁层文本中手术式移除目标 insert 行（保留其余字节，含注释与格式）。
 * 只识别标准形状：顶层 `- insert:` 块，块内 `- id: …` 起始的行组。
 * 目标命中规则与 isUserPluginEntry 一致（id 或归一化 name）。
 * 块内行全部移除后，连同 `- insert:` 行一起删掉，避免留下空块。
 */
export function removeUserPatchRow(text: string, target: RemoveRowTarget): RemoveRowResult {
	const lines = text.split("\n");
	const wantedId = target.id ?? (target.entryId ? target.entryId.replace(/^include:/, "") : undefined);
	const wantedNames = [target.moduleName, target.name].filter((v): v is string => typeof v === "string");
	const matches = (rowId: string | undefined, rowName: string | undefined): boolean => {
		if (wantedId !== undefined && rowId === wantedId) return true;
		if (wantedNames.length === 0 || rowName === undefined) return false;
		const normalized = normalizeModuleName(rowName);
		return wantedNames.some((wanted) => normalizeModuleName(wanted) === normalized);
	};

	// 定位每个 `- insert:` 块与其中的行组
	type Block = { insertLine: number; rows: Array<{ start: number; end: number; id?: string; name?: string }> };
	const blocks: Block[] = [];
	let current: Block | undefined;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (INSERT_LINE.test(line)) {
			current = { insertLine: i, rows: [] };
			blocks.push(current);
			continue;
		}
		if (current === undefined) continue;
		if (/^- /.test(line)) {
			// 下一个顶层列表项：当前 insert 块结束
			current = undefined;
			continue;
		}
		const rowStart = ROW_START.exec(line);
		if (rowStart) {
			current.rows.push({
				start: i,
				end: i + 1,
				id: extractField(line, ID_LINE),
				name: extractField(line, NAME_LINE),
			});
			continue;
		}
		// 行组的续行（name:/config: 等缩进行）并入最近一行组
		const lastRow = current.rows[current.rows.length - 1];
		if (lastRow && /^\s/.test(line)) {
			lastRow.end = i + 1;
			if (lastRow.name === undefined) lastRow.name = extractField(line, NAME_LINE);
		}
	}

	for (const block of blocks) {
		for (const row of block.rows) {
			if (!matches(row.id, row.name)) continue;
			const remove = new Set<number>();
			for (let i = row.start; i < row.end; i += 1) remove.add(i);
			const remainingRows = block.rows.filter((other) => other !== row && !remove.has(other.start));
			if (remainingRows.length === 0) remove.add(block.insertLine);
			const next = lines.filter((_, index) => !remove.has(index));
			return { text: next.join("\n"), removed: true };
		}
	}
	return { text, removed: false, reason: "patch row not found in $DSH_HOME/cordis.patch.yml" };
}

/**
 * 从 Loader 行的 name 推导可删除的插件目录：仅当它指向 PiDeck 管理目录
 * （userData/dsh-plugins/<pkg>/…）时返回该插件根（含 package.json 的最近祖先），
 * 其余位置（用户自选路径、runtime 内、node_modules）一律不动。
 */
export function resolveManagedPluginDir(
	rowName: string,
	managedRoot: string,
): string | undefined {
	const normalized = normalizeModuleName(rowName);
	if (!isAbsolute(normalized)) return undefined;
	const rootWithSlash = managedRoot.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
	if (!normalized.startsWith(rootWithSlash)) return undefined;
	return nearestPackageDir(normalized);
}

/**
 * 仅用于提示信息：从入口路径向上找最近的含 package.json 的目录（插件根），
 * 不限管理目录——卸载时「保留文件」的分支拿它告诉用户插件实际在哪里。
 * 找不到（路径不存在/到达盘根）返回 undefined。
 */
export function nearestPackageDir(entryPath: string): string | undefined {
	const normalized = normalizeModuleName(entryPath);
	if (!isAbsolute(normalized)) return undefined;
	let current = dirname(normalized);
	for (;;) {
		if (existsSync(join(current, "package.json"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}
