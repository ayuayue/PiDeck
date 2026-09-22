import { Download, Copy, Check, ChevronDown } from "lucide-react";
import { memo, useCallback, type RefObject, useState } from "react";
import type { ChatMessage, ImageContent } from "../../../../../shared/types";
import type { ImageGenMeta } from "../../../../../shared/types/imagegen";
import { IMAGE_GEN_SIZE_UNSET, parseImageGenSize } from "../../../../../shared/imageGenParams";
import { imageContentSrc, loadImageBase64 } from "../../../../../shared/imageContentSrc";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../ui-shadcn/dropdown-menu";
import { Textarea } from "../../ui-shadcn/textarea";
import { ImageGeneration } from "../../agents/image-generation";
import { AssistantText } from "../SurfaceComponents";
import { writeClipboardImage } from "../../../utils/clipboard";
import { showNotice } from "../../../utils/notice";

/** 收窄 meta.imageGen（消息数据来自历史会话/缓存，需运行时校验而非盲转）。 */
function isImageGenMeta(value: unknown): value is ImageGenMeta {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (v.status === "generating" || v.status === "complete" || v.status === "error") && typeof v.prompt === "string";
}

/**
 * 生图消息渲染：随 meta.imageGen.status 在「生成中点阵动画 → 图片清晰过渡 → 失败态」间切换。
 * 复用 beUI ImageGeneration（canvas 点阵 + motion 过渡），完成态图片支持点击放大预览。
 */
function ImageGenMessage(props: { meta: ImageGenMeta; images?: ImageContent[]; onPreviewImage: (image: ImageContent) => void }) {
	const [copied, setCopied] = useState(false);
	const status = props.meta.status;
	const statusText = status === "generating" ? t("imagegen.status.generating") : status === "complete" ? t("imagegen.status.complete") : t("imagegen.status.error");
	const image = props.images?.[0];
	// 部分生图 provider 返回 application/octet-stream，但 data 仍是 PNG/JPEG base64；
	// 不能因此让复制入口把有效图片误判为非图片，展示/复制统一使用图片 MIME 兜底。
	const imageMimeType = image?.mimeType.startsWith("image/") ? image.mimeType : "image/png";
	// 展示源：新图是内联 base64，历史图是落盘引用（pideck-img://，由协议流式加载，
	// 不把 200 MB base64 搬回渲染进程堆）。复制/保存需要真实字节，走按需 IPC 取回。
	const imageSrc = imageContentSrc(image);
	const readImageBlob = useCallback((ref: string) => window.piDesktop.imagegen.readImageBlob(ref), []);
	/** 取回可复制/可下载的 data URL；取不到返回 null。 */
	const loadImageDataUrl = async (): Promise<string | null> => {
		const payload = await loadImageBase64(image, readImageBlob);
		if (!payload) return null;
		return `data:${payload.mimeType.startsWith("image/") ? payload.mimeType : imageMimeType};base64,${payload.data}`;
	};
	// 未配置分辨率时不渲染右上角尺寸徽标：请求体没发 size，由模型默认决定，
	// 无法得知实际输出尺寸；"unset" 只是内部哨兵串（历史消息也会带上），不能直接上屏。
	// 用共享 parser 统一收窄，空/非法值同样隐藏。
	const parsedSize = parseImageGenSize(props.meta.size);
	const sizeMatch = parsedSize?.match(/^(\d+)x(\d+)$/i);
	const resolution = parsedSize && parsedSize !== IMAGE_GEN_SIZE_UNSET ? (sizeMatch ? `${sizeMatch[1]} × ${sizeMatch[2]}` : parsedSize) : undefined;
	const aspectRatio = sizeMatch ? `${sizeMatch[1]} / ${sizeMatch[2]}` : undefined;
	const copyImage = async () => {
		try {
			// 不使用 fetch(data:...)：data URL 会被 CSP 当作网络连接拦截。
			// 统一走 writeClipboardImage，避免 Electron 失焦时 ClipboardItem 静默失败。
			const dataUrl = await loadImageDataUrl();
			if (!dataUrl) throw new Error("Generated image is empty");
			const written = await writeClipboardImage(dataUrl);
			if (!written) throw new Error("Unable to write generated image to clipboard");
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			showNotice(t("imagegen.copyFailed"), 2000, "error");
		}
	};
	const saveImage = () => {
		if (!image) return;
		void loadImageDataUrl().then((dataUrl) => {
			if (!dataUrl) return;
			const link = document.createElement("a");
			link.href = dataUrl;
			// 扩展名跟 mime，避免 jpeg 结果被存成 .png
			const ext = image.mimeType === "image/jpeg" ? "jpg" : "png";
			link.download = `pideck-image-${Date.now()}.${ext}`;
			link.click();
		});
	};
	return (
		<div className="py-1">
			<ImageGeneration status={status} prompt={props.meta.prompt} statusText={statusText} resolution={resolution} aspectRatio={aspectRatio} size="fluid" className="max-w-[300px]">
				{status === "complete" && image && imageSrc ? <img src={imageSrc} alt="" className="cursor-zoom-in" onClick={() => props.onPreviewImage(image)} /> : undefined}
			</ImageGeneration>
			{status === "complete" && image && imageSrc ? (
				<div className="mt-1 flex items-center">
					{/* 主按钮和下拉菜单共用同一套图片动作，避免生图消息再显示普通文本复制栏。 */}
					<div className="flex items-center overflow-hidden rounded-sm border border-transparent hover:border-border">
						<Button variant="ghost" size="icon-sm" className="size-7 rounded-none text-muted-foreground hover:bg-muted hover:text-foreground" type="button" onClick={() => void copyImage()} title={t("imagegen.copy")} aria-label={t("imagegen.copy")}>
							{copied ? <Check size={14} /> : <Copy size={14} />}
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								{/* 与 CopyMenu 同规格（size-7 / 图标 14）：生图卡片的下拉半边原来比主按钮小一号 */}
								<Button variant="ghost" size="icon-sm" className="size-7 rounded-none border-l border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground" type="button" aria-label={t("copy.moreOptions")} title={t("copy.moreOptions")}>
									<ChevronDown size={14} />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="copy-menu-popover min-w-[132px]">
								<DropdownMenuItem onSelect={() => void copyImage()}>{t("imagegen.copy")}</DropdownMenuItem>
								<DropdownMenuItem onSelect={saveImage}>{t("imagegen.save")}</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			) : null}
			{status === "error" && props.meta.errorDetail ? <p className="mt-1.5 max-w-[36rem] whitespace-pre-wrap break-words text-xs leading-relaxed text-destructive">{props.meta.errorDetail}</p> : null}
		</div>
	);
}

