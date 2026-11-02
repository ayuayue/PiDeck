/**
 * 智能体记忆的设置页 IPC：只读状态快照 + 清空索引 + 导出/导入。
 *
 * 这里刻意只给主框架放行（`sender !== 主 frame` 一律拒绝）：宿主插件、内置浏览器 guest
 * 与局域网 Web 客户端都够不到记忆文件——记忆里可能含账号路径、私有约定，属于本机数据。
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";

import { ipcChannels } from "../../shared/ipc";
import type { AgentMemoryBundlePeekOutcome, AgentMemoryEntryList, AgentMemoryExportOutcome, AgentMemoryImportOptions, AgentMemoryImportResult, AgentMemoryResult, AgentMemoryStatus } from "../../shared/types/agentMemory";

export interface AgentMemoryIpcDeps {
	getWindow: () => BrowserWindow | null;
	readStatus: () => AgentMemoryStatus;
	clearIndex: () => { removed: number };
	/** 弹保存对话框并写文件；`selection` 为 null 表示全部条目，用户取消时返回 `{ canceled: true }`。 */
	exportBundle: (selection: string[] | null) => Promise<AgentMemoryExportOutcome>;
	/** 选包并只读预览（不传路径就先弹打开对话框）；格式非法时抛错。 */
	previewBundle: (filePath?: string) => Promise<AgentMemoryBundlePeekOutcome>;
	/** 按预览的勾选与冲突策略导入；格式非法时抛错（不落盘）。 */
	importBundle: (options: AgentMemoryImportOptions) => Promise<AgentMemoryImportResult>;
	/** 逐条列出记忆（含内容与作用域），供「记忆」tab 浏览。 */
	listEntries: () => AgentMemoryEntryList;
	/** 删除单条记忆；写墓碑避免旧导出包把它导回来。 */
	deleteEntry: (input: { target: string; projectId: string; key: string }) => { removed: number };
	/** 撤销刚删的条目（写回内容并回收墓碑）。 */
	restoreEntry: (input: { target: string; projectId: string; content: string; category?: string }) => { restored: boolean };
	/** 在系统文件管理器里打开记忆根目录。 */
	revealRoot: () => Promise<void>;
	/** 读常驻指令（STANDING.md）原文；文件不存在返回空串。 */
	readStanding: () => string;
	/** 整文件替换常驻指令并重同步索引。 */
	writeStanding: (content: string) => { chars: number };
	/** 重命名本机设备（id 不变，只改导出包与状态区显示的名字）。 */
	renameDevice: (name: string) => { id: string; name: string };
	warn: (code: string) => void;
}

