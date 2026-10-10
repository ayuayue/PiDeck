import { Check, Copy, Download, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import type { ImageContent } from "../../../../shared/types";
import { loadImageBase64 } from "../../../../shared/imageContentSrc";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { writeClipboardImage } from "../../utils/clipboard";
import { showNotice } from "../../utils/notice";

/** 图片 MIME → 下载扩展名：避免 jpeg 被存成 .png；生图 provider 偶发 octet-stream 兜底 png。 */
function imageDownloadExt(mimeType: string): string {
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/webp") return "webp";
	if (mimeType === "image/gif") return "gif";
	return "png";
}

/**
 * 对话图片统一动作（复制图片 / 保存为文件 / 有历史权限时移除单图）。
 *
 * 覆盖两类形态：新上传图片（内联 base64）直接取字节；历史 ref 引用经
 * `imagegen:read-image-blob` 按需取回（与生图卡片同一条按需回读通道，
 * 不把大图 base64 常驻渲染进程堆）。
 *
 * 使用方：UserBubble 缩略图 hover 覆盖层、ImagePreviewModal 预览工具条。
 * 视觉与生图卡片（FinalAnswer）的 copy/save 按钮同规格（ghost icon-sm / size-7）。
 */
export function ImageActionButtons(props: { image: ImageContent | null | undefined; className?: string; onRemove?: () => void }) {
	const [copied, setCopied] = useState(false);
	// ref 形态的按需取回通道：仅历史生图/落盘引用会走到，普通上传图片在内联分支短路
	const readImageBlob = useCallback((ref: string) => window.piDesktop.imagegen.readImageBlob(ref), []);
	/** 取回可复制/可下载的 data URL；内联与 ref 都取不到时返回 null（由调用方提示失败）。 */
	const loadImageDataUrl = useCallback(async (): Promise<string | null> => {
		const payload = await loadImageBase64(props.image, readImageBlob);
		if (!payload?.data) return null;
		// 部分 provider 返回 application/octet-stream，但字节仍是 PNG/JPEG：展示/复制统一用图片 MIME 兜底
		const mimeType = payload.mimeType?.startsWith("image/") ? payload.mimeType : "image/png";
		return `data:${mimeType};base64,${payload.data}`;
	}, [props.image, readImageBlob]);

	const copyImage = async () => {
		try {
			// 不用 fetch(data:...)（CSP 拦截）；统一走 writeClipboardImage，避免 Electron 失焦时 ClipboardItem 静默失败
			const dataUrl = await loadImageDataUrl();
			if (!dataUrl) throw new Error("Image payload is empty");
			const written = await writeClipboardImage(dataUrl);
			if (!written) throw new Error("Clipboard write rejected");
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			showNotice(t("imagegen.copyFailed"), 2000, "error");
		}
	};

	const saveImage = () => {
		void loadImageDataUrl().then((dataUrl) => {
			if (!dataUrl) {
				showNotice(t("imagegen.saveFailed"), 2000, "error");
				return;
			}
			const link = document.createElement("a");
			link.href = dataUrl;
			const ext = imageDownloadExt(props.image?.mimeType ?? "");
			link.download = `pideck-image-${Date.now()}.${ext}`;
			link.click();
		});
	};

	return (
		<div className={`flex items-center overflow-hidden rounded-md border border-border/70 bg-background/85 shadow-sm backdrop-blur-sm ${props.className ?? ""}`}>
			<Button variant="ghost" size="icon-sm" className="size-7 rounded-none text-muted-foreground hover:bg-muted hover:text-foreground" type="button" onClick={() => void copyImage()} title={t("imagegen.copy")} aria-label={t("imagegen.copy")}>
				{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
			</Button>
			<Button variant="ghost" size="icon-sm" className="size-7 rounded-none border-l border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground" type="button" onClick={saveImage} title={t("imagegen.save")} aria-label={t("imagegen.save")}>
				<Download size={14} aria-hidden="true" />
			</Button>
			{props.onRemove && (
				<Button variant="ghost" size="icon-sm" className="size-7 rounded-none border-l border-border/60 text-muted-foreground hover:bg-muted hover:text-destructive" type="button" onClick={props.onRemove} title={t("message.removeImage")} aria-label={t("message.removeImage")}>
					<Trash2 size={14} aria-hidden="true" />
				</Button>
			)}
		</div>
	);
}
