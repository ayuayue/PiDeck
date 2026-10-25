/**
 * 系统级划词浮窗的 IPC 薄层：只做入参校验与适配，业务在 SelectionToolService。
 *
 * 通道（契约见 shared/ipc.ts + shared/types/selectionTool.ts）：
 * - selection-tool:get-state    浮窗渲染层启动时取可见性（主进程是唯一事实源）；
 * - selection-tool:hide         Escape/关闭按钮；
 * - selection-tool:insert-to-main「发送到 PiDeck」：把文本插回主窗口输入框，
 *   insertToMain 由装配层提供（它持有主窗口引用与「插入当前会话输入框」链路）。
 *
 * 安全边界：渲染层数据一律不可信。文本按 SELECTION_TOOL_TEXT_MAX_CHARS 硬上限校验，
 * 超限直接拒绝（不截断）：主窗口输入框被塞进 16k 以上文本既无意义又会卡渲染。
 * insertToMain 抛错也返回 false，不把裸异常抛过 IPC。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { SELECTION_TOOL_TEXT_MAX_CHARS, type SelectionToolInsertInput, type SelectionToolResizeInput, type SelectionToolWindowState } from "../../shared/types/selectionTool";
import type { SelectionToolService } from "../selection/SelectionToolService";
import type { SelectionToolWindow } from "../selection/SelectionToolWindow";

export type SelectionToolInsertHandler = (text: string) => boolean | Promise<boolean>;

export type SelectionToolIpcDeps = {
	/** 域服务（可为 null：装配失败时不注册业务，只保留状态查询的空实现）。 */
	service: SelectionToolService | null;
	/** 浮窗实例（可见性事实源；service 缺省时的兜底）。 */
	window: SelectionToolWindow | null;
	/** 装配层提供：文本插入主窗口当前会话输入框；返回是否成功。 */
	insertToMain: SelectionToolInsertHandler | null;
};

const EMPTY_STATE: SelectionToolWindowState = { visible: false };

/** 读取对象上的 text 字段（不用 as 断言：入参来自 IPC，结构完全不可信）。 */
function readInsertText(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return null;
	const text = Reflect.get(value, "text");
	return typeof text === "string" ? text : null;
}

/**
 * 校验「发送到 PiDeck」入参（导出供单测锁定边界）。
 * 返回 null = 拒绝：非对象、缺 text、只有空白、或超上限。
 */
export function parseSelectionToolInsertInput(value: unknown): SelectionToolInsertInput | null {
	const text = readInsertText(value);
	if (text === null) return null;
	const trimmed = text.trim();
	if (!trimmed || trimmed.length > SELECTION_TOOL_TEXT_MAX_CHARS) return null;
	return { text: trimmed };
}

/** 校验折叠/展开尺寸：有限数字，范围由窗口层再夹紧（IPC 入参不可信）。 */
export function parseSelectionToolResizeInput(value: unknown): SelectionToolResizeInput | null {
	if (typeof value !== "object" || value === null) return null;
	const width = Reflect.get(value, "width");
	const height = Reflect.get(value, "height");
	if (typeof width !== "number" || typeof height !== "number") return null;
	if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
	if (width <= 0 || height <= 0 || width > 2000 || height > 2000) return null;
	return { width, height };
}

export function registerSelectionToolIpc(deps: SelectionToolIpcDeps): void {
	const currentState = (): SelectionToolWindowState => deps.service?.getState() ?? deps.window?.getState() ?? EMPTY_STATE;

	// removeHandler 先清：热更新/重复装配（dev reload）时 ipcMain.handle 重复注册会抛。
	ipcMain.removeHandler(ipcChannels.selectionToolGetState);
	ipcMain.handle(ipcChannels.selectionToolGetState, () => currentState());

	ipcMain.removeHandler(ipcChannels.selectionToolHide);
	ipcMain.handle(ipcChannels.selectionToolHide, () => {
		if (deps.service) {
			deps.service.hide();
			return;
		}
		deps.window?.hide();
	});

	ipcMain.removeHandler(ipcChannels.selectionToolResize);
	ipcMain.handle(ipcChannels.selectionToolResize, (_event, input: unknown) => {
		const parsed = parseSelectionToolResizeInput(input);
		if (!parsed || !deps.window) return;
		deps.window.resize(parsed);
	});

	ipcMain.removeHandler(ipcChannels.selectionToolInsertToMain);
	ipcMain.handle(ipcChannels.selectionToolInsertToMain, async (_event, input: unknown) => {
		const parsed = parseSelectionToolInsertInput(input);
		if (!parsed || !deps.insertToMain) return false;
		try {
			return await deps.insertToMain(parsed.text);
		} catch {
			// 主窗口已销毁 / 插入链路抛错：对浮窗只反馈「没发送成功」，不抛裸异常。
			return false;
		}
	});
}
