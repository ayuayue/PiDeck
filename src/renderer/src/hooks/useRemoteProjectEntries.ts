import { useCallback, useReducer, useRef, useState } from "react";
import { useStore } from "jotai";
import { codeOf, opFail, opOk, STABLE_CODE_PATTERN, type Op } from "../../../shared/op";
import type { ProjectFileTarget } from "../../../shared/types";
import type { RemoteEntryKind } from "../../../shared/types/remoteFiles";
import { remoteFileDraftsAtom } from "../atoms/remote-file-atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { ProjectServiceError, type ProjectServices } from "../services/projectServiceContracts";
import { applyRemoteFileMutation } from "../utils/remoteFileDrafts";
import { initialRemoteFileManagementState, reduceRemoteFileManagement, remoteFileEntryErrorKey, remoteFileEntrySuccessKey, REMOTE_FILE_ENTRY_UNKNOWN_CODE, type RemoteFileOperation } from "../components/session/remoteFileManagementState";

export type RemoteFileOutcome = { kind: "success" | "failed" | "unknown"; text: string; code: string | null; operation: RemoteFileOperation } | null;

function targetOf(projectId: string, relativePath: string): ProjectFileTarget {
	return { projectId, relativePath };
}

function parentOf(relativePath: string): string {
	const index = relativePath.lastIndexOf("/");
	return index < 0 ? "" : relativePath.slice(0, index);
}

/** 服务异常 → 既有 Op 状态机：稳定码与 outcome 都保留，unknown 绝不被降级成“确定没发生”。 */
function failureOp(error: unknown): Op<never> {
	if (error instanceof ProjectServiceError) return opFail(error.code, error.outcome);
	const attached = error as { code?: unknown; outcome?: unknown } | null;
	if (typeof attached?.code === "string" && STABLE_CODE_PATTERN.test(attached.code)) return opFail(attached.code, attached.outcome === "unknown" ? "unknown" : "rejected");
	return opFail(codeOf(error, "REMOTE_FILE_COMMAND_FAILED"));
}

/**
 * 远端文件管理的命令与状态接线（Phase B：读面与同父目录改名/新建/删除走 ProjectFileService）。
 *
 * 冻结义务（§10.3/§10.4）：
 * - 写操作单飞：状态机 busy 时不再发第二个请求；
 * - 成功只做「显式刷新当前目录」并给成功消息，不自动开关其它弹框；
 * - 已知失败给稳定码文案；未知结果（服务 outcome=unknown 或 RESULT_UNCONFIRMED）保留提示到用户显式刷新，且不自动重放；
 * - rename/delete 成功后只回收**干净**草稿，脏草稿保留并标 stale（§5.7）；
 * - 删除收据里的 trashId 原样经由 Op 返回，供回收站刷新/恢复链路使用（本屏只做显式重载）。
 *
 * 仍是薄壳的两处（服务契约未覆盖，交接 §8.8 已登记）：
 * - 跨目录移动：`renameEntry` 的契约是“同父目录改名”，拖拽/路径编辑改父目录时沿用既有
 *   entry 令牌通道（text version 不参与），等 S 扩展移动方法后删除；
 * - 回收站列表/恢复/清空：`ProjectFileService` 没有对应方法，继续用既有 remoteHosts 通道。
 */
