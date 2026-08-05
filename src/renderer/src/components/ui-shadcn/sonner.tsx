import { useEffect, useSyncExternalStore } from "react";
import { Toaster as SonnerToaster } from "sonner";
import { setToasterReady } from "../../utils/notice";

/**
 * 全局 Toaster（#115）：sonner 官方组件，主题跟随应用 dataset.theme
 * （应用主题独立于系统主题，不能用 sonner 的 "system" 模式）。
 */

function subscribeTheme(callback: () => void) {
	const observer = new MutationObserver(callback);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme"],
	});
	return () => observer.disconnect();
}

function getThemeSnapshot(): "light" | "dark" {
	return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function Toaster() {
	const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot);
	// sonner 2.x 无 toast 时不渲染 DOM，notice.ts 无法靠 DOM 探测挂载态，
	// 挂载/卸载时显式回报，未挂载窗口期 showNotice 才走 DOM 兜底。
	useEffect(() => {
		setToasterReady(true);
		return () => setToasterReady(false);
	}, []);
	return (
		<SonnerToaster
			theme={theme}
			position="top-right"
			gap={10}
			closeButton
			visibleToasts={4}
			offset={{
				// 让开自定义标题栏拖拽区（--window-drag-height：frameless 下 40px，否则 0px）。
				// 首个 toast 若贴顶，左上角关闭按钮会落在 -webkit-app-region: drag 层里，
				// 点击被拖拽命中测试吞掉，表现为“点叉没反应”。
				top: "calc(var(--window-drag-height, 0px) + 12px)",
				right: "16px",
			}}
			toastOptions={{
				className: "app-sonner-toast",
				style: {
					// 中性面板卡片：与弹窗/抽屉同一套 token，类型语义只体现在图标色（见 surfaces.css）
					background: "var(--color-bg-panel)",
					border: "1px solid var(--color-border-subtle)",
					borderRadius: "var(--radius-lg)",
					boxShadow: "var(--shadow-popover)",
					color: "var(--color-text-primary)",
					fontSize: "13px",
					fontFamily: "var(--font-family-base)",
					padding: "12px 36px 12px 14px",
				},
			}}
		/>
	);
}
