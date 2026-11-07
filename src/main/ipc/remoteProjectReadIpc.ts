/**
 * 远端项目域的只读 IPC（从 remoteProjectIpc.ts 拆出，行为保持）。
 *
 * 这里只放按 projectId 的列表订阅、文件读取、文件名搜索与 root 状态；项目登记/确认、目录事实缓存
 * 与写面失效仍留在 remoteProjectIpc.ts。拆分的动因是该文件已越过 400 行红线，而这一组 handler
 * 共享同一套 path/target/session 依赖，边界清晰。
 */

import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { codeOf, opFailFromCode, opOk } from "../../shared/op";
import type { RemoteProjectListResult, RemoteProjectReadResult, RemoteProjectRootStatusResult, RemoteProjectSearchResult, RemoteWorkspaceEntry } from "../../shared/types/remoteHost";
import type { RemoteProjectTargetResolver } from "./remoteProjectTarget";
import type { RemoteProjectSession } from "../remote/RemoteHostConnectionService";
import { REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH } from "../remote/RemoteHelperContract";
import { REMOTE_PROJECT_TRASH_DIR } from "../remote/RemoteProjectEntryCommands";
import { REMOTE_UPLOAD_TEMP_NAME } from "../remote/RemoteProjectUploadNames";
import { createRemoteSearchReader, REMOTE_SEARCH_READER_CODES } from "../remote/RemoteSearchReader";
import { createRemoteWorkspaceReader, type RemoteWorkspacePort } from "../remote/RemoteWorkspaceReader";
import type { RemoteFactsHub } from "../remote/RemoteFactsNotifications";

export type RemoteProjectDirSnapshot = { ok: true; snapshot: { value: RemoteWorkspaceEntry[]; revision: number; truncated: boolean; scanned: number } } | { ok: false; code: string };

