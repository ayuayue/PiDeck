import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { imageMimeForPath } from "../../utils/imageMime";

/**
 * 远端项目里的图片预览。
 *
 * 为什么单独一个组件而不是塞进编辑器：远端文本通道**明确拒绝非 UTF-8 内容**
 * （`REMOTE_FILE_NOT_TEXT`），把 PNG 喂给它只会得到一条错误。图片走只读的 base64 通道
 * （与下载同一个 reader、同样 16 MiB 上限），在这里用 `<img>` 呈现。
 *
 * 不提供的：缩放/旋转/EXIF——预览只需要「看得到」，改图属于编辑器范畴。
 */
export function RemoteImagePreview(props: { projectId: string; path: string }) {
	const [src, setSrc] = useState<string | null>(null);
	const [errorCode, setErrorCode] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let active = true;
		const mime = imageMimeForPath(props.path) ?? "application/octet-stream";
		setLoading(true);
		setErrorCode(null);
		setSrc(null);
		void (async () => {
			try {
				const result = await desktopApi.remoteHosts.readProjectFile(props.projectId, props.path);
				if (!active) return;
				if (!result.ok) {
					setErrorCode(result.code);
					return;
				}
				setSrc(`data:${mime};base64,${result.value.contentBase64}`);
			} catch {
				if (active) setErrorCode("REMOTE_PROJECT_READ_FAILED");
			} finally {
				if (active) setLoading(false);
			}
		})();
		return () => {
			active = false;
		};
	}, [props.projectId, props.path]);

	return (
		<section className="flex min-h-0 flex-col gap-2 rounded border border-border p-2" aria-label={t("remoteFile.imagePreview")}>
			<strong className="min-w-0 truncate font-mono text-label">{props.path}</strong>
			{loading ? <Loader2 className="size-4 animate-pideck-spin" aria-label={t("remoteFile.loading")} /> : null}
			{errorCode !== null ? (
				<p role="alert" className="text-label text-destructive">
					{t("remoteFile.imageFailed", { code: errorCode })}
				</p>
			) : null}
			{src !== null ? (
				// scroll-ok: transient —— 一次性弹窗 / 设置面板：内容随交互生命周期结束，不是随数据增长的列表。
				<div className="flex min-h-0 items-start justify-center overflow-auto rounded border border-border bg-muted/30 p-2">
					<img src={src} alt={props.path} className="max-h-[520px] max-w-full object-contain" />
				</div>
			) : null}
		</section>
	);
}