/**
 * 最终回答段：本轮最后一条 assistant 文本，常驻、永不折叠。
 * 承载原地编辑 UI（编辑入口在 run 操作栏，编辑表单内联在此）。
 */
export const FinalAnswer = memo(function FinalAnswer(props: {
	message: ChatMessage;
	images?: ImageContent[];
	isStreaming?: boolean;
	/** live→settled 交接淡入 */
	settle?: boolean;
	/** 编辑态 */
	editing: boolean;
	editText: string;
	editAreaRef: RefObject<HTMLDivElement | null>;
	onEditTextChange: (text: string) => void;
	onStartEdit: () => void;
	onCancelEdit: () => void;
	onSaveEdit: () => void;
	onPreviewImage: (image: ImageContent) => void;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
}) {
	if (props.editing) {
		return (
			<div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-[color:color-mix(in_srgb,var(--color-accent)_3%,var(--color-bg-panel))] pl-2" ref={props.editAreaRef}>
				<div className="flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] before:content-['✎'] before:text-sm">{t("common.edit")}</div>
				<Textarea
					className="min-h-[100px] max-h-[400px] w-full resize-y rounded-sm border border-[var(--color-accent)] bg-bg-panel p-2 font-mono text-sm leading-relaxed text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[0_0_0_2px_var(--focus-ring)]"
					value={props.editText}
					onChange={(e) => props.onEditTextChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
							e.preventDefault();
							props.onSaveEdit();
						}
						if (e.key === "Escape") props.onCancelEdit();
					}}
					autoFocus
				/>
				<div className="flex justify-end gap-2">
					<Button variant="outline" size="sm" className="h-auto border-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-accent)] shadow-none hover:text-[var(--color-accent)]" onClick={props.onSaveEdit}>
						{t("common.save")}
					</Button>
					<Button variant="outline" size="sm" className="h-auto px-3 py-1 text-xs shadow-none" onClick={props.onCancelEdit}>
						{t("common.cancel")}
					</Button>
				</div>
			</div>
		);
	}
	// 生图消息：不渲染 markdown 正文，改渲染 beUI ImageGeneration（点阵动画→图片→失败态）。
	const imageGenMeta = isImageGenMeta(props.message.meta?.imageGen) ? props.message.meta.imageGen : undefined;
	if (imageGenMeta) {
		return <ImageGenMessage meta={imageGenMeta} images={props.images} onPreviewImage={props.onPreviewImage} />;
	}
	return <AssistantText text={props.message.text} images={props.images} onPreviewImage={props.onPreviewImage} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} isStreaming={props.isStreaming ?? false} settle={props.settle} />;
});
