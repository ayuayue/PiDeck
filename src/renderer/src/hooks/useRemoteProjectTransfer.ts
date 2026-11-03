import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import type { RemoteProjectDownloadResult, RemoteProjectUploadResult } from "../../../shared/types/remoteHost";
import type { RemoteTransferOperation } from "../../../shared/types/remoteTransfers";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import type { ProjectFileTransferOptions, ProjectServices } from "../services/projectServiceContracts";
import { normalizeProjectServiceError } from "../services/projectServiceFence";
import { remoteUploadFailureCopy } from "../utils/remoteCapabilityLimits";
import { REMOTE_ENTRY_DRAG_TYPE } from "../utils/remoteEntryDrag";
import { addRemoteTransferUiItem, createRemoteTransferUiItem, dismissRemoteTransferUi, remoteTransferCancelling, remoteTransferProgress, remoteTransferStarted, settleRemoteTransferUi, type RemoteTransferTerminalPhase, type RemoteTransferUiItem } from "../utils/remoteProjectTransferState";

const TRANSFER_CANCELLED = "REMOTE_TRANSFER_CANCELLED";

type TransferControl = { id: number; scope: string; options: ProjectFileTransferOptions };

/**
 * 远端项目面板的「本机 ↔ 远端」传输关注点（上传按钮 / 拖放上传 / 单条下载）。
 *
 * 服务实例仍隐藏 jobId/IPC；panel 只拿到本地 UI id、进度与一个 cancel(id) 动作。
 * 每个传输捕获创建时的 project generation，换代或卸载后迟到回调不能再改新面板。
 */
