import type { AgentBackend, DshSkillView } from "../../shared/types";
import { mergeSkillCatalog } from "../../shared/skillCatalog";

/**
 * DSH 会话的技能目录加载器（共享文件系统扫描 + host 权威结果并集）。
 *
 * 背景：DSH 的 `skill.list` 只接受 host sessionId（dsh-host-apiproxy 里先
 * `ctx.sessions.get(sessionId)` 再取 cwd + preset standing scope），而 PiDeck 之前要等会话
 * 激活、拿到 runtime.sessionId 才去列技能——于是草稿会话的技能选择器只能显示
 * 「技能目录需要会话启动后才能读取」。
 *
 * 现在的分层：
 * 1. **文件系统扫描**（`skillCatalog`，pi/dsh 通用的读 SKILL.md 逻辑）：草稿/冷会话
 *    快速拿到本地根目录技能，不启动 agent、不依赖 host——DSH 完全没装好时也能搜到。
 * 2. **host 权威结果**：能拿到时（运行中/已 attach；草稿则懒建 host 会话）放在并集前面，
 *    preset 自带技能、插件 provider 技能一个不少；扫描只补 host 没有的名字。
 *
 * 草稿首次读目录时懒建 host 会话（带草稿预选的 agentPreset）并回写 catalog 的
 * dshSessionId——之后真正发送时 DSH 激活会 attach 同一个会话，不会另起炉灶。
 * host 重启/应用重启后旧会话不再 attached（session-not-found）：草稿可安全换新会话
 * （尚无消息），旧 id 记删除墓碑避免外部会话自动同步导回；历史会话不能换新 id，
 * 此时直接退回文件系统扫描结果（至少「能搜到」，启动 runtime 后再以 host 为准）。
 */

/** loader 需要的最小 catalog 条目视图。 */
export type DshSessionSkillEntry = {
	backend?: AgentBackend;
	status?: "draft" | "active";
	noSession?: boolean;
	projectId: string;
	dshSessionId?: string;
	agentPreset?: string;
};

export type DshSessionSkillLoaderDeps = {
	getEntry: (deckSessionId: string) => DshSessionSkillEntry | undefined;
	getProjectPath: (projectId: string) => string | undefined;
	/** 共享文件系统扫描（skillCatalog）：返回本地根目录技能；失败必须返回空数组而不是抛。 */
	scanFilesystem: (entry: DshSessionSkillEntry) => Promise<DshSkillView[]>;
	/** 建一个可 attach 的 host 会话（不启动 agent）。 */
	ensureHostSession: (cwd: string, agentPreset?: string) => Promise<{ sessionId: string; agentPreset?: string }>;
	/** 把 host 会话 id 回写 catalog（保持草稿状态，不 promoteToActive）；host 修正后的 preset 一并回写。 */
	attachHostSession: (deckSessionId: string, dshSessionId: string, agentPreset?: string) => Promise<void>;
	/** 旧 host 会话作废：记删除墓碑，阻止外部会话自动同步导回。 */
	dismissHostSession: (dshSessionId: string) => Promise<void>;
	listSkills: (dshSessionId: string) => Promise<DshSkillView[]>;
};

/** 会话级技能目录不可用（不是「启动后才有」的普通阻塞，而是数据/环境问题）。 */
export class DshSessionSkillsUnavailableError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DshSessionSkillsUnavailableError";
		this.code = code;
	}
}

/** host 侧「该会话未 attach」错误（dsh-host-apiproxy 的 session-not-found）。 */
export function isUnattachedDshSessionError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = (error as { code?: unknown }).code;
	return code === "session-not-found";
}

/**
 * 构造「读 DSH 会话技能目录」入口：扫描结果永远在；host 结果能拿到就并到前面。
 */
export function createDshSessionSkillLoader(deps: DshSessionSkillLoaderDeps): (deckSessionId: string) => Promise<DshSkillView[]> {
	return async function loadDshSessionSkills(deckSessionId: string): Promise<DshSkillView[]> {
		const entry = deps.getEntry(deckSessionId);
		if (!entry || entry.backend !== "dsh") {
			throw new DshSessionSkillsUnavailableError("not-dsh-session", "Skill catalog is only available for DSH sessions");
		}
		// 匿名 DSH 会话没有持久化 host 会话（transient 条目），不扫描。
		if (entry.noSession) {
			throw new DshSessionSkillsUnavailableError("anonymous-session", "Skill catalog is not available for anonymous sessions");
		}
		const cwd = deps.getProjectPath(entry.projectId);
		if (!cwd) {
			throw new DshSessionSkillsUnavailableError("project-missing", "Project directory is unavailable");
		}

		// 预览层：文件系统扫描永远先做，且必须不抛（坏目录/无权限只跳过）。
		const scanned = await deps.scanFilesystem(entry).catch(() => []);

		// 已激活但没有 host 会话 id（理论上不存在；导入异常条目）：给扫描结果即可。
		if (entry.status !== "draft" && !entry.dshSessionId) return scanned;

		try {
			const authoritative = await listAuthoritative(deps, entry, deckSessionId, cwd);
			return mergeSkillCatalog(authoritative, scanned);
		} catch (error) {
			// host 失败但本地还能扫到：返回扫描结果（保证「能搜到」），不把面板打成错误态。
			if (entry.status !== "draft") return scanned;
			if (scanned.length > 0) return scanned;
			throw error;
		}
	};
}

/** host 权威列表：草稿可懒建/换绑 host 会话；历史会话只能用已存在的 host id。 */
async function listAuthoritative(deps: DshSessionSkillLoaderDeps, entry: DshSessionSkillEntry, deckSessionId: string, cwd: string): Promise<DshSkillView[]> {
	if (entry.status !== "draft") {
		// 已 attach 的 host 会话（运行中或 stop 后仍挂载）可直接列；未 attach 交给外层走扫描兜底。
		if (!entry.dshSessionId) throw new DshSessionSkillsUnavailableError("session-started-required", "Start the session before reading the skill catalog");
		return deps.listSkills(entry.dshSessionId);
	}

	const existing = entry.dshSessionId;
	if (existing) {
		try {
			return await deps.listSkills(existing);
		} catch (error) {
			// 只有「未 attach」可以在草稿上安全换新会话；其余错误（registry 缺失等）交给外层用扫描兜底。
			if (!isUnattachedDshSessionError(error)) throw error;
		}
	}

	const created = await deps.ensureHostSession(cwd, entry.agentPreset);
	if (existing && existing !== created.sessionId) await deps.dismissHostSession(existing);
	// host 可能把无效的草稿预选修正为部署默认：catalog 立即以 host 实际组合为准。
	await deps.attachHostSession(deckSessionId, created.sessionId, created.agentPreset);
	return deps.listSkills(created.sessionId);
}
