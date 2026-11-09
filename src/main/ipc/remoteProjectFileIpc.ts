import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { codeOf, opError, opFail, opFailFromCode, opOk, type Op } from "../../shared/op";
import type { RemoteTextOpenResult, RemoteTextSaveResult } from "../../shared/types/remoteFiles";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";
import { createRemoteProjectFileService } from "../remote/RemoteProjectFileService";
import { validateRemoteProjectTextPath, REMOTE_PROJECT_TEXT_MAX_BYTES } from "../remote/RemoteProjectFileCommands";
import { isRemoteProjectTrashPath } from "../remote/RemoteProjectEntryCommands";
import { isUncertainWrite } from "../remote/RemoteProjectWriteFacts";

/**
 * 编辑IPC独立于只读项目handler；locator只从main读取，整次I/O受既有单主机操作锁保护。
 *
 * 信封形状是契约层的 `Op<T>`（v5 §2「单信封」）：与 entry 域逐字同款，成功 `{ok:true, value}`、
 * 失败 `{ok:false, code, outcome}`，`outcome` 由稳定码落在闭集里推出。
 */
/** 供 `files:read-content` / `files:write-content` 复用的远端正文端口（同一份服务与令牌表）。 */
export type RemoteProjectTextPort = {
	openText(senderId: number, projectId: string, path: string): Promise<{ content: string; version?: string }>;
	saveText(senderId: number, projectId: string, path: string, content: string, version: string): Promise<void>;
};

export function registerRemoteProjectFileIpc(input: {
	enabled: boolean;
	service: () => RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined>;
	locator: (projectId: string) => { kind: "ssh"; hostId: string; remotePath: string } | undefined;
	/** 事实层失效钩子（W3）：保存成功后只标脏该文件所在目录，不触发装载。 */
	afterWrite?: (projectId: string, paths: readonly string[]) => void;
}): RemoteProjectTextPort {
	const files = createRemoteProjectFileService({
		locator: input.locator,
		withProject: async (target, work) => {
			const service = await input.service();
			if (!service) throw new Error("REMOTE_CONNECTION_SERVICE_UNAVAILABLE");
			const result = await service.withProjectSession(target.hostId, target.remotePath, (session) => work(session));
			// 连接层的信封只有 {ok, code}：这里升成完整信封（outcome 由码推出），再以异常交给端口。
			if (!result.ok) throw opError(opFailFromCode(result.code));
			return result.value;
		},
	});
	const senders = new Set<number>();
	function validate(sender: Electron.WebContents, projectId: unknown, relative: unknown): { senderId: number; projectId: string; relative: string } {
		if (!Number.isSafeInteger(sender.id) || sender.id < 1 || sender.isDestroyed() || typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) throw new Error("REMOTE_FILE_INPUT_INVALID");
		const path = validateRemoteProjectTextPath(relative);
		// 回收站是文件面的保留命名空间：文本读/写对第一段 .pideck-trash 一律拒绝（§4.3）。
		if (isRemoteProjectTrashPath(path)) throw new Error("REMOTE_FILE_PROTECTED_PATH");
		if (!senders.has(sender.id)) {
			senders.add(sender.id);
			sender.once("destroyed", () => {
				files.releaseSender(sender.id);
				senders.delete(sender.id);
			});
		}
		return { senderId: sender.id, projectId, relative: path };
	}
	/** 门禁 → 入参校验 → 服务；任何异常折叠成稳定码，绝不把自由文本带过边界。 */
	async function wrap<T>(task: () => Promise<T>): Promise<Op<T>> {
		if (!input.enabled) return opFail("REMOTE_FEATURE_DISABLED");
		try {
			return opOk(await task());
		} catch (error) {
			return opFailFromCode(codeOf(error, "REMOTE_FILE_COMMAND_FAILED"));
		}
	}
	ipcMain.handle(
		ipcChannels.remoteProjectTextOpen,
		async (event, projectId: unknown, relative: unknown): Promise<RemoteTextOpenResult> =>
			wrap(async () => {
				const valid = validate(event.sender, projectId, relative);
				return { document: await files.open(valid.senderId, valid.projectId, valid.relative) };
			}),
	);
	ipcMain.handle(
		ipcChannels.remoteProjectTextSave,
		async (event, projectId: unknown, relative: unknown, content: unknown, version: unknown): Promise<RemoteTextSaveResult> =>
			wrap(async () => {
				const valid = validate(event.sender, projectId, relative);
				if (typeof content !== "string" || typeof version !== "string" || !/^[a-f0-9]{32}$/.test(version)) throw new Error("REMOTE_FILE_INPUT_INVALID");
				if (content.length > REMOTE_PROJECT_TEXT_MAX_BYTES || Buffer.byteLength(content, "utf8") > REMOTE_PROJECT_TEXT_MAX_BYTES) throw new Error("REMOTE_FILE_TOO_LARGE");
				try {
					const saved = await files.save(valid.senderId, valid.projectId, valid.relative, content, version);
					input.afterWrite?.(valid.projectId, [valid.relative]);
					return saved;
				} catch (error) {
					// 结果未知/断连：远端可能已经落盘，事实必须与成功的写一样失效；写本身不重放。
					if (isUncertainWrite(error)) input.afterWrite?.(valid.projectId, [valid.relative]);
					throw error;
				}
			}),
	);
	// 中央编辑器这条路走同一个服务实例：令牌表、256KiB 上限、事实失效钩子都只有一份。
	return {
		openText: (senderId, projectId, path) => files.open(senderId, projectId, validateRemoteProjectTextPath(path)),
		saveText: async (senderId, projectId, path, content, version) => {
			await files.save(senderId, projectId, validateRemoteProjectTextPath(path), content, version);
			input.afterWrite?.(projectId, [path]);
		},
	};
}
