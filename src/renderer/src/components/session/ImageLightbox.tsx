import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { t } from "../../i18n";
import { useImageZoom } from "../../hooks/session/useImageZoom";
import { IMAGE_ZOOM_FIT } from "./imageZoom";
import { ImageZoomControls } from "./ImageZoomControls";

/** 浮层内可聚焦元素：Tab 圈定范围（图片本体不可聚焦，动作条按钮要能 Tab 到）。 */
const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** 方向键平移步长（CSS px）。 */
const KEY_PAN_STEP = 48;
/** 方向键 → 平移方向（相对画面中心）。 */
const KEY_PAN: Record<string, readonly [number, number]> = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1],
};

/**
 * 图片全屏预览浮层（只认 `src` 字符串）。
 *
 * 从 `ImagePreviewModal`（只认 `ImageContent` 的 data/ref 形态）里抽出，供
 * Markdown 正文图片复用同一套关闭/Esc/动作条语义——否则会多出第二套浮层实现。
 * 历史消息、输入框附件的图仍经 `ImagePreviewModal` 进来，两者渲染的是同一个组件。
 *
 * 键盘与焦点（照 dsh 的 ImageLightbox 口径）：
 * - Esc 用**捕获阶段**监听并 `stopPropagation`：否则下层会话的快捷键（如 Esc 停止生成）会同时触发；
 * - 打开时焦点进关闭钮，卸载时**还原给打开它的元素**，键盘用户不会掉进 body；
 * - Tab/Shift+Tab 圈在浮层内循环，不会跑到被遮住的时间线里；
 * - `role="dialog" aria-modal` + 可读名称，读屏能识别这是模态。
 *
 * 挂到 `document.body`：`image-preview-modal` 是 `position: absolute; inset: 0`
 * 的覆盖层，挂在时间线里会以最近的定位祖先为界（会话栏内），挂到 body 才等价于
 * 全窗口覆盖——与 App 级预览的实际观感一致。
 *
 * 缩放/平移交给 `useImageZoom`（滚轮缩放 + 放大后拖拽/方向键平移）：浮层只负责关闭语义与
 * 底部控制簇，几何全部在纯函数 `imageZoom.ts` 里，别在这里手写换算。
 */
export function ImageLightbox(props: { src: string; alt: string; onClose: () => void; actions?: ReactNode }) {
	const dialogRef = useRef<HTMLDivElement | null>(null);
	const closeRef = useRef<HTMLButtonElement | null>(null);
	const zoom = useImageZoom(dialogRef);
	const { onClose } = props;

	useEffect(() => {
		const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		closeRef.current?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			onClose();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			restore?.focus();
		};
	}, [onClose]);

	const onDialogKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			// 放大后画面被裁掉：键盘用户也必须能平移，否则只有鼠标能看到细节（与拖拽共用同一套夹取）
			const panDirection = KEY_PAN[event.key];
			if (panDirection) {
				if (zoom.zoom <= IMAGE_ZOOM_FIT) return; // 适配档没有可平移余量，别把方向键吞掉
				event.preventDefault();
				zoom.panBy(panDirection[0] * KEY_PAN_STEP, panDirection[1] * KEY_PAN_STEP);
				return;
			}
			if (event.key !== "Tab") return;
			const dialog = dialogRef.current;
			if (!dialog) return;
			const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
			if (items.length === 0) return;
			const current = items.findIndex((item) => item === document.activeElement);
			const next = event.shiftKey ? (current <= 0 ? items.length - 1 : current - 1) : current < 0 || current === items.length - 1 ? 0 : current + 1;
			event.preventDefault();
			items[next]?.focus();
		},
		[zoom.zoom, zoom.panBy],
	);

	const content = (
		<div
			ref={dialogRef}
			data-close-scope="panel"
			tabIndex={-1}
			className="image-preview-modal overflow-hidden outline-none"
			role="dialog"
			aria-modal="true"
			aria-label={props.alt || t("app.imagePreviewAlt")}
			onKeyDown={onDialogKeyDown}
			// 点图片/背景会把焦点丢回 body（图片不可聚焦）：对话框自己收回焦点，
			// 方向键平移与 Tab 圈定才有上下文。click 里的按钮仍会按原生规则拿到焦点
			onPointerDown={() => dialogRef.current?.focus()}
			// mousedown 而不是 click：按下后拖动（选区、拖拽）松手不该顺带关掉浮层
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			{/* z-10：放大后的图片带 transform 会自建层叠上下文，与定位元素同层绘制；不加这一档关闭钮会被大图盖住 */}
			<button ref={closeRef} data-close-action="true" type="button" className="image-preview-close z-10" onClick={onClose} aria-label={t("app.imagePreviewClose")}>
				<X size={20} strokeWidth={2.4} />
			</button>
			<img
				ref={zoom.imageRef}
				src={props.src}
				alt={props.alt}
				// 缩放后由 transform 决定位置：禁止浏览器原生图片拖拽/选中；touch-none 让触屏/笔拖拽
				// 不被浏览器滚动手势接管（否则只会收到 pointercancel，触屏上就是「拖不动」）
				draggable={false}
				className={`touch-none select-none ${zoom.canZoomOut ? (zoom.dragging ? "cursor-grabbing" : "cursor-grab") : ""}`}
				style={zoom.imageStyle}
				{...zoom.handlers}
			/>
			<div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2">
				<ImageZoomControls zoom={zoom.zoom} canZoomIn={zoom.canZoomIn} canZoomOut={zoom.canZoomOut} onZoomIn={zoom.zoomIn} onZoomOut={zoom.zoomOut} onReset={zoom.reset} />
				{props.actions}
			</div>
		</div>
	);
	return typeof document === "undefined" ? content : createPortal(content, document.body);
}
