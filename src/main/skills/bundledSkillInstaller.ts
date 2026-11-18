/**
 * 内置技能模板安装 / 退役（从 SkillManager 拆出的新逻辑）。
 *
 * 为什么独立成模块：SkillManager 是存量巨文件（行数只准降不准升），
 * 模板安装现在要同步 SKILL.md + references/、处理覆盖层回落与旧目录退役，
 * 继续堆在 SkillManager 里会让它净增长。这里只依赖注入进来的路径与纯函数。
 */
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { trashPath } from "../fs/trash";

const SKILL_FILE = "SKILL.md";

export type BundledSkillInstallResult = { success: true; path: string } | { success: false; error: string };

export interface BundledSkillInstallOptions {
	skillName: string;
	/** 目标技能目录（<技能根>/<技能名>）。 */
	targetDir: string;
	/** 旧版本装在 pi 全局技能根里的目录；只在装进 pideck-global 时给。 */
	legacyDir: string | null;
	/** 生效的热更新覆盖层目录（结构同 resources/skills）；无有效覆盖层时为 null。 */
	overlayDir: string | null;
	/** 打包态为 process.resourcesPath，开发态为 <appPath>/resources。 */
	resourcesRoot: string;
	/** SKILL.md frontmatter 解析（与 SkillManager 列表解析同一实现）。 */
	parseFrontmatter: (raw: string) => Record<string, string>;
}

/**
 * 把随包分发的技能模板（resources/skills/<name>/）落到用户目录。
 *
 * 安装内容是 SKILL.md + references/：路由技能的正文按任务拆在 references/ 下，
 * 漏装引用文件时 SKILL.md 还在、路由却指向不存在的文件。references 按「逐文件覆盖 +
 * 删除模板里没有的旧文件」同步，旧版本删掉的参考不会留在用户目录。
 * 幂等覆盖：模板随应用更新同步；`disable-model-invocation` 是用户手动设置的
 * 「仅手动调用」标记，覆盖时保留。
 */
