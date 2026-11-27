import type { AgentTab, SessionRuntimeInfo, SessionRuntimeTarget } from "../../../shared/types";

/**
 * 运行时快照条目的构造（`SessionRuntimeInfo`）。
 *
 * 为什么独立成模块：`SessionRuntimeCoordinator` 是存量巨文件（行数只准降），而这段构造有两条
 * 调用路径、语义还不一样，留在一起最容易越写越乱：
 *
 * - `runtimeInfo()`（目标命令路径）：先校验绑定，不符就抛 `SESSION_RUNTIME_CHANGED`；
 * - `listRuntimes()`（快照路径）：**只读**、不触发任何解绑，终态条目由调用方跳过。
 *
 * 以前两条路径共用同一个会做惰性解绑的读取（`getTarget` → `getAgentId`），于是
 * `sessions:runtime-list` 遍历到一条终态绑定时会自己把刚查的绑定删掉、随后整体抛错，
 * 渲染层拿不到运行时快照（用户侧表现为「同一会话两行」的温床）。分离之后单测可以直接锁住。
 */
export function buildRuntimeInfo(target: SessionRuntimeTarget, tab: AgentTab): SessionRuntimeInfo {
	return {
		...target,
		projectId: tab.projectId,
		cwd: tab.cwd,
		status: tab.status,
		sessionPath: tab.sessionPath,
		createdAt: tab.createdAt,
		compactionCount: tab.compactionCount,
		noSession: tab.noSession,
		// 远端 trust 现状随 runtime 快照一起给：渲染层重载/首次渲染就能显示提示，不用等下一条
		// `agents:state`（那条推送只在该会话发生状态变化时才来）。本机会话不带该字段。
		...(tab.remoteTrustUnhandled === true ? { remoteTrustUnhandled: true } : {}),
		// 远端注入面同样随 runtime 快照下发：重载后 UI 的能力门不能退化成「应该能」。
		...(tab.remoteExtensions === undefined ? {} : { remoteExtensions: tab.remoteExtensions }),
		// PiDeck 会话身份透传：渲染层侧栏 ACP「agent↔会话」配对依赖它（见 SessionRuntimeInfo.deckSessionId）。
		deckSessionId: tab.deckSessionId,
	};
}
