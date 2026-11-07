import { posix } from "node:path";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { codeOf, opError, opFail, opFailFromCode, opOk, type Op } from "../../shared/op";
import type { RemoteEntryCreateResult, RemoteEntryDeleteResult, RemoteEntryRenameResult, RemoteEntryStatResult, RemoteTrashListResult, RemoteTrashPruneResult, RemoteTrashRestoreResult } from "../../shared/types/remoteFiles";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";
import { createRemoteProjectEntryService, REMOTE_FILE_ENTRY_CODES } from "../remote/RemoteProjectEntryService";
import { validateRemoteProjectEntryName } from "../remote/RemoteProjectEntryCommands";
import { isUncertainWrite } from "../remote/RemoteProjectWriteFacts";

const VERSION = /^[a-f0-9]{32}$/;
/** 回收站 id 形状是 IPC 边界的一部分：main 生成、renderer 只回传。 */
const TRASH_ID = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/;
const PROJECT_ID = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value === value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const SENDER = (sender: IpcMainInvokeEvent["sender"]): boolean => Number.isSafeInteger(sender.id) && sender.id >= 1 && !sender.isDestroyed();

/**
 * 远端文件管理 IPC 边界（Phase 5 文件面；docs/archive/remote/remote-file-management-plan.md §3.2/§3.5）。
 *
 * 只做输入形状/值域/发送者/启用门禁与稳定码信封；locator、令牌、主机锁与固定 Node 命令全部在
 * RemoteProjectEntryService。renderer 永远不发送 hostId/绝对路径/摘要。
 * 与文本保存 IPC 各自持有令牌表（互不驱逐）；窗口销毁时本模块撤销本表令牌，文本模块撤销它自己的。
 *
 * 信封形状是契约层的 `Op<T>`（v5 §2「单信封」）：成功 `{ok:true, value}`，失败 `{ok:false, code, outcome}`。
 * `outcome` 由 `code` 落在闭集里推出（`REMOTE_FILE_RESULT_UNCONFIRMED` ⇒ unknown），所以「可能已执行」
 * 这件事在结构上就传得下去，不再依赖渲染层猜码。
 */