export function useRemoteProjectEntries(options: { services: ProjectServices; reload: () => Promise<void> }) {
	const [state, dispatch] = useReducer(reduceRemoteFileManagement, initialRemoteFileManagementState());
	const [outcome, setOutcome] = useState<RemoteFileOutcome>(null);
	const store = useStore();
	// 单飞判断读最新状态：命令闭包不能依赖过期渲染值。
	const phaseRef = useRef(state.phase);
	phaseRef.current = state.phase;
	const { services, reload } = options;
	const projectId = services.projectId;
	const reloadRef = useRef(reload);
	reloadRef.current = reload;

	const execute = useCallback(async <T>(operation: RemoteFileOperation, work: () => Promise<Op<T>>, successText?: (value: T) => string): Promise<Op<T>> => {
		if (phaseRef.current === "busy") return opFail("REMOTE_FILE_BUSY");
		setOutcome(null);
		dispatch({ type: "begin", operation });
		let result: Op<T>;
		try {
			result = await work();
		} catch {
			// IPC reject 不是业务结论：按「未获确认」呈现，绝不谎报成功或未执行。
			result = opFail("REMOTE_FILE_COMMAND_FAILED");
		}
		if (result.ok) {
			dispatch({ type: "succeeded" });
			setOutcome({ kind: "success", text: successText ? successText(result.value) : t(remoteFileEntrySuccessKey(operation)), code: null, operation });
			try {
				await reloadRef.current();
			} catch {
				// 刷新失败不影响「操作已成功」这个事实；目录事实保持旧值，由用户显式刷新核对。
			}
		} else {
			// unknown 现在来自信封本身（main 按闭集推出，服务层原样保留），不再由渲染层看码猜。
			const unknown = result.outcome === "unknown";
			dispatch(unknown ? { type: "unknown", code: result.code } : { type: "failed", code: result.code });
			setOutcome({ kind: unknown ? "unknown" : "failed", text: t(remoteFileEntryErrorKey(result.code), { code: result.code }), code: result.code, operation });
		}
		return result;
	}, []);

	/** 跨目录移动走服务（provider 负责 local move / remote entry 令牌）；成功同样回收干净草稿。 */
	const moveEntry = useCallback(
		async (source: string, target: string): Promise<Op<{ target: ProjectFileTarget }>> => {
			try {
				const receipt = await services.files.moveEntry(targetOf(projectId, source), target);
				store.set(remoteFileDraftsAtom, (held) => applyRemoteFileMutation(held, projectId, source));
				return opOk(receipt);
			} catch (error) {
				return failureOp(error);
			}
		},
		[projectId, services, store],
	);

	const createEntry = useCallback(
		(parentRelativePath: string, kind: RemoteEntryKind, name: string) =>
			execute(kind === "file" ? "create-file" : "create-directory", async () => {
				try {
					return opOk(await services.files.createEntry(targetOf(projectId, parentRelativePath), name, kind));
				} catch (error) {
					return failureOp(error);
				}
			}),
		[execute, projectId, services],
	);

	const renameEntry = useCallback(
		(source: string, target: string) =>
			execute("rename", async () => {
				// 同父目录改名才是服务契约的形状；改父目录属于移动，走上面的薄壳。
				if (parentOf(source) !== parentOf(target)) return moveEntry(source, target);
				const newName = target.slice(target.lastIndexOf("/") + 1);
				try {
					const receipt = await services.files.renameEntry(targetOf(projectId, source), newName);
					store.set(remoteFileDraftsAtom, (held) => applyRemoteFileMutation(held, projectId, source));
					return opOk(receipt);
				} catch (error) {
					return failureOp(error);
				}
			}),
		[execute, moveEntry, projectId, services, store],
	);

	const deleteEntry = useCallback(
		(path: string) =>
			execute("delete", async () => {
				try {
					const receipt = await services.files.deleteEntry(targetOf(projectId, path));
					store.set(remoteFileDraftsAtom, (held) => applyRemoteFileMutation(held, projectId, path));
					return opOk(receipt);
				} catch (error) {
					return failureOp(error);
				}
			}),
		[execute, projectId, services, store],
	);

	const restoreTrash = useCallback(
		(trashId: string) =>
			execute(
				"restore",
				() => desktopApi.remoteHosts.restoreProjectTrash(projectId, trashId),
				(result) => t("remoteTrash.restored", { name: result.relativePath }),
			),
		[execute, projectId],
	);

	const pruneTrash = useCallback(
		(trashIds: string[]) =>
			execute(
				"prune",
				() => desktopApi.remoteHosts.pruneProjectTrash(projectId, trashIds),
				(result) => {
					const codes = result.kept.map((item) => item.code);
					if (codes.length > 0) return t("remoteTrash.kept", { count: codes.length, code: codes[0] });
					return t("remoteTrash.removed", { count: trashIds.length });
				},
			),
		[execute, projectId],
	);

	return { state, outcome, busy: state.phase === "busy", createEntry, renameEntry, deleteEntry, restoreTrash, pruneTrash, clearOutcome: () => setOutcome(null), unknownCode: REMOTE_FILE_ENTRY_UNKNOWN_CODE };
}
export type RemoteProjectEntries = ReturnType<typeof useRemoteProjectEntries>;