/** 校验项目根相对路径：绝对路径、穿越段、控制字节与反斜杠一律拒绝。空串表示根。 */
export function readRelativePath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 4096) return undefined;
	if (/[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
	if (value.startsWith("/")) return undefined;
	if (value === "") return "";
	const segments = value.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
	return value;
}

/** 本层空串表示根；reader 的协议拼写是 "."。 */
export function readerPath(relative: string): string {
	return relative === "" ? "." : relative;
}

/** 把 reader 的传输绑定到一条已 pin 的会话；hostId 不一致时 fail closed。 */
export function sessionPort(session: RemoteProjectSession, hostId: string): RemoteWorkspacePort {
	return {
		request: (requestHostId, method, params, options) => (requestHostId === hostId ? session.request(method, params, options) : Promise.reject(new Error("SSH_HOST_NOT_READY"))),
		cancel: (requestHostId, requestId, options) => (requestHostId === hostId ? session.cancel(requestId, options) : Promise.reject(new Error("SSH_HOST_NOT_READY"))),
	};
}

export type RemoteProjectReadIpcHandle = {
	/**
	 * 项目内**文件名**搜索的公共实现（`remote:project-search` 与 `files:search-page` 共用）：
	 * 只做读取与投影，不改事实、不签令牌。非法输入/未启用返回 `Op` 失败，不抛异常。
	 */
	searchProject(projectIdValue: unknown, pathValue: unknown, queryValue: unknown): Promise<RemoteProjectSearchResult>;
};

export function registerRemoteProjectReadIpc(input: { enabled: boolean; projectReadTarget: RemoteProjectTargetResolver; factsEvents: RemoteFactsHub; readDirSnapshot: (projectId: string, relative: string, force: boolean) => Promise<RemoteProjectDirSnapshot> }): RemoteProjectReadIpcHandle {
	ipcMain.handle(ipcChannels.remoteProjectList, async (_event, projectIdValue: unknown, pathValue: unknown): Promise<RemoteProjectListResult> => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		const relative = readRelativePath(pathValue);
		if (relative === undefined) return opFailFromCode("REMOTE_PROJECT_PATH_INVALID");
		if (typeof projectIdValue !== "string") return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		const read = await input.readDirSnapshot(projectIdValue, relative, false);
		if (!read.ok) return opFailFromCode(read.code);
		// revision 随值替换或标脏递增：两个读者拿到同一个数就说明他们看的是同一份事实。
		return opOk({ entries: read.snapshot.value, revision: read.snapshot.revision, truncated: read.snapshot.truncated, scanned: read.snapshot.scanned });
	});

	ipcMain.handle(ipcChannels.remoteProjectFactsSubscribe, (event, projectIdValue: unknown) => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		if (typeof projectIdValue !== "string" || projectIdValue.length === 0 || projectIdValue.length > 256 || projectIdValue !== projectIdValue.trim() || /[\u0000-\u001f\u007f]/.test(projectIdValue)) return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		input.factsEvents.subscribe(event.sender, projectIdValue);
		return opOk({ subscribed: true as const });
	});
	ipcMain.handle(ipcChannels.remoteProjectFactsUnsubscribe, (event, projectIdValue: unknown) => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		if (typeof projectIdValue !== "string" || projectIdValue.length === 0 || projectIdValue.length > 256) return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		input.factsEvents.unsubscribe(event.sender.id, projectIdValue);
		return opOk({ subscribed: false as const });
	});

	ipcMain.handle(ipcChannels.remoteProjectRead, async (_event, projectIdValue: unknown, pathValue: unknown): Promise<RemoteProjectReadResult> => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		// The read of the root itself is not a file; an empty path is a valid listing target but never a read.
		const relative = readRelativePath(pathValue);
		if (relative === undefined || relative === "") return opFailFromCode("REMOTE_PROJECT_PATH_INVALID");
		// 回收站不是用户可读的项目文件：读通道在这里拒绝（只读列表隐藏、回收站三通道单独授权）。
		if (relative === REMOTE_PROJECT_TRASH_DIR || relative.startsWith(REMOTE_PROJECT_TRASH_DIR + "/")) return opFailFromCode("REMOTE_FILE_PROTECTED_PATH");
		const target = await input.projectReadTarget(projectIdValue);
		if ("code" in target) return opFailFromCode(target.code);
		try {
			// The sizing stat, every chunk and the closing stat all happen under one host operation.
			const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				const reader = createRemoteWorkspaceReader({ port: sessionPort(session, target.hostId) });
				return reader.readFile(target.hostId, relative);
			});
			if (!outcome.ok) return opFailFromCode(outcome.code);
			const file = outcome.value;
			return opOk({ contentBase64: Buffer.from(file.content).toString("base64"), bytes: file.bytes, mtimeMs: file.mtimeMs });
		} catch (error) {
			return opFailFromCode(codeOf(error, "REMOTE_PROJECT_READ_FAILED"));
		}
	});

	/**
	 * 项目内**文件名**搜索（不含内容搜索）。整次搜索都在 withProjectSession 的受控边界内完成，
	 * 因此一次搜索不会横跨两个 root；非法 query 一个帧都不发出去。
	 * `truncated` 如实透传，不能把一屏结果伪装成完整答案。
	 */
	const searchProject: RemoteProjectReadIpcHandle["searchProject"] = async (projectIdValue, pathValue, queryValue) => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		const relative = readRelativePath(pathValue);
		if (relative === undefined) return opFailFromCode("REMOTE_PROJECT_PATH_INVALID");
		if (typeof queryValue !== "string" || queryValue.length === 0 || queryValue.length > REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(queryValue)) return opFailFromCode(REMOTE_SEARCH_READER_CODES.queryInvalid);
		const target = await input.projectReadTarget(projectIdValue);
		if ("code" in target) return opFailFromCode(target.code);
		try {
			const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				const reader = createRemoteSearchReader({ port: sessionPort(session, target.hostId) });
				return reader.search(target.hostId, readerPath(relative), queryValue);
			});
			if (!outcome.ok) return opFailFromCode(outcome.code);
			const result = outcome.value;
			// 递归搜索会命中回收站里的归档条目，但它们不是用户可搜索的文件：按首段过滤整棵 .pideck-trash。
			return opOk({
				entries: result.entries.filter((entry) => entry.path.split("/")[0] !== REMOTE_PROJECT_TRASH_DIR && !REMOTE_UPLOAD_TEMP_NAME.test(entry.path.split("/").at(-1) ?? "")).map((entry) => ({ path: entry.path, name: entry.name, kind: entry.kind, ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }) })),
				scanned: result.scanned,
				truncated: result.truncated,
			});
		} catch (error) {
			return opFailFromCode(codeOf(error, "REMOTE_PROJECT_READ_FAILED"));
		}
	};

	ipcMain.handle(ipcChannels.remoteProjectRootStatus, async (_event, projectIdValue: unknown): Promise<RemoteProjectRootStatusResult> => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		const target = await input.projectReadTarget(projectIdValue);
		if ("code" in target) return opFailFromCode(target.code);
		const status = target.service.projectRootStatus(target.hostId, target.remotePath);
		// Optional capability list of **this project's own root session** (content search is the first consumer).
		// A sibling root's helper must not answer here: the host can hold a live session for another project,
		// and advertising its vocabulary would claim a capability this root never negotiated. Absent means
		// "unknown/unsupported" - a renderer must fall back instead of guessing, which is exactly the old-helper
		// path. It is a diagnostic read: querying status still opens no session.
		const capabilities = target.service.projectHelperCapabilities(target.hostId, target.remotePath);
		return opOk({
			status: status.status === "ok" ? ("ok" as const) : ("needs-attention" as const),
			...(status.status === "ok" ? {} : { code: status.code }),
			...(capabilities === undefined ? {} : { helperCapabilities: capabilities }),
		});
	});

	return { searchProject };
}
