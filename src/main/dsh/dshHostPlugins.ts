import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DshCommandView, DshPluginInstallInput, DshPluginLifecycleInput, DshPluginView, DshStaticPluginView, DshUserPluginUninstallInput, DshUserPluginUninstallResult } from "../../shared/types";
import { PIDECK_COMMANDS_BRIDGE_PATH } from "./pideckCommandsBridge";
import { PIDECK_PLUGIN_BRIDGE_PATH } from "./pideckPluginBridge";
import { PIDECK_SESSION_BRIDGE_PATH } from "./pideckSessionBridge";
import { classifyStaticPlugins, isUserPluginEntry, nearestPackageDir, readUserPatchRows, removeUserPatchRow, resolveManagedPluginDir, USER_PATCH_FILENAME, withArrayDocumentFallback } from "./dshUserPlugins";

/**
 * 插件 / 命令 / 冷读 cursor 的宿主协作者：一律经宿主传入的桥 RPC 入口（bridgeRpc）
 * 打到 host 侧 pideck-* 桥服务；宿主负责 fetch 桥传输与启动兜底，本模块只管信封形状
 * 与 `$DSH_HOME` 下的补丁层读写。
 */
export type DshPluginHostDeps = {
	/** 宿主的桥 RPC 入口（POST {path} → { ok, value|error } 信封）。 */
	rpc: (path: string, method: string, params: unknown) => Promise<unknown>;
	homeDir: string;
	userDataDir: string;
	trashPath: (path: string) => Promise<void>;
	log: (scope: string, message: string, detail?: unknown) => void;
};

/** 动态插件桥（G13 深化）：pideck-plugin-bridge 服务的 RPC 入口。 */
function pluginRpc(deps: DshPluginHostDeps, method: string, params: unknown): Promise<unknown> {
	return deps.rpc(PIDECK_PLUGIN_BRIDGE_PATH, method, params);
}

/** 动态插件清单（进程内全部会话的临时扩展；重启即失）。 */
export async function listDshDynamicPlugins(deps: DshPluginHostDeps): Promise<DshPluginView[]> {
	const value = await pluginRpc(deps, "inventory", undefined);
	return Array.isArray(value) ? (value as DshPluginView[]) : [];
}

/** 静态 Loader 条目清单（origin 标注来源：user = 用户补丁层 / builtin = 官方与 PiDeck 组合）。 */
export async function listDshStaticPlugins(deps: DshPluginHostDeps): Promise<DshStaticPluginView[]> {
	const value = await pluginRpc(deps, "staticInventory", undefined);
	const views = Array.isArray(value) ? (value as DshStaticPluginView[]) : [];
	try {
		const patchPath = join(deps.homeDir, USER_PATCH_FILENAME);
		const { rows } = readUserPatchRows(patchPath);
		return classifyStaticPlugins(views, rows);
	} catch (error) {
		// 分类是纯增强：读不到用户补丁层时按 builtin 呈现，不让列表失败
		deps.log("dsh-host", "plugin origin classification skipped", {
			error: error instanceof Error ? error.message : String(error),
		});
		return views;
	}
}

/**
 * 卸载用户自装的静态插件：从 $DSH_HOME/cordis.patch.yml 移除对应行（下个 host
 * 重启生效），可选把插件目录移入回收站（仅限 userData/dsh-plugins 内的 PiDeck
 * 管理目录）。内置条目一律拒绝——它们属于 base/预设/PiDeck 组合，不归用户卸载。
 */
