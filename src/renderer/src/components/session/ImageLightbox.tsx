import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { t } from "../../i18n";

/** 浮层内可聚焦元素：Tab 圈定范围（图片本体不可聚焦，动作条按钮要能 Tab 到）。 */
const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

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
 */
export function ImageLightbox(props: { src: string; alt: string; onClose: () => void; actions?: ReactNode }) {
	const dialogRef = useRef<HTMLDivElement | null>(null);
	const closeRef = useRef<HTMLButtonElement | null>(null);
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

	const onDialogKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Tab") return;
		const dialog = dialogRef.current;
		if (!dialog) return;
		const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
		if (items.length === 0) return;
		const current = items.findIndex((item) => item === document.activeElement);
		const next = event.shiftKey ? (current <= 0 ? items.length - 1 : current - 1) : current < 0 || current === items.length - 1 ? 0 : current + 1;
		event.preventDefault();
		items[next]?.focus();
	}, []);

	const content = (
		<div
			ref={dialogRef}
			className="image-preview-modal"
			role="dialog"
			aria-modal="true"
			aria-label={props.alt || t("app.imagePreviewAlt")}
			onKeyDown={onDialogKeyDown}
			// mousedown 而不是 click：按下后拖动（选区、拖拽）松手不该顺带关掉浮层
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<button ref={closeRef} type="button" className="image-preview-close" onClick={onClose} aria-label={t("app.imagePreviewClose")}>
				<X size={20} strokeWidth={2.4} />
			</button>
			<img src={props.src} alt={props.alt} />
			{props.actions ? <div className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2">{props.actions}</div> : null}
		</div>
	);
	return typeof document === "undefined" ? content : createPortal(content, document.body);
}
