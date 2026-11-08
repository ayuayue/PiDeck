import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { Loader2 } from "lucide-react";
import { t } from "../../../i18n";

/**
 * Word（.docx）只读预览：docx-preview 解析 OOXML 后直接构建 DOM 节点。
 *
 * 安全边界：文档内容不可信——渲染后剥掉所有外链 href、只保留 data:/blob: 图片，
 * 并拦截点击，预览区永远不会导航或加载第三方资源。旧版 .doc（OLE 二进制）不在支持范围。
 */
export default function DocxPreview(props: { bytes: Uint8Array }) {
	const bodyRef = useRef<HTMLDivElement>(null);
	const styleRef = useRef<HTMLDivElement>(null);
	const [rendering, setRendering] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const body = bodyRef.current;
		const styleHost = styleRef.current;
		if (!body || !styleHost) return;
		let cancelled = false;
		setRendering(true);
		setError(null);
		body.innerHTML = "";
		styleHost.innerHTML = "";
		void (async () => {
			try {
				// 传副本：解析器会保留数据引用，避免与其他预览共用同一视图。
				await renderAsync(props.bytes.slice(), body, styleHost, {
					inWrapper: true,
					breakPages: true,
					ignoreLastRenderedPageBreak: false,
					renderHeaders: true,
					renderFooters: true,
					renderFootnotes: false,
					renderEndnotes: false,
					renderComments: false,
					renderChanges: false,
					useBase64URL: true,
				});
				if (cancelled) {
					body.innerHTML = "";
					styleHost.innerHTML = "";
					return;
				}
				sanitizeRenderedDocx(body);
				setRendering(false);
			} catch (e) {
				if (cancelled) return;
				setError(e instanceof Error ? e.message : String(e));
				setRendering(false);
			}
		})();
		return () => {
			cancelled = true;
			body.innerHTML = "";
			styleHost.innerHTML = "";
		};
	}, [props.bytes]);

	return (
		<div
			className="relative flex h-full w-full flex-col overflow-hidden bg-muted/40"
			onClickCapture={(event) => {
				if ((event.target as HTMLElement).closest("a")) event.preventDefault();
			}}
		>
			{/* docx-preview 把生成的页面样式写进这个容器，正文节点写进 body 容器 */}
			<div ref={styleRef} hidden />
			{/* scroll-ok: text —— docx-preview 自管内部滚动，正文是渲染后的文档，没有可切分的行列表。 */}
			<div ref={bodyRef} className="h-full w-full overflow-auto" />
			{rendering && !error && (
				<div className="absolute inset-0 grid place-items-center bg-background/60">
					<span className="inline-flex items-center gap-2 text-caption text-muted-foreground">
						<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
						{t("common.loading")}
					</span>
				</div>
			)}
			{error && <div className="absolute inset-0 grid place-items-center p-6 text-center text-caption text-destructive">{t("editor.previewFailed", { error })}</div>}
		</div>
	);
}

function sanitizeRenderedDocx(root: HTMLElement): void {
	root.querySelectorAll("a[href]").forEach((anchor) => {
		// 保留原地址给悬停提示，但去掉可导航属性（含 target）。
		anchor.setAttribute("title", anchor.getAttribute("href") ?? "");
		anchor.removeAttribute("href");
		anchor.removeAttribute("target");
		anchor.removeAttribute("rel");
	});
	root.querySelectorAll("img").forEach((img) => {
		const src = img.getAttribute("src") ?? "";
		if (!/^(?:data:|blob:)/i.test(src)) img.removeAttribute("src");
		img.setAttribute("loading", "lazy");
		img.setAttribute("referrerpolicy", "no-referrer");
	});
}
