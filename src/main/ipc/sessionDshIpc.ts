/**
 * DSH 会话域 IPC：目标 / 子代理 / 技能 / 孤儿会话 / 外部会话同步 / 归档 / 插件。
 * 从 sessionIpc.ts 按通道域拆出（纯搬迁：通道常量、入参校验、错误文案与注册顺序不变）。
 */

import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { validateNpmSpec } from "../dsh/dshPluginNpmRunner";
import { validateSearchKeyword } from "../dsh/dshPluginMarket";
import type { ArchivedDshSession } from "../../shared/types";
import type { DshBackendIpcDeps, SessionIpcDeps } from "./sessionIpc";
import { isRecord } from "./sessionIpcInputGuards";

/** 本组 handler 真正用到的依赖：DSH 后端能力（dshBackend 分组）+ catalog / 项目 / 文案 / 窗口 / 日志。 */
export type SessionDshIpcDeps = Pick<
	DshBackendIpcDeps,
	| "createDshGoal"
	| "runDshGoalAction"
	| "listDshSubagents"
	| "cancelDshQueuedMessage"
	| "readDshSubagentHistory"
	| "listDshSkills"
	| "listDshSessionSkills"
	| "listDshOrphans"
	| "listDshForeignSessions"
	| "importDshForeignSession"
	| "syncDshForeignSessions"
	| "unarchiveDshSession"
	| "deleteArchivedDshSession"
	| "listArchivedDshSessions"
	| "listDshDynamicPlugins"
	| "listDshStaticPlugins"
	| "uninstallDshUserPlugin"
	| "searchDshPluginMarket"
	| "installDshUserPlugin"
	| "listDshUserPlugins"
	| "installDshPlugin"
	| "runDshPlugin"
	| "stopDshPlugin"
	| "uninstallDshPlugin"
> &
	Pick<SessionIpcDeps, "sessionCatalog" | "projectStore" | "mainCopy" | "getMainWindow" | "appLogger">;