export async function installBundledSkillTemplate(options: BundledSkillInstallOptions): Promise<BundledSkillInstallResult> {
	const { skillName, targetDir, legacyDir, overlayDir, resourcesRoot, parseFrontmatter } = options;
	try {
		if (legacyDir) await migrateLegacyBundledSkill(legacyDir, targetDir);
		// 覆盖层优先：热更新把有差异的技能写进 userData/skills-overlay（结构同
		// <builtin>/skills/<name>/），安装时读生效源，避免「更新成功但装旧模板」。
		// 覆盖层是整包快照：远端清单换了技能名时（例如四个技能合并成 pideck），旧版客户端
		// 仍会按旧名来装，而新快照里没有那个目录。逐技能回落打包模板，避免「更新成功后
		// 技能反而消失」。
		const sourceDir = await resolveSkillTemplateDir([overlayDir, join(resourcesRoot, "skills")], skillName);
		const content = await readFile(join(sourceDir, SKILL_FILE), "utf8");
		await mkdir(targetDir, { recursive: true });
		const targetPath = join(targetDir, SKILL_FILE);
		// 模板正文随应用更新同步；用户自行设置的 user-only 标记仍需保留。
		const previous = await readFile(targetPath, "utf8").catch(() => null);
		const wasUserOnly = previous !== null && parseFrontmatter(previous)["disable-model-invocation"] === "true";
		await writeFile(targetPath, content, "utf8");
		if (wasUserOnly) {
			await writeFile(targetPath, setFrontmatterBoolean(content, "disable-model-invocation", true), "utf8");
		}
		await syncSkillReferences(join(sourceDir, "references"), join(targetDir, "references"));
		return { success: true, path: targetPath };
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 退役已并入其他技能的内置技能目录（只处理 pideck-global 下的普通目录）。
 * 走系统回收站，可恢复；软链/普通文件不是 PiDeck 建的（技能库工具会把库里的技能链进来），
 * 原样保留。返回结果供启动日志点名，调用方不需要为此阻塞启动。
 */
export async function retireBundledSkillDirs(names: readonly string[], skillsRoot: string | null): Promise<{ removed: string[]; failed: Array<{ name: string; error: string }> }> {
	const removed: string[] = [];
	const failed: Array<{ name: string; error: string }> = [];
	if (!skillsRoot) return { removed, failed };
	for (const name of names) {
		const dir = join(skillsRoot, name);
		const entry = await lstat(dir).catch(() => null);
		if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) continue;
		try {
			await trashPath(dir, { source: "skills:retire-bundled" });
			removed.push(name);
		} catch (error) {
			failed.push({ name, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { removed, failed };
}

/** 按优先级找一个带 SKILL.md 的模板目录（覆盖层 → 打包 resources）。
 *  覆盖层有效但里面没有这个技能时回落打包副本，而不是直接报「文件不存在」。 */
async function resolveSkillTemplateDir(bases: Array<string | null>, skillName: string): Promise<string> {
	for (const base of bases) {
		if (!base) continue;
		const candidate = join(base, skillName);
		const entry = await stat(join(candidate, SKILL_FILE)).catch(() => null);
		if (entry?.isFile()) return candidate;
	}
	throw new Error(`Bundled skill template not found: ${skillName}`);
}

/** 逐文件同步参考目录：模板里有的覆盖，模板里没有的旧文件删掉。
 *  源目录不存在（例如 mcp-setup 没有 references）时不动目标目录——那可能是用户自己的附件。
 *  源里出现软链或特殊文件说明安装源坏了，直接报错；目标侧的脏条目只让本轮跳过清理。 */
async function syncSkillReferences(sourceDir: string, targetDir: string): Promise<void> {
	const sourceEntry = await lstat(sourceDir).catch(() => null);
	if (!sourceEntry) return;
	if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) throw new Error(`Skill references source is not a directory: ${sourceDir}`);
	const files = await collectSkillReferenceFiles(sourceDir);
	const wanted = new Set(files);
	for (const rel of files) {
		const target = join(targetDir, rel);
		await mkdir(dirname(target), { recursive: true });
		await cp(join(sourceDir, rel), target, { force: true });
	}
	for (const rel of await collectSkillReferenceFiles(targetDir).catch(() => [] as string[])) {
		if (!wanted.has(rel)) await rm(join(targetDir, rel), { force: true });
	}
}

/** 递归列出参考目录下的普通文件（相对路径，正斜杠）。非普通文件抛错，由调用方决定是否吞下。 */
async function collectSkillReferenceFiles(root: string, prefix = ""): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		const full = join(root, entry.name);
		if (entry.isDirectory()) out.push(...(await collectSkillReferenceFiles(full, rel)));
		else if (entry.isFile()) out.push(rel);
		else throw new Error(`Skill references contains an unsupported entry: ${full}`);
	}
	return out;
}

/**
 * 迁移旧版本装在 `~/.pi/agent/skills/<name>` 的内置技能。
 *
 * 只搬 PiDeck 自己创建的普通目录：软链（技能库工具会把库里的技能链进来）和普通文件
 * 都不是 PiDeck 建的，搬/删会破坏用户配置，原样留给用户处理。
 * 迁移失败不阻断安装：新副本照常落到内置目录，旧副本只是继续对 TUI 可见。
 */
async function migrateLegacyBundledSkill(legacyDir: string, targetDir: string): Promise<void> {
	if (await lstat(targetDir).catch(() => null)) return;
	const entry = await lstat(legacyDir).catch(() => null);
	if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) return;
	await mkdir(dirname(targetDir), { recursive: true });
	await rename(legacyDir, targetDir).catch(() => undefined);
}

/** 更新 frontmatter 中的布尔字段；原 frontmatter 缺该字段时追加。 */
function setFrontmatterBoolean(raw: string, key: string, value: boolean): string {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return `---\n${key}: ${value}\n---\n\n${raw}`;
	const lines = match[1].split(/\r?\n/);
	let changed = false;
	const nextLines = lines.map((line) => {
		if (!line.trim().startsWith(`${key}:`)) return line;
		changed = true;
		return `${key}: ${value}`;
	});
	if (!changed) nextLines.push(`${key}: ${value}`);
	return raw.replace(match[0], `---\n${nextLines.join("\n")}\n---`);
}
