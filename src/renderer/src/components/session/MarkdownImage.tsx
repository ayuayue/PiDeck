import { memo, useCallback, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { localImageUrl } from "../../../../shared/localImage";
import { t } from "../../i18n";
import { useFileLinkBaseDir } from "./FileLinkBase";
import { ImageLightbox } from "./ImageLightbox";
import { MarkdownImageHoverSave, MarkdownImageToolbar } from "./MarkdownImageActions";
import { useMarkdownImageGroupCount } from "./MarkdownImageGroup";
import { resolveMarkdownImageSrc } from "./markdownImageSrc";

/**
 * Markdown 正文图片的唯一渲染入口（`MarkdownStream` 的 `img` 组件）。
 *
 * 布局照 dsh（两档，数值直接抄）：
 * - 单图：`display: block` + `max-width: min(100%, 640px)` + `max-height: 360px`（contain）
 *   —— 大截图不会占满整条时间线，宽图按比例缩，竖排堆叠。
 * - 同段多图（≥2）：96px 方块瓷砖（cover），细节靠点击看原图 —— 形制照 dsh 的
 *   `MessageImage` tile，尺寸按 PiDeck 观感从 64px 放大到 96px。张数由 `p` 组件数出来后
 *   经 `MarkdownImageGroupProvider` 下发（不能用 HTML 属性：`rehype-sanitize` 会剥掉）。
 *
 * 三条硬约束：
 * 1. 解析不出可加载 URL 时渲染 alt 原文，**绝不产出空 src 的白图**——失败要能被看见。
 * 2. 加载失败降级成「失败文案 · alt 或原路径」+ 可重试（瓷砖态给刷新图标，同 dsh）。
 * 3. 失败态绑定具体 `src`：流式期间半截路径会先 404，完整路径到达后必须能自愈。
 *
 * 相对路径的基准取本站会话的 cwd（`useFileLinkBaseDir`，与文件链接同一份上下文），
 * 不在渲染层猜项目根——猜错会静默打开另一份工作区里的同名图片。
 *
 * 本地图统一走 `pideck-file://`（主进程白名单里的只读协议），不用 `file://`：
 * dev 下页源是 http，`file://` 子资源会被 Chromium 直接拒绝。
 */
export const MarkdownImage = memo(function MarkdownImage(props: { destination: string; alt: string }) {
	const baseDir = useFileLinkBaseDir();
	const src = useMemo(() => resolveMarkdownImageSrc(props.destination, { baseDir, toLocalUrl: localImageUrl }), [props.destination, baseDir]);
	const [failedFor, setFailedFor] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	const label = props.alt || props.destination;
	const failed = failedFor !== null && failedFor === src;
	const tiled = useMarkdownImageGroupCount() > 1;

	// 解析不出可加载 URL（含流式期间故意不解析本地图）：一律显示 alt 文本。
	// 不再渲染 96px 占位框——流式时占位框会先闪一下再变真图，反而更吵。
	if (src === undefined) return <span className="text-text-tertiary">{label}</span>;
	if (failed) {
		return tiled ? (
			<button type="button" className="inline-flex size-24 cursor-pointer items-center justify-center rounded-sm bg-bg-muted text-text-tertiary hover:text-text-secondary" title={`${t("markdown.imageLoadFailed")} · ${label}`} aria-label={`${t("markdown.imageLoadFailed")} · ${label}`} onClick={() => setFailedFor(null)}>
				<RefreshCw size={16} />
			</button>
		) : (
			<span className="text-text-tertiary">
				{t("markdown.imageLoadFailed")}
				{label ? ` · ${label}` : ""} {/* 重试把失败态清掉 → img 重新挂载 → 重新请求。文件被创建/改好之后不用刷新会话 */}
				<button type="button" className="underline underline-offset-2 hover:text-text-secondary" onClick={() => setFailedFor(null)}>
					{t("markdown.imageRetry")}
				</button>
			</span>
		);
	}
	const openLabel = props.alt ? `${t("markdown.imageOpen")}: ${props.alt}` : t("markdown.imageOpen");
	const image = (
		<img
			className={tiled ? "inline-block size-24 cursor-zoom-in rounded-sm object-cover align-bottom" : "block max-h-[360px] w-auto max-w-[min(100%,640px)] cursor-zoom-in rounded-sm object-contain"}
			src={src}
			alt={props.alt}
			title={openLabel}
			role="button"
			tabIndex={0}
			loading="lazy"
			decoding="async"
			referrerPolicy="no-referrer"
			onClick={(event) => {
				// 图被链接包裹时（`[![](a.png)](url)`）：点图应当开预览，而不是跟着链接跳走
				event.preventDefault();
				event.stopPropagation();
				setOpen(true);
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					event.stopPropagation();
					setOpen(true);
				}
			}}
			onError={() => setFailedFor(src)}
		/>
	);
	return (
		<>
			{/* 大图带 hover 保存角标（对齐改造前 streamdown 的行为）；瓷砖太小不加角标，走预览工具条 */}
			{tiled ? (
				image
			) : (
				<span className="group/image relative inline-block">
					{image}
					<MarkdownImageHoverSave src={src} alt={props.alt} />
				</span>
			)}
			{open ? <ImageLightbox src={src} alt={props.alt || t("app.imagePreviewAlt")} onClose={close} actions={<MarkdownImageToolbar src={src} alt={props.alt} />} /> : null}
		</>
	);
});