export function registerSessionDshIpc(deps: SessionDshIpcDeps): void {
	const {
		sessionCatalog,
		projectStore,
		mainCopy,
		getMainWindow,
		appLogger,
		createDshGoal,
		runDshGoalAction,
		listDshSubagents,
		cancelDshQueuedMessage,
		readDshSubagentHistory,
		listDshSkills,
		listDshSessionSkills,
		listDshOrphans,
		listDshForeignSessions,
		importDshForeignSession,
		syncDshForeignSessions,
		unarchiveDshSession,
		deleteArchivedDshSession,
		listArchivedDshSessions,
		listDshDynamicPlugins,
		listDshStaticPlugins,
		uninstallDshUserPlugin,
		searchDshPluginMarket,
		installDshUserPlugin,
		listDshUserPlugins,
		installDshPlugin,
		runDshPlugin,
		stopDshPlugin,
		uninstallDshPlugin,
	} = deps;
	// DSH 目标创建（G5：goal.create）
	ipcMain.handle(ipcChannels.dshCreateGoal, async (_event, agentId: unknown, objective: unknown, maxGoalRounds?: unknown): Promise<void> => {
		if (typeof agentId !== "string" || typeof objective !== "string") {
			throw new Error("Invalid goal create request");
		}
		if (!createDshGoal) throw new Error("dsh goals are not available");
		await createDshGoal(agentId, objective, typeof maxGoalRounds === "number" ? maxGoalRounds : undefined);
	});
	// DSH 目标操作（G5：pause/resume/complete/clear）
	ipcMain.handle(ipcChannels.dshGoalAction, async (_event, agentId: unknown, action: unknown): Promise<void> => {
		if (typeof agentId !== "string" || (action !== "pause" && action !== "resume" && action !== "complete" && action !== "clear")) {
			throw new Error("Invalid goal action request");
		}
		if (!runDshGoalAction) throw new Error("dsh goals are not available");
		await runDshGoalAction(agentId, action);
	});
	// DSH 子代理列表（G6）
	ipcMain.handle(ipcChannels.dshListSubagents, async (_event, agentId: unknown) => {
		if (typeof agentId !== "string") return [];
		if (!listDshSubagents) return [];
		return listDshSubagents(agentId);
	});
	// DSH 取消 host 侧排队消息（inbox 投影项的撤回）
	ipcMain.handle(ipcChannels.dshCancelQueuedMessage, async (_event, agentId: unknown, itemId: unknown) => {
		if (typeof agentId !== "string" || typeof itemId !== "string" || itemId === "") {
			throw new Error("Invalid agentId or queue item id");
		}
		if (!cancelDshQueuedMessage) throw new Error("dsh queue is not available");
		await cancelDshQueuedMessage(agentId, itemId);
	});
	// DSH 子代理历史（G6）
	ipcMain.handle(ipcChannels.dshSubagentHistory, async (_event, agentId: unknown, childSessionId: unknown, beforeSeq?: unknown, maxMessages?: unknown) => {
		if (typeof agentId !== "string" || typeof childSessionId !== "string") {
			return { messages: [], hasMore: false };
		}
		if (!readDshSubagentHistory) return { messages: [], hasMore: false };
		return readDshSubagentHistory(agentId, childSessionId, typeof beforeSeq === "number" ? beforeSeq : undefined, typeof maxMessages === "number" ? maxMessages : undefined);
	});
	// DSH 技能目录（G7：skill.list 只读；/name 斜杠调用提示由渲染层给）
	// 目标有两种寻址：agentId 字符串（运行中会话，工具面板/Web 端沿用）或
	// { sessionId }（草稿会话，技能选择器在会话启动前读取目录）。
	ipcMain.handle(ipcChannels.dshListSkills, async (_event, target: unknown) => {
		if (typeof target === "string") {
			if (!target.trim() || target.length > 256) return [];
			if (!listDshSkills) return [];
			return listDshSkills(target);
		}
		if (isRecord(target) && typeof target.sessionId === "string") {
			const sessionId = target.sessionId.trim();
			if (!sessionId || sessionId.length > 256) return [];
			if (!listDshSessionSkills) return [];
			return listDshSessionSkills(sessionId);
		}
		return [];
	});
	// DSH 孤儿会话列表（G3/D11：host 有但 catalog 无映射，用于清理提示）
	ipcMain.handle(ipcChannels.dshListOrphans, async (): Promise<string[]> => {
		if (!listDshOrphans) return [];
		return listDshOrphans();
	});
	// DSH 外部会话清单（跨工具兼容，2026-12）：dsh-web 等其他工具创建的 host 根会话，
	// 带标题/cwd，供配置页「导入」把 host 数据映射进 catalog（导入后侧栏可见可加载）。
	// 已映射进 catalog 的会话从清单过滤掉：导入后即从「待导入」列表消失，避免重复导入。
	ipcMain.handle(ipcChannels.dshListForeignSessions, async (): Promise<Array<{ dshSessionId: string; title?: string; cwd?: string; updatedAt?: number }>> => {
		if (!listDshForeignSessions) return [];
		const items = await listDshForeignSessions();
		const known = new Set(
			sessionCatalog
				.listEntries()
				.map((entry) => entry.dshSessionId)
				.filter((id): id is string => Boolean(id)),
		);
		const dismissed = sessionCatalog.listDismissedDshSessionIds();
		// 侧栏删过的 host 会话不要出现在「待导入」：否则看起来像没删掉。
		// 归档恢复仍走独立入口，会带 restoreDismissed 清墓碑。
		return items.filter((item) => !known.has(item.dshSessionId) && !dismissed.has(item.dshSessionId));
	});
	// DSH 外部会话导入：按 host 会话 id 建 catalog 映射（status=active，重启保留；
	// 同 dshSessionId 重复导入幂等吸收，见 SessionCatalog.createDraft）。
	ipcMain.handle(ipcChannels.dshImportForeignSession, async (_event, dshSessionId: unknown): Promise<import("../../shared/types").SessionRecord> => {
		if (typeof dshSessionId !== "string" || !/^session-[A-Za-z0-9-]+$/.test(dshSessionId)) {
			throw new Error(mainCopy("session.invalidArchivePath"));
		}
		if (!importDshForeignSession) throw new Error("DSH session import is not available");
		return importDshForeignSession(dshSessionId);
	});
	// DSH 外部会话全量同步：把 catalog 未映射的磁盘根会话全部导入（不启动 host），
	// 返回 { imported, skipped } 供配置页展示。未装配时返回空统计。
	ipcMain.handle(ipcChannels.dshSyncForeignSessions, async (): Promise<{ imported: number; skipped: number }> => {
		if (!syncDshForeignSessions) return { imported: 0, skipped: 0 };
		return syncDshForeignSessions();
	});
	// DSH 归档区会话清单（G14：目录已移入 .pideck-archive 的 host 会话，恢复入口用；含标题）
	ipcMain.handle(ipcChannels.dshListArchived, async (): Promise<ArchivedDshSession[]> => {
		if (!listArchivedDshSessions) return [];
		return listArchivedDshSessions();
	});
	// DSH 会话恢复（G14）：目录按 manifest 移回 sessions 树，并重建 catalog 记录
	ipcMain.handle(ipcChannels.dshUnarchive, async (_event, dshSessionId: unknown): Promise<boolean> => {
		// 入参校验：host 生成的会话 id 固定 "session-" 前缀（host 侧目录名 = sessionId），
		// 白名单正则挡掉路径穿越类输入（渲染层数据不可信，校验在边界）。
		if (typeof dshSessionId !== "string" || !/^session-[A-Za-z0-9-]+$/.test(dshSessionId)) {
			throw new Error(mainCopy("session.invalidArchivePath"));
		}
		if (!unarchiveDshSession) throw new Error("DSH archive restore is not available");
		const restored = await unarchiveDshSession(dshSessionId);
		if (!restored) throw new Error(mainCopy("session.invalidArchivePath"));
		// 重建 catalog 记录：按会话自己的 cwd 匹配或注册项目；没有 cwd 才兑底。
		// 打开会话时 DshAgentManager 用 project.path 当 cwd，挂错项目会 attach 错 workspace。
		const project = restored.cwd ? (projectStore.findByPath(restored.cwd) ?? (await projectStore.add(restored.cwd))) : await projectStore.ensureExternalSessionsProject(mainCopy("project.externalSessions"));
		const draft = await sessionCatalog.createDraft({
			projectId: project.id,
			// 恢复时优先用 manifest 里的原标题（旧归档由 DshHost 日志折叠补全），
			// 缺省才落「新会话」占位——否则侧栏恢复后显示不了真实会话名。
			title: restored.title ?? mainCopy("session.newTitle"),
			environment: "native",
			backend: "dsh",
		});
		// 归档恢复是用户明确找回：必须 active，并清掉删除墓碑，否则下次自动同步仍会跳过。
		await sessionCatalog.attachRuntime({
			sessionId: draft.id,
			dshSessionId,
			promoteToActive: true,
			restoreDismissed: true,
		});
		const window = getMainWindow();
		if (window && !window.isDestroyed()) {
			window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: project.id });
		}
		void appLogger.info("session", "DSH session restored from archive", {
			dshSessionId,
			restoredPath: restored.restoredPath,
			projectId: project.id,
		});
		return true;
	});
	// DSH 永久删除已归档会话（G14：归档目录移入系统回收站，区别于恢复）
	ipcMain.handle(ipcChannels.dshDeleteArchived, async (_event, dshSessionId: unknown): Promise<boolean> => {
		// 入参校验：host 生成的会话 id 固定 "session-" 前缀（host 侧目录名 = sessionId），
		// 白名单正则挡掉路径穿越类输入（渲染层数据不可信，校验在边界）。
		if (typeof dshSessionId !== "string" || !/^session-[A-Za-z0-9-]+$/.test(dshSessionId)) {
			throw new Error(mainCopy("session.invalidArchivePath"));
		}
		if (!deleteArchivedDshSession) throw new Error("DSH archive delete is not available");
		const deleted = await deleteArchivedDshSession(dshSessionId);
		if (!deleted) throw new Error(mainCopy("session.invalidArchivePath"));
		void appLogger.info("session", "DSH archived session deleted", { dshSessionId });
		return true;
	});
	// DSH 动态插件管理（G13 深化：进程内临时扩展，define/run/stop/undefine）。
	// 语义校验（idPrefix 规则、源码单侧上限、会话归属）在 host 侧桥插件统一执行；
	// IPC 边界只做第一行类型检查（渲染层数据不可信）。
	ipcMain.handle(ipcChannels.dshPluginList, async (): Promise<import("../../shared/types").DshPluginView[]> => {
		if (!listDshDynamicPlugins) return [];
		return listDshDynamicPlugins();
	});
	ipcMain.handle(ipcChannels.dshPluginStaticList, async (): Promise<import("../../shared/types").DshStaticPluginView[]> => {
		if (!listDshStaticPlugins) return [];
		return listDshStaticPlugins();
	});
	// DSH 用户自装静态插件卸载：从 $DSH_HOME/cordis.patch.yml 移除行（+可选回收插件目录）。
	// 目标校验在 DshHost 侧（行必须真的来自用户补丁层，内置条目拒绝）；这里只做形状检查。
	ipcMain.handle(ipcChannels.dshPluginUserUninstall, async (_event, input: unknown): Promise<import("../../shared/types").DshUserPluginUninstallResult> => {
		if (typeof input !== "object" || input === null) {
			throw new Error("invalid user plugin uninstall payload");
		}
		const record = input as Record<string, unknown>;
		if (typeof record.entryId !== "string" || !record.entryId || typeof record.moduleName !== "string" || !record.moduleName) {
			throw new Error("invalid user plugin uninstall payload");
		}
		if (!uninstallDshUserPlugin) throw new Error("DSH user plugin uninstall is not available");
		return uninstallDshUserPlugin({
			entryId: record.entryId,
			moduleName: record.moduleName,
			deleteFiles: record.deleteFiles === true,
		});
	});
	// DSH 插件市场搜索：关键词 1-80 字符、无控制字符（渲染层输入不可信）。
	ipcMain.handle(ipcChannels.dshPluginMarketSearch, async (_event, keyword: unknown): Promise<import("../../shared/types").DshPluginMarketSearchResult> => {
		if (typeof keyword !== "string") throw new Error("invalid plugin market search payload");
		const validated = validateSearchKeyword(keyword);
		if (!validated.ok) throw new Error(validated.reason);
		if (!searchDshPluginMarket) throw new Error("DSH plugin market search is not available");
		return searchDshPluginMarket(validated.value);
	});
	// DSH 用户插件安装：spec 只接受 npm 包名或 name@精确版本（路径/range/tag 全拒）。
	ipcMain.handle(ipcChannels.dshPluginUserInstall, async (_event, input: unknown): Promise<import("../../shared/types").DshUserPluginInstallResult> => {
		if (typeof input !== "object" || input === null) throw new Error("invalid user plugin install payload");
		const record = input as Record<string, unknown>;
		if (typeof record.spec !== "string" || !record.spec.trim()) throw new Error("invalid user plugin install payload");
		const spec = validateNpmSpec(record.spec);
		if (!spec.ok) throw new Error(spec.reason);
		if (!installDshUserPlugin) throw new Error("DSH user plugin install is not available");
		return installDshUserPlugin(record.spec.trim());
	});
	// DSH 用户补丁层清单（安装服务视角；未装配返回空列表与既有 list 通道语义一致）。
	ipcMain.handle(ipcChannels.dshPluginUserList, async (): Promise<import("../../shared/types").DshUserPluginListEntry[]> => {
		if (!listDshUserPlugins) return [];
		return listDshUserPlugins();
	});
	ipcMain.handle(ipcChannels.dshPluginInstall, async (_event, input: unknown): Promise<unknown> => {
		if (typeof input !== "object" || input === null) {
			throw new Error("invalid plugin install payload");
		}
		const record = input as Record<string, unknown>;
		if (typeof record.sessionId !== "string" || !record.sessionId || typeof record.idPrefix !== "string" || !record.idPrefix || typeof record.name !== "string" || !record.name.trim() || typeof record.purpose !== "string" || !record.purpose.trim()) {
			throw new Error("invalid plugin install payload");
		}
		if (!installDshPlugin) throw new Error("DSH plugin install is not available");
		return installDshPlugin(input as import("../../shared/types").DshPluginInstallInput);
	});
	ipcMain.handle(ipcChannels.dshPluginRun, async (_event, input: unknown): Promise<unknown> => {
		if (typeof input !== "object" || input === null) {
			throw new Error("invalid plugin lifecycle payload");
		}
		const record = input as Record<string, unknown>;
		if (typeof record.sessionId !== "string" || !record.sessionId || typeof record.pluginId !== "string" || !record.pluginId) {
			throw new Error("invalid plugin lifecycle payload");
		}
		if (!runDshPlugin) throw new Error("DSH plugin run is not available");
		return runDshPlugin(input as import("../../shared/types").DshPluginLifecycleInput);
	});
	ipcMain.handle(ipcChannels.dshPluginStop, async (_event, input: unknown): Promise<unknown> => {
		if (typeof input !== "object" || input === null) {
			throw new Error("invalid plugin lifecycle payload");
		}
		const record = input as Record<string, unknown>;
		if (typeof record.sessionId !== "string" || !record.sessionId || typeof record.pluginId !== "string" || !record.pluginId) {
			throw new Error("invalid plugin lifecycle payload");
		}
		if (!stopDshPlugin) throw new Error("DSH plugin stop is not available");
		return stopDshPlugin(input as import("../../shared/types").DshPluginLifecycleInput);
	});
	ipcMain.handle(ipcChannels.dshPluginUninstall, async (_event, input: unknown): Promise<unknown> => {
		if (typeof input !== "object" || input === null) {
			throw new Error("invalid plugin lifecycle payload");
		}
		const record = input as Record<string, unknown>;
		if (typeof record.sessionId !== "string" || !record.sessionId || typeof record.pluginId !== "string" || !record.pluginId) {
			throw new Error("invalid plugin lifecycle payload");
		}
		if (!uninstallDshPlugin) throw new Error("DSH plugin uninstall is not available");
		return uninstallDshPlugin(input as import("../../shared/types").DshPluginLifecycleInput);
	});
}
