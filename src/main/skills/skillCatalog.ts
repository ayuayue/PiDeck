import { open, readdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DshSkillView } from "../../shared/types";

/**
 * 通用技能目录扫描（Phase 1：DSH 文件系统 provider 的只读预览层）。
 *
 * 背景：DSH 的 skill.list 依赖 host 会话，拿不到目录就没法在草稿期展示技能。
 * 但 DSH 的文件系统 provider（@deepseek-ai/dsh-skill-filesystem）规则是稳定且
 * 可复刻的：按 rank 合并 project/user/bundled 根目录，解析 SKILL.md 的 YAML
 * frontmatter（name/description/whenToUse/disable-model-invocation/user-invocable）。
 * 这里把这套「读目录 + 解析 frontmatter + 按 rank 去重」收口成纯函数：
 * - DSH 草稿/冷会话用它做快速预览（不启动 agent、不建 host 会话）；
 * - host 能拿到权威列表时（运行中/已 attach），把权威结果放在前面做并集——
 *   保证「不会少」：host 的 preset/插件技能不会因为文件系统扫描缺席。
 *
 * 为什么不用 Go sidecar：每个技能只需要读前 64KiB frontmatter，典型一个项目
 * 几十个 SKILL.md，Node 冷扫毫秒级且带缓存；等出现「全量技能 >500 / 冷扫 >50ms」
 * 这类信号再按 GoSidecarClient 规范迁移。
 */

/** 一个技能根目录：rank 越小优先级越高（与 DSH provider 的 rank 对齐）。 */
export type SkillRoot = {
	path: string;
	rank: number;
	/** 来源标识（与 DSH provider 的 source 对齐：project-dsh / project-agents / user-dsh / ...）。 */
	source: string;
	/** user-dsh 根要跳过 host 自己的 <root>/.system 技能。 */
	skipSystem?: boolean;
};

/** 扫描得到的技能元数据（不读正文）。 */
export type ScannedSkillEntry = {
	name: string;
	description: string;
	whenToUse?: string;
	/** false = disable-model-invocation: true（仅用户可调用）。 */
	modelInvocable: boolean;
	/** false = user-invocable: false（宿主列表也会过滤掉）。 */
	userInvocable: boolean;
	source: string;
	rank: number;
	path: string;
	dir: string;
};

/** DSH filesystem provider 的根目录 rank（dsh-skill-filesystem/lib 常量对齐）。 */
export const DSH_SKILL_ROOT_RANKS = {
	projectDsh: 100,
	projectAgents: 200,
	custom: 300,
	userDsh: 400,
	userAgents: 500,
	bundled: 600,
} as const;

/** DSH 技能名合法形态（dsh-skill 的 SKILL_NAME 正则）。 */
const DSH_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** frontmatter 只读上限：技能元数据在文件头，正文不进内存（资源边界）。 */
const FRONTMATTER_READ_LIMIT = 64 * 1024;

/** 扫描 IO 抽象：生产用真实 fs，单测用内存假实现（不测 node 版本行为）。 */
export type SkillScanIo = {
	listDirectory: (path: string) => Promise<Array<{ name: string; type: "directory" | "file" }>>;
	readTextHead: (path: string, limit: number) => Promise<string | undefined>;
};