export function registerAgentMemoryIpc(deps: AgentMemoryIpcDeps): () => void {
	const channels = [
		ipcChannels.agentMemoryStatus,
		ipcChannels.agentMemoryClearIndex,
		ipcChannels.agentMemoryExport,
		ipcChannels.agentMemoryPreview,
		ipcChannels.agentMemoryImport,
		ipcChannels.agentMemoryList,
		ipcChannels.agentMemoryDeleteEntry,
		ipcChannels.agentMemoryRestoreEntry,
		ipcChannels.agentMemoryRevealRoot,
		ipcChannels.agentMemoryStandingRead,
		ipcChannels.agentMemoryStandingWrite,
		ipcChannels.agentMemoryRenameDevice,
	];

	/** 统一包成 `{ok,value}` / `{ok:false,code}`：渲染层不需要猜错误形态，异常码也不会带出本机路径。 */
	async function result<T>(event: IpcMainInvokeEvent, run: () => Promise<T> | T): Promise<AgentMemoryResult<T>> {
		try {
			const window = deps.getWindow();
			if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("sender-not-authorized");
			return { ok: true, value: await run() };
		} catch (error) {
			const code = error instanceof Error && /^[a-z-]{1,80}$/.test(error.message) ? error.message : "operation-failed";
			deps.warn(code);
			return { ok: false, code };
		}
	}

	/**
	 * 勾选清单的入参校验：条目 id 形如 `memory|global||<规范化内容>`，长度受单条上限约束。
	 * 上限 20000 条只是防「渲染层被改造成把整个磁盘塞进来」，正常记忆是百量级。
	 */
	function readSelection(value: unknown): string[] | null {
		if (!Array.isArray(value)) return null;
		if (value.length > 20000) throw new Error("invalid-input");
		const items: string[] = [];
		for (const item of value) {
			if (typeof item !== "string" || item.length === 0 || item.length > 8000) throw new Error("invalid-input");
			items.push(item);
		}
		return items;
	}

	ipcMain.handle(ipcChannels.agentMemoryStatus, (event) => result(event, () => deps.readStatus()));
	ipcMain.handle(ipcChannels.agentMemoryClearIndex, (event) => result(event, () => deps.clearIndex()));
	// 导出没有可选参数：`devices/` 下的设备专属记忆按定义不出设备，不给渲染层留「带上它」的开关。
	// 导出可以带选择：`selection` 省略/null = 全导，给了数组就只装这些条目 id。
	ipcMain.handle(ipcChannels.agentMemoryExport, (event, input: unknown) =>
		result(event, () => {
			const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
			return deps.exportBundle(readSelection(value.selection));
		}),
	);
	// 预览只读：拿到条目清单以后渲染层弹窗再决定勾哪些，文件对话框只弹一次。
	ipcMain.handle(ipcChannels.agentMemoryPreview, (event, input: unknown) =>
		result(event, () => {
			const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
			const filePath = typeof value.filePath === "string" && value.filePath.length > 0 && value.filePath.length < 4096 ? value.filePath : undefined;
			return deps.previewBundle(filePath);
		}),
	);
	ipcMain.handle(ipcChannels.agentMemoryImport, (event, input: unknown) =>
		result(event, () => {
			const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
			const filePath = typeof value.filePath === "string" && value.filePath.length > 0 && value.filePath.length < 4096 ? value.filePath : undefined;
			// 冲突策略只认两个字面量：拼错时按保守的「都留」处理，而不是让一次导入变成覆盖。
			const conflictPolicy = value.conflictPolicy === "overwrite" ? "overwrite" : "append";
			return deps.importBundle({
				filePath,
				selection: readSelection(value.selection),
				conflictPolicy,
				applyTombstones: value.applyTombstones !== false,
			});
		}),
	);

	ipcMain.handle(ipcChannels.agentMemoryList, (event) => result(event, () => deps.listEntries()));
	// 打开目录不接入参：路径由主进程从 userData 自己算，渲染层没有指哪打哪的能力。
	// showItemInFolder 是 fire-and-forget，这里包成 Promise 让 result() 的信封仍然成立。
	ipcMain.handle(ipcChannels.agentMemoryRevealRoot, (event) => result(event, () => deps.revealRoot()));
	// STANDING 的读没有入参；写只收 {content}，长度受预算硬上限约束（4000，超限报 standing-too-long）。
	ipcMain.handle(ipcChannels.agentMemoryStandingRead, (event) => result(event, () => deps.readStanding()));
	ipcMain.handle(ipcChannels.agentMemoryStandingWrite, (event, input: unknown) =>
		result(event, () => {
			const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
			const content = typeof value.content === "string" ? value.content : "";
			if (content.length > 8000) throw new Error("invalid-input");
			return deps.writeStanding(content);
		}),
	);
	// 设备名只收短字符串；空名/超长在 sync.renameDevice 内部归一或抛错（device-name-required）。
	ipcMain.handle(ipcChannels.agentMemoryRenameDevice, (event, name: unknown) =>
		result(event, () => {
			if (typeof name !== "string" || name.length > 200) throw new Error("invalid-input");
			return deps.renameDevice(name);
		}),
	);
	// 删除只接受「target + 作用域 + 内容键」三件套：渲染层拿不到文件路径，也就无法借这个通道
	// 删到记忆目录之外的任何东西。键是规范化后的内容，最长 4000 字符（单条上限 2000 的两倍余量）。
	ipcMain.handle(ipcChannels.agentMemoryDeleteEntry, (event, input: unknown) =>
		result(event, () => {
			const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
			const target = typeof value.target === "string" ? value.target : "";
			const projectId = typeof value.projectId === "string" ? value.projectId : "";
			const key = typeof value.key === "string" ? value.key : "";
			if (!target || !key || key.length > 4000 || projectId.length > 200) throw new Error("invalid-input");
			return deps.deleteEntry({ target, projectId, key });
		}),
	);
	// 撤销的入参校验与删除同源：内容受单条 2000 字上限的 2 倍约束（容 failure 前缀与空白）。
	ipcMain.handle(ipcChannels.agentMemoryRestoreEntry, (event, input: unknown) =>
		result(event, () => {
			const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
			const target = typeof value.target === "string" ? value.target : "";
			const projectId = typeof value.projectId === "string" ? value.projectId : "";
			const content = typeof value.content === "string" ? value.content : "";
			const category = typeof value.category === "string" ? value.category : undefined;
			if (!target || !content || content.length > 4000 || projectId.length > 200) throw new Error("invalid-input");
			return deps.restoreEntry({ target, projectId, content, category });
		}),
	);

	return () => {
		for (const channel of channels) ipcMain.removeHandler(channel);
	};
}
