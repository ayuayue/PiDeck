/**
 * 会话 fork/clone 命令统一中间层（桌面 IPC 与 Web HTTP 共用）。
 *
 * 背景：此前桌面端（sessionIpc）与 Web 端（WebServiceManager deps）各自实现了一份
 * fork/clone——桌面走 replaceAgentSession（catalog ensureRuntimeTarget + fork 标记 +
 * supersededBy 隐藏 + catalog 刷新广播），Web 只发裸 /fork RPC（旧会话不隐藏、绑定不
 * 刷新、列表出现重复会话）。重发/编辑 fork 化语义必须两端一致，因此把整条命令链
 * 收口到这里：任何入口（桌面/Web/外部端）发起的 fork/clone 都经过同一份实现。
 *
 * 语义（与迁移前桌面行为逐条对齐）：
 * - pi：replaceAgentSession → agentManager.forkSession(agentId, entryId)；
 *   mutationFork && !branchMode（尾部重发/编辑替换）→ markSuperseded（旧会话从列表
 *   隐藏，文件保留可恢复）；显式分支/普通 fork → markForked（子会话带 (fork) 后缀）。
 * - DSH：replaceDshAgentSession（dshSessionFork.ts）→ 新建 catalog 条目（(fork) 标题、
 *   forked 标记、新 dshSessionId），replacement 流程把 agentId 换绑到新条目；原条目保留。
 *   旧实现只回写当前条目的 dshSessionId（原地换绑），侧栏始终一条 → issue #381 后续。
 *   mutationFork 明确不支持 DSH。
 * - 成功后回调 notifyForkCatalogRefreshed：桌面主窗口收 sessionsCatalogRefreshed，
 *   Web SSE 由快照 diff 兜底（前端在命令返回后也会显式刷新）。
 */
import type { SessionCommandResult, SessionRuntimeTarget, SessionTargetedValue } from "../../shared/types";

/** 重发/编辑 fork 化重试标记：mutationFork=尾部替换（隐藏旧会话）；branchMode=分支保留。 */
export type ForkRuntimeSessionOptions = { mutationFork?: boolean; branchMode?: boolean };

/** fork/clone 命令结果载荷（与 preload sessionsRuntimeFork 的类型声明同形）。 */
export type SessionForkValue = {
	cancelled?: boolean;
	text?: string;
	targetSessionId?: string;
	[key: string]: unknown;
};

/** fork/clone 命令结果（与 preload sessionsRuntimeFork 的类型声明同形）。 */
export type SessionForkResult = SessionCommandResult<SessionForkValue>;

/** replaceAgentSession 返回 unknown，这里按最小结构收窄（非对象→空载荷），
 * 避免 as 直转；与主进程其它 SessionCommandResult 包装同风格。 */
function toForkValue(value: unknown): SessionForkValue {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as SessionForkValue) : {};
}

export interface SessionForkCommandDeps {
	/** 校验 runtime target 并取 lease 保护（与桌面 sessionIpc 同款入口）。 */
	sessionRuntimeCoordinator: {
		validateTarget(target: SessionRuntimeTarget): SessionCommandResult<SessionTargetedValue<unknown>> | { ok: true; value: unknown };
	};
	agentManager: {
		forkSession(agentId: string, entryId: string): Promise<unknown>;
		cloneSession(agentId: string): Promise<unknown>;
	};
	/** pi fork/clone 专用：RPC 成功后刷新 sessionPath/消息投影并换绑 catalog。 */
	replaceAgentSession: (agentId: string, replace: () => Promise<unknown>, options?: { markForked?: boolean; markSuperseded?: boolean }) => Promise<unknown>;
	/** 判断 agentId 是否属于 DSH 后端（fork 等 pi 专属命令按 backend 分流）。 */
	isDshAgent: (agentId: string) => boolean;
	/** DSH fork：session.fork 裁剪 + 新建 catalog 条目 + runtime 换绑到新条目。未装配时抛错。 */
	replaceDshAgentSession?: (target: SessionRuntimeTarget, entryId: string) => Promise<unknown>;
	/** DSH clone：fork 无锚点（完整副本）+ 新建 catalog 条目 + runtime 换绑。未装配时抛错。 */
	replaceDshCloneSession?: (target: SessionRuntimeTarget) => Promise<unknown>;
	logger: { info(channel: string, message: string, data?: Record<string, unknown>): unknown };
	/** fork/clone 成功后的 catalog 刷新广播（桌面主窗口；Web 走 SSE 快照 diff）。 */
	notifyForkCatalogRefreshed: (sessionId: string) => void;
}

