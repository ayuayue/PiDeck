/**
 * DSH 后端的 fork/clone：在 catalog 里**新建一条会话记录**，把运行时换绑过去。
 *
 * 为什么不能沿用「原地换绑」：DSH 的 session.fork 会在 host 侧生成新的 host 会话，
 * 旧 host 会话仍在 $DSH_HOME 磁盘上。只把当前 catalog 条目的 dshSessionId 改成新会话，
 * 用户看到的还是同一条会话（历史被截断）、侧栏永远只有一条——issue #381 的现场。
 * 旧 host 会话随后会被 DSH 外部会话同步当成未映射会话重新导入，变成标题不同的重复项。
 *
 * 与 pi fork 对齐的语义：
 * - 原条目保持原名、原 dshSessionId（列表里继续可见）；
 * - 新条目 = 复制源条目的项目/环境/模型/思考档位/预设，标题写 (fork) 后缀，标记 forked；
 * - 运行时绑定（agentId ↔ SessionRecord）原子地移到新条目，旧会话解绑；
 * - DSH 的标题权威在 host：新标题必须回写 host（rename），否则 attach/title 事件会把
 *   刚写入的 (fork) 名覆盖回源会话名（pi 侧同样是物理写入会话名）。
 */
import type { SessionEnvironment, SessionModelPreference, SessionRuntimeTarget, SessionSource } from "../../shared/types";
import type { SessionCatalogEntry } from "./SessionCatalog";
import type { SessionRuntimeBinding } from "./SessionRuntimeCoordinator";
import { appendSessionForkSuffix } from "./sessionForkTitle";

/** DSH host 侧 fork/clone 需要的最小网关（DshAgentManager 结构兼容）。 */
export type DshForkAgentGateway = {
	list(): Array<{ id: string; sessionId?: string; title?: string; agentPreset?: string }>;
	forkSession(agentId: string, entryId: string): Promise<{ text?: string }>;
	cloneSession(agentId: string): Promise<{ text?: string }>;
	/** host 会话改名（标题权威在 host）；缺失时只保留 catalog 标题。 */
	rename?(agentId: string, name: string): Promise<{ title?: string } | undefined>;
};

/** catalog 侧最小依赖：读取源条目 + 新建 fork 条目。 */
export type DshForkCatalogGateway = {
	get(sessionId: string): SessionCatalogEntry | undefined;
	createDraft(input: {
		projectId: string;
		title: string;
		environment: SessionEnvironment;
		source?: SessionSource;
		backend?: "dsh";
		model?: SessionModelPreference;
		thinkingLevel?: string;
		permissionPreset?: string;
		agentPreset?: string;
		sideTask?: boolean;
		titleOrigin?: "manual";
		dshSessionId?: string;
		forked?: boolean;
	}): Promise<{ id: string }>;
};

/** 协调器侧最小依赖：replacement 流程负责解绑/换绑与代次。 */
export type DshForkCoordinatorGateway = {
	replaceBoundRuntime<T extends { cancelled?: boolean }>(input: {
		agentId: string;
		replace: () => Promise<T>;
		resolveTargetSessionId: (result: T) => Promise<string>;
		canRestoreOrigin: () => boolean;
		onDetached: (binding: SessionRuntimeBinding) => void;
		onAttached: (binding: SessionRuntimeBinding) => void;
		onRestored: (binding: SessionRuntimeBinding) => void;
	}): Promise<T & { targetSessionId?: string }>;
};

export type DshSessionForkDeps = {
	catalog: DshForkCatalogGateway;
	agents: DshForkAgentGateway;
	coordinator: DshForkCoordinatorGateway;
	/** (fork) 后缀（i18n）：惰性取值，装配期 i18n 可能尚未就绪。 */
	forkedSuffix: () => string;
	onDetached: (binding: SessionRuntimeBinding) => void;
	onAttached: (binding: SessionRuntimeBinding) => void;
	onRestored: (binding: SessionRuntimeBinding) => void;
	/** (fork) 标题写回 host 失败：与 pi 侧同款可见提示（提示用户手动重命名补后缀）。 */
	onTitleRenameFailed?: () => void;
	logger?: { warn(scope: string, message: string, data?: Record<string, unknown>): unknown };
};

