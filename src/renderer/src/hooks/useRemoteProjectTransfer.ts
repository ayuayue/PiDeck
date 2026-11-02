import { useCallback, useState, type DragEvent } from "react";
import type { RemoteProjectUploadResult } from "../../../shared/types/remoteHost";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import type { ProjectServices } from "../services/projectServiceContracts";
import { normalizeProjectServiceError } from "../services/projectServiceFence";
import { readRemoteUploadNotice, remoteUploadFailureCopy } from "../utils/remoteCapabilityLimits";
import { REMOTE_ENTRY_DRAG_TYPE } from "../utils/remoteEntryDrag";

/**
 * 远端项目面板的「本机 ↔ 远端」传输关注点（上传按钮 / 拖放上传 / 单条下载）。
 *
 * 抽出来的理由：`RemoteProjectPanel` 同时管导航、搜索、写操作弹框、回收站与传输，已经越过
 * 「单文件 ≤400 行」的目标。传输与它们没有耦合——只依赖「当前目录 + 刷新目录 + 报错」三样，
 * 所以整块搬出来，面板只保留接线。
 *
 * 失败提示的**顺序**在这里是刻意的：所有成功路径都先 `reload()`（它会清掉错误位）再写反馈，
 * 否则「传 10 个失败 9 个」的提示会被刷新抹掉，用户只能看到列表跳一下。
 */
export function useRemoteProjectTransfer(input: { services: ProjectServices; directory: string; reload: () => Promise<void>; setError: (message: string | null) => void; searching: boolean }) {
	const { services, directory, reload, setError, searching } = input;
	const [dragActive, setDragActive] = useState(false);

	/** 上传失败码 → 人话（未知码原样展示，绝不吞掉）。 */
	const failureText = useCallback((code: string): string => {
		const copy = remoteUploadFailureCopy(code);
		return copy.withCode ? t(copy.key, { code }) : t(copy.key);
	}, []);

	const finish = useCallback(
		async (result: RemoteProjectUploadResult) => {
			// 失败码与部分失败由纯函数分类：任何失败都不会落进 success 分支。
			const notice = readRemoteUploadNotice(result);
			if (notice.kind === "error") {
				setError(failureText(notice.code));
				return;
			}
			// 取消是用户的动作（现在是成功载荷的一个分支），不报错、也不当作已完成。
			if (notice.kind === "none") return;
			await reload();
			if (notice.kind === "partial") setError(t("project.remote.uploadPartial", { count: notice.failedCount, message: failureText(notice.code) }));
		},
		[failureText, reload, setError],
	);

	const uploadFiles = useCallback(() => {
		if (!services.capabilities.files.upload) {
			setError(failureText("PROJECT_SERVICE_UNSUPPORTED"));
			return;
		}
		void (async () => {
			try {
				await finish(await services.files.uploadFiles({ projectId: services.projectId, relativePath: directory }, { kind: "picker" }));
			} catch (error) {
				setError(failureText(normalizeProjectServiceError(error).code));
			}
		})();
	}, [finish, services, directory, failureText, setError]);

	/**
	 * 拖放上传：把拖进来的本机文件传到**当前目录**。
	 *
	 * Electron 32+ 的 File 没有 `path`，必须经 `webUtils.getPathForFile`（preload 暴露）解析；
	 * 解析不出来的项跳过——但如果**一个都没有**就不能当成「成功传了 0 个」，要明确告诉用户。
	 * 路径校验与大小门都在主进程（`parseLocalUploadPaths` + `uploadMany`）。
	 */
	const dropFiles = useCallback(
		(files: FileList | null) => {
			// 搜索态下列表不显示目录内容，传输反馈也会被搜索状态盖掉：宁可不接受。
			if (searching) {
				setError(t("project.remote.dropSearching"));
				return;
			}
			if (files === null || files.length === 0) {
				setError(t("project.remote.dropUnsupported"));
				return;
			}
			if (!services.capabilities.files.upload) {
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
			void (async () => {
				try {
					await finish(await services.files.uploadFiles({ projectId: services.projectId, relativePath: directory }, { kind: "paths", paths }));
				} catch (error) {
					setError(failureText(normalizeProjectServiceError(error).code));
				}
			})();
		},
		[directory, failureText, finish, searching, services, setError],
	);

	/** 下载到本机：保存对话框与写盘都在主进程，这里只报失败（取消不是失败）。 */
	const downloadFile = useCallback(
		(relativePath: string) => {
			if (!services.capabilities.files.download) {
				setError(t("project.remote.downloadFailed", { code: "PROJECT_SERVICE_UNSUPPORTED" }));
				return;
			}
			void (async () => {
				try {
					const result = await services.files.downloadFile({ projectId: services.projectId, relativePath });
					if (!result.ok) {
						setError(t("project.remote.downloadFailed", { code: result.code }));
						return;
					}
					// 取消不是失败：用户自己关掉了保存对话框。
					if (result.value.canceled === true) return;
					setError(null);
				} catch (error) {
					setError(t("project.remote.downloadFailed", { code: normalizeProjectServiceError(error).code }));
				}
			})();
		},
		[services, setError],
	);

	/** 只在真正离开面板时收起高亮：子元素之间移动也会触发 dragleave。 */
	const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
		// 不 preventDefault 就不会触发 drop（浏览器默认拒绝接收）。
		if (!event.dataTransfer.types.includes("Files")) return;
		// 内部拖动（条目→目录）也带 Files? 不带；但为稳妥起见只认真的文件拖入。
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

	return { dragActive, uploadFiles, dropFiles, downloadFile, onDragOver, onDragLeave, onDrop };
}