export type SessionForkCommands = {
	forkRuntimeSession: (target: SessionRuntimeTarget, entryId: string, options?: ForkRuntimeSessionOptions) => Promise<SessionForkResult>;
	cloneRuntimeSession: (target: SessionRuntimeTarget) => Promise<SessionForkResult>;
};

function forkCommandError(error: unknown): { ok: false; error: { code: "SESSION_COMMAND_FAILED"; debugDetails: string } } {
	return {
		ok: false as const,
		error: {
			code: "SESSION_COMMAND_FAILED" as const,
			debugDetails: error instanceof Error ? error.message : String(error),
		},
	};
}

export function createSessionForkCommands(deps: SessionForkCommandDeps): SessionForkCommands {
	const forkRuntimeSession = async (target: SessionRuntimeTarget, entryId: string, options?: ForkRuntimeSessionOptions): Promise<SessionForkResult> => {
		const validated = deps.sessionRuntimeCoordinator.validateTarget(target);
		if (!validated.ok) return validated;
		// fork 化重试标记（重发/编辑迁移用）：只认显式 true，其余值按 false 处理（边界校验）。
		// branchMode：fork 锚点不是最后一条用户消息 → 旧会话保留可见（带 (fork) 后缀），
		// 只有尾部替换才隐藏旧会话（supersededBy）。
		const mutationFork = options?.mutationFork === true;
		const branchMode = options?.branchMode === true;
		try {
			// DSH 后端：fork = session.fork 裁剪出新 host 会话 → 新建 catalog 条目（(fork)
			// 后缀 + forked 标记 + 新 dshSessionId）→ replacement 把 runtime 换绑到新条目。
			// 原条目保留原 dshSessionId，侧栏两条；replacement 内部自带 dispatch lease 检查
			// 与 replacement 预留，fork 期间并发 restart 等命令交错会被拒绝。
			if (deps.isDshAgent(target.agentId)) {
				// 重发/编辑 fork 化迁移明确不覆盖 DSH：mutation fork 只服务 pi 后端
				if (mutationFork) {
					throw new Error("dsh does not support fork-mutation retry");
				}
				if (!deps.replaceDshAgentSession) {
					throw new Error("dsh fork is not available");
				}
				const dshFork = deps.replaceDshAgentSession;
				const value = toForkValue(await dshFork(target, entryId));
				void deps.logger.info("session", "Session forked (dsh)", {
					sessionId: target.sessionId,
					entryId,
				});
				deps.notifyForkCatalogRefreshed(target.sessionId);
				return { ok: true as const, value };
			}
			const value = toForkValue(
				await deps.replaceAgentSession(
					target.agentId,
					() => deps.agentManager.forkSession(target.agentId, entryId),
					// 显式分支 fork 与非尾部重试分支：子会话带 (fork) 后缀、新旧都在列表；
					// 尾部重发/编辑 fork 化：子会话继承原标题，旧会话打 supersededBy 从列表隐藏（文件保留）
					mutationFork && !branchMode ? { markForked: false, markSuperseded: true } : { markForked: true },
				),
			);
			void deps.logger.info("session", "Session forked", { sessionId: target.sessionId, entryId, mutationFork, branchMode });
			deps.notifyForkCatalogRefreshed(target.sessionId);
			return {
				ok: true as const,
				value,
			};
		} catch (error) {
			return forkCommandError(error);
		}
	};

	const cloneRuntimeSession = async (target: SessionRuntimeTarget): Promise<SessionForkResult> => {
		const validated = deps.sessionRuntimeCoordinator.validateTarget(target);
		if (!validated.ok) return validated;
		try {
			// DSH 后端：clone = fork 无锚点（完整副本）→ 新建 catalog 条目 → runtime 换绑；
			// 与 fork 共用 dshSessionFork 的 replacement 约束（lease 检查 + 预留）。
			if (deps.isDshAgent(target.agentId)) {
				if (!deps.replaceDshCloneSession) {
					throw new Error("dsh clone is not available");
				}
				const dshClone = deps.replaceDshCloneSession;
				const value = toForkValue(await dshClone(target));
				void deps.logger.info("session", "Session cloned (dsh)", {
					sessionId: target.sessionId,
				});
				deps.notifyForkCatalogRefreshed(target.sessionId);
				return { ok: true as const, value };
			}
			const value = toForkValue(await deps.replaceAgentSession(target.agentId, () => deps.agentManager.cloneSession(target.agentId), { markForked: true }));
			void deps.logger.info("session", "Session cloned", { sessionId: target.sessionId });
			deps.notifyForkCatalogRefreshed(target.sessionId);
			return {
				ok: true as const,
				value,
			};
		} catch (error) {
			return forkCommandError(error);
		}
	};

	return { forkRuntimeSession, cloneRuntimeSession };
}