export function registerRemoteProjectEntryIpc(input: {
	enabled: boolean;
	service: () => RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined>;
	locator: (projectId: string) => { kind: "ssh"; hostId: string; remotePath: string } | undefined;
	/**
	 * 事实层失效钩子（W3）：写成功后告诉目录事实「这几条路径变了」。
	 * 只标脏不装载——一次写不产生任何远端往返，下一次读自然重新装载。
	 */
	afterWrite?: (projectId: string, paths: readonly string[]) => void;
}) {
	const entry = createRemoteProjectEntryService({
		locator: (projectId) => {
			const locator = input.locator(projectId);
			return locator === undefined ? undefined : { hostId: locator.hostId, remotePath: locator.remotePath };
		},
		withProject: async (target, work) => {
			const service = await input.service();
			if (!service) throw new Error("REMOTE_CONNECTION_SERVICE_UNAVAILABLE");
			const result = await service.withProjectSession(target.hostId, target.remotePath, (session) => work(session));
			// 连接层的信封只有 {ok, code}：这里升成完整信封（outcome 由码推出），再以异常交给端口。
			if (!result.ok) throw opError(opFailFromCode(result.code));
			return result.value;
		},
	});
	const senders = new Map<number, { sender: IpcMainInvokeEvent["sender"]; destroy: () => void }>();
	function watchSender(sender: IpcMainInvokeEvent["sender"]): number {
		if (!SENDER(sender)) throw new Error("REMOTE_FILE_INPUT_INVALID");
		if (!senders.has(sender.id)) {
			const destroy = () => {
				entry.releaseSender(sender.id);
				senders.delete(sender.id);
			};
			senders.set(sender.id, { sender, destroy });
			sender.once("destroyed", destroy);
		}
		return sender.id;
	}
	/**
	 * 统一信封：启用门禁 → （handler 内）入参校验 → 服务；任何异常都折叠成闭集稳定码。
	 * 门禁关闭时不注册 sender 资源，返回的只有 REMOTE_FEATURE_DISABLED（渲染层连「有这条路」都不该知道）。
	 *
	 * 闭集过滤与迁移前逐字一致：`REMOTE_FILE_ENTRY_CODES` 之外的码（含自由文本、含连接层自己的码）
	 * 一律折成 `REMOTE_FILE_COMMAND_FAILED`，否则这条通道会变成 stderr 的下水道。
	 */
	/**
	 * 写路径的统一收尾：成功与「可能已落地」的失败都失效事实；明确失败不失效。写本身不重放。
	 *
	 * `completed` 返回成功后的已知路径（undefined = 这次写不影响用户可见条目，例如清理回收站）；
	 * `requested` 是未知结局时唯一能负责的路径：请求里的 parent/name 或 source/target，不猜远端实际状态。
	 */
	async function writeWithFacts<T>(projectId: string, requested: readonly string[], completed: (value: T) => readonly string[] | undefined, write: () => Promise<T>): Promise<T> {
		try {
			const value = await write();
			const paths = completed(value);
			if (paths !== undefined) input.afterWrite?.(projectId, paths);
			return value;
		} catch (error) {
			if (isUncertainWrite(error)) input.afterWrite?.(projectId, requested);
			throw error;
		}
	}
	/** 创建请求的目标路径（与 service 里 entryRelativePath 同一规则）：未知结局时按它标脏。 */
	const requestedEntryPath = (parent: string, name: string): string => (parent === "" ? name : parent + "/" + name);
	async function wrap<T>(task: () => Promise<T>): Promise<Op<T>> {
		if (!input.enabled) return opFail("REMOTE_FEATURE_DISABLED");
		try {
			return opOk(await task());
		} catch (error) {
			const code = codeOf(error, "REMOTE_FILE_COMMAND_FAILED");
			return opFailFromCode(REMOTE_FILE_ENTRY_CODES.has(code) ? code : "REMOTE_FILE_COMMAND_FAILED");
		}
	}

	ipcMain.handle(
		ipcChannels.remoteProjectTrashList,
		async (event, projectId: unknown): Promise<RemoteTrashListResult> =>
			wrap(async () => {
				if (!PROJECT_ID(projectId)) throw new Error("REMOTE_FILE_INPUT_INVALID");
				const sender = watchSender(event.sender);
				return await entry.listTrash(sender, projectId);
			}),
	);

	ipcMain.handle(
		ipcChannels.remoteProjectTrashRestore,
		async (event, projectId: unknown, trashId: unknown): Promise<RemoteTrashRestoreResult> =>
			wrap(async () => {
				if (!PROJECT_ID(projectId) || typeof trashId !== "string" || !TRASH_ID.test(trashId)) throw new Error("REMOTE_FILE_INPUT_INVALID");
				const sender = watchSender(event.sender);
				// 还原的目标路径只在成功回执里出现：未知结局没有已知路径，仍发一次空范围失效。
				return await writeWithFacts(
					projectId,
					[],
					(restored) => [restored.relativePath],
					() => entry.restoreTrash(sender, projectId, trashId),
				);
			}),
	);

	ipcMain.handle(
		ipcChannels.remoteProjectTrashPrune,
		async (event, projectId: unknown, trashIds: unknown): Promise<RemoteTrashPruneResult> =>
			wrap(async () => {
				if (!PROJECT_ID(projectId)) throw new Error("REMOTE_FILE_INPUT_INVALID");
				if (!Array.isArray(trashIds) || trashIds.length === 0 || trashIds.length > 32 || trashIds.some((id) => typeof id !== "string" || !TRASH_ID.test(id))) throw new Error("REMOTE_FILE_INPUT_INVALID");
				const sender = watchSender(event.sender);
				// 清理回收站不改用户可见条目：成功与未知都不需要标脏（仍可能影响 Git status，由装配层项目级失效负责）。
				return await writeWithFacts(
					projectId,
					[],
					() => undefined,
					() => entry.pruneTrash(sender, projectId, trashIds),
				);
			}),
	);

	return {
		/**
		 * 供 `files:create` / `files:rename` 在 main 内按位置分派时复用（位置分派收口第二片）：
		 * 与既有 `remote:project-entry-*` 通道共用同一套服务、令牌表、事实失效与错误码。
		 * 令牌不离开 main：rename 先 stat 取得一次性令牌，立刻用它提交。
		 */
		create(sender: IpcMainInvokeEvent["sender"], projectId: string, parent: string, name: string, type: "file" | "directory"): Promise<{ relativePath: string; kind: "file" | "directory" | "other" }> {
			if (!input.enabled) throw new Error("REMOTE_FEATURE_DISABLED");
			if (!PROJECT_ID(projectId) || typeof parent !== "string" || typeof name !== "string") throw new Error("REMOTE_FILE_INPUT_INVALID");
			const senderId = watchSender(sender);
			return writeWithFacts(
				projectId,
				[requestedEntryPath(parent, name)],
				(created) => [created.relativePath],
				() => (type === "file" ? entry.createFile(senderId, projectId, parent, name) : entry.createDirectory(senderId, projectId, parent, name)),
			);
		},
		rename(sender: IpcMainInvokeEvent["sender"], projectId: string, source: string, targetPath: string): Promise<{ relativePath: string }> {
			if (!input.enabled) throw new Error("REMOTE_FEATURE_DISABLED");
			if (!PROJECT_ID(projectId) || typeof source !== "string" || typeof targetPath !== "string") throw new Error("REMOTE_FILE_INPUT_INVALID");
			// 改名不是移动：目标必须与原路径同父目录，最后一段必须是单段名字（不含 `/`、不是临时后缀/保留名）。
			// 本机 FileSystemService.rename 有同一 P0 判据；这里守在服务边界，任何新入口都绕不过去。
			if (posix.dirname(targetPath) !== posix.dirname(source)) throw new Error("REMOTE_FILE_INPUT_INVALID");
			validateRemoteProjectEntryName(posix.basename(targetPath));
			const senderId = watchSender(sender);
			return (async () => {
				// 乐观锁的凭据是 stat 签发的一次性令牌：这里现读现用，绝不跨调用复用。
				const { version } = await entry.stat(senderId, projectId, source);
				return await writeWithFacts(
					projectId,
					[source, targetPath],
					(renamed) => [source, renamed.relativePath],
					() => entry.rename(senderId, projectId, source, targetPath, version),
				);
			})();
		},
		move(sender: IpcMainInvokeEvent["sender"], projectId: string, source: string, targetDir: string): Promise<{ relativePath: string }> {
			if (!input.enabled) throw new Error("REMOTE_FEATURE_DISABLED");
			if (!PROJECT_ID(projectId) || typeof source !== "string" || typeof targetDir !== "string") throw new Error("REMOTE_FILE_INPUT_INVALID");
			const senderId = watchSender(sender);
			const name = source.slice(source.lastIndexOf("/") + 1);
			const targetPath = targetDir === "" ? name : `${targetDir}/${name}`;
			// 移到同一个目录 = 无操作：不签令牌、不发帧（与本地 backend 的“同名移动”语义一致）。
			if (targetPath === source) return Promise.resolve({ relativePath: source });
			return (async () => {
				const { version } = await entry.stat(senderId, projectId, source);
				return await writeWithFacts(
					projectId,
					[source, targetPath],
					(renamed) => [source, renamed.relativePath],
					() => entry.rename(senderId, projectId, source, targetPath, version),
				);
			})();
		},
		delete(sender: IpcMainInvokeEvent["sender"], projectId: string, relativePath: string): Promise<{ trashId: string }> {
			if (!input.enabled) throw new Error("REMOTE_FEATURE_DISABLED");
			if (!PROJECT_ID(projectId) || typeof relativePath !== "string") throw new Error("REMOTE_FILE_INPUT_INVALID");
			const senderId = watchSender(sender);
			return (async () => {
				// 删除不可恢复（进回收站）：乐观锁凭据同样现读现用，不跨调用复用。
				const { version } = await entry.stat(senderId, projectId, relativePath);
				return await writeWithFacts(
					projectId,
					[relativePath],
					() => [relativePath],
					() => entry.deleteEntry(senderId, projectId, relativePath, version),
				);
			})();
		},
		/** 退出清理：撤销全部 sender 令牌并解除窗口监听（与文本保存 IPC 各管各的表）。 */
		dispose(): void {
			for (const { sender, destroy } of senders.values()) sender.removeListener("destroyed", destroy);
			senders.clear();
		},
		/** 测试/诊断：入口服务（令牌表大小与 releaseSender 的可观察语义）。 */
		service: entry,
	};
}
export type RemoteProjectEntryIpc = ReturnType<typeof registerRemoteProjectEntryIpc>;
