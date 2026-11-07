import { lazy, Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { ProjectFileAccessScope, ProjectFileTarget } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { base64ToBytes } from "../../../utils/base64Bytes";
import { BINARY_PREVIEW_MAX_BYTES, type BinaryFilePreviewKind } from "../../../utils/binaryPreview";
import { fileLoadErrorMessage } from "../fileLoadErrorMessage";

// 每个预览器都是独立 chunk：docx-preview（+jszip）、SheetJS、fflate 都只在内置预览
// 真正打开时才下载/解析，不进首屏主 chunk。
const DocxPreview = lazy(() => import("./DocxPreview"));
const SheetPreview = lazy(() => import("./SheetPreview"));
const ArchivePreview = lazy(() => import("./ArchivePreview"));

type PreviewState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; bytes: Uint8Array };

/**
 * Office / 压缩包预览宿主：自己按类型读盘（带大小上限），再把字节交给对应的
 * lazy 预览器。父层 FileDiffViewer 只管「该不该展示」，不重复读同一份二进制。
 */
export function BinaryFilePreview(props: {
	/** 只接需要解析的二进制；音视频走 Blob URL，不经过这里。 */
	kind: Exclude<BinaryFilePreviewKind, "audio" | "video">;
	/** 与 readContent/readBase64 一致：项目内文件可传相对 target，由 scope 限制根目录。 */
	filePath: string | ProjectFileTarget;
	fileAccessScope?: ProjectFileAccessScope;
}) {
	const [state, setState] = useState<PreviewState>({ status: "loading" });
	const scopeProjectId = props.fileAccessScope?.projectId;
	const pathLabel = typeof props.filePath === "string" ? props.filePath : props.filePath.relativePath;
	// 对象 target 每次渲染都可能是新引用：依赖收敛到稳定 key，避免 effect 自激循环。
	const targetKey = typeof props.filePath === "string" ? props.filePath : `${props.filePath.projectId}:${props.filePath.relativePath}`;

	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		const readBinary = window.piDesktop?.files?.readBase64;
		if (!readBinary) {
			setState({
				status: "error",
				message: t("editor.previewUnavailable"),
			});
			return;
		}
		void (async () => {
			try {
				const maxBytes = BINARY_PREVIEW_MAX_BYTES[props.kind];
				const base64 = await readBinary(props.filePath, maxBytes, props.fileAccessScope);
				if (cancelled) return;
				if (!base64) {
					setState({
						status: "error",
						message: t("editor.previewFailed", {
							error: t("editor.fileNotFound", { path: pathLabel }),
						}),
					});
					return;
				}
				setState({ status: "ready", bytes: base64ToBytes(base64) });
			} catch (e) {
				if (!cancelled) setState({ status: "error", message: fileLoadErrorMessage(e) });
			}
		})();
		return () => {
			cancelled = true;
		};
		// fileAccessScope 只按项目 id 变化；路径/类型变化由父层 key 触发重挂载。
	}, [props.kind, targetKey, scopeProjectId]);

	if (state.status === "loading") {
		return (
			<div className="file-diff-loading">
				<span className="inline-flex items-center gap-2">
					<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
					{t("common.loading")}
				</span>
			</div>
		);
	}
	if (state.status === "error") return <div className="file-diff-error">{state.message}</div>;

	const fallback = (
		<div className="file-diff-loading">
			<span className="inline-flex items-center gap-2">
				<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
				{t("common.loading")}
			</span>
		</div>
	);
	return <Suspense fallback={fallback}>{props.kind === "docx" ? <DocxPreview bytes={state.bytes} /> : props.kind === "spreadsheet" ? <SheetPreview bytes={state.bytes} /> : props.kind === "archive" ? <ArchivePreview bytes={state.bytes} /> : null}</Suspense>;
}
