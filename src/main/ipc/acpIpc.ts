/**
 * ACP 域 IPC:工具登记表的读/存/校验 + 预设工具生命周期(检测/安装/卸载)。
 *
 * 只做输入校验与适配(硬规则):业务在 SettingsStore(acpTools 字段)、
 * acpToolConfig(消毒/校验纯函数)与 acpToolLifecycle(进程编排);
 * AcpAgentManager 由 index.ts 装配,这里不触碰(工具表变化不需要通知运行中的
 * agent 进程——配置在 spawn 时快照)。
 *
 * 生命周期安全边界:presetId 只认内置预设枚举,安装/卸载命令全部来自
 * ACP_TOOL_PRESETS 内置表(不接受用户命令串)——这不是任意命令执行入口;
 * manual 安装形态(claude/cursor 官网脚本)在 IPC 层直接拒绝并给出引导文案 key。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AcpToolConfig } from "../../shared/types/acp";
import { sanitizeAcpTools, validateAcpTool } from "../acp/acpToolConfig";
import { detectAcpPreset, findPresetById, runNpmGlobalAction, type AcpToolLifecycleDeps } from "../acp/acpToolLifecycle";
import type { AcpLifecycleEvent, AcpToolStatus } from "../../shared/types/acp";
import type { SettingsStore } from "../settings/SettingsStore";

export function registerAcpIpc(deps: { settingsStore: SettingsStore; getLifecycleDeps?: () => AcpToolLifecycleDeps }): void {
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

	// ── 预设工具生命周期(检测只读;安装/卸载有全局 npm 副作用,由渲染层确认弹窗把关) ──
	// 惰性取依赖:注册时 piLocator 可能尚未创建(index.ts 里注册在前、实例化在后)。
	const getLifecycleDeps = (): AcpToolLifecycleDeps => {
		const resolved = deps.getLifecycleDeps?.();
		if (!resolved) throw new Error("acp: lifecycle not available");
		return resolved;
	};

	const requirePreset = (input: unknown) => {
		if (typeof input !== "string") throw new Error("acp: expects a presetId string");
		const preset = findPresetById(input);
		if (!preset) throw new Error(`acp: unknown presetId: ${input.slice(0, 40)}`);
		return preset;
	};

	ipcMain.handle(ipcChannels.acpToolDetect, async (_event, presetId: unknown): Promise<AcpToolStatus> => {
		const preset = requirePreset(presetId);
		return detectAcpPreset(getLifecycleDeps(), preset);
	});

	const runAction = async (presetId: unknown, action: "install" | "uninstall", sender: Electron.WebContents): Promise<{ ok: boolean; output: string }> => {
		const preset = requirePreset(presetId);
		const lifecycleDeps = getLifecycleDeps();
		// manual 形态(claude/cursor 官网脚本)不经 npm:拒绝执行,渲染层拿 error 引导用户去官网。
		if (preset.install?.kind !== "npm") throw new Error("acp: preset is not npm-installable");
		const send = (event: AcpLifecycleEvent) => {
			// 设置页可能中途关闭:destroyed 后 send 会抛,吞掉即可(结果还有 invoke 返回兜底)。
			try {
				if (!sender.isDestroyed()) sender.send(ipcChannels.acpLifecycleEvent, event);
			} catch {
				/* webContents 已销毁,进度丢弃 */
			}
		};
		send({ presetId: preset.id, phase: "line", line: `$ npm ${action === "install" ? "install" : "uninstall"} -g ${preset.install.package}` });
		const result = await runNpmGlobalAction(lifecycleDeps, preset, action, (line) => send({ presetId: preset.id, phase: "line", line }));
		send({ presetId: preset.id, phase: "done", ok: result.ok, output: result.output.slice(-4000) });
		return result;
	};

	ipcMain.handle(ipcChannels.acpToolInstall, (event, presetId: unknown) => runAction(presetId, "install", event.sender));
	ipcMain.handle(ipcChannels.acpToolUninstall, (event, presetId: unknown) => runAction(presetId, "uninstall", event.sender));
}
