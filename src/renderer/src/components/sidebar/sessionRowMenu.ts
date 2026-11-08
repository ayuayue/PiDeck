import type { MouseEvent } from "react";
import { getBoundSidebarRuntimeAgent, type SidebarController } from "../../hooks/useSidebarController";

/**
 * 会话行右键菜单：有运行时绑定的会话走 Agent 菜单（含运行控制），否则走会话菜单。
 *
 * 项目树、分组树、关联子会话三处共用同一判定——各写一份会出现「同一个会话在不同位置
 * 弹出不同菜单」。菜单项本身由 SidebarContent 按 projectId + sessionId 从 catalog 解析，
 * 所以调用方只负责定位与打开。
 */
export function openSessionRowMenu(controller: SidebarController, event: Pick<MouseEvent, "clientX" | "clientY" | "preventDefault">, projectId: string, sessionId: string, pinnable = true): void {
	event.preventDefault();
	const runtime = getBoundSidebarRuntimeAgent(controller.catalog, sessionId);
	void controller.openMenu(runtime ? { kind: "agent", agentId: runtime.id, pinnable, x: event.clientX, y: event.clientY } : { kind: "session", projectId, sessionId, pinnable, x: event.clientX, y: event.clientY });
}
