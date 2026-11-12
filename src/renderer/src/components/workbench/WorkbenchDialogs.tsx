import type { useCuaApproval } from "../overlays/CuaApprovalDialog";
import { CuaApprovalDialog } from "../overlays/CuaApprovalDialog";
import { CommandPalette } from "../overlays/CommandPalette";
import { CommandPaletteOnboarding } from "../overlays/CommandPaletteOnboarding";
import { DataEnvMismatchDialog } from "../app/DataEnvMismatchDialog";
import { DataModeChoiceDialog } from "../app/DataModeChoiceDialog";
import { t } from "../../i18n";
import type { PaletteCommand } from "../../utils/commandPaletteCommands";

export interface WorkbenchDialogsProps {
	/** 命令面板：开合状态、命令表，以及首次引导「现在该不该弹」的同一批门控。 */
	palette: {
		commandPaletteOpen: boolean;
		setCommandPaletteOpen: (open: boolean) => void;
		commandPaletteCommands: PaletteCommand[];
		openCommandPalette: () => void;
		activeProjectId?: string;
		activeProjectHasBusyAgent: boolean;
		settingsPageActive: boolean;
		/** 极简浮窗/快捷任务窗口里没有工作台，不弹引导。 */
		quickTaskActive: boolean;
	};
	/** CUA 操作审批：请求队列与响应命令（事件驱动，根级唯一挂载点）。 */
	cuaApproval: ReturnType<typeof useCuaApproval>;
}

/**
 * 工作台根级常驻弹窗装配层：命令面板 + 首次引导 / 数据环境弹窗族 / CUA 操作审批。
 *
 * 均为 atom 或事件驱动、与 AppShell 平级渲染，因此由 WorkbenchShell 的 rootDialogs 槽注入，
 * 保持与原内联版本相同的挂载层级与顺序。
 */
export function WorkbenchDialogs({ palette, cuaApproval }: WorkbenchDialogsProps) {
	const { commandPaletteOpen, setCommandPaletteOpen, commandPaletteCommands, openCommandPalette, activeProjectId, activeProjectHasBusyAgent, settingsPageActive, quickTaskActive } = palette;

	return (
		<>
			{/* 命令面板（Ctrl/Cmd+P）：模糊搜索设置项并跳转 + 执行操作，根级渲染 */}
			<CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} commands={commandPaletteCommands} placeholder={t("command.placeholder")} emptyMessage={t("command.empty")} />

			{/* 命令面板首次引导：它是纯键盘入口，没有任何可点的 affordance，
        不主动提示就等于不存在。看完即写 localStorage，只弹一次。
        空状态（没项目）不弹——那时面板本身也没什么可搜的。 */}
			{!quickTaskActive && <CommandPaletteOnboarding enabled={Boolean(activeProjectId) && !activeProjectHasBusyAgent && !commandPaletteOpen && !settingsPageActive} onTryNow={openCommandPalette} />}

			{/* 数据环境弹窗族：首启数据模式选择（内含导入向导）与目录标记警告，事件/atom 驱动 */}
			<DataModeChoiceDialog />
			<DataEnvMismatchDialog />

			{/* CUA 操作审批弹框：pi Agent 注入鼠标/键盘前的用户确认（事件驱动，根级渲染） */}
			<CuaApprovalDialog request={cuaApproval.request} pendingCount={cuaApproval.pendingCount} responding={cuaApproval.responding} open={cuaApproval.open} onOpenChange={cuaApproval.setOpen} onRespond={(allowed) => void cuaApproval.respond(allowed)} onCancel={cuaApproval.cancel} />
		</>
	);
}