/** 解析 SKILL.md 的 YAML frontmatter（pi 与 DSH 共用同一形状，仅布尔键语义统一）。 */
export function parseSkillFrontmatter(raw: string): { name?: string; description?: string; whenToUse?: string; modelInvocable: boolean; userInvocable: boolean } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const data: Record<string, string> = {};
	if (match) {
		for (const line of match[1].split(/\r?\n/)) {
			const index = line.indexOf(":");
			if (index === -1) continue;
			const key = line.slice(0, index).trim();
			const value = line
				.slice(index + 1)
				.trim()
				.replace(/^['"]|['"]$/g, "");
			if (key) data[key] = value;
		}
	}
	const name = data.name?.trim() || undefined;
	const description = data.description?.trim() || undefined;
	const whenToUse = data.whenToUse?.trim() || undefined;
	// DSH 用 disable-model-invocation / user-invocable；pi 的 disable-model-invocation 同义。
	const modelInvocable = data["disable-model-invocation"] !== "true";
	const userInvocable = data["user-invocable"] !== "false";
	return { ...(name ? { name } : {}), ...(description ? { description } : {}), ...(whenToUse ? { whenToUse } : {}), modelInvocable, userInvocable };
}

/** 默认扫描 IO：readdir 只取名字与类型；frontmatter 用句柄读前 64KiB（不整文件读入）。 */
const nodeSkillScanIo: SkillScanIo = {
	async listDirectory(path) {
		const entries = await readdir(path, { withFileTypes: true, encoding: "utf8" });
		return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
	},
	async readTextHead(path, limit) {
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(limit);
			const { bytesRead } = await handle.read(buffer, 0, limit, 0);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	},
};

/**
 * 扫描单个技能根：目录 bundle（<dir>/SKILL.md）与根层扁平 markdown（<root>/x.md）。
 * 单个根/单条技能的 IO 错误只跳过该项，不让一个坏目录拖垮整套目录预览。
 */
export async function scanSkillRoot(root: SkillRoot, io: SkillScanIo = nodeSkillScanIo): Promise<ScannedSkillEntry[]> {
	let entries: Array<{ name: string; type: "directory" | "file" }>;
	try {
		entries = await io.listDirectory(root.path);
	} catch {
		return [];
	}
	const skills: ScannedSkillEntry[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (root.skipSystem && entry.name === ".system") continue;
		const skillFile = entry.type === "directory" ? join(root.path, entry.name, "SKILL.md") : entry.type === "file" && entry.name.endsWith(".md") ? join(root.path, entry.name) : undefined;
		if (skillFile === undefined) continue;
		let raw: string | undefined;
		try {
			raw = await io.readTextHead(skillFile, FRONTMATTER_READ_LIMIT);
		} catch {
			continue;
		}
		if (raw === undefined) continue;
		const parsed = parseSkillFrontmatter(raw);
		if (!parsed.name || !parsed.description) continue;
		skills.push({
			name: parsed.name,
			description: parsed.description,
			...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
			modelInvocable: parsed.modelInvocable,
			userInvocable: parsed.userInvocable,
			source: root.source,
			rank: root.rank,
			path: skillFile,
			dir: entry.type === "directory" ? join(root.path, entry.name) : root.path,
		});
	}
	return skills;
}

/** 扫描多个根并按 rank 去重：同名技能 rank 小者胜（与 DSH provider 优先级一致）。 */
export async function scanSkillRoots(roots: readonly SkillRoot[], io: SkillScanIo = nodeSkillScanIo): Promise<ScannedSkillEntry[]> {
	const winner = new Map<string, ScannedSkillEntry>();
	for (const root of [...roots].sort((a, b) => a.rank - b.rank)) {
		for (const skill of await scanSkillRoot(root, io)) {
			const key = skill.name.toLowerCase();
			const previous = winner.get(key);
			if (!previous || skill.rank < previous.rank) winner.set(key, skill);
		}
	}
	return [...winner.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 从 cwd 向上找最近的 .git 祖先（DSH 的 project root 规则；找不到时回退 cwd 本身）。 */
export async function resolveSkillProjectRoot(
	cwd: string,
	pathExists: (path: string) => Promise<boolean> = async (path) =>
		access(path).then(
			() => true,
			() => false,
		),
): Promise<string> {
	const start = resolve(cwd);
	let current = start;
	for (;;) {
		if (await pathExists(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

/** DSH 文件系统技能根清单（与 dsh-skill-filesystem.roots() 对齐）。 */
export function dshSkillRoots(input: { projectRoot?: string; dshHome: string; agentsHome?: string; customSkillDirs?: readonly string[]; bundledSkillDir?: string }): SkillRoot[] {
	const roots: SkillRoot[] = [];
	if (input.projectRoot) {
		roots.push({ path: join(input.projectRoot, ".dsh", "skills"), rank: DSH_SKILL_ROOT_RANKS.projectDsh, source: "project-dsh" });
		roots.push({ path: join(input.projectRoot, ".agents", "skills"), rank: DSH_SKILL_ROOT_RANKS.projectAgents, source: "project-agents" });
	}
	for (const dir of input.customSkillDirs ?? []) roots.push({ path: dir, rank: DSH_SKILL_ROOT_RANKS.custom, source: "custom" });
	roots.push({ path: join(input.dshHome, "skills"), rank: DSH_SKILL_ROOT_RANKS.userDsh, source: "user-dsh", skipSystem: true });
	roots.push({ path: join(input.agentsHome ?? join(homedir(), ".agents"), "skills"), rank: DSH_SKILL_ROOT_RANKS.userAgents, source: "user-agents" });
	if (input.bundledSkillDir) roots.push({ path: input.bundledSkillDir, rank: DSH_SKILL_ROOT_RANKS.bundled, source: "bundled" });
	return roots;
}

/** 扫描 DSH 文件系统技能并转成渲染层视图（过滤 user-invocable:false 与非法名，与 host skills/list 一致）。 */
export async function listDshFilesystemSkills(input: { projectPath: string; dshHome: string; agentsHome?: string; customSkillDirs?: readonly string[]; bundledSkillDir?: string; io?: SkillScanIo }): Promise<DshSkillView[]> {
	const projectRoot = await resolveSkillProjectRoot(input.projectPath);
	const entries = await scanSkillRoots(dshSkillRoots({ ...input, projectRoot }), input.io);
	return entries.filter((skill) => skill.userInvocable && DSH_SKILL_NAME.test(skill.name)).map((skill) => ({ name: skill.name, description: skill.description, ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}), modelInvocable: skill.modelInvocable }));
}