export type DshSessionFork = {
	fork(target: SessionRuntimeTarget, entryId: string): Promise<{ text?: string; targetSessionId?: string }>;
	clone(target: SessionRuntimeTarget): Promise<{ text?: string; targetSessionId?: string }>;
};

export function createDshSessionFork(deps: DshSessionForkDeps): DshSessionFork {
	/** fork 出来的 host 会话 → 新 catalog 条目；返回新条目 id 交给 replacement 换绑。 */
	const createForkEntry = async (target: SessionRuntimeTarget, origin: SessionCatalogEntry): Promise<string> => {
		const tab = deps.agents.list().find((candidate) => candidate.id === target.agentId);
		if (!tab?.sessionId) {
			throw new Error(`Replacement runtime has no session id: ${target.agentId}`);
		}
		// 标题取 host runtime 的当前标题（DSH 的权威名），catalog 只是镜像；空值回退 catalog。
		const baseTitle = tab.title?.trim() || origin.title;
		const title = appendSessionForkSuffix(baseTitle, deps.forkedSuffix());
		const created = await deps.catalog.createDraft({
			projectId: origin.projectId,
			title,
			environment: origin.environment,
			source: origin.source,
			backend: "dsh",
			model: origin.model,
			thinkingLevel: origin.thinkingLevel,
			// fork 出的 host 会话沿用源会话的权限/预设；不继承会让新会话以默认权限打开。
			permissionPreset: origin.permissionPreset,
			agentPreset: tab.agentPreset ?? origin.agentPreset,
			sideTask: origin.sideTask,
			titleOrigin: "manual",
			dshSessionId: tab.sessionId,
			forked: true,
		});
		// 标题写回 host：DSH attach / session/title 事件会把 catalog 标题覆盖成 host 名，
		// 不回写的话 (fork) 后缀只活到下一次 attach。失败不阻断 fork（pi 侧同款降级）。
		if (deps.agents.rename) {
			// DshAgentManager.rename 在 host 拒绝时不抛错（只返回旧 tab）：必须核对回传标题，
			// 否则失败被吞掉，用户只能等到下次 attach 被覆盖回原名时才发现后缀没了。
			let renameError: unknown;
			try {
				const renamed = await deps.agents.rename(target.agentId, title);
				if (!renamed || (typeof renamed.title === "string" && renamed.title !== title)) renameError = new Error("host kept the previous title");
			} catch (error) {
				renameError = error;
			}
			if (renameError) {
				void deps.logger?.warn("session", "DSH fork title rename failed", {
					sessionId: target.sessionId,
					agentId: target.agentId,
					title,
					error: renameError instanceof Error ? renameError.message : String(renameError),
				});
				deps.onTitleRenameFailed?.();
			}
		}
		return created.id;
	};

	const replaceWithFork = async (target: SessionRuntimeTarget, run: () => Promise<{ cancelled?: boolean; text?: string }>): Promise<{ cancelled?: boolean; text?: string; targetSessionId?: string }> => {
		const origin = deps.catalog.get(target.sessionId);
		if (!origin) throw new Error(`Session not found: ${target.sessionId}`);
		const restoredHostSessionId = origin.dshSessionId;
		return deps.coordinator.replaceBoundRuntime({
			agentId: target.agentId,
			replace: run,
			resolveTargetSessionId: () => createForkEntry(target, origin),
			// fork RPC 失败时 manager 仍指向源 host 会话 → 回滚绑定；已经换到新会话则 fail-closed。
			canRestoreOrigin: () => deps.agents.list().find((candidate) => candidate.id === target.agentId)?.sessionId === restoredHostSessionId,
			onDetached: deps.onDetached,
			onAttached: deps.onAttached,
			onRestored: deps.onRestored,
		});
	};

	return {
		fork: (target, entryId) => replaceWithFork(target, () => deps.agents.forkSession(target.agentId, entryId)),
		clone: (target) => replaceWithFork(target, () => deps.agents.cloneSession(target.agentId)),
	};
}
