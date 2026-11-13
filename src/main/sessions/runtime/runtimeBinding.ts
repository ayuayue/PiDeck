import type { SessionRuntimeTarget } from "../../../shared/types";
import type { SessionRuntimeBinding } from "../SessionRuntimeCoordinator";
import { SessionRuntimeCommandError } from "./sessionRuntimeCommandError";
import type { SessionCatalogGateway } from "./sessionRuntimeGateways";

/**
 * 会话身份 ↔ 运行实例的绑定表读取 + 代数（generation）判定。
 *
 * 为什么独立成协作对象：本域的每个判定都只**读**三张映射（sessionId→agentId、agentId→sessionId、
 * sessionId→代数）并据此拒绝过期目标，不持有任何状态；写这三张表的仍是宿主（bind / 解绑 / 换绑 /
 * 删除回收各自有独立语义与调用顺序），搬走会变成两份 writer。这里按注入的映射实例读取，正文逐字保留。
 *
 * 宿主（`SessionRuntimeCoordinator`）保留同名薄包装，公开方法签名与调用点都不动；本文件只对宿主做
 * **类型**依赖（`SessionRuntimeBinding`），运行时无环。
 */

/**
 * 协作对象对宿主的需求面。成员名与宿主同名字段/方法一致，搬走的正文因此保持 `this.x` 逐字不变。
 */
export type RuntimeBindingHost = {
	catalog: Pick<SessionCatalogGateway, "get">;
	sessionIdByAgent: Map<string, string>;
	agentIdBySession: Map<string, string>;
	generationBySession: Map<string, number>;
};

export class RuntimeBinding {
	constructor(
		private readonly catalog: RuntimeBindingHost["catalog"],
		private readonly sessionIdByAgent: RuntimeBindingHost["sessionIdByAgent"],
		private readonly agentIdBySession: RuntimeBindingHost["agentIdBySession"],
		private readonly generationBySession: RuntimeBindingHost["generationBySession"],
	) {}

	/**
	 * 激活前合成事件用的当前代数（bind 递增前的值）：IPC 层在激活窗口发 session 级
	 * starting 事件时，需要与渲染层已存的代数对齐才能压住旧 runtime 的迟到事件。
	 */
	currentRuntimeGeneration(sessionId: string): number {
		return this.generationBySession.get(sessionId) ?? 0;
	}

	getRuntimeBinding(agentId: string):
		| {
				sessionId: string;
				runtimeGeneration: number;
		  }
		| undefined {
		const sessionId = this.sessionIdByAgent.get(agentId);
		if (!sessionId || this.agentIdBySession.get(sessionId) !== agentId) return undefined;
		return {
			sessionId,
			runtimeGeneration: this.generationBySession.get(sessionId) ?? 0,
		};
	}

	requireTarget(target: SessionRuntimeTarget): SessionRuntimeBinding {
		// 远端 runtime 同样是可寻址的 target（模型/派生/中断都走 stdio RPC）；本机专属命令在更底层拒绝。
		if (!this.catalog.get(target.sessionId)) {
			throw new SessionRuntimeCommandError("SESSION_NOT_FOUND", `Session not found: ${target.sessionId}`);
		}
		return this.requireBoundTarget(target);
	}

	/**
	 * 停止专用目标规范化（与 requireTarget 不同）：停止的语义是「让这个进程停下来」，
	 * agentId 才是运行实例的稳定身份。草稿会话被扫描合并 remap 后，渲染层持有的
	 * sessionId/generation 可能同时过期——只要 agentId 仍有 live 绑定就按 live 绑定停。
	 * 真正两边都没有（无 live 绑定且 catalog 无行）才报 SESSION_NOT_FOUND；
	 * 有 catalog 行但无绑定则报「运行实例不可用」，避免误导用户去刷新会话列表。
	 */
	resolveStopTarget(target: SessionRuntimeTarget): SessionRuntimeTarget {
		// 远端 runtime 必须能停（它是个真进程）；本机专属操作不在这条链路上。
		const live = this.getRuntimeBinding(target.agentId);
		if (live) {
			return {
				sessionId: live.sessionId,
				agentId: target.agentId,
				runtimeGeneration: live.runtimeGeneration,
			};
		}
		if (!this.catalog.get(target.sessionId)) {
			throw new SessionRuntimeCommandError("SESSION_NOT_FOUND", `Session not found: ${target.sessionId}`);
		}
		throw new SessionRuntimeCommandError("SESSION_RUNTIME_UNAVAILABLE", "Session runtime is not available");
	}

	requireBoundTarget(target: SessionRuntimeTarget): SessionRuntimeBinding {
		const binding = this.getRuntimeBinding(target.agentId);
		if (!binding || this.agentIdBySession.get(target.sessionId) !== target.agentId) {
			throw new SessionRuntimeCommandError("SESSION_RUNTIME_UNAVAILABLE", "Session runtime is not available");
		}
		if (binding.sessionId !== target.sessionId || binding.runtimeGeneration !== target.runtimeGeneration) {
			throw new SessionRuntimeCommandError("SESSION_RUNTIME_CHANGED", "Session runtime binding changed");
		}
		return { ...target };
	}
}
