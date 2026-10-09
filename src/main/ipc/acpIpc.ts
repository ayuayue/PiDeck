/**
 * ACP 域 IPC:工具登记表的读/存/校验。
 *
 * 只做输入校验与适配(硬规则):业务在 SettingsStore(acpTools 字段)与
 * acpToolConfig(消毒/校验纯函数);AcpAgentManager 由 index.ts 装配,
 * 这里不触碰(工具表变化不需要通知运行中的 agent 进程——配置在 spawn 时快照)。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AcpToolConfig } from "../../shared/types/acp";
import { sanitizeAcpTools, validateAcpTool } from "../acp/acpToolConfig";
import type { SettingsStore } from "../settings/SettingsStore";

export function registerAcpIpc(deps: { settingsStore: SettingsStore }): void {
	const { settingsStore } = deps;

	ipcMain.handle(ipcChannels.acpToolsList, () => settingsStore.get().acpTools ?? []);

	ipcMain.handle(ipcChannels.acpToolsSave, (_event, tools: unknown): AcpToolConfig[] => {
		// 整表替换语义(渲染层持有完整列表):消毒在 SettingsStore.update 再做一次,
		// 这里先粗校验形状,让非数组入参在 IPC 边界直接报错而不是静默清表。
		if (!Array.isArray(tools)) throw new Error("acp:tools-save expects an array of tools");
		const sanitized = sanitizeAcpTools(tools);
		settingsStore.update({ acpTools: sanitized });
		return settingsStore.get().acpTools ?? [];
	});

	ipcMain.handle(ipcChannels.acpToolValidate, (_event, input: unknown): ReturnType<typeof validateAcpTool> => {
		if (!input || typeof input !== "object") return { ok: false, reasonKey: "acp.toolNameRequired" };
		const record = input as Record<string, unknown>;
		return validateAcpTool(
			{
				id: typeof record.id === "string" ? record.id : undefined,
				name: record.name,
				command: record.command,
				args: record.args,
				env: record.env,
			},
			settingsStore.get().acpTools ?? [],
		);
	});
}