export async function uninstallDshUserPlugin(deps: DshPluginHostDeps, input: DshUserPluginUninstallInput): Promise<DshUserPluginUninstallResult> {
	const patchPath = join(deps.homeDir, USER_PATCH_FILENAME);
	const { rows, exists } = readUserPatchRows(patchPath);
	if (!exists) {
		return { rowRemoved: false, reason: "no user patch layer found (nothing user-installed)" };
	}
	const probe = { entryId: input.entryId, moduleName: input.moduleName };
	if (!isUserPluginEntry(probe, rows)) {
		return {
			rowRemoved: false,
			reason: "entry is not declared in the user patch layer (builtin plugins cannot be uninstalled here)",
		};
	}

	// 先备份再改写：补丁文件是用户自管文件，误删行可从 .bak 恢复
	const backupPath = `${patchPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	copyFileSync(patchPath, backupPath);
	const current = readFileSync(patchPath, "utf8");
	const removed = removeUserPatchRow(current, { entryId: input.entryId, moduleName: input.moduleName });
	if (!removed.removed) {
		return { rowRemoved: false, reason: removed.reason, backupPath };
	}
	// 删掉最后一行会只剩表头注释：补成合法空数组文档，否则下次 host 启动被 dsh 拒。
	writeFileSync(patchPath, withArrayDocumentFallback(removed.text), "utf8");
	deps.log("dsh-host", "user plugin uninstalled from patch layer", {
		entryId: input.entryId,
		moduleName: input.moduleName,
		backupPath,
	});

	const result: DshUserPluginUninstallResult = { rowRemoved: true, backupPath };
	if (input.deleteFiles === true) {
		const matchedRow = rows.find((row) => isUserPluginEntry(probe, [row]));
		const pluginDir = matchedRow?.name !== undefined ? resolveManagedPluginDir(matchedRow.name, join(deps.userDataDir, "dsh-plugins")) : undefined;
		if (pluginDir === undefined) {
			// 管理目录之外不代删，但把插件实际位置告诉用户（常见于换实例卸载：
			// 插件装在另一个 userData 的 dsh-plugins 下）
			const hintDir = matchedRow?.name !== undefined ? nearestPackageDir(matchedRow.name) : undefined;
			result.reason = hintDir ? `plugin files are outside this install's managed folder: ${hintDir}` : "plugin directory is outside PiDeck's managed folder; remove it manually if needed";
			result.keptPluginDir = hintDir;
		} else {
			try {
				await deps.trashPath(pluginDir);
				result.removedPluginDir = pluginDir;
			} catch (error) {
				result.fileError = error instanceof Error ? error.message : String(error);
			}
		}
	}
	return result;
}

/** 安装动态插件（define：定义源码包，不运行；按会话归属）。 */
export async function installDshDynamicPlugin(deps: DshPluginHostDeps, input: DshPluginInstallInput): Promise<unknown> {
	return pluginRpc(deps, "install", input);
}

/** 运行动态插件的指定包（面板手势 requestId=null，无需审批）。 */
export async function runDshDynamicPlugin(deps: DshPluginHostDeps, input: DshPluginLifecycleInput): Promise<unknown> {
	return pluginRpc(deps, "run", input);
}

/** 停止动态插件的活动 run（保留全部包版本）。 */
export async function stopDshDynamicPlugin(deps: DshPluginHostDeps, input: DshPluginLifecycleInput): Promise<unknown> {
	return pluginRpc(deps, "stop", input);
}

/** 卸载动态插件（undefine：删除插件与全部包版本）。 */
export async function uninstallDshDynamicPlugin(deps: DshPluginHostDeps, input: DshPluginLifecycleInput): Promise<unknown> {
	return pluginRpc(deps, "uninstall", input);
}

/**
 * 会话命令枚举（D15）：经 pideck-command-bridge 调 host 命令注册表
 * （ctx.commands.list(agent)），返回该会话 live Agent 生效的命令描述符。
 * 会话未激活（无 live Agent）时桥返回结构化错误，主进程抛错，
 * 渲染层按能力降级为静态建议列表（DSH_COMMAND_SUGGESTIONS）。
 */
export async function listDshCommands(rpc: DshPluginHostDeps["rpc"], sessionId: string): Promise<DshCommandView[]> {
	const value = await rpc(PIDECK_COMMANDS_BRIDGE_PATH, "list", { sessionId });
	return Array.isArray(value) ? (value as DshCommandView[]) : [];
}

/**
 * 冷读会话日志 cursor（0.1.5 `session/page` 的 throughSeq 上界）。
 *
 * 契约见 pideckSessionBridge：cursor 来自 host 内 sessionQuery 的
 * observation（与 page 内部 sourceFor 同一数据源），不激活会话、不写投影缓存；
 * 取 cursor 与后续 page 之间日志只可能增长，旧 cursor 仍是合法切点。
 * 空日志返回 -1（page 拿到 -1 会返回空页）。
 * 返回非合法数字（桥未挂载/返回异常）时抛错，由调用方（historyPage）回退。
 */
export async function readDshSessionCursor(rpc: DshPluginHostDeps["rpc"], sessionId: string): Promise<number> {
	const value = await rpc(PIDECK_SESSION_BRIDGE_PATH, "cursor", { sessionId });
	const cursor = (value as { cursor?: unknown } | undefined)?.cursor;
	if (typeof cursor !== "number" || !Number.isSafeInteger(cursor)) {
		throw new Error("session bridge returned an invalid cursor");
	}
	return cursor;
}
