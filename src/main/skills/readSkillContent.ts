import { open } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

const MAX_SKILL_CONTENT_BYTES = 64 * 1024;

export type SkillContentDeps = {
	/** 全局技能目录（~/.pi/agent/skills、~/.agents/skills；WSL 时为主机路径）。 */
	globalSkillPaths: string[];
	/** 已注册项目根路径（装配层已转换为可读的主机路径）。 */
	projectRootPaths: string[];
};

/**
 * 读取技能 SKILL.md 正文（技能选择器「查看详情 / 插入全文」用）。
 * 只读 + 路径白名单：目录必须落在全局技能位置或某项目 `.pi/skills` / `.agents/skills`
 * 之下，渲染层传入的任意路径一律拒绝——IPC 边界输入不可信（安全约束 #2）。
 */
export async function readSkillContent(skillPath: string, deps: SkillContentDeps): Promise<{ content: string }> {
	const normalized = normalize(skillPath);
	const allowedPrefixes = [...deps.globalSkillPaths, ...deps.projectRootPaths.flatMap((root) => [join(root, ".pi", "skills"), join(root, ".agents", "skills")])];
	const inside = allowedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix + sep));
	if (!inside) {
		throw new Error("Skill path is outside allowed skill locations");
	}
	// 只读文件头 64KB：正文用途是预览/插入，不需要更多；
	// 用句柄定位读代替「全量读入再 slice」，避免超大 SKILL.md 把整文件拉进内存（资源边界约束）。
	const handle = await open(skillPath, "r");
	try {
		const buf = Buffer.alloc(MAX_SKILL_CONTENT_BYTES);
		const { bytesRead } = await handle.read(buf, 0, MAX_SKILL_CONTENT_BYTES, 0);
		const content = buf.subarray(0, bytesRead).toString("utf8");
		return { content };
	} finally {
		await handle.close();
	}
}
