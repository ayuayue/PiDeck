import type { PiDesktopApi } from "../../../../preload";
import type { TerminalTarget } from "../../../../shared/types";
import { TerminalDock, type TerminalDockSettings } from "../terminal/TerminalDock";
import type { TerminalThemeId } from "../../../../shared/types/settings";

export const SESSION_RUNTIME_DOCK_MOTION_MS = 180;

export type SessionRuntimeDockMotionState = Readonly<{
	mounted: boolean;
	closing: boolean;
	agentId?: string;
}>;

export const CLOSED_SESSION_RUNTIME_DOCK: SessionRuntimeDockMotionState = {
	mounted: false,
	closing: false,
};

export function transitionSessionRuntimeDock(current: SessionRuntimeDockMotionState, input: { agentId?: string; open: boolean }): SessionRuntimeDockMotionState {
	if (input.open && input.agentId) {
		return { mounted: true, closing: false, agentId: input.agentId };
	}
	if (!current.mounted) return CLOSED_SESSION_RUNTIME_DOCK;
	return { mounted: true, closing: true, agentId: current.agentId };
}

export function finishSessionRuntimeDockClose(current: SessionRuntimeDockMotionState): SessionRuntimeDockMotionState {
	return current.closing ? CLOSED_SESSION_RUNTIME_DOCK : current;
}

export function disposeSessionRuntimeDock(): SessionRuntimeDockMotionState {
	return CLOSED_SESSION_RUNTIME_DOCK;
}

export type SessionRuntimeDockProps = {
	/** agent 或 project 终端目标；未解析出目标（无 owner）时不渲染 */
	target?: TerminalTarget;
	mounted: boolean;
	open: boolean;
	closing: boolean;
	collapsed: boolean;
	height: number;
	terminal: PiDesktopApi["terminal"];
	terminalSettings: TerminalDockSettings;
	onThemeChange: (themeId: TerminalThemeId) => void;
	onOpenChange: (open: boolean) => void;
	onCollapsedChange: (collapsed: boolean) => void;
	onHeightChange: (height: number) => void;
};

// Motion state is owned by useTerminalDock. This leaf only forwards the already
// computed mounted/open/closing signals to the expensive terminal surface.
// key 由父级按 owner 传入（agent:<id> / project:<id>），切换 owner 时整体重建实例。
export function SessionRuntimeDock(props: SessionRuntimeDockProps) {
	if (!props.mounted || !props.target) return null;
	return (
		<TerminalDock
			target={props.target}
			open={props.open}
			closing={props.closing}
			collapsed={props.collapsed}
			height={props.height}
			terminal={props.terminal}
			terminalSettings={props.terminalSettings}
			onThemeChange={props.onThemeChange}
			onCollapsedChange={props.onCollapsedChange}
			onHeightChange={props.onHeightChange}
			onClose={() => props.onOpenChange(false)}
		/>
	);
}