export function useRemoteProjectTransfer(input: { services: ProjectServices; directory: string; reload: () => Promise<void>; setError: (message: string | null) => void; searching: boolean }) {
	const { services, directory, reload, setError, searching } = input;
	const [dragActive, setDragActive] = useState(false);
	const [transfers, setTransfers] = useState<RemoteTransferUiItem[]>([]);
	const nextIdRef = useRef(0);
	const controllersRef = useRef(new Map<number, { controller: AbortController; scope: string }>());
	const aliveRef = useRef(true);
	const scopeKey = `${services.projectId}:${services.generation}`;
	const scopeRef = useRef(scopeKey);
	scopeRef.current = scopeKey;

	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
			for (const active of controllersRef.current.values()) active.controller.abort();
			controllersRef.current.clear();
		};
	}, []);

	useEffect(() => {
		setTransfers([]);
		return () => {
			for (const active of controllersRef.current.values()) active.controller.abort();
			controllersRef.current.clear();
		};
	}, [scopeKey]);

	/** 上传失败码 → 人话（未知码原样展示，绝不吞掉）。 */
	const failureText = useCallback((code: string): string => {
		const copy = remoteUploadFailureCopy(code);
		return copy.withCode ? t(copy.key, { code }) : t(copy.key);
	}, []);

	const updateUi = useCallback((id: number, scope: string, reduce: (items: RemoteTransferUiItem[]) => RemoteTransferUiItem[]): boolean => {
		const active = controllersRef.current.get(id);
		if (!aliveRef.current || scopeRef.current !== scope || active === undefined || active.scope !== scope) return false;
		setTransfers(reduce);
		return true;
	}, []);

	const isCurrentTransfer = useCallback((id: number, scope: string): boolean => {
		const active = controllersRef.current.get(id);
		return aliveRef.current && scopeRef.current === scope && active !== undefined && active.scope === scope;
	}, []);

	const settle = useCallback(
		(id: number, scope: string, phase: RemoteTransferTerminalPhase, detail: { code?: string; failedCount?: number } = {}): boolean => {
			return updateUi(id, scope, (items) => settleRemoteTransferUi(items, id, phase, detail));
		},
		[updateUi],
	);

	const finishUpload = useCallback(
		async (result: RemoteProjectUploadResult, id: number, scope: string): Promise<void> => {
			if (!result.ok) {
				if (result.code === TRANSFER_CANCELLED) {
					settle(id, scope, "cancelled", { code: result.code });
					return;
				}
				if (!settle(id, scope, result.outcome === "unknown" ? "unknown" : "failed", { code: result.code })) return;
				setError(result.outcome === "unknown" ? t("project.remote.transferUnknown", { code: result.code }) : failureText(result.code));
				return;
			}

			const value = result.value;
			if (!("uploaded" in value)) {
				settle(id, scope, "cancelled");
				return;
			}
			const failedCount = value.failed.length;
			if (!settle(id, scope, failedCount > 0 ? "partial" : "succeeded", failedCount > 0 ? { code: value.failed[0]?.code, failedCount } : {})) return;
			try {
				await reload();
			} catch {
				// Directory refresh has its own error surface; it must not rewrite a completed transfer.
			}
			if (!isCurrentTransfer(id, scope)) return;
			if (failedCount > 0) setError(t("project.remote.uploadPartial", { count: failedCount, message: failureText(value.failed[0]?.code ?? "PROJECT_SERVICE_FAILED") }));
		},
		[failureText, isCurrentTransfer, reload, setError, settle],
	);

	const finishDownload = useCallback(
		(result: RemoteProjectDownloadResult, id: number, scope: string): void => {
			if (result.ok && result.value.canceled === true) {
				settle(id, scope, "cancelled");
				return;
			}
			if (!result.ok) {
				if (result.code === TRANSFER_CANCELLED) {
					settle(id, scope, "cancelled", { code: result.code });
					return;
				}
				if (!settle(id, scope, result.outcome === "unknown" ? "unknown" : "failed", { code: result.code })) return;
				setError(result.outcome === "unknown" ? t("project.remote.transferUnknown", { code: result.code }) : t("project.remote.downloadFailed", { code: result.code }));
				return;
			}
			if (!settle(id, scope, "succeeded")) return;
			setError(null);
		},
		[setError, settle],
	);

	const settleThrown = useCallback(
		(error: unknown, operation: RemoteTransferOperation, id: number, scope: string): void => {
			const normalized = normalizeProjectServiceError(error);
			if (normalized.code === TRANSFER_CANCELLED) {
				settle(id, scope, "cancelled", { code: normalized.code });
				return;
			}
			if (!settle(id, scope, normalized.outcome === "unknown" ? "unknown" : "failed", { code: normalized.code })) return;
			setError(normalized.outcome === "unknown" ? t("project.remote.transferUnknown", { code: normalized.code }) : operation === "upload" ? failureText(normalized.code) : t("project.remote.downloadFailed", { code: normalized.code }));
		},
		[failureText, setError, settle],
	);

	const beginTransfer = useCallback(
		(operation: RemoteTransferOperation, run: (control: TransferControl) => Promise<void>): void => {
			const id = nextIdRef.current++;
			const scope = scopeRef.current;
			const controller = new AbortController();
			controllersRef.current.set(id, { controller, scope });
			setTransfers((items) => addRemoteTransferUiItem(items, createRemoteTransferUiItem(id, operation)));
			const options: ProjectFileTransferOptions = {
				signal: controller.signal,
				onStarted: (event) => updateUi(id, scope, (items) => remoteTransferStarted(items, id, event.total)),
				onProgress: (event) => updateUi(id, scope, (items) => remoteTransferProgress(items, id, event.operation, event.transferred, event.total)),
			};
			void run({ id, scope, options })
				.catch(() => {})
				.finally(() => {
					const active = controllersRef.current.get(id);
					if (active?.controller === controller) controllersRef.current.delete(id);
				});
		},
		[updateUi],
	);

	const startUpload = useCallback(
		(source: { kind: "picker" } | { kind: "paths"; paths: readonly string[] }) => {
			if (!services.capabilities.files.write || !services.capabilities.files.upload) {
				setError(failureText("PROJECT_SERVICE_UNSUPPORTED"));
				return;
			}
			beginTransfer("upload", async ({ id, scope, options }) => {
				let result: RemoteProjectUploadResult;
				try {
					result = await services.files.uploadFiles({ projectId: services.projectId, relativePath: directory }, source, options);
				} catch (error) {
					settleThrown(error, "upload", id, scope);
					return;
				}
				await finishUpload(result, id, scope);
			});
		},
		[beginTransfer, directory, failureText, finishUpload, services, setError, settleThrown],
	);

	const uploadFiles = useCallback(() => startUpload({ kind: "picker" }), [startUpload]);

	/**
	 * 拖放上传：Electron 32+ 的 File 没有 path，必须经 webUtils；路径与大小门仍在 main。
	 * 一个都解析不出来时明确报错，不能当成“成功传了 0 个”。
	 */
	const dropFiles = useCallback(
		(files: FileList | null) => {
			if (searching) {
				setError(t("project.remote.dropSearching"));
				return;
			}
			if (files === null || files.length === 0) {
				setError(t("project.remote.dropUnsupported"));
				return;
			}
			if (!services.capabilities.files.write || !services.capabilities.files.upload) {
				setError(failureText("PROJECT_SERVICE_UNSUPPORTED"));
				return;
			}
			const paths: string[] = [];
			for (const file of Array.from(files)) {
				const path = desktopApi.files.getPathForFile(file);
				if (typeof path === "string" && path.length > 0) paths.push(path);
			}
			if (paths.length === 0) {
				setError(t("project.remote.dropUnsupported"));
				return;
			}
			startUpload({ kind: "paths", paths });
		},
		[failureText, searching, services.capabilities.files.upload, services.capabilities.files.write, setError, startUpload],
	);

	const downloadFile = useCallback(
		(relativePath: string) => {
			if (!services.capabilities.files.read || !services.capabilities.files.download) {
				setError(t("project.remote.downloadFailed", { code: "PROJECT_SERVICE_UNSUPPORTED" }));
				return;
			}
			beginTransfer("download", async ({ id, scope, options }) => {
				let result: RemoteProjectDownloadResult;
				try {
					result = await services.files.downloadFile({ projectId: services.projectId, relativePath }, options);
				} catch (error) {
					settleThrown(error, "download", id, scope);
					return;
				}
				finishDownload(result, id, scope);
			});
		},
		[beginTransfer, finishDownload, services, setError, settleThrown],
	);

	const cancelTransfer = useCallback((id: number): void => {
		const active = controllersRef.current.get(id);
		if (active === undefined || active.controller.signal.aborted) return;
		setTransfers((items) => remoteTransferCancelling(items, id));
		active.controller.abort();
	}, []);

	const dismissTransfer = useCallback((id: number): void => {
		setTransfers((items) => dismissRemoteTransferUi(items, id));
	}, []);

	/** 只在真正离开面板时收起高亮：子元素之间移动也会触发 dragleave。 */
	const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
		if (!event.dataTransfer.types.includes("Files")) return;
		if (event.dataTransfer.types.includes(REMOTE_ENTRY_DRAG_TYPE)) return;
		event.preventDefault();
		setDragActive(true);
	}, []);

	const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
		if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
		setDragActive(false);
	}, []);

	const onDrop = useCallback(
		(event: DragEvent<HTMLElement>) => {
			event.preventDefault();
			setDragActive(false);
			dropFiles(event.dataTransfer.files);
		},
		[dropFiles],
	);

	return { dragActive, transfers, uploadFiles, dropFiles, downloadFile, cancelTransfer, dismissTransfer, onDragOver, onDragLeave, onDrop };
}
