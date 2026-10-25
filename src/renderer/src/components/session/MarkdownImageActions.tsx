import { Check, Copy, Download } from "lucide-react";
import { useCallback, useState } from "react";
import { imageDownloadName } from "../../../../shared/imageFilename";
import { parseLocalImageUrl } from "../../../../shared/localImage";
import { t } from "../../i18n";
import { writeClipboardImage } from "../../utils/clipboard";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";

/**
 * Markdown 正文图片的「复制 / 保存」动作（按 `src` 取字节，不依赖 ImageContent）。
 *
 * 来历（2026-10-20）：改造前正文图片由 streamdown 内置组件渲染，右下角 hover 就有下载
 * 按钮；换成 `MarkdownImage` 后这个能力被静默丢掉了（用户反馈「我的图还能下载吗」）。
 * 现在按同一套语义补回，并放到更稳的位置：预览浮层工具条 + 大图 hover。
 *
 * 取字节分两条路：
 * - 本地图（`pideck-file://`）走 IPC `localImage.readBytes`。**不能 fetch**：该自定义 scheme
 *   是 `corsEnabled: false`，渲染层 fetch 直接 `TypeError: Failed to fetch`（2026-10-20 e2e
 *   实测：保存按钮只会弹失败提示）。主进程用与协议同一份白名单判定后再返回字节。
 * - 远程图只能 fetch（受 CORS 限制，失败提示而不是静默）。
 * 不把 base64 常驻内存：只在动作发生时取一次 blob。
 */

function base64ToBlob(data: string, mimeType: string): Blob {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return new Blob([bytes], { type: mimeType });
}

async function loadImageBlob(src: string): Promise<Blob> {
	// 本地图必须走 IPC：pideck-file:// 是 corsEnabled:false 的自定义 scheme，fetch 会被拦
	const localPath = parseLocalImageUrl(src);
	if (localPath !== null) {
		const payload = await window.piDesktop.localImage.readBytes(localPath);
		if (!payload) throw new Error("local image rejected");
		return base64ToBlob(payload.data, payload.mimeType);
	}
	const response = await fetch(src);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.blob();
}

/** 复制/保存的共用逻辑：一次取 blob，两条动作都基于它。 */
function useMarkdownImageActions(src: string, alt: string) {
	const [copied, setCopied] = useState(false);

	const copy = useCallback(async () => {
		try {
			const blob = await loadImageBlob(src);
			const ok = await writeClipboardImage(blob);
			if (!ok) throw new Error("Clipboard write rejected");
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			showNotice(t("imagegen.copyFailed"), 2000, "error");
		}
	}, [src]);

	const save = useCallback(async () => {
		try {
			const blob = await loadImageBlob(src);
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = imageDownloadName(alt, blob.type);
			link.click();
			// 下载由 Chromium 接管后立即释放，不常驻内存
			window.setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch {
			showNotice(t("imagegen.saveFailed"), 2000, "error");
		}
	}, [src, alt]);

	return { copied, copy, save };
}

/** 预览浮层底部工具条：复制 + 保存（与附件图的 ImageActionButtons 同规格）。 */
export function MarkdownImageToolbar(props: { src: string; alt: string }) {
	const { copied, copy, save } = useMarkdownImageActions(props.src, props.alt);
	return (
		<div className="flex items-center overflow-hidden rounded-md border border-border/70 bg-background/85 shadow-sm backdrop-blur-sm">
			<Button variant="ghost" size="icon-sm" className="size-7 rounded-none text-muted-foreground hover:bg-muted hover:text-foreground" type="button" data-testid="markdown-image-copy" onClick={() => void copy()} title={t("imagegen.copy")} aria-label={t("imagegen.copy")}>
				{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
			</Button>
			<Button variant="ghost" size="icon-sm" className="size-7 rounded-none border-l border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground" type="button" data-testid="markdown-image-save" onClick={() => void save()} title={t("imagegen.save")} aria-label={t("imagegen.save")}>
				<Download size={14} aria-hidden="true" />
			</Button>
		</div>
	);
}

/** 大图 hover 角标：与改造前的 streamdown 行为对齐（不弹浮层也能直接存）。 */
export function MarkdownImageHoverSave(props: { src: string; alt: string }) {
	const { save } = useMarkdownImageActions(props.src, props.alt);
	return (
		<button
			type="button"
			className="absolute right-2 top-2 flex size-8 cursor-pointer items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground opacity-0 shadow-sm backdrop-blur-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/image:opacity-100"
			data-testid="markdown-image-save-hover"
			onClick={() => void save()}
			title={t("imagegen.save")}
			aria-label={t("imagegen.save")}
		>
			<Download size={14} aria-hidden="true" />
		</button>
	);
}
